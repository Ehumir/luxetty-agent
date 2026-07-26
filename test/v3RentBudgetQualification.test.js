'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PREV_HANDOFF = process.env.PERSEO_V3_HANDOFF_ENABLED;
const PREV_CRM = process.env.PERSEO_V3_CRM_DRY_RUN;

before(() => {
  process.env.PERSEO_V3_HANDOFF_ENABLED = 'true';
  process.env.PERSEO_V3_CRM_DRY_RUN = 'true';
});

after(() => {
  if (PREV_HANDOFF === undefined) delete process.env.PERSEO_V3_HANDOFF_ENABLED;
  else process.env.PERSEO_V3_HANDOFF_ENABLED = PREV_HANDOFF;
  if (PREV_CRM === undefined) delete process.env.PERSEO_V3_CRM_DRY_RUN;
  else process.env.PERSEO_V3_CRM_DRY_RUN = PREV_CRM;
});

const { parseMoneyAmount } = require('../conversation/v3/interpreter/moneyParser');
const { processV3Turn, clearV3Session } = require('../conversation/v3');
const { evaluateQualification } = require('../conversation/v3/planner/qualificationPlanner');
const { CONVERSATION_GOALS, CONVERSATION_STAGES, ADVISOR_CONTACT_CONSENT } = require('../conversation/v3/types/constants');
const { mapV3StateToLegacyAiState } = require('../conversation/v3/state/v3ToLegacyAiState');

describe('moneyParser — rent budget MX formats', () => {
  for (const [input, expected] of [
    ['25 mil', 25_000],
    ['25000', 25_000],
    ['$25,000', 25_000],
    ['presupuesto 25 mil', 25_000],
    ['renta mensual 25 mil', 25_000],
    ['presupuesto 8 millones', 8_000_000],
    ['menos de 50 mil', 50_000],
    ['debajo de 25 mil pesos', 25_000],
    ['menor a 50 mil', 50_000],
    ['menos de 5 millones', 5_000_000],
  ]) {
    it(`parseMoneyAmount("${input}") => ${expected}`, () => {
      assert.equal(parseMoneyAmount(input), expected);
    });
  }

  it('no confunde recámaras con presupuesto', () => {
    assert.equal(parseMoneyAmount('2 recámaras'), null);
  });
});

describe('V3 rent budget qualification (R-043)', () => {
  it('A) renta por turnos — 25 mil persiste budget', () => {
    const cid = 'rent-budget-a';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'Quiero rentar en Cumbres' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });
    const last = processV3Turn({ conversationId: cid, phone: '521', text: '25 mil' });
    assert.equal(last.ok, true);
    assert.equal(last.state.budget, 25_000);
    const planner = evaluateQualification(last.state);
    assert.equal(planner.missingSlots.includes('budget'), false);
    const legacy = mapV3StateToLegacyAiState(last.state);
    assert.equal(legacy.budget_max, 25_000);
  });

  it('B) renta — 25000 directo con awaiting budget', () => {
    const cid = 'rent-budget-b';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'Quiero rentar en Cumbres' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });
    const last = processV3Turn({ conversationId: cid, phone: '521', text: '25000' });
    assert.equal(last.state.budget, 25_000);
    assert.equal(evaluateQualification(last.state).missingSlots.includes('budget'), false);
  });

  it('C) renta en primer mensaje — zona, budget y recámaras', () => {
    const cid = 'rent-budget-c';
    clearV3Session(cid);
    const r = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: 'Quiero rentar en Cumbres, presupuesto 25 mil, 2 recámaras',
    });
    assert.equal(r.ok, true);
    assert.equal(r.state.operationType, 'rent');
    assert.equal(r.state.conversationGoal, CONVERSATION_GOALS.RENT_PROPERTY);
    assert.match(String(r.state.locationText || ''), /Cumbres/i);
    assert.equal(r.state.budget, 25_000);
    assert.equal(r.state.bedrooms, 2);
    const planner = evaluateQualification(r.state);
    assert.equal(planner.missingSlots.includes('budget'), false);
    assert.match(String(r.reply || ''), /nombre|llamas/i);
    assert.doesNotMatch(String(r.reply || ''), /presupuesto mensual|renta mensual te queda/i);
  });

  it('D) compra — presupuesto millones no regresa', () => {
    const cid = 'rent-budget-d';
    clearV3Session(cid);
    const r = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: 'Busco casa en San Pedro, presupuesto 8 millones',
    });
    assert.equal(r.state.operationType, 'sale');
    assert.equal(r.state.conversationGoal, CONVERSATION_GOALS.BUY_PROPERTY);
    assert.equal(r.state.budget, 8_000_000);
    assert.match(String(r.state.locationText || ''), /San Pedro/i);
  });

  it('E) handoff asesor — HANDOFF_READY y consent', () => {
    const cid = 'rent-budget-e';
    clearV3Session(cid);
    processV3Turn({
      conversationId: cid,
      phone: '521',
      text: 'Quiero rentar en Cumbres, presupuesto 25 mil, 2 recámaras',
    });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });
    const handoff = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: 'Ya quiero hablar con un asesor',
    });
    assert.equal(handoff.ok, true);
    assert.match(String(handoff.reply || ''), /asesor|humano|equipo/i);
    const consent = processV3Turn({ conversationId: cid, phone: '521', text: 'Sí' });
    assert.equal(consent.ok, true);
    assert.ok(
      consent.state.conversationStage === CONVERSATION_STAGES.HANDOFF_READY ||
        consent.state.conversationStage === CONVERSATION_STAGES.CRM_READY,
      `stage=${consent.state.conversationStage}`,
    );
    assert.equal(consent.state.advisorContactConsent, ADVISOR_CONTACT_CONSENT.ACCEPTED);
    assert.match(String(consent.reply || ''), /asesor/i);
  });
});
