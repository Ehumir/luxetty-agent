'use strict';

/**
 * RQ-1 — métricas IR offline (Recall@k, MRR, nDCG). Sin side-effects en producción.
 */

function chunkScore(chunk) {
  return Number(chunk?.similarity ?? chunk?.score ?? 0);
}

function rankOfCorrect(results = [], correctChunkIds = new Set()) {
  const ids = correctChunkIds instanceof Set ? correctChunkIds : new Set(correctChunkIds);
  for (let i = 0; i < results.length; i += 1) {
    const id = results[i]?.chunk_id || results[i]?.id;
    if (id && ids.has(id)) return i + 1;
  }
  return null;
}

function recallAtK(results = [], correctChunkIds = new Set(), k = 1) {
  const ids = correctChunkIds instanceof Set ? correctChunkIds : new Set(correctChunkIds);
  if (!ids.size) return null;
  const top = results.slice(0, k);
  return top.some((r) => ids.has(r?.chunk_id || r?.id)) ? 1 : 0;
}

function mrr(results = [], correctChunkIds = new Set()) {
  const rank = rankOfCorrect(results, correctChunkIds);
  return rank ? 1 / rank : 0;
}

function ndcgAtK(results = [], correctChunkIds = new Set(), k = 10) {
  const ids = correctChunkIds instanceof Set ? correctChunkIds : new Set(correctChunkIds);
  if (!ids.size) return null;
  const top = results.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i += 1) {
    const id = top[i]?.chunk_id || top[i]?.id;
    if (id && ids.has(id)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealHits = Math.min(ids.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

function aggregateRecallMetrics(rows = []) {
  const ks = [1, 3, 5, 10, 20];
  const out = {};
  for (const k of ks) {
    const vals = rows.map((r) => r[`recall_at_${k}`]).filter((v) => v != null);
    out[`recall_at_${k}`] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const mrrVals = rows.map((r) => r.mrr).filter((v) => v != null);
  const ndcgVals = rows.map((r) => r.ndcg_at_10).filter((v) => v != null);
  return {
    sample_size: rows.length,
    recall_at_1: out.recall_at_1,
    recall_at_3: out.recall_at_3,
    recall_at_5: out.recall_at_5,
    recall_at_10: out.recall_at_10,
    recall_at_20: out.recall_at_20,
    mrr: mrrVals.length ? mrrVals.reduce((a, b) => a + b, 0) / mrrVals.length : 0,
    ndcg_at_10: ndcgVals.length ? ndcgVals.reduce((a, b) => a + b, 0) / ndcgVals.length : 0,
  };
}

function chunkReuseStats(retrievalRows = []) {
  const counts = new Map();
  for (const row of retrievalRows) {
    for (const c of row.top20 || []) {
      const id = c.chunk_id || c.id;
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const never = retrievalRows.length
    ? [...new Set(retrievalRows.flatMap((r) => (r.all_chunk_ids || [])))].filter((id) => !counts.has(id))
    : [];
  return {
    unique_chunks_retrieved: counts.size,
    top_reused: sorted.slice(0, 10).map(([chunk_id, hits]) => ({ chunk_id, hits })),
    never_retrieved_in_audit: never.length,
    chunk_diversity: counts.size / Math.max(retrievalRows.length, 1),
  };
}

function simulateThresholdCurve(rows = [], thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.75, 0.8]) {
  return thresholds.map((threshold) => {
    let grounded = 0;
    let fallback = 0;
    let hallucinationRisk = 0;
    let top1Hit = 0;
    let n = 0;
    for (const row of rows) {
      if (!row.has_labeled_relevant) continue;
      n += 1;
      const top = row.top20?.[0];
      const topScore = top ? chunkScore(top) : 0;
      const correctRank = rankOfCorrect(row.top20 || [], row.correct_chunk_ids);
      const correctScore = correctRank ? chunkScore(row.top20[correctRank - 1]) : 0;
      const wouldGround = topScore >= threshold && (row.correct_in_top1 ? topScore >= threshold : false);
      const correctAbove = correctScore >= threshold && correctRank != null;
      if (correctAbove) {
        grounded += 1;
        if (correctRank === 1) top1Hit += 1;
      } else {
        fallback += 1;
        if (topScore >= threshold && !row.correct_in_top20) hallucinationRisk += 1;
      }
    }
    return {
      threshold,
      grounded_rate: n ? grounded / n : 0,
      fallback_rate: n ? fallback / n : 0,
      top1_accuracy: n ? top1Hit / n : 0,
      hallucination_risk_rate: n ? hallucinationRisk / n : 0,
      sample_labeled: n,
    };
  });
}

function averageContextUtilization(selectedTokens = 0, maxTokens = 2500) {
  return maxTokens > 0 ? selectedTokens / maxTokens : 0;
}

module.exports = {
  chunkScore,
  rankOfCorrect,
  recallAtK,
  mrr,
  ndcgAtK,
  aggregateRecallMetrics,
  chunkReuseStats,
  simulateThresholdCurve,
  averageContextUtilization,
};
