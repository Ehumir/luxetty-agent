#!/usr/bin/env node
'use strict';

/**
 * Dedicated Railway worker process.
 *
 * Existing responsibility: CRM outbox worker.
 * Sprint 3: also runs a lightweight ICF daily-followup eligibility scan on an
 * independent cadence. The DB enforces >=24h between commercial reminders.
 */

require('dotenv').config();

const { supabase } = require('../services/supabaseService');
const { executeV3CrmIfEligible } = require('../conversation/v3/crm/crmExecutor');
const {
  runCrmOutboxWorkerBatch,
  shouldStartRailwayWorkerLoop,
  defaultWorkerId,
} = require('../conversation/v3/runtime/crmOutboxWorker');
const { bootstrapCrmWorkerStore } = require('../conversation/v3/runtime/crmWorkerStoreBootstrap');
const { getCrmWorkerPollMs } = require('../config/perseoM402Flags');
const { v3Log } = require('../conversation/v3/core/v3Logger');
const { runIcfDailyFollowups } = require('../services/icfFollowupProduction');

const workerId = defaultWorkerId();
let stopping = false;
let workerStore = null;
let workerStoreMode = 'unknown';
let lastIcfFollowupScanAt = 0;
let tickInFlight = false;
let consecutiveTickFailures = 0;
let nextTickAllowedAt = 0;

function logEvent(type, payload) {
  v3Log(type, { worker_id: workerId, ...payload });
}

function icfScanIntervalMs() {
  const configured = Number(process.env.PERSEO_ICF_FOLLOWUP_SCAN_INTERVAL_MS || 15 * 60 * 1000);
  return Math.max(60 * 1000, Math.min(configured, 60 * 60 * 1000));
}

function workerBackoffMs(failures) {
  const pollMs = getCrmWorkerPollMs();
  const exponent = Math.max(0, Math.min(Number(failures || 1) - 1, 6));
  return Math.min(5 * 60 * 1000, Math.max(10 * 1000, pollMs * (2 ** exponent)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRunIcfFollowupScan() {
  const now = Date.now();
  if (now - lastIcfFollowupScanAt < icfScanIntervalMs()) return;
  lastIcfFollowupScanAt = now;

  try {
    const summary = await runIcfDailyFollowups({
      supabase,
      now: new Date(now),
      logger: {
        info: (event, payload) => logEvent(event, payload),
        warn: (event, payload) => logEvent(event, { level: 'warn', ...payload }),
      },
    });
    logEvent('icf_daily_followup_worker_scan', {
      skipped: summary?.skipped === true,
      reason: summary?.reason || null,
      candidates: summary?.candidates ?? 0,
      sent: summary?.sent ?? 0,
      blocked: summary?.blocked ?? 0,
      errors: summary?.errors ?? 0,
    });
  } catch (err) {
    logEvent('icf_daily_followup_worker_error', {
      error: String(err?.message || err),
    });
  }
}

async function tick() {
  if (stopping || !workerStore || tickInFlight) return;
  if (Date.now() < nextTickAllowedAt) return;

  tickInFlight = true;
  let infrastructureHealthy = false;

  try {
    const batch = await runCrmOutboxWorkerBatch({
      supabase,
      store: workerStore,
      executeCore: (input) => executeV3CrmIfEligible(input),
      workerId,
      crmDryRun: process.env.PERSEO_V3_CRM_EXECUTE !== 'true',
      logEvent,
    });

    consecutiveTickFailures = 0;
    nextTickAllowedAt = 0;
    infrastructureHealthy = true;

    if (batch.claimed > 0) {
      logEvent('crm_worker_tick', { claimed: batch.claimed, processed: batch.processed, mode: batch.mode });
    }
  } catch (err) {
    consecutiveTickFailures += 1;
    const backoffMs = workerBackoffMs(consecutiveTickFailures);
    nextTickAllowedAt = Date.now() + backoffMs;
    logEvent('crm_worker_tick_error', {
      error: String(err?.message || err),
      consecutive_failures: consecutiveTickFailures,
      backoff_ms: backoffMs,
      next_attempt_at: new Date(nextTickAllowedAt).toISOString(),
    });
  }

  try {
    // The ICF scan also talks to Supabase. Do not add more DB pressure while the
    // CRM infrastructure tick is failing or timing out.
    if (infrastructureHealthy) await maybeRunIcfFollowupScan();
  } finally {
    tickInFlight = false;
  }
}

async function bootstrapWorkerStoreWithBackoff() {
  let failures = 0;

  while (!stopping) {
    try {
      const boot = await bootstrapCrmWorkerStore(supabase);
      if (boot.mode !== 'db') {
        throw new Error(
          `expected selectedStoreMode=db, got ${boot.mode}. memoryFallbackReason=${boot.memoryFallbackReason}`,
        );
      }
      return boot;
    } catch (err) {
      failures += 1;
      const backoffMs = workerBackoffMs(failures);
      console.error(
        `[crm-worker] bootstrap unavailable; retrying in ${backoffMs}ms: ${String(err?.message || err)}`,
      );
      await sleep(backoffMs);
    }
  }

  return null;
}

async function main() {
  if (!shouldStartRailwayWorkerLoop()) {
    console.error(
      '[crm-worker] Refusing to start: set PERSEO_CRM_WORKER_PROCESS_ENABLED=true, PERSEO_CRM_WORKER_ASYNC_ENABLED=true, PERSEO_CRM_RUNTIME_PERSISTENT_ENABLED=true',
    );
    process.exit(1);
  }

  const shutdown = () => {
    stopping = true;
    console.log('[crm-worker] shutdown requested');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const boot = await bootstrapWorkerStoreWithBackoff();
  if (!boot || stopping) return;

  workerStore = boot.store;
  workerStoreMode = boot.mode;

  console.log(
    JSON.stringify({
      event: 'crm_worker_startup',
      worker_id: workerId,
      icf_followup_scan_interval_ms: icfScanIntervalMs(),
      single_flight: true,
      infrastructure_backoff: true,
      ...boot.diagnostics,
    }),
  );

  const pollMs = getCrmWorkerPollMs();
  console.log(`[crm-worker] ready worker_id=${workerId} poll_ms=${pollMs} selectedStoreMode=${workerStoreMode}`);

  const interval = setInterval(() => {
    void tick();
  }, pollMs);

  void tick();

  const stopInterval = () => {
    clearInterval(interval);
    if (!tickInFlight) process.exit(0);
  };
  process.once('SIGTERM', stopInterval);
  process.once('SIGINT', stopInterval);
}

main().catch((err) => {
  console.error('[crm-worker] bootstrap failed', err);
  process.exit(1);
});