'use strict';

const { aggregateRagKpis } = require('../conversation/v3/rag/ragKpi');

/**
 * ARGOS — autoridad de calidad RAG P0 (Sprint 5).
 * Agrega KPIs desde conversation_events tipo rag_retrieval.
 */
function buildRagQualityReport({ events = [], ragQueryLogs = [], since = null } = {}) {
  const kpi = aggregateRagKpis(events);
  const logs = Array.isArray(ragQueryLogs) ? ragQueryLogs : [];
  const fallbackLogs = logs.filter((l) => l.fallback_used === true).length;
  const retrievalLogs = logs.length;

  const gates = {
    grounded_response_rate: kpi.grounded_response_rate >= kpi.targets.grounded_min,
    fallback_rate_sane: kpi.fallback_rate <= 0.5,
    citation_coverage: kpi.citation_coverage >= kpi.targets.citation_coverage_min,
    avg_retrieval_latency_ms: kpi.avg_retrieval_latency_ms < kpi.targets.retrieval_latency_max_ms,
    sample_present: kpi.sample_size > 0,
  };

  const pass = Object.values(gates).every(Boolean);

  return {
    report_version: '1',
    since,
    kpi,
    rag_query_logs: {
      count: retrievalLogs,
      fallback_count: fallbackLogs,
      fallback_rate: retrievalLogs ? fallbackLogs / retrievalLogs : 0,
    },
    gates,
    pass,
    sprint: 5,
  };
}

module.exports = {
  buildRagQualityReport,
};
