'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deduplicateChunks, applyContextBudget, MAX_CONTEXT_TOKENS } = require('../conversation/v3/rag/contextBudget');
const { buildRagRetrievalKpi, aggregateRagKpis } = require('../conversation/v3/rag/ragKpi');
const { canAssertClaim } = require('../conversation/v3/rag/ragPolicy');
const { buildRagQualityReport } = require('../argos/ragKpiReport');
const { pickGroundedExcerpt } = require('../conversation/v3/rag/ragTurnOrchestrator');

const ROOT = path.join(__dirname, '..');
const SUITE = path.join(ROOT, 'docs/argos/suites/rag-quality-p0.json');

describe('ragQualityP0 — Sprint 5', () => {
  it('S5-STRUCT — suite rag-quality-p0.json', () => {
    assert.ok(fs.existsSync(SUITE));
    const suite = JSON.parse(fs.readFileSync(SUITE, 'utf8'));
    assert.equal(suite.suite, 'rag-quality-p0');
    assert.equal(suite.sprint, 5);
    assert.ok(suite.scenarios.length >= 25);
    const ids = suite.scenarios.map((s) => s.id);
    assert.ok(ids.includes('S5-H01'));
    assert.ok(ids.includes('S5-K03'));
  });

  it('S5-K03 — deduplicateChunks elimina duplicados por chunk_id', () => {
    const chunks = [
      { chunk_id: 'a', content: 'Casa en Cumbres con jardín' },
      { chunk_id: 'a', content: 'Casa en Cumbres con jardín duplicado' },
      { chunk_id: 'b', content: 'Otra propiedad' },
    ];
    const out = deduplicateChunks(chunks);
    assert.equal(out.length, 2);
    assert.equal(out[0].chunk_id, 'a');
    assert.equal(out[1].chunk_id, 'b');
  });

  it('S5-K03 — deduplicateChunks elimina duplicados por prefijo de contenido', () => {
    const shared = 'mismo contenido repetido para dedup '.repeat(4);
    const chunks = [
      { content: `${shared} cola A` },
      { content: `${shared} cola B` },
      { content: 'único chunk' },
    ];
    const out = deduplicateChunks(chunks);
    assert.equal(out.length, 2);
  });

  it('S5-K04 — applyContextBudget respeta MAX_CONTEXT_TOKENS', () => {
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      chunk_id: `c${i}`,
      content: 'token '.repeat(120),
      registry_domain_code: 'properties',
    }));
    const budget = applyContextBudget(chunks);
    assert.ok(budget.context_tokens_estimated <= MAX_CONTEXT_TOKENS);
    assert.ok(budget.chunks_dropped >= 0);
  });

  it('S5-K01 — buildRagRetrievalKpi marca grounded con citations válidas', () => {
    const kpi = buildRagRetrievalKpi({
      confidence: 0.85,
      fallback_used: false,
      citations: [{ source_id: 's1', chunk_id: 'c1', score: 0.85, registry_domain_code: 'commercial_objections' }],
      context_tokens_estimated: 400,
      latency_ms: 210,
      scores: { top_score: 0.85, min_score_threshold: 0.72 },
    });
    assert.equal(kpi.kpi_version, '1');
    assert.equal(kpi.grounded, true);
    assert.equal(kpi.citation_count, 1);
    assert.equal(kpi.citations_internal[0].registry_domain, 'commercial_objections');
  });

  it('S5-H01 — sin evidencia → no grounded', () => {
    const kpi = buildRagRetrievalKpi({
      confidence: 0.4,
      fallback_used: true,
      citations: [],
    });
    assert.equal(kpi.grounded, false);
    assert.equal(kpi.fallback_used, true);
  });

  it('S5-H02 — canAssertClaim bloquea claim sin citation', () => {
    assert.equal(canAssertClaim({ confidence: 0.95, citations: [] }), false);
    assert.equal(
      canAssertClaim({ confidence: 0.95, citations: [{ score: 0.8 }] }),
      true
    );
  });

  it('S5-H03 — pickGroundedExcerpt null sin citations', () => {
    assert.equal(
      pickGroundedExcerpt({ confidence: 0.9, citations: [], fallback_used: false }),
      null
    );
  });

  it('S5-K02 — aggregateRagKpis calcula rates', () => {
    const events = [
      { type: 'rag_retrieval', payload: { grounded: true, fallback_used: false, citation_count: 2, confidence: 0.8, retrieval_latency_ms: 300 } },
      { type: 'rag_retrieval', payload: { grounded: false, fallback_used: true, citation_count: 0, confidence: 0, retrieval_latency_ms: 150 } },
    ];
    const agg = aggregateRagKpis(events);
    assert.equal(agg.sample_size, 2);
    assert.equal(agg.grounded_response_rate, 0.5);
    assert.equal(agg.fallback_rate, 0.5);
    assert.equal(agg.citation_coverage, 0.5);
  });

  it('S5-K05 — buildRagQualityReport gates Sprint 5', () => {
    const report = buildRagQualityReport({
      events: [
        {
          type: 'rag_retrieval',
          payload: {
            kpi_version: '1',
            grounded: true,
            fallback_used: false,
            citation_count: 1,
            confidence: 0.9,
            retrieval_latency_ms: 250,
          },
        },
      ],
    });
    assert.equal(report.sprint, 5);
    assert.equal(report.kpi.sample_size, 1);
    assert.equal(report.gates.avg_retrieval_latency_ms, true);
  });
});
