#!/usr/bin/env node
'use strict';

/**
 * ARGOS RAG KPI report — lee conversation_events + rag_query_logs.
 * Usage: node scripts/argos-rag-kpi-report.js [--since=2026-07-01T00:00:00Z] [--json]
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { buildRagQualityReport } = require('../argos/ragKpiReport');

const jsonOut = process.argv.includes('--json');
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const since = sinceArg ? sinceArg.split('=')[1] : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(2);
  }

  const supabase = createClient(url, key);
  const [eventsRes, logsRes] = await Promise.all([
    supabase
      .from('conversation_events')
      .select('id, type, payload, created_at')
      .eq('type', 'rag_retrieval')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('rag_query_logs')
      .select('id, fallback_used, result_count, latency_ms, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
  ]);

  const report = buildRagQualityReport({
    events: eventsRes.data || [],
    ragQueryLogs: logsRes.data || [],
    since,
  });

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('ARGOS RAG Quality Report (Sprint 5)');
    console.log('since:', since);
    console.log('sample_size:', report.kpi.sample_size);
    console.log('grounded_rate:', report.kpi.grounded_response_rate.toFixed(3));
    console.log('fallback_rate:', report.kpi.fallback_rate.toFixed(3));
    console.log('citation_coverage:', report.kpi.citation_coverage.toFixed(3));
    console.log('avg_retrieval_latency_ms:', Math.round(report.kpi.avg_retrieval_latency_ms));
    console.log('PASS:', report.pass);
  }

  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
