'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDomainIntent,
  detectRulesDomain,
  shouldBlockInventoryForRulesIntent,
  OFFICIAL_DOMAINS,
} = require('../conversation/v3/rag/domainIntentClassifier');

describe('domainIntentClassifier — RQ-3', () => {
  it('RQ3-IC-01 — comisión → commercial_objections', () => {
    const r = classifyDomainIntent('Me parece mucho la comisión que cobran');
    assert.equal(r.domain, 'commercial_objections');
    assert.ok(r.confidence >= 0.75);
  });

  it('RQ3-IC-02 — captación gana sobre demanda inventario', () => {
    const r = classifyDomainIntent('Quiero vender mi casa en San Pedro');
    assert.equal(r.domain, 'commercial_objections');
    assert.equal(r.reason, 'captacion_propietario_keywords');
    assert.equal(shouldBlockInventoryForRulesIntent('Quiero vender mi casa en San Pedro'), true);
  });

  it('RQ3-IC-03 — demanda inventario → properties', () => {
    const r = classifyDomainIntent('Busco casa con jardín en Cumbres');
    assert.equal(r.domain, 'properties');
  });

  it('RQ3-IC-04 — LUX listing → properties', () => {
    const r = classifyDomainIntent('Info LUX-A0453');
    assert.equal(r.domain, 'properties');
  });

  it('RQ3-IC-05 — asignación → assignment_rules', () => {
    assert.equal(classifyDomainIntent('¿Cómo funciona la asignación de contactos?').domain, 'assignment_rules');
  });

  it('RQ3-IC-06 — solo dominios oficiales', () => {
    for (const q of ['comisión', 'Busco casa', 'zona Cumbres', 'campaña meta']) {
      assert.ok(OFFICIAL_DOMAINS.includes(classifyDomainIntent(q).domain));
    }
  });

  it('RQ3-IC-08 — valuación → commercial_objections', () => {
    const r = classifyDomainIntent('¿Cuánto vale mi casa?');
    assert.equal(r.domain, 'commercial_objections');
    assert.equal(r.reason, 'valuacion_keywords');
  });

  it('RQ47-C01 — stripHarnessNoise quita tag QA', () => {
    const { stripHarnessNoise } = require('../conversation/v3/rag/domainIntentClassifier');
    const out = stripHarnessNoise('comisión alta [rq5-1783385980459]');
    assert.equal(out, 'comisión alta');
  });
});
