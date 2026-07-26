#!/usr/bin/env node
'use strict';

/**
 * RC-1 Final — Production certification protocol.
 * Usage:
 *   node scripts/qa/rc1FinalCertification.js --preflight-only
 *   node scripts/qa/rc1FinalCertification.js --activate-and-smoke
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');
const { RQ4_CERTIFIED_THRESHOLDS } = require('../../conversation/v3/rag/ragDomainThresholdLoader');

const RUN_ID = `rc1-final-${Date.now()}`;
const PROD_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-agent-production.up.railway.app').replace(/\/$/, '');
const EXPECTED_COMMIT = process.env.RC1_EXPECTED_COMMIT || 'd57f170';
const ALLOWLIST = '5218181877351';
const NON_ALLOWLIST = '5299912345678';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc1-final');

const FLAG_KEYS = [
  'RAG_P0_ENABLED',
  'RAG_INVENTORY_ENABLED',
  'RAG_RULES_ENABLED',
  'RAG_DOMAIN_ROUTING_ENABLED',
  'RAG_ADAPTIVE_THRESHOLD_ENABLED',
  'RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED',
  'RAG_RC11_TELEMETRY_ENABLED',
  'RAG_P0_ALLOWLIST',
  'RAG_DOMAIN_THRESHOLDS_JSON',
];

const THRESHOLDS_JSON =
  '{"properties":0.78,"commercial_objections":0.55,"assignment_rules":0.55,"rules_atena":0.45,"rules_perseo":0.45,"zones":0.45,"campaigns":0.45,"scripts":0.72}';

const SCENARIOS = [
  { id: 'INV-01', group: 'inventory', text: 'Info LUX-A0453' },
  { id: 'INV-02', group: 'inventory', text: 'Busco casa con jardín en Cumbres' },
  { id: 'INV-03', group: 'inventory', text: '¿Cuánto cuesta LUX-A0475?' },
  { id: 'COM-01', group: 'commercial', text: 'Me parece mucho la comisión que cobran' },
  { id: 'COM-02', group: 'commercial', text: 'No quiero firmar exclusiva' },
  { id: 'COM-03', group: 'commercial', text: 'Quiero vender mi casa en San Pedro' },
  { id: 'COM-04', group: 'commercial', text: '¿Cuánto vale mi casa?' },
  { id: 'NEG-01', group: 'negative', text: '¿Cuánto cuesta LUX-FAKE-999?', expect_fallback: true },
  { id: 'NEG-02', group: 'negative', text: 'precio inventado $1 peso castillo luna', expect_fallback: true },
  { id: 'NEG-03', group: 'negative', text: 'zona ColoniaInexistenteXYZ-999', expect_fallback: true, require_zone_mismatch: true },
  { id: 'NEG-C01', group: 'negative', text: 'campaña CampaniaInexistenteXYZ-999', expect_fallback: true },
  { id: 'LEG-01', group: 'legacy', text: 'Hola, regresión legacy', phone: NON_ALLOWLIST },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function railwayEnv(env) {
  return JSON.parse(
    execSync(`railway variable list -s luxetty-perseo -e ${env} --json`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  );
}

function railwayDeploy(env) {
  return JSON.parse(
    execSync(`railway deployment list -s luxetty-perseo -e ${env} --json`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  )[0] || {};
}

function gitHead() {
  return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: path.join(__dirname, '../..') }).trim();
}

function activateProdFlags() {
  execSync(
    `railway variable set RAG_P0_ENABLED=true RAG_INVENTORY_ENABLED=true RAG_RULES_ENABLED=true RAG_DOMAIN_ROUTING_ENABLED=true RAG_ADAPTIVE_THRESHOLD_ENABLED=true RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED=true RAG_RC11_TELEMETRY_ENABLED=true RAG_P0_ALLOWLIST=${ALLOWLIST} RAG_DOMAIN_THRESHOLDS_JSON='${THRESHOLDS_JSON}' -s luxetty-perseo -e production`,
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8' }
  );
}

function rollbackProdFlags() {
  for (const k of FLAG_KEYS) {
    try {
      execSync(`railway variable delete ${k} -s luxetty-perseo -e production`, {
        cwd: path.join(__dirname, '../..'),
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      /* ignore */
    }
  }
}

async function waitDeploy(commitPrefix, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const d = railwayDeploy('production');
    if (d.status === 'SUCCESS' && String(d.meta?.commitHash || '').startsWith(commitPrefix)) {
      return d;
    }
    await sleep(10000);
  }
  return railwayDeploy('production');
}

function simulateSelfCheck(vars, deploy) {
  const prev = { ...process.env };
  try {
    for (const k of FLAG_KEYS) {
      if (vars[k] != null) process.env[k] = vars[k];
    }
    for (const mod of [
      '../../config/accP0Flags',
      '../../conversation/v3/rag/ragDomainThresholdLoader',
      '../../conversation/v3/rag/ragRuntimeSelfCheck',
    ]) {
      delete require.cache[require.resolve(mod)];
    }
    const { isRagRc11ZoneEntityValidationEnabled, isRagRc11TelemetryEnabled } = require('../../config/accP0Flags');
    const { getThresholdAuditSnapshot } = require('../../conversation/v3/rag/ragDomainThresholdLoader');
    const { runRagRuntimeSelfCheck } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
    const check = runRagRuntimeSelfCheck();
    const thresholds = getThresholdAuditSnapshot();
    return {
      ...check,
      commit_runtime: deploy.meta?.commitHash?.slice(0, 7),
      rc11_zone_entity_validation: isRagRc11ZoneEntityValidationEnabled(),
      rc11_telemetry: isRagRc11TelemetryEnabled(),
      domain_count: thresholds.domain_count,
      pipeline_match: check.pass && check.domain_routing_active && check.adaptive_threshold_active,
      allowlist_only: vars.RAG_P0_ALLOWLIST === ALLOWLIST,
      canary_mode: true,
      pass:
        check.pass &&
        isRagRc11ZoneEntityValidationEnabled() &&
        isRagRc11TelemetryEnabled() &&
        vars.RAG_P0_ALLOWLIST === ALLOWLIST &&
        String(deploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT),
    };
  } finally {
    process.env = prev;
  }
}

async function probeSupabaseBaseline(db) {
  const [ke, pe, logs, cites, events] = await Promise.all([
    db.rpc('match_knowledge_chunks', {
      query_embedding: new Array(1536).fill(0.01),
      match_count: 1,
      min_score: 0.5,
      filter_is_active: true,
    }),
    db.rpc('match_property_chunks', {
      query_embedding: new Array(1536).fill(0.01),
      match_count: 1,
      min_score: 0.5,
      filter_is_active: true,
      filter_visibility_scope: null,
      filter_property_id: null,
    }),
    db.from('rag_query_logs').select('id', { count: 'exact', head: true }),
    db.from('retrieval_citations').select('id', { count: 'exact', head: true }),
    db.from('conversation_events').select('id', { count: 'exact', head: true }).eq('type', 'rag_retrieval'),
  ]);
  return {
    knowledge_rpc_ok: !ke.error,
    property_rpc_ok: !pe.error,
    rag_query_logs_baseline: logs.count ?? 0,
    retrieval_citations_baseline: cites.count ?? 0,
    rag_events_baseline: events.count ?? 0,
    pass: !ke.error && !pe.error,
  };
}

async function postInbound({ phone, text, wamid }) {
  const t0 = Date.now();
  const msg = textMessage(text, { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'RC1 Final Prod' });
  const res = await fetch(`${PROD_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return { ok: res.status === 200, status: res.status, latency_ms: Date.now() - t0, wamid };
}

function findEvents(events, wamid) {
  return events.filter((e) => {
    const p = e.payload || {};
    return p.message_id === wamid || String(p.message_id || '').includes(wamid);
  });
}

async function runSmoke(db) {
  const since = new Date().toISOString();
  const results = [];
  for (const sc of SCENARIOS) {
    const phone = sc.phone || ALLOWLIST;
    const wamid = `wamid.${RUN_ID}.${sc.id}.${Math.random().toString(36).slice(2, 8)}`;
    const http = await postInbound({ phone, text: sc.text, wamid });
    results.push({ ...sc, ...http, phone, wamid });
    await sleep(Number(process.env.RC1_WEBHOOK_DELAY_MS || 3500));
  }
  await sleep(12000);
  const { data: events } = await db
    .from('conversation_events')
    .select('id,type,payload,created_at')
    .eq('type', 'rag_retrieval')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  const ragEvents = events || [];
  const [leads, crm, assignments] = await Promise.all([
    db.from('leads').select('id').gte('created_at', since).limit(10),
    db.from('crm_outbox').select('id').gte('created_at', since).limit(10),
    db.from('assignments').select('id').gte('created_at', since).limit(10),
  ]);

  const timeline = [];
  for (const r of results) {
    const matched = findEvents(ragEvents, r.wamid);
    const p = matched[0]?.payload || {};
    r.events = matched;
    r.payload = p;
    r.had_rag_event = matched.length > 0;
    timeline.push({
      scenario_id: r.id,
      wamid: r.wamid,
      webhook_ok: r.ok,
      grounded: p.grounded,
      fallback_reason: p.fallback_reason,
      domain_selected: p.domain_selected,
      inventory_path: p.inventory_path,
      citation_count: p.citation_count,
      hallucination_blocked: p.hallucination_blocked,
      embedding_ms: p.embedding_ms,
      rpc_ms: p.rpc_ms,
      retrieval_latency_ms: p.retrieval_latency_ms,
    });
  }

  const neg03 = results.find((r) => r.id === 'NEG-03')?.payload || {};
  const negativeRuns = results.filter((r) => r.expect_fallback);
  const hallucinationCount = negativeRuns.filter(
    (r) => r.payload?.grounded === true && (r.payload?.citation_count ?? 0) > 0
  ).length;
  const legacyRag = results.filter((r) => r.phone === NON_ALLOWLIST).some((r) => r.had_rag_event);
  const payloads = ragEvents.map((e) => e.payload || {});
  const latencies = payloads.map((p) => Number(p.retrieval_latency_ms ?? 0)).filter((n) => n > 0).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.ceil(0.95 * latencies.length) - 1] : 0;

  const inventoryOk = results
    .filter((r) => r.group === 'inventory')
    .every((r) => r.had_rag_event && (r.payload?.inventory_path || r.payload?.pipeline));

  const commercialOk = results
    .filter((r) => r.group === 'commercial')
    .every((r) => r.had_rag_event && (r.payload?.citation_count ?? 0) > 0);

  const gates = {
    webhooks_12_12: results.every((r) => r.ok),
    neg03_grounded_false: neg03.grounded === false,
    neg03_zone_entity_mismatch: neg03.fallback_reason === 'zone_entity_mismatch',
    hallucination_zero: hallucinationCount === 0,
    wrong_domain_zero: payloads.filter((p) => p.wrong_domain_retrieval).length === 0,
    legacy_isolated: !legacyRag,
    crm_zero: (crm.data || []).length === 0,
    leads_zero: (leads.data || []).length === 0,
    assignments_zero: (assignments.data || []).length === 0,
    inventory_telemetry: inventoryOk,
    commercial_citations: commercialOk,
    retrieval_p95_ms: p95,
  };

  const pass = Object.entries(gates)
    .filter(([k]) => k !== 'retrieval_p95_ms')
    .every(([, v]) => v === true);

  return { since, results, timeline, gates, pass, hallucinationCount, neg03 };
}

function writeCheckpoint(hours) {
  const file = path.join(EVIDENCE_DIR, `RC1_FINAL_CHECKPOINT_${String(hours).padStart(2, '0')}H.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        status: 'pending_observation',
        hours,
        scheduled_review_at_hours: hours,
        note: 'Ventana 72h — revisión manual o harness programado',
      },
      null,
      2
    )
  );
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--')) || '--activate-and-smoke';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const prodDeployBefore = railwayDeploy('production');
  const prodVarsBefore = railwayEnv('production');
  const qaSmokePath = path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc11/RC11_QA_SMOKE_RC1.json');
  const qaSmoke = fs.existsSync(qaSmokePath) ? JSON.parse(fs.readFileSync(qaSmokePath, 'utf8')) : { pass: false };

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseBaseline = await probeSupabaseBaseline(db);

  const prodFlagsOff = FLAG_KEYS.every((k) => prodVarsBefore[k] == null);
  let thresholdsMatch = false;
  try {
    thresholdsMatch =
      JSON.stringify(JSON.parse(prodVarsBefore.RAG_DOMAIN_THRESHOLDS_JSON || '{}')) ===
      JSON.stringify(RQ4_CERTIFIED_THRESHOLDS);
  } catch {
    thresholdsMatch = false;
  }

  const preflight = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    git: {
      perseo_head: gitHead(),
      expected_commit: EXPECTED_COMMIT,
      atena_evidence_commit: 'e4eaed0',
      branch: 'fix/rag-rq47-quality-hardening',
    },
    production_before: {
      deployment_id: prodDeployBefore.id,
      commit: prodDeployBefore.meta?.commitHash?.slice(0, 7),
      status: prodDeployBefore.status,
      rag_flags_off: prodFlagsOff,
    },
    qa_rc11: { pass: qaSmoke.pass === true, reference: 'docs/argos/evidence/acc-rag-p0-rc11/RC11_QA_SMOKE_RC1.json' },
    supabase: supabaseBaseline,
    pass:
      String(prodDeployBefore.meta?.commitHash || '').startsWith(EXPECTED_COMMIT) &&
      prodDeployBefore.status === 'SUCCESS' &&
      prodFlagsOff &&
      qaSmoke.pass === true &&
      supabaseBaseline.pass,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_FINAL_PREFLIGHT.json'), JSON.stringify(preflight, null, 2));

  if (!preflight.pass) {
    console.error('RC1 FINAL preflight FAIL', preflight);
    process.exit(2);
  }
  if (mode === '--preflight-only') {
    console.log(JSON.stringify({ preflight }, null, 2));
    process.exit(0);
  }

  activateProdFlags();
  const flagsOn = {
    run_id: RUN_ID,
    activated_at: new Date().toISOString(),
    allowlist: ALLOWLIST,
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, k.includes('JSON') ? 'SET' : 'true'])),
    pass: true,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_FINAL_PROD_FLAGS_ON.json'), JSON.stringify(flagsOn, null, 2));

  const deploy = await waitDeploy(EXPECTED_COMMIT);
  const prodVars = railwayEnv('production');
  const selfCheck = simulateSelfCheck(prodVars, deploy);
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_FINAL_RUNTIME_SELFCHECK.json'), JSON.stringify({ run_id: RUN_ID, ...selfCheck }, null, 2));

  if (!selfCheck.pass) {
    rollbackProdFlags();
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'RC1_FINAL_ROLLBACK_EXECUTED.json'),
      JSON.stringify({ run_id: RUN_ID, reason: 'self_check_fail', at: new Date().toISOString() }, null, 2)
    );
    process.exit(3);
  }

  const smoke = await runSmoke(db);
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_FINAL_SMOKE_PROD.json'),
    JSON.stringify({ run_id: RUN_ID, environment: 'production', url: PROD_URL, deployment_id: deploy.id, ...smoke }, null, 2)
  );

  if (!smoke.pass) {
    rollbackProdFlags();
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'RC1_FINAL_ROLLBACK_EXECUTED.json'),
      JSON.stringify(
        {
          run_id: RUN_ID,
          reason: 'smoke_fail',
          gates: smoke.gates,
          hallucination_count: smoke.hallucinationCount,
          at: new Date().toISOString(),
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'RC1_FINAL_FAILURE_ANALYSIS.json'),
      JSON.stringify({ run_id: RUN_ID, failed_gates: Object.entries(smoke.gates).filter(([, v]) => v !== true) }, null, 2)
    );
    process.exit(4);
  }

  for (const h of [2, 6, 12, 24, 48, 72]) writeCheckpoint(h);

  const observationStart = new Date().toISOString();
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_FINAL_KPI_REPORT.json'),
    JSON.stringify({ run_id: RUN_ID, smoke_gates: smoke.gates, observation_started_at: observationStart, certified: false, pending_72h: true }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_FINAL_SECURITY_AUDIT.json'),
    JSON.stringify({ run_id: RUN_ID, legacy_isolated: smoke.gates.legacy_isolated, allowlist: ALLOWLIST, pass: smoke.gates.legacy_isolated }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_FINAL_PERFORMANCE.json'),
    JSON.stringify({ run_id: RUN_ID, p95_retrieval_ms: smoke.gates.retrieval_p95_ms }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_FINAL_ROLLBACK_READINESS.json'),
    JSON.stringify(
      {
        run_id: RUN_ID,
        rollback_procedure: 'railway variable delete (9 RAG keys) — no code change',
        flags_to_disable: FLAG_KEYS,
        ready: true,
        observation_status: 'running',
      },
      null,
      2
    )
  );

  const summary = `# RC-1 Final Executive Summary

**Run ID:** ${RUN_ID}
**Estado:** OBSERVACIÓN 72H INICIADA (smoke PASS)
**Smoke PASS:** SÍ
**Certificación final 72h:** PENDIENTE

## Smoke gates
${Object.entries(smoke.gates).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## NEG-03
- grounded: ${smoke.neg03.grounded}
- fallback_reason: ${smoke.neg03.fallback_reason}

**RC-1 FINAL NO CERTIFICADO — VENTANA 72H EN CURSO. NO RC-2 HASTA CHECKPOINT 72H.**
`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_FINAL_EXECUTIVE_SUMMARY.md'), summary);

  console.log(JSON.stringify({ run_id: RUN_ID, smoke_pass: true, observation: '72h_started', gates: smoke.gates }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try {
    rollbackProdFlags();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
