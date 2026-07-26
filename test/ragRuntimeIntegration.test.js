'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runRagRuntimeSelfCheck } = require('../conversation/v3/rag/ragRuntimeSelfCheck');
const { resetThresholdLoaderForTests } = require('../conversation/v3/rag/ragDomainThresholdLoader');

describe('ragRuntimeIntegration — RQ-4.6', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetThresholdLoaderForTests();
  });

  it('RQ46-I01 — self-check modules load', () => {
    const report = runRagRuntimeSelfCheck();
    assert.equal(report.modules.domainIntentClassifier, true);
    assert.equal(report.modules.domainRetrievalOrchestrator, true);
    assert.equal(report.modules.ragDomainThresholdLoader, true);
    assert.equal(report.pass, true);
  });

  it('RQ46-I02 — legacy path when routing flag OFF', () => {
    delete process.env.RAG_DOMAIN_ROUTING_ENABLED;
    const { enrichTurnWithRagContextLegacy } = require('../conversation/v3/rag/ragTurnOrchestrator');
    assert.equal(typeof enrichTurnWithRagContextLegacy, 'function');
  });

  it('RQ46-I03 — rq3 path when routing flag ON', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
    const { enrichTurnWithRagContextRq3 } = require('../conversation/v3/rag/ragTurnOrchestrator');
    assert.equal(typeof enrichTurnWithRagContextRq3, 'function');
  });
});
