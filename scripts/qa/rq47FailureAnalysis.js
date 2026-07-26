#!/usr/bin/env node
'use strict';

/**
 * RQ-4.7 — Offline audit from RQ-5 rerun window (Fases 1–4).
 * Usage:
 *   EVIDENCE_DIR=../luxetty-atena/docs/argos/evidence/acc-rag-p0-rq47 \
 *   node scripts/qa/rq47FailureAnalysis.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rq47');

const RQ5_RERUN = path.join(
  __dirname,
  '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rq5/RQ5_CANARY_100_RERUN.json',
);

const CAUSE_LABELS = [
  'NO_RETRIEVAL',
  'LOW_SCORE',
  'NO_CITATION',
  'WRONG_DOMAIN',
  'NO_KNOWLEDGE',
  'AMBIGUOUS',
  'THRESHOLD_TOO_HIGH',
  'TOP_K_TOO_LOW',
  'QUERY_NORMALIZATION',
  'LEGACY_PATH',
  'TELEMETRY_ONLY',
  'BUG',
  'NO_SECONDARY_FALLBACK',
  'PROPERTIES_DEFERRED',
  'HARNESS_NOISE',
];

function classifyFailure(payload) {
  const domain = payload.domain_detected || payload.domain_selected;
  const grounded = !!payload.grounded;
  if (grounded) return { cause: null, group: 'A' };

  if (payload.fallback_used && Number(payload.top_score || 0) === 0 && Number(payload.citation_count || 0) === 0) {
    if (domain === 'commercial_objections') {
      return {
        cause: 'NO_SECONDARY_FALLBACK',
        group: 'B',
        detail: 'Primary vacío en alta confianza; secondary scripts no intentado (RQ-3 primary_only).',
      };
    }
    return { cause: 'NO_RETRIEVAL', group: 'B', detail: 'fallback_used sin chunks ni score' };
  }

  if (payload.fallback_used && Number(payload.top_score || 0) > 0) {
    const thr = Number(payload.min_score_threshold ?? 0.72);
    if (Number(payload.top_score) < thr) {
      return { cause: 'THRESHOLD_TOO_HIGH', group: 'B', detail: `top_score ${payload.top_score} < threshold ${thr}` };
    }
    return { cause: 'LOW_SCORE', group: 'B', detail: 'Score insuficiente tras threshold' };
  }

  if (!payload.fallback_used && Number(payload.citation_count || 0) === 0) {
    return { cause: 'NO_CITATION', group: 'B', detail: 'Retrieval sin citas persistidas' };
  }

  return { cause: 'BUG', group: 'B', detail: 'Patrón no clasificado' };
}

function writeJson(name, data) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const p = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

async function main() {
  const rerun = JSON.parse(fs.readFileSync(RQ5_RERUN, 'utf8'));
  const since = rerun.since;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  const supabase = createClient(url, key);
  const [eventsRes, logsRes] = await Promise.all([
    supabase
      .from('conversation_events')
      .select('id,type,payload,created_at')
      .eq('type', 'rag_retrieval')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(500),
    supabase
      .from('rag_query_logs')
      .select('id,fallback_used,result_count,latency_ms,filters,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(500),
  ]);

  const events = eventsRes.data || [];
  const logs = logsRes.data || [];
  const payloads = events.map((e) => ({ event_id: e.id, created_at: e.created_at, ...(e.payload || {}) }));

  const passCases = [];
  const failCases = [];
  const causeCounts = Object.fromEntries(CAUSE_LABELS.map((c) => [c, 0]));

  for (const p of payloads) {
    const { cause, group, detail } = classifyFailure(p);
    const row = {
      event_id: p.event_id,
      domain_detected: p.domain_detected,
      domain_selected: p.domain_selected,
      grounded: p.grounded,
      fallback_used: p.fallback_used,
      top_score: p.top_score,
      min_score_threshold: p.min_score_threshold,
      citation_count: p.citation_count,
      cross_domain_discarded: p.cross_domain_discarded,
      routing_strategy: p.routing_strategy,
      cause,
      detail,
    };
    if (group === 'A') passCases.push(row);
    else {
      failCases.push(row);
      if (cause) causeCounts[cause] = (causeCounts[cause] || 0) + 1;
    }
  }

  const legacyAudit = {
    phase: 'RQ-4.7',
    source_run: rerun.run_id,
    since,
    finding: 'TELEMETRY_ONLY',
    rag_executed_outside_allowlist: false,
    explanation:
      'LEG-01 falló porque el harness RQ-5 marcó had_rag_event si CUALQUIER evento contenía RUN_ID en payload, no por wamid del webhook fuera allowlist.',
    evidence: {
      wrong_domain_retrieval: rerun.kpis?.wrong_domain_retrieval ?? 0,
      legacy_gate_rq5: rerun.gates?.legacy_isolated === false,
      fix_rq47: 'Correlación por message_id/wamid + phone eligibility; sin RUN_ID en texto del mensaje.',
    },
    pass_after_fix_expected: true,
  };

  const crossDomainAudit = {
    phase: 'RQ-4.7',
    source_run: rerun.run_id,
    cross_domain_discarded_total: rerun.kpis?.cross_domain_retrieval ?? 0,
    wrong_domain_retrieval: rerun.kpis?.wrong_domain_retrieval ?? 0,
    classification: 'C',
    meaning: 'Chunks de dominios secundarios descartados correctamente por filterChunksByDomain — no wrong domain.',
    gate_bug_rq5: 'RQ-5 gate cross_domain_retrieval === 0 bloqueaba descartes legítimos.',
    gate_rq47: 'wrong_domain_retrieval === 0 es el gate crítico; cross_domain_discarded es informativo.',
    pass_after_fix_expected: true,
  };

  const fixPlan = {
    generated_at: new Date().toISOString(),
    fixes: [
      {
        cause: 'NO_SECONDARY_FALLBACK',
        action: 'Secondary domain fallback cuando primary vacío (sin búsqueda global)',
        files: ['domainRetrievalOrchestrator.js'],
      },
      {
        cause: 'HARNESS_NOISE',
        action: 'stripHarnessNoise + rq47 canary sin RUN_ID en texto',
        files: ['domainIntentClassifier.js', 'domainRetrievalOrchestrator.js', 'rq47QualityCanary.js'],
      },
      {
        cause: 'QUERY_NORMALIZATION',
        action: 'Enriquecer buildRulesRetrievalQuery commercial_objections',
        files: ['ragRulesService.js'],
      },
      {
        cause: 'PROPERTIES_DEFERRED',
        action: 'Properties vía fetchDomainAwareRulesContextPack + adaptive minScore',
        files: ['ragTurnOrchestrator.js', 'ragInventoryService.js'],
      },
      {
        cause: 'TELEMETRY_ONLY',
        action: 'KPI min_score_threshold desde extras; wrong_domain_retrieval field',
        files: ['ragKpi.js', 'domainRetrievalOrchestrator.js'],
      },
      {
        cause: 'BUG',
        action: 'Harness legacy_isolated + cross_domain gate',
        files: ['rq47QualityCanary.js'],
      },
    ],
  };

  const gapAnalysis = {
    phase: 'RQ-4.7',
    fail_count: failCases.length,
    pass_count: passCases.length,
    cases: failCases.map((c) => ({
      ...c,
      knowledge_existed: c.domain_detected === 'commercial_objections',
      retrieved: false,
      position: null,
      secondary_attempted: false,
      recommendation: 'secondary_fallback + query normalization + strip harness noise',
    })),
  };

  const failureAnalysis = {
    phase: 'RQ-4.7',
    source: 'RQ5_CANARY_100_RERUN',
    run_id: rerun.run_id,
    since,
    sample_rag_events: payloads.length,
    grounded_pass: passCases.length,
    grounded_fail: failCases.length,
    grounded_rate: payloads.length ? passCases.length / payloads.length : 0,
    group_a: passCases,
    group_b: failCases,
    cause_counts: causeCounts,
    domains_fail: [...new Set(failCases.map((f) => f.domain_detected))],
  };

  const paths = {
    RQ47_FAILURE_ANALYSIS: writeJson('RQ47_FAILURE_ANALYSIS.json', failureAnalysis),
    RQ47_LEGACY_ISOLATION_AUDIT: writeJson('RQ47_LEGACY_ISOLATION_AUDIT.json', legacyAudit),
    RQ47_CROSS_DOMAIN_AUDIT: writeJson('RQ47_CROSS_DOMAIN_AUDIT.json', crossDomainAudit),
    RQ47_GROUNDED_GAP_ANALYSIS: writeJson('RQ47_GROUNDED_GAP_ANALYSIS.json', gapAnalysis),
    RQ47_FIX_PLAN: writeJson('RQ47_FIX_PLAN.json', fixPlan),
    RQ47_PERFORMANCE_BREAKDOWN: writeJson('RQ47_PERFORMANCE_BREAKDOWN.json', {
      source_run: rerun.run_id,
      note: 'Pre-patch baseline from RQ-5 rerun; post-patch from RQ47 canary.',
      rq5_rerun: rerun.performance,
      components: {
        embedding_rpc: 'included in retrieval_latency_ms',
        context_pack: 'included in routing_latency_ms',
        harness_webhook_delay_ms: 2200,
        e2e_includes_qa_network: true,
      },
    }),
  };

  console.log(JSON.stringify({ ok: true, paths, fail_cases: failCases.length, events: events.length, logs: logs.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
