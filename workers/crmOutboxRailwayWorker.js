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

function logEvent(type, payload) {
  v3Log(type, { worker_id: workerId, ...payload });
}

function icfScanIntervalMs() {
  const configured = Number(process.env.PERSEO_ICF_FOLLOWUP_SCAN_INTERVAL_MS || 15 * 60 * 1000);
  return Math.max(60 * 1000, Math.min(configured, 60 * 60 * 1000));
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
  if (stopping || !workerStore) return;
  try {
    const batch = await runCrmOutboxWorkerBatch({
      supabase,
      store: workerStore,
      executeCore: (input) => executeV3CrmIfEligible(input),
      workerId,
      crmDryRun: process.env.PERSEO_V3_CRM_EXECUTE !== 'true',
      logEvent,
    });
    if (batch.claimed > 0) {
      logEvent('crm_worker_tick', { claimed: batch.claimed, processed: batch.processed, mode: batch.mode });
    }
  } catch (err) {
    logEvent('crm_worker_tick_error', { error: String(err?.message || err) });
  }

  await maybeRunIcfFollowupScan();
}

async function main() {
  if (!shouldStartRailwayWorkerLoop()) {
    console.error(
      '[crm-worker] Refusing to start: set PERSEO_CRM_WORKER_PROCESS_ENABLED=true, PERSEO_CRM_WORKER_ASYNC_ENABLED=true, PERSEO_CRM_RUNTIME_PERSISTENT_ENABLED=true',
    );
    process.exit(1);
  }

  const boot = await bootstrapCrmWorkerStore(supabase);
  workerStore = boot.store;
  workerStoreMode = boot.mode;

  console.log(
    JSON.stringify({
      event: 'crm_worker_startup',
      worker_id: workerId,
      icf_followup_scan_interval_ms: icfScanIntervalMs(),
      ...boot.diagnostics,
    }),
  );

  if (workerStoreMode !== 'db') {
    console.error(
      `[crm-worker] FATAL: expected selectedStoreMode=db, got ${workerStoreMode}. memoryFallbackReason=${boot.memoryFallbackReason}`,
    );
    process.exit(1);
  }

  const pollMs = getCrmWorkerPollMs();
  console.log(`[crm-worker] ready worker_id=${workerId} poll_ms=${pollMs} selectedStoreMode=${workerStoreMode}`);

  const interval = setInterval(() => {
    void tick();
  }, pollMs);

  void tick();

  const shutdown = () => {
    stopping = true;
    clearInterval(interval);
    console.log('[crm-worker] shutdown');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[crm-worker] bootstrap failed', err);
  process.exit(1);
});
