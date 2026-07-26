#!/usr/bin/env node
'use strict';

/**
 * RC-1.2 QA certification: activate QA flags + smoke RC-1 Final against QA.
 * Usage:
 *   node scripts/qa/rc12QaCertification.js --flags-only
 *   node scripts/qa/rc12QaCertification.js --smoke-only
 *   node scripts/qa/rc12QaCertification.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');
const { RQ4_CERTIFIED_THRESHOLDS } = require('../../conversation/v3/rag/ragDomainThresholdLoader');

const RUN_ID = `rc12-qa-${Date.now()}`;
const QA_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-perseo-qa.up.railway.app').replace(/\/$/, '');
const EXPECTED_COMMIT = process.env.RC12_EXPECTED_COMMIT || execSync('git rev-parse --short HEAD', {
  encoding: 'utf8',
  cwd: path.join(__dirname, '../..'),
}).trim();
const ALLOWLIST = '5218181877351';
const NON_ALLOWLIST = '5299912345678';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc12');

const QA_FLAG_KEYS = [
  'RAG_P0_ENABLED',
  'RAG_INVENTORY_ENABLED',
  'RAG_RULES_ENABLED',
  'RAG_DOMAIN_ROUTING_ENABLED',
  'RAG_ADAPTIVE_THRESHOLD_ENABLED',
  'RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED',
  'RAG_RC11_TELEMETRY_ENABLED',
  'RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED',
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
  { id: 'NEG-03', group: 'negative', text: 'zona ColoniaInexistenteXYZ-999', expect_fallback: true },
  { id: 'NEG-C01', group: 'negative', text: 'campaña CampaniaInexistenteXYZ-999', expect_fallback: true },
  { id: 'LEG-01', group: 'legacy', text: 'Hola, regresión legacy', phone: NON_ALLOWLIST },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function railwayEnv(name) {
  return JSON.parse(
    execSync(`railway variable list -s luxetty-perseo -e ${name} --json`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  );
}

function railwayDeploy(name) {
  return JSON.parse(
    execSync(`railway deployment list -s luxetty-perseo -e ${name} --json`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '../..'),
    })
  )[0] || {};
}

function activateQaFlags() {
  execSync(
    `railway variable set RAG_P0_ENABLED=true RAG_INVENTORY_ENABLED=true RAG_RULES_ENABLED=true RAG_DOMAIN_ROUTING_ENABLED=true RAG_ADAPTIVE_THRESHOLD_ENABLED=true RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED=true RAG_RC11_TELEMETRY_ENABLED=true RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED=true RAG_P0_ALLOWLIST=${ALLOWLIST} RAG_DOMAIN_THRESHOLDS_JSON='${THRESHOLDS_JSON}' -s luxetty-perseo -e qa`,
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8' }
  );
}

async function waitDeploy(commitPrefix, maxWaitMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const d = railwayDeploy('qa');
    if (d.status === 'SUCCESS' && String(d.meta?.commitHash || '').startsWith(commitPrefix)) {
      return d;
    }
    await sleep(10000);
  }
  return railwayDeploy('qa');
}

function simulateSelfCheck(vars, deploy) {
  const prev = { ...process.env };
  try {
    for (const k of QA_FLAG_KEYS) {
      if (vars[k] != null) process.env[k] = vars[k];
    }
    for (const mod of [
      '../../config/accP0Flags',
      '../../conversation/v3/rag/ragDomainThresholdLoader',
      '../../conversation/v3/rag/ragRuntimeSelfCheck',
    ]) {
      delete require.cache[require.resolve(mod)];
    }
    const {
      isRagRc11ZoneEntityValidationEnabled,
      isRagRc11TelemetryEnabled,
      isRagRc12CampaignEntityValidationEnabled,
    } = require('../../config/accP0Flags');
    const { runRagRuntimeSelfCheck } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
    const check = runRagRuntimeSelfCheck();
    return {
      ...check,
      commit_runtime: deploy?.meta?.commitHash?.slice(0, 7),
      rc11_zone_entity_validation: isRagRc11ZoneEntityValidationEnabled(),
      rc11_telemetry: isRagRc11TelemetryEnabled(),
      rc12_campaign_entity_validation: isRagRc12CampaignEntityValidationEnabled(),
      pass:
        check.pass &&
        isRagRc11ZoneEntityValidationEnabled() &&
        isRagRc11TelemetryEnabled() &&
        isRagRc12CampaignEntityValidationEnabled() &&
        vars.RAG_P0_ALLOWLIST === ALLOWLIST &&
        (!deploy || String(deploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT)),
    };
  } finally {
    process.env = prev;
  }
}

async function postInbound({ phone, text, wamid }) {
  const t0 = Date.now();
  const msg = textMessage(text, { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'RC12 QA Smoke' });
  const res = await fetch(`${QA_URL}/webhook`, {
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
    await sleep(Number(process.env.RC12_WEBHOOK_DELAY_MS || 3500));
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
    const domainEvent = matched.find((e) => e.payload?.pipeline === 'rq3_domain_routing') || matched[0];
    const p = domainEvent?.payload || {};
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
  const negC01 = results.find((r) => r.id === 'NEG-C01')?.payload || {};
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
    .every((r) => {
      const ev = findEvents(ragEvents, r.wamid).find((e) => e.payload?.pipeline === 'rq3_domain_routing');
      return ev && (ev.payload?.citation_count ?? 0) > 0;
    });

  const gates = {
    webhooks_12_12: results.every((r) => r.ok),
    neg03_grounded_false: neg03.grounded === false,
    neg03_zone_entity_mismatch: neg03.fallback_reason === 'zone_entity_mismatch',
    negc01_grounded_false: negC01.grounded === false,
    negc01_campaign_entity_mismatch: negC01.fallback_reason === 'campaign_entity_mismatch',
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

  return { since, results, timeline, gates, pass, hallucinationCount, neg03, negC01 };
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--')) || '--full';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  if (mode !== '--smoke-only') {
    activateQaFlags();
    await sleep(5000);
  }

  const qaDeploy = await waitDeploy(EXPECTED_COMMIT);
  const qaVars = railwayEnv('qa');
  const prodVars = railwayEnv('production');

  const deployEvidence = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    environment: 'qa',
    deployment_id: qaDeploy.id,
    status: qaDeploy.status,
    commit: qaDeploy.meta?.commitHash?.slice(0, 7),
    expected_commit: EXPECTED_COMMIT,
    url: QA_URL,
    pass: qaDeploy.status === 'SUCCESS' && String(qaDeploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC12_QA_DEPLOY.json'), JSON.stringify(deployEvidence, null, 2));

  const productionRag = Object.fromEntries(
    QA_FLAG_KEYS.map((k) => [k, prodVars[k] != null ? prodVars[k] : 'NOT_SET'])
  );

  const flagsEvidence = {
    run_id: RUN_ID,
    qa: Object.fromEntries(QA_FLAG_KEYS.map((k) => [k, qaVars[k] != null ? (k.includes('JSON') ? 'SET' : qaVars[k]) : 'NOT_SET'])),
    production_rag: productionRag,
    production_off: Object.values(productionRag).every((v) => v === 'NOT_SET'),
    pass:
      qaVars.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED === 'true' &&
      qaVars.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED === 'true' &&
      Object.values(productionRag).every((v) => v === 'NOT_SET'),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC12_QA_FLAGS.json'), JSON.stringify(flagsEvidence, null, 2));

  const selfCheck = simulateSelfCheck(qaVars, qaDeploy);
  if (!deployEvidence.pass || !flagsEvidence.pass || !selfCheck.pass) {
    console.error('RC12 QA preflight FAIL', { deployEvidence, flagsEvidence, selfCheck });
    process.exit(2);
  }

  if (mode === '--flags-only') {
    console.log(JSON.stringify({ deployEvidence, flagsEvidence, selfCheck }, null, 2));
    process.exit(0);
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const smoke = await runSmoke(db);
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC12_QA_SMOKE_RC1_FINAL.json'),
    JSON.stringify({ run_id: RUN_ID, environment: 'qa', url: QA_URL, deployment_id: qaDeploy.id, ...smoke }, null, 2)
  );

  const fixReport = {
    run_id: RUN_ID,
    fix: 'campaign_entity_validation',
    flag: 'RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED',
    fallback_reason: 'campaign_entity_mismatch',
    files: [
      'conversation/v3/rag/campaignEntityValidation.js',
      'conversation/v3/rag/domainRetrievalOrchestrator.js',
      'conversation/v3/rag/ragTurnOrchestrator.js',
      'config/accP0Flags.js',
    ],
    negc01_result: {
      grounded: smoke.negC01.grounded,
      fallback_reason: smoke.negC01.fallback_reason,
      hallucination_blocked: smoke.negC01.hallucination_blocked,
      citation_count: smoke.negC01.citation_count,
    },
    pass: smoke.gates.negc01_campaign_entity_mismatch && smoke.gates.hallucination_zero,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC12_FIX_REPORT.json'), JSON.stringify(fixReport, null, 2));

  const summary = `# RC-1.2 Executive Summary

**Run ID:** ${RUN_ID}
**QA PASS:** ${smoke.pass ? 'SÍ' : 'NO'}
**Producción tocada:** NO

## NEG-C01
- grounded: ${smoke.negC01.grounded}
- fallback_reason: ${smoke.negC01.fallback_reason}
- hallucination_blocked: ${smoke.negC01.hallucination_blocked}

## NEG-03
- grounded: ${smoke.neg03.grounded}
- fallback_reason: ${smoke.neg03.fallback_reason}

## Gates
${Object.entries(smoke.gates).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

${smoke.pass ? '**RC-1.2 QA CERTIFICADO — LISTO PARA REPROPONER RC-1 FINAL EN PRODUCCIÓN.**' : '**RC-1.2 QA NO CERTIFICADO — NO AVANZAR.**'}
`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC12_EXECUTIVE_SUMMARY.md'), summary);

  console.log(JSON.stringify({ run_id: RUN_ID, pass: smoke.pass, gates: smoke.gates }, null, 2));
  process.exit(smoke.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
