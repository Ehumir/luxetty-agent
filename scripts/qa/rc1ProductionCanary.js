#!/usr/bin/env node
'use strict';

/**
 * RC-1 — Production controlled canary (allowlist only).
 * Usage:
 *   PERSEO_BASE_URL=https://luxetty-agent-production.up.railway.app \
 *   EVIDENCE_DIR=../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc1 \
 *   node scripts/qa/rc1ProductionCanary.js [--preflight-only|--smoke-only|--day=1]
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');
const { runRagRuntimeSelfCheck } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
const { RQ4_CERTIFIED_THRESHOLDS } = require('../../conversation/v3/rag/ragDomainThresholdLoader');

const BASE_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-agent-production.up.railway.app').replace(/\/$/, '');
const ALLOWLIST = String(process.env.RAG_P0_ALLOWLIST || '5218181877351').replace(/\D/g, '');
const NON_ALLOWLIST = String(process.env.RC1_NON_ALLOWLIST || '5299912345678').replace(/\D/g, '');
const RUN_ID = `rc1-${Date.now()}`;
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rc1');
const EXPECTED_COMMIT = process.env.RC1_EXPECTED_COMMIT || '913b421';
const DEPLOY_ID = process.env.RC1_DEPLOYMENT_ID || null;

const RAG_FLAG_KEYS = [
  'RAG_P0_ENABLED',
  'RAG_INVENTORY_ENABLED',
  'RAG_RULES_ENABLED',
  'RAG_DOMAIN_ROUTING_ENABLED',
  'RAG_ADAPTIVE_THRESHOLD_ENABLED',
  'RAG_P0_ALLOWLIST',
  'RAG_DOMAIN_THRESHOLDS_JSON',
];

const SMOKE_SCENARIOS = [
  { id: 'INV-01', group: 'inventory', text: 'Info LUX-A0453', expect_rag: true },
  { id: 'INV-02', group: 'inventory', text: 'Busco casa con jardín en Cumbres', expect_rag: true },
  { id: 'INV-03', group: 'inventory', text: '¿Cuánto cuesta LUX-A0475?', expect_rag: true },
  { id: 'COM-01', group: 'commercial', text: 'Me parece mucho la comisión que cobran', expect_rag: true },
  { id: 'COM-02', group: 'commercial', text: 'No quiero firmar exclusiva', expect_rag: true },
  { id: 'COM-03', group: 'commercial', text: 'Quiero vender mi casa en San Pedro', expect_rag: true },
  { id: 'COM-04', group: 'commercial', text: '¿Cuánto vale mi casa?', expect_rag: true },
  { id: 'NEG-01', group: 'negative', text: '¿Cuánto cuesta LUX-FAKE-999?', expect_rag: true, expect_fallback: true },
  { id: 'NEG-02', group: 'negative', text: 'precio inventado $1 peso castillo luna', expect_rag: true, expect_fallback: true },
  { id: 'NEG-03', group: 'negative', text: 'zona ColoniaInexistenteXYZ-999', expect_rag: true, expect_fallback: true },
  { id: 'LEG-01', group: 'legacy', text: 'Hola, regresión legacy', phone: NON_ALLOWLIST, expect_rag: false },
];

const KPI_GATES = {
  grounded_min: 0.95,
  citation_min: 0.95,
  hallucination_max: 0,
  wrong_domain_max: 0,
  fallback_correct_min: 0.99,
  routing_min: 0.99,
  retrieval_p95_max: 400,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function railwayProdVars() {
  const raw = execSync('railway variable list -s luxetty-perseo -e production --json', {
    encoding: 'utf8',
    cwd: path.join(__dirname, '../..'),
  });
  return JSON.parse(raw);
}

function railwayProdDeploy() {
  const raw = execSync('railway deployment list -s luxetty-perseo -e production --json', {
    encoding: 'utf8',
    cwd: path.join(__dirname, '../..'),
  });
  const list = JSON.parse(raw);
  return list[0] || {};
}

function simulateSelfCheckFromEnv(vars) {
  const prev = { ...process.env };
  try {
    for (const k of RAG_FLAG_KEYS) {
      if (vars[k] != null) process.env[k] = vars[k];
    }
    for (const mod of [
      '../../config/accP0Flags',
      '../../conversation/v3/rag/ragDomainThresholdLoader',
      '../../conversation/v3/rag/ragRuntimeSelfCheck',
    ]) {
      delete require.cache[require.resolve(mod)];
    }
    const { runRagRuntimeSelfCheck: check } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
    return { ...check(), note: 'Simulated with production Railway env snapshot' };
  } finally {
    process.env = prev;
  }
}

async function supabaseKnowledgeProbe() {
  const ragService = require('../../services/ragService');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const knowledge = await ragService.semanticSearch(db, {
    query: 'objeción comisión inmobiliaria',
    rpcName: 'match_knowledge_chunks',
    rpcParams: { match_count: 3, min_score: 0.45, filter_is_active: true },
  });
  const properties = await ragService.semanticSearch(db, {
    query: 'LUX-A0453 propiedad',
    rpcName: 'match_property_chunks',
    rpcParams: { match_count: 3, min_score: 0.5, filter_is_active: true, filter_visibility_scope: null, filter_property_id: null },
  });
  return {
    knowledge_rpc_ok: !knowledge.fallback || (knowledge.chunks?.length ?? 0) > 0,
    knowledge_chunks: knowledge.chunks?.length ?? 0,
    property_rpc_ok: !properties.fallback || (properties.chunks?.length ?? 0) > 0,
    property_chunks: properties.chunks?.length ?? 0,
    pass: (knowledge.chunks?.length ?? 0) > 0 || (properties.chunks?.length ?? 0) > 0,
  };
}

function buildPreflight(prodVars, deploy) {
  const ragBefore = RAG_FLAG_KEYS.every((k) => !prodVars[k] || String(prodVars[k]).toLowerCase() === 'false');
  let thresholdsMatch = false;
  try {
    const parsed = JSON.parse(prodVars.RAG_DOMAIN_THRESHOLDS_JSON || '{}');
    thresholdsMatch = JSON.stringify(parsed) === JSON.stringify(RQ4_CERTIFIED_THRESHOLDS);
  } catch {
    thresholdsMatch = false;
  }

  return {
    generated_at: new Date().toISOString(),
    phase: 'RC-1',
    run_id: RUN_ID,
    git: {
      expected_commit: EXPECTED_COMMIT,
      branch: 'fix/rag-rq47-quality-hardening',
      rq47_certified: true,
    },
    railway_production: {
      deployment_id: deploy.id || DEPLOY_ID,
      status: deploy.status,
      commit: deploy.meta?.commitHash?.slice(0, 7),
      branch: deploy.meta?.branch,
      url: BASE_URL,
    },
    flags_production: Object.fromEntries(
      RAG_FLAG_KEYS.map((k) => [k, prodVars[k] != null ? (k === 'RAG_DOMAIN_THRESHOLDS_JSON' ? 'SET' : prodVars[k]) : 'NOT_SET'])
    ),
    allowlist_only: prodVars.RAG_P0_ALLOWLIST === ALLOWLIST,
    thresholds_certified: thresholdsMatch,
    rq47_reference: 'docs/argos/evidence/acc-rag-p0-rq47/RQ47_FINAL_CERTIFICATION.json',
    pass:
      String(deploy.meta?.commitHash || '').startsWith(EXPECTED_COMMIT) &&
      prodVars.RAG_P0_ENABLED === 'true' &&
      prodVars.RAG_P0_ALLOWLIST === ALLOWLIST &&
      thresholdsMatch,
  };
}

async function postInbound({ phone, text, wamid }) {
  const t0 = Date.now();
  const msg = textMessage(text, { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'RC1 Prod Canary' });
  const res = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return { ok: res.status === 200, status: res.status, latency_ms: Date.now() - t0, wamid };
}

async function fetchWindow(supabase, since) {
  const [events, logs, citations, leads, crm, assignments] = await Promise.all([
    supabase.from('conversation_events').select('id,type,payload,created_at').eq('type', 'rag_retrieval').gte('created_at', since).order('created_at', { ascending: false }).limit(500),
    supabase.from('rag_query_logs').select('id,fallback_used,result_count,latency_ms,created_at,filters').gte('created_at', since).order('created_at', { ascending: false }).limit(500),
    supabase.from('retrieval_citations').select('id,chunk_id,score,rank,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(500),
    supabase.from('leads').select('id,created_at,source').gte('created_at', since).limit(20),
    supabase.from('crm_outbox').select('id,created_at').gte('created_at', since).limit(20),
    supabase.from('assignments').select('id,created_at').gte('created_at', since).limit(20),
  ]);
  return {
    events: events.data || [],
    logs: logs.data || [],
    citations: citations.data || [],
    leads: leads.data || [],
    crm: crm.data || [],
    assignments: assignments.data || [],
  };
}

function analyzeSmoke(events, results, window) {
  const payloads = events.map((e) => e.payload || {});
  const grounded = payloads.filter((p) => p.grounded === true).length;
  const withCitations = payloads.filter((p) => Number(p.citation_count ?? 0) > 0).length;
  const fallback = payloads.filter((p) => p.fallback_used === true).length;
  const wrongDomain = payloads.filter((p) => p.wrong_domain_retrieval === true).length;
  const latencies = payloads.map((p) => Number(p.retrieval_latency_ms ?? 0)).filter((n) => n > 0);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p95 = sortedLat.length ? sortedLat[Math.ceil(0.95 * sortedLat.length) - 1] : 0;

  const negativeRuns = results.filter((r) => SMOKE_SCENARIOS.find((s) => s.id === r.id)?.expect_fallback);
  const hallucinationUnsafe = negativeRuns.filter((r) => {
    const ev = events.find((e) => (e.payload?.message_id || '').includes(r.wamid));
    return ev?.payload?.grounded === true && Number(ev?.payload?.citation_count ?? 0) > 0;
  }).length;

  const legacyRuns = results.filter((r) => r.phone === NON_ALLOWLIST);
  const legacyRag = legacyRuns.some((r) => r.had_rag_event);

  const kpis = {
    grounded_response_rate: payloads.length ? grounded / payloads.length : 0,
    citation_coverage: payloads.length ? withCitations / payloads.length : 0,
    hallucination_rate: negativeRuns.length ? hallucinationUnsafe / negativeRuns.length : 0,
    wrong_domain_retrieval: wrongDomain,
    fallback_correct_rate: fallback
      ? payloads.filter((p) => p.fallback_used && Number(p.citation_count ?? 0) === 0).length / fallback
      : 1,
    routing_accuracy: payloads.length ? payloads.filter((p) => p.domain_selected).length / payloads.length : 0,
    p95_retrieval_latency_ms: p95,
    sample_rag_events: payloads.length,
    legacy_isolated: !legacyRag,
    new_leads: window.leads.length,
    crm_outbox: window.crm.length,
    new_assignments: window.assignments.length,
  };

  const rollback_triggers = [];
  if (kpis.hallucination_rate > KPI_GATES.hallucination_max) rollback_triggers.push('hallucination');
  if (kpis.wrong_domain_retrieval > KPI_GATES.wrong_domain_max) rollback_triggers.push('wrong_domain');
  if (!kpis.legacy_isolated) rollback_triggers.push('rag_outside_allowlist');
  if (window.leads.length > 0) rollback_triggers.push('unexpected_lead');
  if (window.crm.length > 0) rollback_triggers.push('unexpected_crm');
  if (window.assignments.length > 0) rollback_triggers.push('unexpected_assignment');

  const pass =
    rollback_triggers.length === 0 &&
    kpis.grounded_response_rate >= KPI_GATES.grounded_min &&
    kpis.citation_coverage >= KPI_GATES.citation_min &&
    kpis.legacy_isolated;

  return { kpis, pass, rollback_triggers };
}

function buildTimeline(results, events) {
  return results.map((r) => {
    const ev = events.find((e) => (e.payload?.message_id || '').includes(r.wamid));
    const p = ev?.payload || {};
    return {
      scenario_id: r.id,
      group: r.group,
      phone: r.phone,
      wamid: r.wamid,
      started_at: r.since,
      webhook_ok: r.ok,
      e2e_latency_ms: r.latency_ms,
      had_rag_event: r.had_rag_event,
      retrieval: p.grounded != null ? {
        grounded: p.grounded,
        fallback_used: p.fallback_used,
        domain_selected: p.domain_selected,
        citation_count: p.citation_count,
        confidence: p.confidence,
        retrieval_latency_ms: p.retrieval_latency_ms,
        min_score_threshold: p.min_score_threshold,
      } : null,
    };
  });
}

async function runSmoke(supabase) {
  const since = new Date().toISOString();
  const results = [];

  for (const sc of SMOKE_SCENARIOS) {
    const phone = sc.phone || ALLOWLIST;
    const wamid = `wamid.${RUN_ID}.${sc.id}.${Math.random().toString(36).slice(2, 8)}`;
    const http = await postInbound({ phone, text: sc.text, wamid });
    results.push({ ...sc, ...http, phone, wamid, since });
    await sleep(Number(process.env.RC1_WEBHOOK_DELAY_MS || 3000));
  }

  await sleep(8000);
  const window = await fetchWindow(supabase, since);

  for (const r of results) {
    r.had_rag_event = window.events.some((e) => {
      const p = e.payload || {};
      return p.message_id === r.wamid || String(p.message_id || '').includes(r.wamid);
    });
    r.had_rag_log = window.logs.some((l) => (l.filters || {}).message_id === r.wamid);
  }

  const analysis = analyzeSmoke(window.events, results, window);
  const timeline = buildTimeline(results, window.events);

  return { since, results, window, analysis, timeline };
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--')) || '--full';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const prodVars = railwayProdVars();
  const deploy = railwayProdDeploy();
  const preflight = buildPreflight(prodVars, deploy);
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_PREFLIGHT.json'), JSON.stringify(preflight, null, 2));

  if (!preflight.pass && mode !== '--preflight-only') {
    console.error('RC1 preflight FAIL', preflight);
    process.exit(2);
  }

  const selfCheck = simulateSelfCheckFromEnv(prodVars);
  selfCheck.phase = 'RC-1';
  selfCheck.pipeline_match = selfCheck.pass && selfCheck.domain_routing_active && selfCheck.adaptive_threshold_active;
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_RUNTIME_SELFCHECK.json'), JSON.stringify(selfCheck, null, 2));

  let knowledge = { pass: false, skipped: true };
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    process.env.RAG_P0_ENABLED = 'true';
    knowledge = await supabaseKnowledgeProbe();
  }

  if (mode === '--preflight-only') {
    console.log(JSON.stringify({ preflight, selfCheck, knowledge }, null, 2));
    process.exit(preflight.pass && selfCheck.pass ? 0 : 1);
  }

  if (!selfCheck.pass) {
    console.error('RC1 self-check FAIL');
    process.exit(2);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const smoke = await runSmoke(supabase);

  const dayReport = {
    run_id: RUN_ID,
    phase: 'RC-1',
    day: 1,
    environment: 'production',
    allowlist: ALLOWLIST,
    deployment_id: deploy.id || DEPLOY_ID,
    commit: EXPECTED_COMMIT,
    started_at: smoke.since,
    smoke_scenarios: smoke.results.length,
    ...smoke.analysis,
    regression: {
      leads: smoke.window.leads.length,
      crm: smoke.window.crm.length,
      assignments: smoke.window.assignments.length,
    },
    observation_period_hours: 72,
    reviews_scheduled_h: [2, 6, 12, 24, 48, 72],
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_CANARY_DAY1.json'), JSON.stringify(dayReport, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RC1_TIMELINE.json'), JSON.stringify({ run_id: RUN_ID, timeline: smoke.timeline }, null, 2));
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_KPI_REPORT.json'),
    JSON.stringify({ run_id: RUN_ID, day1: dayReport.kpis, gates: KPI_GATES, pass: dayReport.pass }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_SECURITY_AUDIT.json'),
    JSON.stringify({
      allowlist_only: ALLOWLIST,
      non_allowlist_isolated: smoke.analysis.kpis.legacy_isolated,
      production_flags: preflight.flags_production,
      rollback_triggers: smoke.analysis.rollback_triggers,
      pass: smoke.analysis.kpis.legacy_isolated && smoke.analysis.rollback_triggers.length === 0,
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_PERFORMANCE.json'),
    JSON.stringify({
      p95_retrieval_ms: smoke.analysis.kpis.p95_retrieval_latency_ms,
      avg_e2e_ms: smoke.results.reduce((s, r) => s + r.latency_ms, 0) / smoke.results.length,
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RC1_ROLLBACK_READINESS.json'),
    JSON.stringify({
      rollback_procedure: 'railway variable delete RAG_* on production (or set false) — no code change',
      triggers_active: smoke.analysis.rollback_triggers,
      ready: smoke.analysis.rollback_triggers.length === 0,
      flags_to_disable: RAG_FLAG_KEYS,
    }, null, 2)
  );

  for (const day of [2, 3]) {
    const p = path.join(EVIDENCE_DIR, `RC1_CANARY_DAY${day}.json`);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify({ status: 'pending_observation', day, reviews_at_h: day * 24 }, null, 2));
    }
  }

  console.log(JSON.stringify({ run_id: RUN_ID, preflight: preflight.pass, selfCheck: selfCheck.pass, smoke: dayReport }, null, 2));
  process.exit(dayReport.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
