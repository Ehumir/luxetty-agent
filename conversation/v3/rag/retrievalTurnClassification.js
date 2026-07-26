'use strict';

/**
 * F1A — clasificación de retrieval por turno (sin PII, sin falsificar rag_query_logs).
 * Códigos alineados a Master Plan V2.1 §7.2.
 */

const CLASSIFICATION = Object.freeze({
  INVENTORY_ONLY: 'inventory_only',
  PROPERTY_SOT_ONLY: 'property_sot_only',
  RAG_RETRIEVAL: 'rag_retrieval',
  RAG_AND_INVENTORY: 'rag_and_inventory',
  NO_RETRIEVAL_NEEDED: 'no_retrieval_needed',
  RETRIEVAL_FAILED: 'retrieval_failed',
  RETRIEVAL_SKIPPED_BY_POLICY: 'retrieval_skipped_by_policy',
});

/**
 * @param {{
 *   ragMeta?: object|null,
 *   inventoryMeta?: object|null,
 *   hasActiveProperty?: boolean,
 * }} input
 */
function classifyRetrievalTurn({ ragMeta = null, inventoryMeta = null, hasActiveProperty = false } = {}) {
  const invRan = !!(inventoryMeta && (inventoryMeta.source || inventoryMeta.emptyAfterSearch != null || inventoryMeta.operation));
  const ragSkipped = !ragMeta || ragMeta.skipped === true;
  const ragFailed = !!(ragMeta && ragMeta.fallback_reason === 'exception');
  const ragRan = !!(ragMeta && !ragSkipped && ragMeta.skipped !== true);

  if (ragMeta?.reason === 'not_eligible' || ragMeta?.allowlist_eligible === false) {
    if (invRan) return CLASSIFICATION.INVENTORY_ONLY;
    if (hasActiveProperty) return CLASSIFICATION.PROPERTY_SOT_ONLY;
    return CLASSIFICATION.RETRIEVAL_SKIPPED_BY_POLICY;
  }

  if (ragFailed) return CLASSIFICATION.RETRIEVAL_FAILED;

  if (ragRan && invRan) return CLASSIFICATION.RAG_AND_INVENTORY;
  if (ragRan) return CLASSIFICATION.RAG_RETRIEVAL;
  if (invRan) return CLASSIFICATION.INVENTORY_ONLY;
  if (hasActiveProperty) return CLASSIFICATION.PROPERTY_SOT_ONLY;

  if (ragSkipped && (ragMeta?.reason === 'no_rules_intent' || ragMeta?.skipped_reason === 'properties_domain_deferred_to_inventory')) {
    return ragMeta?.skipped_reason === 'properties_domain_deferred_to_inventory'
      ? CLASSIFICATION.INVENTORY_ONLY
      : CLASSIFICATION.NO_RETRIEVAL_NEEDED;
  }

  if (ragSkipped) return CLASSIFICATION.NO_RETRIEVAL_NEEDED;
  return CLASSIFICATION.NO_RETRIEVAL_NEEDED;
}

/**
 * Payload seguro para conversation_events (sin transcript / PII).
 */
function buildRetrievalClassificationPayload({
  classification,
  ragMeta = null,
  inventoryMeta = null,
  messageId = null,
} = {}) {
  return {
    kpi_version: 'f1a_1',
    classification,
    message_id: messageId || null,
    rag: ragMeta
      ? {
          skipped: !!ragMeta.skipped,
          reason: ragMeta.reason || ragMeta.skipped_reason || null,
          domain: ragMeta.domain || null,
          pipeline: ragMeta.pipeline || null,
          allowlist_eligible: ragMeta.allowlist_eligible !== false,
          fallback_used: !!ragMeta.fallback_used,
          rag_query_log_id: ragMeta.rag_query_log_id || null,
          latency_ms: ragMeta.latency_ms ?? null,
        }
      : null,
    inventory: inventoryMeta
      ? {
          source: inventoryMeta.source || null,
          empty: !!inventoryMeta.emptyAfterSearch,
          operation: inventoryMeta.operation || null,
          count: inventoryMeta.count ?? null,
        }
      : null,
  };
}

module.exports = {
  CLASSIFICATION,
  classifyRetrievalTurn,
  buildRetrievalClassificationPayload,
};
