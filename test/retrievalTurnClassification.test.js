'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLASSIFICATION,
  classifyRetrievalTurn,
  buildRetrievalClassificationPayload,
} = require('../conversation/v3/rag/retrievalTurnClassification');

test('classifyRetrievalTurn — inventory_only when RAG skipped by policy and inventory ran', () => {
  const c = classifyRetrievalTurn({
    ragMeta: { skipped: true, reason: 'not_eligible', allowlist_eligible: false },
    inventoryMeta: { source: 'sql', emptyAfterSearch: false, operation: 'rent', count: 3 },
  });
  assert.equal(c, CLASSIFICATION.INVENTORY_ONLY);
});

test('classifyRetrievalTurn — retrieval_skipped_by_policy without inventory', () => {
  const c = classifyRetrievalTurn({
    ragMeta: { skipped: true, reason: 'not_eligible', allowlist_eligible: false },
  });
  assert.equal(c, CLASSIFICATION.RETRIEVAL_SKIPPED_BY_POLICY);
});

test('classifyRetrievalTurn — rag_and_inventory', () => {
  const c = classifyRetrievalTurn({
    ragMeta: { skipped: false, domain: 'rules_perseo', rag_query_log_id: 'x' },
    inventoryMeta: { source: 'sql', operation: 'sale', count: 2 },
  });
  assert.equal(c, CLASSIFICATION.RAG_AND_INVENTORY);
});

test('classifyRetrievalTurn — properties deferred → inventory_only', () => {
  const c = classifyRetrievalTurn({
    ragMeta: {
      skipped: true,
      skipped_reason: 'properties_domain_deferred_to_inventory',
    },
  });
  assert.equal(c, CLASSIFICATION.INVENTORY_ONLY);
});

test('buildRetrievalClassificationPayload — no PII fields', () => {
  const p = buildRetrievalClassificationPayload({
    classification: CLASSIFICATION.RAG_RETRIEVAL,
    ragMeta: { skipped: false, domain: 'zones', latency_ms: 12, rag_query_log_id: 'abc' },
    messageId: 'mid',
  });
  const s = JSON.stringify(p);
  assert.equal(p.classification, CLASSIFICATION.RAG_RETRIEVAL);
  assert.ok(!/"phone"|transcript|nombre|whatsapp/i.test(s));
});
