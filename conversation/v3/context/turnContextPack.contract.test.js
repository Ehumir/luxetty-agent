'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TURN_CONTEXT_PACK_VERSION,
  createEmptyTurnContextPack,
  validateTurnContextPackMinimal,
} = require('./turnContextPack.types');

test('validateTurnContextPackMinimal — empty pack missing intent is ok structurally', () => {
  const pack = createEmptyTurnContextPack();
  pack.version = TURN_CONTEXT_PACK_VERSION;
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, true);
});

test('validateTurnContextPackMinimal — fail-closed PROPERTY_QA without property', () => {
  const pack = createEmptyTurnContextPack();
  pack.intent.primary = 'PROPERTY_QA';
  pack.propertyContext = { activeProperty: null };
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('PROPERTY_QA_WITHOUT_PROPERTY'));
  assert.ok(r.decisionCodes.includes('FAIL_CLOSED_PROPERTY_QA'));
});

test('validateTurnContextPackMinimal — PROPERTY_QA with property id passes gate', () => {
  const pack = createEmptyTurnContextPack();
  pack.intent.primary = 'PROPERTY_QA';
  pack.propertyContext = { activeProperty: { id: 'prop-uuid-1', code: 'LUX-A0490' } };
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, true);
});

test('validateTurnContextPackMinimal — fail-closed ambiguous lead', () => {
  const pack = createEmptyTurnContextPack();
  pack.decisionCodes = ['LEAD_ASK_WHICH'];
  pack.topic.leadId = 'AMBIGUOUS';
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('AMBIGUOUS_LEAD'));
  assert.ok(r.decisionCodes.includes('FAIL_CLOSED_AMBIGUOUS_LEAD'));
});

test('validateTurnContextPackMinimal — ambiguous lead must not bind real leadId', () => {
  const pack = createEmptyTurnContextPack();
  pack.slots.confirmed.leadAmbiguous = true;
  pack.topic.leadId = 'real-lead-uuid';
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('AMBIGUOUS_LEAD_WITH_BOUND_ID'));
});

test('validateTurnContextPackMinimal — null pack fail-closed', () => {
  const r = validateTurnContextPackMinimal(null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('PACK_MISSING'));
});

test('validateTurnContextPackMinimal — invalid version fail-closed', () => {
  const pack = createEmptyTurnContextPack();
  pack.version = 'TurnContextPackV0';
  const r = validateTurnContextPackMinimal(pack);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('PACK_VERSION_INVALID'));
});
