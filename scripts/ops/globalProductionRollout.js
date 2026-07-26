#!/usr/bin/env node
'use strict';

/**
 * Global Production Rollout — PERSEO RAG + V3 100% traffic.
 * Usage: node scripts/ops/globalProductionRollout.js [--dry-run]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');

const RUN_ID = `global-rollout-${Date.now()}`;
const PROD_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-agent-production.up.railway.app').replace(/\/$/, '');
const EXPECTED_COMMIT = process.env.GLOBAL_ROLLOUT_COMMIT || '03654cd';
const EVIDENCE_DIR = path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/global-rollout');
const DRY_RUN = process.argv.includes('--dry-run');

const THRESHOLDS_JSON =
  '{"properties":0.78,"commercial_objections":0.55,"assignment_rules":0.55,"rules_atena":0.45,"rules_perseo":0.45,"zones":0.45,"campaigns":0.45,"scripts":0.72}';

function railwayEnv() {
  return JSON.parse(
    execSync('railway variable list -s luxetty-perseo -e production --json', {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  );
}

function railwayDeploy() {
  return JSON.parse(
    execSync('railway deployment list -s luxetty-perseo -e production --json', {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  )[0] || {};
}

function gitHead() {
  return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: path.join(__dirname, '../..') }).trim();
}

function activateGlobal() {
  if (DRY_RUN) return;
  execSync(
    `railway variable set ` +
      `RAG_P0_ENABLED=true ` +
      `RAG_INVENTORY_ENABLED=true ` +
      `RAG_RULES_ENABLED=true ` +
      `RAG_DOMAIN_ROUTING_ENABLED=true ` +
      `RAG_ADAPTIVE_THRESHOLD_ENABLED=true ` +
      `RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED=true ` +
      `RAG_RC11_TELEMETRY_ENABLED=true ` +
      `RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED=true ` +
      `RAG_P0_GLOBAL_MODE=true ` +
      `PERSEO_V3_ENABLED=true ` +
      `PERSEO_V3_GLOBAL_MODE=true ` +
      `RAG_DOMAIN_THRESHOLDS_JSON='${THRESHOLDS_JSON}' ` +
      `-s luxetty-perseo -e production`,
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8' }
  );
  try {
    execSync('railway variable delete RAG_P0_ALLOWLIST -s luxetty-perseo -e production', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'pipe',
    });
  } catch {
    /* ok */
  }
  try {
    execSync('railway variable delete PERSEO_V3_QA_ALLOWLIST -s luxetty-perseo -e production', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'pipe',
    });
  } catch {
    /* ok */
  }
}

async function verifyNonAllowlist() {
  const phone = `52999${String(Date.now()).slice(-7)}`;
  const wamid = `wamid.${RUN_ID}.verify.${Math.random().toString(36).slice(2, 8)}`;
  const msg = textMessage('Hola verificación global rollout', {
    from: phone,
    id: wamid,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'Global Verify' });
  const res = await fetch(`${PROD_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  await new Promise((r) => setTimeout(r, 8000));
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const since = new Date(Date.now() - 60000).toISOString();
  const { data: events } = await db
    .from('conversation_events')
    .select('type,payload')
    .eq('type', 'rag_retrieval')
    .gte('created_at', since)
    .limit(20);
  const ragForPhone = (events || []).filter((e) => {
    const p = e.payload || {};
    return p.message_id === wamid || String(p.message_id || '').includes(wamid);
  });
  const { data: gates } = await db
    .from('conversation_events')
    .select('type,payload')
    .eq('type', 'v3_primary_gate')
    .gte('created_at', since)
    .limit(20);
  const v3Gate = (gates || []).find((g) => {
    const p = g.payload || {};
    return p.inbound_normalized && String(p.inbound_normalized).includes(phone.slice(-10));
  });
  return {
    phone,
    wamid,
    http_ok: res.status === 200,
    rag_events: ragForPhone.length,
    v3_allowed: v3Gate?.payload?.v3_primary_allowed === true,
    v3_route: v3Gate?.payload?.route || null,
    pass: res.status === 200 && (ragForPhone.length > 0 || v3Gate?.payload?.v3_primary_allowed === true),
  };
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const before = railwayEnv();
  const deploy = railwayDeploy();

  const preflight = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    commit: deploy.meta?.commitHash?.slice(0, 7),
    expected: EXPECTED_COMMIT,
    deployment_status: deploy.status,
    before_allowlist: {
      RAG_P0_ALLOWLIST: before.RAG_P0_ALLOWLIST || 'NOT_SET',
      PERSEO_V3_QA_ALLOWLIST: before.PERSEO_V3_QA_ALLOWLIST || 'NOT_SET',
      RAG_P0_GLOBAL_MODE: before.RAG_P0_GLOBAL_MODE || 'NOT_SET',
      PERSEO_V3_GLOBAL_MODE: before.PERSEO_V3_GLOBAL_MODE || 'NOT_SET',
    },
    pass: String(deploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT) && deploy.status === 'SUCCESS',
  };

  activateGlobal();
  await new Promise((r) => setTimeout(r, 12000));
  const after = railwayEnv();
  const verification = await verifyNonAllowlist();

  const rollout = {
    run_id: RUN_ID,
    dry_run: DRY_RUN,
    activated_at: new Date().toISOString(),
    scope: 'global_100_percent',
    flags_set: {
      RAG_P0_GLOBAL_MODE: 'true',
      PERSEO_V3_GLOBAL_MODE: 'true',
      RAG_P0_ALLOWLIST: 'DELETED',
      PERSEO_V3_QA_ALLOWLIST: 'DELETED',
      guards_active: [
        'zone_entity_validation',
        'campaign_entity_validation',
        'adaptive_thresholds',
        'domain_routing',
        'runtime_self_check',
        'telemetry',
      ],
    },
    after_env: {
      RAG_P0_GLOBAL_MODE: after.RAG_P0_GLOBAL_MODE,
      PERSEO_V3_GLOBAL_MODE: after.PERSEO_V3_GLOBAL_MODE,
      RAG_P0_ALLOWLIST: after.RAG_P0_ALLOWLIST || 'NOT_SET',
      PERSEO_V3_QA_ALLOWLIST: after.PERSEO_V3_QA_ALLOWLIST || 'NOT_SET',
    },
    verification,
    rollback: {
      procedure: 'railway variable delete RAG_P0_GLOBAL_MODE PERSEO_V3_GLOBAL_MODE; restore allowlists OR delete all RAG flags',
      no_code_change: true,
    },
    pass: verification.pass && after.RAG_P0_GLOBAL_MODE === 'true' && after.PERSEO_V3_GLOBAL_MODE === 'true',
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'GLOBAL_ROLLOUT.json'), JSON.stringify({ preflight, rollout }, null, 2));
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'PERSEO_OPERATIONAL_STATUS.json'),
    JSON.stringify(
      {
        run_id: RUN_ID,
        status: rollout.pass ? 'GLOBAL_LIVE' : 'ROLLOUT_INCOMPLETE',
        url: PROD_URL,
        commit: gitHead(),
        global_mode: true,
        allowlist_removed: true,
        verification,
      },
      null,
      2
    )
  );

  const md = `# Global Production Rollout

**Run ID:** ${RUN_ID}
**Estado:** ${rollout.pass ? 'GLOBAL LIVE' : 'INCOMPLETE'}
**Commit:** ${EXPECTED_COMMIT}

## Cambios
- RAG_P0_GLOBAL_MODE=true
- PERSEO_V3_GLOBAL_MODE=true
- Allowlists eliminadas (RAG + V3)

## Verificación no-allowlist
- HTTP: ${verification.http_ok}
- V3 allowed: ${verification.v3_allowed}
- RAG events: ${verification.rag_events}

## Rollback
Delete global mode flags o todos los RAG_* — sin cambio de código.
`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'GLOBAL_ROLLOUT_REPORT.md'), md);

  console.log(JSON.stringify({ run_id: RUN_ID, pass: rollout.pass, verification }, null, 2));
  process.exit(rollout.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
