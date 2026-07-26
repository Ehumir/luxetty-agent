'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getMinScoreForDomain,
  getThresholdAuditSnapshot,
  resetThresholdLoaderForTests,
  parseThresholdJson,
  RQ4_CERTIFIED_THRESHOLDS,
} = require('../conversation/v3/rag/ragDomainThresholdLoader');

describe('ragDomainThresholdLoader — RQ-4.6', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    resetThresholdLoaderForTests();
  });

  beforeEach(() => {
    resetThresholdLoaderForTests();
  });

  it('RQ46-T01 — adaptive OFF uses global 0.72', () => {
    delete process.env.RAG_DOMAIN_ROUTING_ENABLED;
    delete process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED;
    assert.equal(getMinScoreForDomain('commercial_objections'), 0.72);
  });

  it('RQ46-T02 — adaptive ON uses certified defaults', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
    process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';
    assert.equal(getMinScoreForDomain('commercial_objections'), RQ4_CERTIFIED_THRESHOLDS.commercial_objections);
    assert.equal(getMinScoreForDomain('rules_atena'), 0.45);
  });

  it('RQ46-T03 — parses env JSON', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
    process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';
    process.env.RAG_DOMAIN_THRESHOLDS_JSON = JSON.stringify({ commercial_objections: 0.55 });
    resetThresholdLoaderForTests();
    const snap = getThresholdAuditSnapshot();
    assert.equal(snap.source, 'env_json');
    assert.equal(getMinScoreForDomain('commercial_objections'), 0.55);
  });

  it('RQ46-T04 — invalid JSON falls back safely', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
    process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';
    process.env.RAG_DOMAIN_THRESHOLDS_JSON = '{bad';
    resetThresholdLoaderForTests();
    const snap = getThresholdAuditSnapshot();
    assert.ok(snap.load_error);
    assert.equal(getMinScoreForDomain('zones'), RQ4_CERTIFIED_THRESHOLDS.zones);
  });

  it('RQ46-T05 — parseThresholdJson validates range', () => {
    assert.throws(() => parseThresholdJson({ commercial_objections: 0.1 }));
  });
});
