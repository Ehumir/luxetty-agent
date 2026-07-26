'use strict';

const { DEFAULT_MIN_SCORE } = require('./ragPolicy');
const {
  aggregateRecallMetrics,
  chunkReuseStats,
  averageContextUtilization,
} = require('./ragRetrievalMetrics');

/**
 * KPI payload interno para ARGOS (Sprint 5). No expone citations al usuario.
 */
function buildRagRetrievalKpi(contextPack, extras = {}) {
  const citations = Array.isArray(contextPack?.citations) ? contextPack.citations : [];
  const confidence = Number(contextPack?.confidence ?? 0);
  const fallbackUsed = !!contextPack?.fallback_used;
  const minThreshold = Number(
    contextPack?.scores?.min_score_threshold ?? extras.min_score_threshold ?? DEFAULT_MIN_SCORE
  );
  const grounded =
    !fallbackUsed &&
    citations.length > 0 &&
    confidence >= minThreshold &&
    citations.some((c) => Number(c.score) >= minThreshold);

  return {
    kpi_version: '1',
    grounded,
    fallback_used: fallbackUsed,
    fallback_correct: fallbackUsed && citations.length === 0,
    confidence,
    top_score: Number(contextPack?.scores?.top_score ?? citations[0]?.score ?? 0),
    min_score_threshold: minThreshold,
    citation_count: citations.length,
    citation_coverage: citations.length > 0 ? 1 : 0,
    chunks_selected: Number(contextPack?.chunks_selected ?? citations.length),
    chunks_dropped: Number(contextPack?.chunks_dropped ?? 0),
    context_tokens_estimated: Number(contextPack?.context_tokens_estimated ?? 0),
    retrieval_latency_ms: Number(contextPack?.latency_ms ?? extras.latency_ms ?? 0),
    rag_query_log_id: contextPack?.rag_query_log_id || extras.rag_query_log_id || null,
    citations_internal: citations.map((c, idx) => ({
      rank: idx + 1,
      source_id: c.source_id || null,
      chunk_id: c.chunk_id || null,
      score: Number(c.score ?? 0),
      registry_domain: c.registry_domain_code || c.source_type || null,
    })),
    hallucination_blocked: extras.hallucination_blocked === true,
    ...extras,
  };
}

/**
 * Agrega KPIs de una ventana de eventos rag_retrieval (ARGOS authority).
 */
function aggregateRagKpis(events = []) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => e?.type === 'rag_retrieval' || e?.payload?.kpi_version);
  const n = rows.length || 1;
  let grounded = 0;
  let fallback = 0;
  let citations = 0;
  let latencySum = 0;
  let confidenceSum = 0;
  let tokensSum = 0;
  let hallucinationBlocked = 0;

  let withCitations = 0;

  for (const row of rows) {
    const p = row.payload || row;
    if (p.grounded === true || (p.kpi_version && p.grounded)) grounded += 1;
    if (p.fallback_used === true) fallback += 1;
    const citeCount = Number(p.citation_count ?? p.citations_count ?? 0);
    citations += citeCount;
    if (citeCount > 0) withCitations += 1;
    latencySum += Number(p.retrieval_latency_ms ?? p.latency_ms ?? 0);
    confidenceSum += Number(p.confidence ?? 0);
    tokensSum += Number(p.context_tokens_estimated ?? 0);
    if (p.hallucination_blocked) hallucinationBlocked += 1;
  }

  const count = rows.length;
  return {
    sample_size: count,
    grounded_response_rate: count ? grounded / count : 0,
    fallback_rate: count ? fallback / count : 0,
    citation_coverage: count ? withCitations / count : 0,
    avg_citation_count: count ? citations / count : 0,
    avg_confidence: count ? confidenceSum / count : 0,
    avg_retrieval_latency_ms: count ? latencySum / count : 0,
    avg_context_tokens: count ? tokensSum / count : 0,
    hallucination_blocked_count: hallucinationBlocked,
    targets: {
      grounded_min: 0.95,
      hallucination_max: 0.02,
      fallback_correct_min: 0.99,
      retrieval_latency_max_ms: 400,
      total_latency_max_ms: 1200,
      citation_coverage_min: 0.95,
      top1_accuracy_min: 0.9,
    },
  };
}

module.exports = {
  buildRagRetrievalKpi,
  aggregateRagKpis,
  aggregateRecallMetrics,
  chunkReuseStats,
  averageContextUtilization,
};
