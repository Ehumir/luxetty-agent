'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ragService = require('../services/ragService');
const { filterChunksByDomain, retrieveWithDomainRouting } = require('../conversation/v3/rag/domainRetrievalOrchestrator');
const { resetThresholdLoaderForTests } = require('../conversation/v3/rag/ragDomainThresholdLoader');

const originalSemanticSearch = ragService.semanticSearch;

describe('domainRetrievalOrchestrator — RQ-3', () => {
  beforeEach(() => {
    ragService.semanticSearch = originalSemanticSearch;
    resetThresholdLoaderForTests();
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
  });

  afterEach(() => {
    ragService.semanticSearch = originalSemanticSearch;
    resetThresholdLoaderForTests();
    delete process.env.RAG_P0_ENABLED;
    delete process.env.RAG_RULES_ENABLED;
    delete process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED;
    delete process.env.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED;
    delete process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED;
  });

  it('RQ3-RO-01 — filterChunksByDomain descarta properties', () => {
    const chunks = [
      { registry_domain_code: 'commercial_objections', similarity: 0.8 },
      { registry_domain_code: 'properties', similarity: 0.9 },
    ];
    const out = filterChunksByDomain(chunks, 'commercial_objections');
    assert.equal(out.length, 1);
    assert.equal(out[0].registry_domain_code, 'commercial_objections');
  });

  it('RQ3-RO-02 — captación no compite con properties en top1', async () => {
    ragService.semanticSearch = async (_db, opts) => {
      if (opts.rpcName === 'match_knowledge_chunks') {
        return {
          chunks: [
            { chunk_id: 'p1', registry_domain_code: 'properties', similarity: 0.85, content: 'San Pedro listing' },
            { chunk_id: 'c1', registry_domain_code: 'commercial_objections', similarity: 0.72, content: 'captación' },
          ],
          fallback: false,
          query_hash: 'h1',
          latency_ms: 10,
        };
      }
      return { chunks: [], fallback: true, query_hash: 'h2', latency_ms: 5 };
    };

    const db = { rpc: async () => ({ data: [], error: null }) };
    const routed = await retrieveWithDomainRouting(db, {
      query: 'Quiero vender mi casa en San Pedro',
    });

    assert.equal(routed.intent.domain, 'commercial_objections');
    assert.equal(routed.routing.domain_selected, 'commercial_objections');
    assert.ok(routed.routing.cross_domain_discarded >= 1);
    assert.equal(routed.top1?.registry_domain_code, 'commercial_objections');
  });

  it('RQ47-RO-03 — secondary fallback cuando primary vacío (alta confianza)', async () => {
    let calls = 0;
    ragService.semanticSearch = async (_db, opts) => {
      calls += 1;
      if (opts.rpcName === 'match_knowledge_chunks' && calls === 1) {
        return { chunks: [], fallback: false, query_hash: 'empty', latency_ms: 5 };
      }
      if (opts.rpcName === 'match_knowledge_chunks') {
        return {
          chunks: [
            {
              chunk_id: 's1',
              registry_domain_code: 'scripts',
              similarity: 0.82,
              content: 'script seguimiento',
            },
          ],
          fallback: false,
          query_hash: 'sec',
          latency_ms: 8,
        };
      }
      return { chunks: [], fallback: true, query_hash: 'x', latency_ms: 1 };
    };

    process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';
    const db = { rpc: async () => ({ data: [], error: null }) };
    const routed = await retrieveWithDomainRouting(db, {
      query: 'Me parece mucho la comisión que cobran',
    });
    assert.equal(routed.routing.domain_detected, 'commercial_objections');
    assert.equal(routed.routing.secondary_domain_used, true);
    assert.equal(routed.routing.domain_selected, 'scripts');
    assert.equal(routed.fallback, false);
  });

  it('RC11-RO-01 — NEG-03 fuerza fallback por zone entity mismatch', async () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
    process.env.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED = 'true';
    ragService.semanticSearch = async (_db, opts) => {
      if (opts.rpcName === 'match_knowledge_chunks') {
        return {
          chunks: [
            {
              chunk_id: 'z1',
              registry_domain_code: 'zones',
              similarity: 0.49,
              content: 'Colonia Cumbres en Monterrey',
            },
            {
              chunk_id: 'z2',
              registry_domain_code: 'zones',
              similarity: 0.48,
              content: 'San Pedro Garza García',
            },
          ],
          fallback: false,
          query_hash: 'zones',
          latency_ms: 120,
          embedding_ms: 80,
          rpc_ms: 40,
        };
      }
      return { chunks: [], fallback: true, query_hash: 'x', latency_ms: 1 };
    };

    const db = { rpc: async () => ({ data: [], error: null }) };
    const routed = await retrieveWithDomainRouting(db, {
      query: 'zona ColoniaInexistenteXYZ-999',
    });
    assert.equal(routed.intent.domain, 'zones');
    assert.equal(routed.fallback, true);
    assert.equal(routed.routing.fallback_reason, 'zone_entity_mismatch');
    delete process.env.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED;
  });

  it('RC12-RO-01 — NEG-C01 fuerza fallback por campaign entity mismatch', async () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
    process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED = 'true';
    ragService.semanticSearch = async (_db, opts) => {
      if (opts.rpcName === 'match_knowledge_chunks') {
        return {
          chunks: [
            {
              chunk_id: 'c1',
              registry_domain_code: 'campaigns',
              similarity: 0.51,
              content: 'Campaña de captación Meta Ads para propiedades',
            },
          ],
          fallback: false,
          query_hash: 'campaigns',
          latency_ms: 120,
          embedding_ms: 80,
          rpc_ms: 40,
        };
      }
      return { chunks: [], fallback: true, query_hash: 'x', latency_ms: 1 };
    };

    const db = { rpc: async () => ({ data: [], error: null }) };
    const routed = await retrieveWithDomainRouting(db, {
      query: 'campaña CampaniaInexistenteXYZ-999',
    });
    assert.equal(routed.intent.domain, 'campaigns');
    assert.equal(routed.fallback, true);
    assert.equal(routed.routing.fallback_reason, 'campaign_entity_mismatch');
    delete process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED;
  });

  it('RC12-RO-02 — flag OFF mantiene comportamiento previo en campaigns', async () => {
    process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
    process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';
    process.env.RAG_DOMAIN_THRESHOLDS_JSON =
      '{"properties":0.78,"commercial_objections":0.55,"assignment_rules":0.55,"rules_atena":0.45,"rules_perseo":0.45,"zones":0.45,"campaigns":0.45,"scripts":0.72}';
    resetThresholdLoaderForTests();
    delete process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED;
    ragService.semanticSearch = async (_db, opts) => {
      if (opts.rpcName === 'match_knowledge_chunks') {
        return {
          chunks: [
            {
              chunk_id: 'c1',
              registry_domain_code: 'campaigns',
              similarity: 0.51,
              content: 'Campaña de captación Meta Ads',
            },
          ],
          fallback: false,
          query_hash: 'campaigns',
          latency_ms: 100,
        };
      }
      return { chunks: [], fallback: true, query_hash: 'x', latency_ms: 1 };
    };

    const db = { rpc: async () => ({ data: [], error: null }) };
    const routed = await retrieveWithDomainRouting(db, {
      query: 'campaña CampaniaInexistenteXYZ-999',
    });
    assert.equal(routed.fallback, false);
    assert.notEqual(routed.routing.fallback_reason, 'campaign_entity_mismatch');
    delete process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED;
  });
});
