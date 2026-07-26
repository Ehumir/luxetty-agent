'use strict';

const { isRagInventoryEffectiveForUser } = require('../config/accP0Flags');
const ragService = require('./ragService');
const { getMinScoreForDomain } = require('../conversation/v3/rag/ragDomainThresholdLoader');
const {
  evaluateRetrieval,
  filterValidChunks,
  isPropertyRowPublishable,
  chunkScore,
} = require('../conversation/v3/rag/ragPolicy');
const { extractPropertyCode } = require('../conversation/propertyIntentResolver');
const {
  findPropertyByCode,
} = require('./propertyInventoryService');

const RAG_TIMEOUT_MS = Number(process.env.RAG_TIMEOUT_MS || 1200);

function cleanSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extrae zona de frases naturales ("en Cumbres", "de García").
 */
function extractZoneFromNaturalQuery(text) {
  const raw = String(text || '');
  const enMatch = raw.match(/\ben\s+([A-Za-zÁÉÍÓÚáéíóú0-9\s]{2,40}?)(?:\s+con|\s+y|\s*$|[.?!,])/i);
  if (enMatch?.[1]) return cleanSpaces(enMatch[1]);
  const deMatch = raw.match(/\bde\s+([A-Za-zÁÉÍÓÚáéíóú0-9\s]{2,40}?)(?:\s+con|\s+y|\s*$|[.?!,])/i);
  if (deMatch?.[1]) return cleanSpaces(deMatch[1]);
  return '';
}

/**
 * Normaliza texto conversacional al formato de chunks indexados (solo embedding).
 */
function buildInventoryRetrievalQuery(text, hintZone = '') {
  const zone = cleanSpaces(hintZone) || extractZoneFromNaturalQuery(text) || 'Monterrey';
  const stripped = cleanSpaces(String(text || '')).replace(
    /^(busco|quiero|necesito|me interesa|info de|información de|informacion de)\s+/i,
    ''
  );
  const typeMatch = stripped.match(/\b(casa|departamento|depa|terreno|residencia|local)\b/i);
  const type = (typeMatch ? typeMatch[1] : 'casa').toUpperCase();
  const zoneLabel = zone.toUpperCase();
  const opMatch = stripped.match(/\b(renta|rentar|alquiler|venta|comprar)\b/i);
  const operation = opMatch ? ` EN ${opMatch[1].toUpperCase()}` : ' EN VENTA';

  return [
    `Título: ${type} EN ${zoneLabel}${operation}`,
    `Zona: ${zone}`,
    'Ciudad: Monterrey',
    `Descripción: ${stripped || text}`,
  ].join('\n');
}

function extractListingIdFromChunk(chunk) {
  const meta = chunk?.metadata || {};
  if (meta.listing_id) return cleanSpaces(meta.listing_id);
  const m = String(chunk?.content || '').match(/LUX:\s*(LUX-[A-Z0-9-]+)/i);
  return m?.[1] ? cleanSpaces(m[1]) : null;
}

function extractPropertyIdFromChunk(chunk) {
  const meta = chunk?.metadata || {};
  return meta.property_id || meta.source_property_id || null;
}

async function loadPropertyFromChunk(db, chunk, logger) {
  const propertyId = extractPropertyIdFromChunk(chunk);
  if (propertyId) {
    const byId = await findPropertyByCode(db, propertyId, logger);
    if (byId?.property) return byId;
  }
  const listingId = extractListingIdFromChunk(chunk);
  if (listingId) {
    return findPropertyByCode(db, listingId, logger);
  }
  return { property: null, propertyId: null, normalized: null };
}

function wrapFoundResult(found, { matchMethod = 'rag_semantic', ragMeta = null } = {}) {
  return {
    status: 'found',
    property: found.property,
    propertyId: found.propertyId,
    normalized: found.normalized,
    match_method: matchMethod,
    rag_meta: ragMeta,
  };
}

function wrapAmbiguousResult(candidates, { ragMeta = null } = {}) {
  return {
    status: 'ambiguous',
    candidates: candidates.map((c) => ({
      listing_id: extractListingIdFromChunk(c) || c.metadata?.listing_id || null,
      property_id: extractPropertyIdFromChunk(c) || null,
      score: chunkScore(c),
      excerpt: String(c.content || '').slice(0, 120),
    })),
    match_method: 'rag_semantic',
    rag_meta: ragMeta,
  };
}

/**
 * Resolución de inventario vía Knowledge Store (solo cuando RAG_INVENTORY_ENABLED).
 * Nunca escribe CRM. Fallback → { status: 'fallback_legacy' }.
 */
async function resolveInboundPropertyReference(db, { text, hintZone, canaryPhone }, logger = console) {
  if (!isRagInventoryEffectiveForUser(canaryPhone)) {
    return { status: 'fallback_legacy' };
  }

  const looseText = cleanSpaces(text);
  if (!looseText) return { status: 'fallback_legacy' };

  // Código directo: no alterar path — delegar a legacy
  if (extractPropertyCode(looseText)) {
    return { status: 'fallback_legacy', resolution_path: 'lux_code_bypass', reason: 'lux_code_bypass' };
  }

  const start = Date.now();
  const minScore = getMinScoreForDomain('properties');
  const retrievalQuery = buildInventoryRetrievalQuery(looseText, hintZone);

  try {
    const search = await ragService.semanticSearch(db, {
      query: retrievalQuery,
      rpcName: 'match_property_chunks',
      rpcParams: {
        match_count: 5,
        min_score: ragService.getRagRpcMinScore(),
        filter_visibility_scope: null,
        filter_is_active: true,
        filter_property_id: null,
      },
      logger,
    });

    if (Date.now() - start > RAG_TIMEOUT_MS || search.fallback) {
      return { status: 'fallback_legacy', reason: 'timeout_or_rpc_fail' };
    }

    const valid = filterValidChunks(search.chunks);
    const candidates = ragService.selectCandidates(valid, { topK: 5 });
    const thresholded = ragService.applyThresholds(candidates, { minScore });
    const evalResult = evaluateRetrieval(thresholded, { minScore });

    const ragMeta = {
      query_hash: search.query_hash,
      latency_ms: search.latency_ms,
      confidence: evalResult.confidence,
      cache_hit: search.cache_hit,
      embedding_ms: search.embedding_ms ?? null,
      rpc_ms: search.rpc_ms ?? null,
      serialization_ms: search.serialization_ms ?? null,
    };

    if (evalResult.fallback) {
      return { status: 'fallback_legacy', rag_meta: ragMeta, reason: 'low_score', resolution_path: 'rag_semantic_low_score' };
    }

    if (evalResult.ambiguous) {
      const publishable = [];
      for (const c of thresholded.slice(0, 3)) {
        const loaded = await loadPropertyFromChunk(db, c, logger);
        if (loaded?.property && isPropertyRowPublishable(loaded.property)) {
          publishable.push(c);
        }
      }
      if (publishable.length >= 2) {
        return wrapAmbiguousResult(publishable, { ragMeta });
      }
    }

    const loaded = await loadPropertyFromChunk(db, evalResult.top, logger);
    if (!loaded?.property || !isPropertyRowPublishable(loaded.property)) {
      return { status: 'fallback_legacy', rag_meta: ragMeta, reason: 'hidden_or_inactive' };
    }

    await ragService.persistRagQueryLog(db, {
      queryHash: search.query_hash,
      filters: {
        source: 'inventory',
        hint_zone: hintZone || null,
        domain: 'properties',
        conversation_id: null,
      },
      resultsCount: 1,
      latencyMs: search.latency_ms,
      fallbackUsed: false,
      citations: ragService.buildCitationsFromChunks([evalResult.top]),
    });

    return wrapFoundResult(loaded, { matchMethod: 'rag_semantic', ragMeta: { ...ragMeta, resolution_path: 'rag_semantic_found' } });
  } catch (err) {
    logger.warn?.('rag_inventory_resolve_failed', { error: String(err?.message || err) });
    return { status: 'fallback_legacy', reason: 'exception' };
  }
}

module.exports = {
  resolveInboundPropertyReference,
  extractListingIdFromChunk,
  loadPropertyFromChunk,
  buildInventoryRetrievalQuery,
  extractZoneFromNaturalQuery,
};
