'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('demandSearchSlots', () => {
  const {
    readDemandSlots,
    mergeDemandSlots,
    toAiStatePatch,
    toV3StatePatch,
    buildInventorySearchMeta,
  } = require('../conversation/v3/rag/demandSearchSlots');

  it('unifica snake_case y camelCase', () => {
    const a = readDemandSlots({ operation_type: 'rent', location_text: 'Cumbres', budget_max: 25000 });
    const b = readDemandSlots({ operationType: 'sale', locationText: 'San Pedro', budget: 5000000 });
    assert.equal(a.operationType, 'rent');
    assert.equal(a.locationText, 'Cumbres');
    assert.equal(a.budgetMax, 25000);
    assert.equal(b.operationType, 'sale');
    assert.equal(b.budgetMax, 5000000);
  });

  it('merge mantiene zona/presupuesto entre turnos', () => {
    const prev = { location_text: 'Cumbres', budget_max: 30000, operation_type: 'rent' };
    const merged = mergeDemandSlots(prev, { bedrooms: 2 });
    assert.equal(merged.locationText, 'Cumbres');
    assert.equal(merged.budgetMax, 30000);
    assert.equal(merged.operationType, 'rent');
    assert.equal(merged.bedrooms, 2);
  });

  it('patches dual schema', () => {
    const slots = { operationType: 'sale', locationText: 'Valle', budgetMax: 1e6, bedrooms: 3 };
    assert.deepEqual(toAiStatePatch(slots).location_text, 'Valle');
    assert.deepEqual(toV3StatePatch(slots).budget, 1e6);
  });

  it('buildInventorySearchMeta incluye bedrooms', () => {
    const meta = buildInventorySearchMeta({
      attempted: true,
      operation: 'rent',
      zone: 'Cumbres',
      budgetMax: 20_000,
      bedrooms: 2,
      emptyAfterSearch: false,
    });
    assert.equal(meta.bedrooms, 2);
    assert.equal(meta.attempted, true);
  });
});

describe('domain routing RQ-3/4 modules', () => {
  it('classifyDomainIntent objeción → commercial_objections', () => {
    const { classifyDomainIntent } = require('../conversation/v3/rag/domainIntentClassifier');
    assert.equal(classifyDomainIntent('Me parece mucho la comisión').domain, 'commercial_objections');
  });

  it('threshold loader exposes certified map', () => {
    const { RQ4_CERTIFIED_THRESHOLDS, getThresholdAuditSnapshot } = require('../conversation/v3/rag/ragDomainThresholdLoader');
    assert.equal(RQ4_CERTIFIED_THRESHOLDS.properties, 0.78);
    const snap = getThresholdAuditSnapshot();
    assert.ok(snap && typeof snap === 'object');
    assert.ok(Object.keys(RQ4_CERTIFIED_THRESHOLDS).length >= 8);
  });

  it('campaign entity blocks inexistent when RC12 ON', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
    process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED = 'true';
    delete require.cache[require.resolve('../config/accP0Flags')];
    delete require.cache[require.resolve('../conversation/v3/rag/campaignEntityValidation')];
    const { validateCampaignEntityMatch } = require('../conversation/v3/rag/campaignEntityValidation');
    const probe = validateCampaignEntityMatch('campaña CampaniaInexistenteXYZ-999', [
      { content: 'Campaña Meta captación', similarity: 0.51, registry_domain_code: 'campaigns' },
    ]);
    assert.equal(probe.valid, false);
    delete process.env.RAG_P0_ENABLED;
    delete process.env.RAG_RULES_ENABLED;
    delete process.env.RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED;
  });

  it('zone entity blocks inexistent when RC11 ON', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
    process.env.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED = 'true';
    delete require.cache[require.resolve('../config/accP0Flags')];
    delete require.cache[require.resolve('../conversation/v3/rag/zoneEntityValidation')];
    const { validateZoneEntityMatch } = require('../conversation/v3/rag/zoneEntityValidation');
    const probe = validateZoneEntityMatch('zona ColoniaInexistenteXYZ-999', [
      { content: 'Colonia Cumbres Monterrey', similarity: 0.49, registry_domain_code: 'zones' },
    ]);
    assert.equal(probe.valid, false);
    delete process.env.RAG_P0_ENABLED;
    delete process.env.RAG_RULES_ENABLED;
    delete process.env.RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED;
  });

  it('runtime self-check pass with modules present', () => {
    const { runRagRuntimeSelfCheck } = require('../conversation/v3/rag/ragRuntimeSelfCheck');
    const check = runRagRuntimeSelfCheck();
    assert.equal(check.pass, true);
    assert.equal(check.modules.domainIntentClassifier, true);
    assert.equal(check.modules.domainRetrievalOrchestrator, true);
  });

  it('filterChunksByDomain isolates domain', () => {
    const { filterChunksByDomain } = require('../conversation/v3/rag/domainRetrievalOrchestrator');
    const out = filterChunksByDomain(
      [
        { registry_domain_code: 'zones', chunk_id: '1' },
        { registry_domain_code: 'campaigns', chunk_id: '2' },
      ],
      'zones'
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].chunk_id, '1');
  });
});
