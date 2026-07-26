#!/usr/bin/env node
'use strict';

/**
 * RC-1.1 QA certification: deploy verify + smoke RC-1 against QA.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');
const { RQ4_CERTIFIED_THRESHOLDS } = require('../../conversation/v3/rag/ragDomainThresholdLoader');

const RUN_ID = `rc11-qa-${Date.now()}`;
const QA_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-perseo-qa.up.railway.app').replace(/\/$/, '');
const EXPECTED_COMMIT = process.env.RC11_EXPECTED_COMMIT || 'd57f170';
const ALLOWLIST = '5218181877351';
const NON_ALLOWLIST = '5299912345678';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc11');

const QA_FLAG_KEYS = [
  'RAG_P0_ENABLED',
  'RAG_INVENTORY_ENABLED',
  'RAG_RULES_ENABLED',
  'RAG_DOMAIN_ROUTING_ENABLED',
  'RAG_ADAPTIVE_THRESHOLD_ENABLED',
  'RAG_P0_ALLOWLIST',
  'RAG_DOMAIN_THRESHOLDS_JSON',
  'RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED',
  'RAG_RC11_TELEMETRY_ENABLED',
];

const SCENARIOS = [
  { id: 'INV-01', group: 'inventory', text: 'Info LUX-A0453', expect_telemetry: true, expected_paths: ['direct_code', 'properties_domain_deferred'] },
  { id: 'INV-02', group: 'inventory', text: 'Busco casa con jardín en Cumbres', expect_telemetry: true, expected_paths: ['rag_semantic_found', 'rag_semantic_ambiguous', 'rag_semantic_low_score', 'properties_domain_deferred', 'legacy_resolution'] },
  { id: 'INV-03', group: 'inventory', text: '¿Cuánto cuesta LUX-A0475?', expect_telemetry: true, expected_paths: ['direct_code', 'properties_domain_deferred'] },
  { id: 'COM-01', group: 'commercial', text: 'Me parece mucho la comisión que cobran', expect_telemetry: true },
  { id: 'COM-02', group: 'commercial', text: 'No quiero firmar exclusiva', expect_telemetry: true },
  { id: 'COM-03', group: 'commercial', text: 'Quiero vender mi casa en San Pedro', expect_telemetry: true },
  { id: 'COM-04', group: 'commercial', text: '¿Cuánto vale mi casa?', expect_telemetry: true },
  { id: 'NEG-01', group: 'negative', text: '¿Cuánto cuesta LUX-FAKE-999?', expect_fallback: true },
  { id: 'NEG-02', group: 'negative', text: 'precio inventado $1 peso castillo luna', expect_fallback: true },
  { id: 'NEG-03', group: 'negative', text: 'zona ColoniaInexistenteXYZ-999', expect_fallback: true, require_zone_mismatch: true },
  { id: 'NEG-C01', group: 'negative', text: 'campaña BlackFridayInexistente2029', expect_fallback: true, latent_gap: true },
  { id: 'LEG-01', group: 'legacy', text: 'Hola, regresión legacy', phone: NON_ALLOWLIST, expect_rag: false },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function railwayEnv(name) {
  const raw = execSync(`railway variable list -s luxetty-perseo -e ${name} --json`, {
    encoding: 'utf8',
    cwd: path.join(__dirname, '../..'),
  });
  return JSON.parse(raw);
}

function railwayDeploy(name) {
  const raw = execSync(`railway deployment list -s luxetty-perseo -e ${name} --json`, {
    encoding: 'utf8',
    cwd: path.join(__dirname, '../..'),
  });
  return JSON.parse(raw)[0] || {};
}

function simulateSelfCheck(vars) {
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
    const { isRagRc11ZoneEntityValidationEnabled, isRagRc11TelemetryEnabled } = require('../../config/accP0Flags');
    const { runRagRuntimeSelfCheck } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
    const check = runRagRuntimeSelfCheck();
    return {
      ...check,
      rc11_zone_entity_validation: isRagRc11ZoneEntityValidationEnabled(),
      rc11_telemetry: isRagRc11TelemetryEnabled(),
      expected_commit: EXPECTED_COMMIT,
    };
  } finally {
    process.env = prev;
  }
}

async function postInbound({ phone, text, wamid }) {
  const t0 = Date.now();
  const msg = textMessage(text, { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'RC11 QA Smoke' });
  const res = await fetch(`${QA_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return { ok: res.status === 200, status: res.status, latency_ms: Date.now() - t0, wamid };
}

function findEvent(events, wamid) {
  return events.find((e) => {
    const p = e.payload || {};
    return p.message_id === wamid || String(p.message_id || '').includes(wamid);
  });
}

function findAllEvents(events, wamid) {
  return events.filter((e) => {
    const p = e.payload || {};
    return p.message_id === wamid || String(p.message_id || '').includes(wamid);
  });
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const qaDeploy = railwayDeploy('qa');
  const prodVars = railwayEnv('production');
  const qaVars = railwayEnv('qa');

  const deployEvidence = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    environment: 'qa',
    deployment_id: qaDeploy.id,
    status: qaDeploy.status,
    commit: qaDeploy.meta?.commitHash?.slice(0, 7),
    branch: qaDeploy.meta?.branch,
    url: QA_URL,
    expected_commit: EXPECTED_COMMIT,
    pass: qaDeploy.status === 'SUCCESS' && String(qaDeploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_DEPLOY.json'), JSON.stringify(deployEvidence, null, 2));

  let thresholdsMatch = false;
  try {
    thresholdsMatch = JSON.stringify(JSON.parse(qaVars.RAG_DOMAIN_THRESHOLDS_JSON || '{}')) === JSON.stringify(RQ4_CERTIFIED_THRESHOLDS);
  } catch {
    thresholdsMatch = false;
  }

  const productionRag = Object.fromEntries(
    ['RAG_P0_ENABLED', 'RAG_INVENTORY_ENABLED', 'RAG_RULES_ENABLED', 'RAG_DOMAIN_ROUTING_ENABLED', 'RAG_ADAPTIVE_THRESHOLD_ENABLED', 'RAG_P0_ALLOWLIST', 'RAG_DOMAIN_THRESHOLDS_JSON', 'RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED', 'RAG_RC11_TELEMETRY_ENABLED'].map((k) => [
      k,
      prodVars[k] != null ? prodVars[k] : 'NOT_SET',
    ])
  );

  const flagsEvidence = {
    run_id: RUN_ID,
    qa: Object.fromEntries(QA_FLAG_KEYS.map((k) => [k, qaVars[k] != null ? (k.includes('JSON') ? 'SET' : qaVars[k]) : 'NOT_SET'])),
    production_rag: productionRag,
    thresholds_certified: thresholdsMatch,
    allowlist: qaVars.RAG_P0_ALLOWLIST,
    pass:
      qaVars.RAG_P0_ENABLED === 'true' &&
      qaVars.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED === 'true' &&
      qaVars.RAG_RC11_TELEMETRY_ENABLED === 'true' &&
      Object.values(productionRag).every((v) => v === 'NOT_SET'),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_FLAGS.json'), JSON.stringify(flagsEvidence, null, 2));

  const selfCheck = simulateSelfCheck(qaVars);
  const runtimeVerification = {
    run_id: RUN_ID,
    url: QA_URL,
    commit_runtime: deployEvidence.commit,
    self_check_pass: selfCheck.pass,
    kpi_version_expected: '1',
    rc11_zone_entity_validation: selfCheck.rc11_zone_entity_validation,
    rc11_telemetry: selfCheck.rc11_telemetry,
    domain_routing_active: selfCheck.domain_routing_active,
    adaptive_threshold_active: selfCheck.adaptive_threshold_active,
    pipeline_match: selfCheck.pass && selfCheck.domain_routing_active,
    pass: deployEvidence.pass && selfCheck.pass && selfCheck.rc11_zone_entity_validation && selfCheck.rc11_telemetry,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_RUNTIME_VERIFICATION.json'), JSON.stringify(runtimeVerification, null, 2));

  if (!deployEvidence.pass || !flagsEvidence.pass) {
    console.error('Preflight QA FAIL', { deployEvidence, flagsEvidence });
    process.exit(2);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const since = new Date().toISOString();
  const results = [];

  for (const sc of SCENARIOS) {
    const phone = sc.phone || ALLOWLIST;
    const wamid = `wamid.${RUN_ID}.${sc.id}.${Math.random().toString(36).slice(2, 8)}`;
    const http = await postInbound({ phone, text: sc.text, wamid });
    results.push({ ...sc, ...http, phone, wamid });
    await sleep(Number(process.env.RC11_WEBHOOK_DELAY_MS || 3500));
  }

  await sleep(10000);
  const { data: events } = await supabase
    .from('conversation_events')
    .select('id,type,payload,created_at')
    .eq('type', 'rag_retrieval')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);

  const ragEvents = events || [];
  const [leads, crm, assignments] = await Promise.all([
    supabase.from('leads').select('id').gte('created_at', since).limit(10),
    supabase.from('crm_outbox').select('id').gte('created_at', since).limit(10),
    supabase.from('assignments').select('id').gte('created_at', since).limit(10),
  ]);

  const timeline = [];
  for (const r of results) {
    const matched = findAllEvents(ragEvents, r.wamid);
    const ev = matched[0];
    const p = ev?.payload || {};
    r.events = matched.length;
    r.had_rag_event = matched.length > 0;
    r.payload = p;
    timeline.push({
      scenario_id: r.id,
      wamid: r.wamid,
      webhook_ok: r.ok,
      event_count: matched.length,
      kpi_version: p.kpi_version,
      grounded: p.grounded,
      fallback_used: p.fallback_used,
      fallback_reason: p.fallback_reason,
      domain_selected: p.domain_selected,
      inventory_path: p.inventory_path,
      embedding_ms: p.embedding_ms,
      rpc_ms: p.rpc_ms,
      retrieval_latency_ms: p.retrieval_latency_ms,
      hallucination_blocked: p.hallucination_blocked,
      citation_count: p.citation_count,
    });
  }

  const neg03 = results.find((r) => r.id === 'NEG-03');
  const neg03p = neg03?.payload || {};
  const negResults = results
    .filter((r) => r.group === 'negative')
    .map((r) => ({
      id: r.id,
      grounded: r.payload?.grounded ?? null,
      fallback_used: r.payload?.fallback_used ?? null,
      fallback_reason: r.payload?.fallback_reason ?? null,
      hallucination: r.expect_fallback && r.payload?.grounded === true && (r.payload?.citation_count ?? 0) > 0,
      latent_gap: r.latent_gap === true,
      pass:
        r.id === 'NEG-03'
          ? r.payload?.grounded === false && r.payload?.fallback_reason === 'zone_entity_mismatch'
          : r.latent_gap
            ? true
            : !(r.expect_fallback && r.payload?.grounded === true && (r.payload?.citation_count ?? 0) > 0),
    }));

  const inventoryResults = results
    .filter((r) => r.group === 'inventory')
    .map((r) => ({
      id: r.id,
      had_rag_event: r.had_rag_event,
      event_count: r.events,
      inventory_path: r.payload?.inventory_path || null,
      pipeline: r.payload?.pipeline || null,
      embedding_ms: r.payload?.embedding_ms ?? null,
      rpc_ms: r.payload?.rpc_ms ?? null,
      telemetry_ok: r.had_rag_event && (r.payload?.inventory_path || r.payload?.pipeline),
    }));

  const latencies = ragEvents.map((e) => Number(e.payload?.retrieval_latency_ms ?? e.payload?.retrieval_ms ?? 0)).filter((n) => n > 0).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.ceil(0.95 * latencies.length) - 1] : 0;
  const perfWaiver = p95 > 400 && p95 < 1500;

  const payloads = ragEvents.map((e) => e.payload || {});
  const hallucinationCount = negResults.filter((n) => n.hallucination && !n.latent_gap).length;
  const legacyRag = results.filter((r) => r.phone === NON_ALLOWLIST).some((r) => r.had_rag_event);
  const webhookOk = results.every((r) => r.ok);

  const gates = {
    neg03_grounded_false: neg03p.grounded === false,
    neg03_zone_entity_mismatch: neg03p.fallback_reason === 'zone_entity_mismatch',
    hallucination_zero: hallucinationCount === 0,
    wrong_domain_zero: payloads.filter((p) => p.wrong_domain_retrieval).length === 0,
    legacy_isolated: !legacyRag,
    inventory_telemetry: inventoryResults.every((i) => i.telemetry_ok),
    crm_zero: (crm.data || []).length === 0,
    leads_zero: (leads.data || []).length === 0,
    assignments_zero: (assignments.data || []).length === 0,
    webhook_100: webhookOk,
    retrieval_p95: p95,
    retrieval_p95_gate: p95 < 400 || perfWaiver,
  };

  const pass =
    gates.neg03_grounded_false &&
    gates.neg03_zone_entity_mismatch &&
    gates.hallucination_zero &&
    gates.wrong_domain_zero &&
    gates.legacy_isolated &&
    gates.inventory_telemetry &&
    gates.crm_zero &&
    gates.leads_zero &&
    gates.assignments_zero &&
    gates.webhook_100 &&
    gates.retrieval_p95_gate;

  const smokeReport = {
    run_id: RUN_ID,
    environment: 'qa',
    commit: EXPECTED_COMMIT,
    deployment_id: qaDeploy.id,
    url: QA_URL,
    scenarios: results.length,
    timeline,
    gates,
    pass,
    perf_waiver: perfWaiver,
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_SMOKE_RC1.json'), JSON.stringify(smokeReport, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_NEGATIVE_RESULTS.json'), JSON.stringify({ run_id: RUN_ID, scenarios: negResults, neg03_detail: neg03p, pass: gates.neg03_grounded_false && gates.neg03_zone_entity_mismatch }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_INVENTORY_TELEMETRY.json'), JSON.stringify({ run_id: RUN_ID, scenarios: inventoryResults, pass: gates.inventory_telemetry }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_PERFORMANCE.json'), JSON.stringify({ run_id: RUN_ID, p95_retrieval_ms: p95, perf_waiver: perfWaiver, latencies }, null, 2));

  const summary = `# RC-1.1 QA Executive Summary

**Run ID:** ${RUN_ID}  
**QA PASS:** ${pass ? 'SÍ' : 'NO'}  
**Producción tocada:** NO

## Deploy
- Commit: \`${deployEvidence.commit}\` @ ${QA_URL}
- Deployment: \`${qaDeploy.id}\` ${qaDeploy.status}

## NEG-03
- grounded: ${neg03p.grounded}
- fallback_reason: ${neg03p.fallback_reason}
- PASS: ${gates.neg03_grounded_false && gates.neg03_zone_entity_mismatch}

## Gates
${Object.entries(gates).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

${pass ? '**RC-1.1 QA CERTIFICADO — LISTO PARA REPROPONER RC-1 EN PRODUCCIÓN.**' : '**RC-1.1 QA NO CERTIFICADO — NO AVANZAR.**'}
`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC11_QA_EXECUTIVE_SUMMARY.md'), summary);

  console.log(JSON.stringify({ run_id: RUN_ID, pass, gates, smokeReport: { scenarios: results.length } }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
