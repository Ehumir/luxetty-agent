'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  recallAtK,
  mrr,
  ndcgAtK,
  rankOfCorrect,
  simulateThresholdCurve,
} = require('../conversation/v3/rag/ragRetrievalMetrics');

describe('ragRetrievalMetrics — RQ-1', () => {
  const results = [
    { chunk_id: 'a', similarity: 0.8 },
    { chunk_id: 'b', similarity: 0.75 },
    { chunk_id: 'c', similarity: 0.6 },
  ];
  const correct = new Set(['b']);

  it('RQ1-M01 — rankOfCorrect', () => {
    assert.equal(rankOfCorrect(results, correct), 2);
  });

  it('RQ1-M02 — recall@1 vs recall@5', () => {
    assert.equal(recallAtK(results, correct, 1), 0);
    assert.equal(recallAtK(results, correct, 5), 1);
  });

  it('RQ1-M03 — mrr', () => {
    assert.equal(mrr(results, correct), 0.5);
  });

  it('RQ1-M04 — ndcg@10', () => {
    const v = ndcgAtK(results, correct, 10);
    assert.ok(v > 0 && v <= 1);
  });

  it('RQ1-M05 — threshold curve monotonic fallback', () => {
    const rows = [
      {
        has_labeled_relevant: true,
        top20: results,
        correct_chunk_ids: ['b'],
        correct_in_top1: false,
        correct_in_top20: true,
      },
    ];
    const curve = simulateThresholdCurve(rows, [0.5, 0.72]);
    assert.ok(curve[0].grounded_rate >= curve[1].grounded_rate);
  });
});
