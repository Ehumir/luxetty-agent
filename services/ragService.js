'use strict';

const crypto = require('crypto');
const { openai } = require('./openaiService');
const { isRagP0Enabled } = require('../config/accP0Flags');
const { buildContextPackV1 } = require('../conversation/v3/rag/buildContextPack');
const { applyContextBudget } = require('../conversation/v3/rag/contextBudget');
const {
  DEFAULT_MIN_SCORE,
  filterValidChunks,
  evaluateRetrieval,
} = require('../conversation/v3/rag/ragPolicy');

const RAG_TIMEOUT_MS = Number(process.env.RAG_TIMEOUT_MS || 1200);
const RAG_RETRIEVAL_BUDGET_MS = Number(process.env.RAG_RETRIEVAL_BUDGET_MS || 900);
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';

/** Umbral RPC (recall): devuelve candidatos; el umbral final (0.72) se aplica en app. */
function getRagRpcMinScore() {
  const env = Number(process.env.RAG_RPC_MIN_SCORE);
  if (Number.isFinite(env) && env > 0 && env < 1) return env;
  return 0.5;
}

const embeddingCache = new Map();
const EMBEDDING_CACHE_MAX = 100;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function embedQuery(text) {
  const input = String(text || '').slice(0, 8000);
  if (!input.trim()) throw new Error('empty_query');
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
  const embedding = res?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.length) throw new Error('embedding_failed');
  return embedding;
}

async function getQueryEmbedding(query, cacheKey) {
  if (cacheKey && embeddingCache.has(cacheKey)) {
    return { embedding: embeddingCache.get(cacheKey), cache_hit: true };
  }
  const embedding = await embedQuery(query);
  if (cacheKey) {
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
      const first = embeddingCache.keys().next().value;
      embeddingCache.delete(first);
    }
    embeddingCache.set(cacheKey, embedding);
  }
  return { embedding, cache_hit: false };
}

/**
 * Recuperación semántica vía RPC (nunca SQL directo).
 * Con RAG_HYBRID_ENABLED usa match_knowledge_chunks_hybrid (FTS+vector RRF) cuando aplica.
 */
async function semanticSearch(db, { query, rpcName, rpcParams = {}, logger = console, timeoutMs = RAG_RETRIEVAL_BUDGET_MS }) {
  if (!isRagP0Enabled()) return { chunks: [], fallback: true, latency_ms: 0 };
  if (!db || typeof db.rpc !== 'function') return { chunks: [], fallback: true, latency_ms: 0 };

  const q = String(query || '').trim();
  if (!q) return { chunks: [], fallback: true, latency_ms: 0 };

  const queryHash = sha256(q);
  const start = Date.now();
  const { isRagHybridEnabled } = require('../config/accP0Flags');
  let effectiveRpc = rpcName;
  let effectiveParams = { ...rpcParams };

  if (
    isRagHybridEnabled() &&
    (rpcName === 'match_knowledge_chunks' || rpcName === 'match_property_chunks')
  ) {
    effectiveRpc = 'match_knowledge_chunks_hybrid';
    effectiveParams = {
      ...rpcParams,
      query_text: q,
      filter_source_type:
        rpcName === 'match_property_chunks' ? 'property' : rpcParams.filter_source_type ?? null,
    };
  }

  try {
    const embedStart = Date.now();
    const { embedding, cache_hit } = await withTimeout(
      getQueryEmbedding(q, queryHash),
      timeoutMs,
      'embedding'
    );
    const embedding_ms = Date.now() - embedStart;

    const rpcStart = Date.now();
    let data;
    let error;
    try {
      const res = await withTimeout(
        db.rpc(effectiveRpc, { ...effectiveParams, query_embedding: embedding }),
        timeoutMs,
        'rpc'
      );
      data = res.data;
      error = res.error;
    } catch (hybridErr) {
      if (effectiveRpc === 'match_knowledge_chunks_hybrid') {
        logger.warn?.('rag_hybrid_fallback_vector', { error: String(hybridErr?.message || hybridErr) });
        const res = await withTimeout(
          db.rpc(rpcName, { ...rpcParams, query_embedding: embedding }),
          timeoutMs,
          'rpc'
        );
        data = res.data;
        error = res.error;
        effectiveRpc = rpcName;
      } else {
        throw hybridErr;
      }
    }
    const rpc_ms = Date.now() - rpcStart;
    const serialization_ms = 0;

    if (error) {
      if (effectiveRpc === 'match_knowledge_chunks_hybrid') {
        logger.warn?.('rag_hybrid_rpc_error_fallback', { message: error.message });
        const res = await withTimeout(
          db.rpc(rpcName, { ...rpcParams, query_embedding: embedding }),
          timeoutMs,
          'rpc'
        );
        if (res.error) {
          logger.warn?.('rag_semantic_search_rpc_error', { rpc: rpcName, message: res.error.message });
          return {
            chunks: [],
            fallback: true,
            latency_ms: Date.now() - start,
            query_hash: queryHash,
            cache_hit,
            embedding_ms,
            rpc_ms,
            serialization_ms,
          };
        }
        return {
          chunks: Array.isArray(res.data) ? res.data : [],
          fallback: false,
          latency_ms: Date.now() - start,
          query_hash: queryHash,
          cache_hit,
          embedding_ms,
          rpc_ms,
          serialization_ms,
          hybrid: false,
          hybrid_fallback: true,
        };
      }
      logger.warn?.('rag_semantic_search_rpc_error', { rpc: rpcName, message: error.message });
      return {
        chunks: [],
        fallback: true,
        latency_ms: Date.now() - start,
        query_hash: queryHash,
        cache_hit,
        embedding_ms,
        rpc_ms,
        serialization_ms,
      };
    }

    return {
      chunks: Array.isArray(data) ? data : [],
      fallback: false,
      latency_ms: Date.now() - start,
      query_hash: queryHash,
      cache_hit,
      embedding_ms,
      rpc_ms,
      serialization_ms,
      hybrid: effectiveRpc === 'match_knowledge_chunks_hybrid',
    };
  } catch (err) {
    logger.warn?.('rag_semantic_search_failed', { rpc: rpcName, error: String(err?.message || err) });
    return {
      chunks: [],
      fallback: true,
      latency_ms: Date.now() - start,
      query_hash: queryHash,
      embedding_ms: null,
      rpc_ms: null,
      serialization_ms: null,
    };
  }
}

function selectCandidates(chunks = [], { topK = 5 } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  return [...list].sort((a, b) => (b.similarity ?? b.score ?? 0) - (a.similarity ?? a.score ?? 0)).slice(0, topK);
}

function applyThresholds(candidates = [], { minScore = DEFAULT_MIN_SCORE } = {}) {
  return (Array.isArray(candidates) ? candidates : []).filter((c) => (c.similarity ?? c.score ?? 0) >= minScore);
}

function buildContext(chunks = []) {
  const valid = filterValidChunks(chunks);
  const budget = applyContextBudget(valid);
  return {
    chunks: budget.selected,
    dropped: budget.dropped,
    context_tokens_estimated: budget.context_tokens_estimated,
    chunks_selected: budget.chunks_selected,
    chunks_dropped: budget.chunks_dropped,
  };
}

function buildCitationsFromChunks(chunks = []) {
  return chunks.map((c) => ({
    source_type: c.source_type,
    source_id: c.source_id,
    chunk_id: c.chunk_id || c.id,
    registry_domain_code: c.registry_domain_code || c.metadata?.registry_domain_code || null,
    score: Number(c.similarity ?? c.score ?? 0),
    excerpt: String(c.content || '').slice(0, 200),
  }));
}

function createContextPack({
  chunks = [],
  confidence = 0,
  minScore = DEFAULT_MIN_SCORE,
  fallback_used = false,
  rag_query_log_id = null,
  latency_ms = 0,
  budgetMeta = {},
} = {}) {
  const citations = buildCitationsFromChunks(chunks);
  const scores = chunks.length
    ? {
        top_score: Math.max(...chunks.map((c) => Number(c.similarity ?? c.score ?? 0))),
        min_score_threshold: minScore,
        avg_score: chunks.reduce((s, c) => s + Number(c.similarity ?? c.score ?? 0), 0) / chunks.length,
      }
    : { top_score: 0, min_score_threshold: minScore };

  const sources = chunks.map((c) => ({
    source_type: c.source_type,
    source_id: c.source_id,
    chunk_id: c.chunk_id || c.id,
    registry_domain_code: c.registry_domain_code || null,
  }));

  return buildContextPackV1({
    sources,
    citations,
    scores,
    confidence,
    context_tokens_estimated: budgetMeta.context_tokens_estimated ?? 0,
    chunks_selected: budgetMeta.chunks_selected ?? chunks.length,
    chunks_dropped: budgetMeta.chunks_dropped ?? 0,
    fallback_used,
    rag_query_log_id,
    latency_ms,
  });
}

/** Forma mínima compatible con consumidores legacy. */
function mapLegacyShape(contextPack) {
  if (!contextPack) return null;
  return {
    confidence: contextPack.confidence,
    citations: contextPack.citations,
    context_tokens_estimated: contextPack.context_tokens_estimated,
    fallback_used: contextPack.fallback_used,
  };
}

async function persistRagQueryLog(db, {
  queryHash,
  model = EMBEDDING_MODEL,
  filters = {},
  resultsCount = 0,
  latencyMs = 0,
  fallbackUsed = false,
  citations = [],
}) {
  if (!db || typeof db.from !== 'function') return null;
  try {
    const { data: logRow, error: logErr } = await db
      .from('rag_query_logs')
      .insert({
        query_text_hash: queryHash,
        embedding_provider: 'openai',
        embedding_model: model,
        filters,
        top_k: citations.length || resultsCount,
        result_count: resultsCount,
        latency_ms: latencyMs,
        fallback_used: fallbackUsed,
      })
      .select('id')
      .maybeSingle();

    if (logErr || !logRow?.id) {
      // F1A: no silenciar fallos de insert (RLS/schema/credenciales).
      if (typeof console !== 'undefined') {
        console.warn('persistRagQueryLog_failed', {
          error: logErr?.message || logErr || 'no_row',
          code: logErr?.code || null,
        });
      }
      return null;
    }

    if (citations.length) {
      const rows = citations.map((c, idx) => ({
        rag_query_log_id: logRow.id,
        chunk_id: c.chunk_id,
        score: c.score,
        rank: idx + 1,
      }));
      await db.from('retrieval_citations').insert(rows);
    }
    return logRow.id;
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('persistRagQueryLog_exception', { error: String(err?.message || err) });
    }
    return null;
  }
}

/**
 * Orquestación completa con timeout global y fallback.
 */
async function retrieveContextPack(
  db,
  {
    query,
    rpcName,
    rpcParams,
    logger = console,
    minScore = DEFAULT_MIN_SCORE,
    registryDomainFilter = null,
    allowedDomains = null,
  } = {}
) {
  const start = Date.now();
  if (!isRagP0Enabled()) {
    return { contextPack: createContextPack({ fallback_used: true }), fallback: true };
  }

  try {
    const search = await withTimeout(
      semanticSearch(db, { query, rpcName, rpcParams, logger }),
      RAG_TIMEOUT_MS,
      'rag_total'
    );

    if (search.fallback || !search.chunks?.length) {
      const pack = createContextPack({ fallback_used: true, latency_ms: Date.now() - start });
      return { contextPack: pack, fallback: true };
    }

    let scopedChunks = search.chunks;
    if (registryDomainFilter) {
      scopedChunks = scopedChunks.filter((c) => c.registry_domain_code === registryDomainFilter);
    } else if (Array.isArray(allowedDomains) && allowedDomains.length) {
      scopedChunks = scopedChunks.filter((c) => allowedDomains.includes(c.registry_domain_code));
    }

    if (!scopedChunks.length) {
      const pack = createContextPack({ fallback_used: true, latency_ms: Date.now() - start });
      return { contextPack: pack, fallback: true, cross_domain_empty: true };
    }

    const candidates = selectCandidates(scopedChunks);
    const thresholded = applyThresholds(candidates, { minScore });
    const evalResult = evaluateRetrieval(thresholded, { minScore });

    if (evalResult.fallback) {
      const pack = createContextPack({ fallback_used: true, latency_ms: Date.now() - start });
      return { contextPack: pack, fallback: true, evalResult };
    }

    const ctx = buildContext(thresholded);
    const citations = buildCitationsFromChunks(ctx.chunks);
    const logId = await persistRagQueryLog(db, {
      queryHash: search.query_hash,
      filters: rpcParams,
      resultsCount: ctx.chunks.length,
      latencyMs: search.latency_ms,
      fallbackUsed: false,
      citations,
    });

    const contextPack = createContextPack({
      chunks: ctx.chunks,
      confidence: evalResult.confidence,
      minScore,
      fallback_used: false,
      rag_query_log_id: logId,
      latency_ms: Date.now() - start,
      budgetMeta: ctx,
    });

    return { contextPack, fallback: false, evalResult };
  } catch (err) {
    logger.warn?.('rag_retrieve_context_pack_failed', { error: String(err?.message || err) });
    return {
      contextPack: createContextPack({ fallback_used: true, latency_ms: Date.now() - start }),
      fallback: true,
    };
  }
}

module.exports = {
  RAG_TIMEOUT_MS,
  RAG_RETRIEVAL_BUDGET_MS,
  getRagRpcMinScore,
  sha256,
  embedQuery,
  getQueryEmbedding,
  semanticSearch,
  buildContext,
  selectCandidates,
  applyThresholds,
  createContextPack,
  mapLegacyShape,
  persistRagQueryLog,
  retrieveContextPack,
  buildCitationsFromChunks,
  getQueryEmbedding,
  _clearEmbeddingCacheForTests: () => embeddingCache.clear(),
};
