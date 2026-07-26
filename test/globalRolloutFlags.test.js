'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const flags = require('../config/accP0Flags');
const { evaluateV3PrimaryGate } = require('../config/perseoV3Flags');

const QA = '5218181877351';
const OTHER = '5299912345678';

describe('globalRolloutFlags — GO LIVE', () => {
  beforeEach(() => {
    delete process.env.RAG_P0_ENABLED;
    delete process.env.RAG_P0_GLOBAL_MODE;
    delete process.env.RAG_P0_ALLOWLIST;
    delete process.env.RAG_INVENTORY_ENABLED;
    delete process.env.RAG_RULES_ENABLED;
    delete process.env.PERSEO_V3_ENABLED;
    delete process.env.PERSEO_V3_GLOBAL_MODE;
    delete process.env.PERSEO_V3_QA_ALLOWLIST;
  });

  afterEach(() => {
    delete process.env.RAG_P0_GLOBAL_MODE;
    delete process.env.PERSEO_V3_GLOBAL_MODE;
  });

  it('GR-01 — RAG global mode: todos los teléfonos elegibles sin allowlist', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_INVENTORY_ENABLED = 'true';
    process.env.RAG_RULES_ENABLED = 'true';
    process.env.RAG_P0_GLOBAL_MODE = 'true';
    assert.equal(flags.isRagGlobalModeEnabled(), true);
    assert.equal(flags.isRagCanaryEligible(QA), true);
    assert.equal(flags.isRagCanaryEligible(OTHER), true);
    assert.equal(flags.isRagInventoryEffectiveForUser(OTHER), true);
  });

  it('GR-02 — RAG sin global ni allowlist → nadie elegible', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_INVENTORY_ENABLED = 'true';
    assert.equal(flags.isRagCanaryEligible(QA), false);
  });

  it('GR-03 — V3 global mode: todos entran v3_primary', () => {
    process.env.PERSEO_V3_ENABLED = 'true';
    process.env.PERSEO_V3_GLOBAL_MODE = 'true';
    const gate = evaluateV3PrimaryGate({ phone: OTHER });
    assert.equal(gate.v3_primary_allowed, true);
    assert.equal(gate.route, 'v3_primary');
    assert.equal(gate.v3_primary_bypass_reason, 'global_mode');
  });

  it('GR-04 — V3 allowlist legacy sigue funcionando sin global', () => {
    process.env.PERSEO_V3_ENABLED = 'true';
    process.env.PERSEO_V3_QA_ALLOWLIST = QA;
    assert.equal(evaluateV3PrimaryGate({ phone: QA }).v3_primary_allowed, true);
    assert.equal(evaluateV3PrimaryGate({ phone: OTHER }).v3_primary_allowed, false);
  });

  it('GR-05 — rollback: global OFF restaura allowlist gate', () => {
    process.env.RAG_P0_ENABLED = 'true';
    process.env.RAG_INVENTORY_ENABLED = 'true';
    process.env.RAG_P0_ALLOWLIST = QA;
    process.env.RAG_P0_GLOBAL_MODE = 'false';
    assert.equal(flags.isRagCanaryEligible(QA), true);
    assert.equal(flags.isRagCanaryEligible(OTHER), false);
  });
});
