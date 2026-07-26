'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isExplicitFlowSwitchToRentDemand,
  mentionsRentDemand,
  isRentOutOwnerPhrase,
} = require('../conversation/v3/interpreter/campaignIntake');
const { interpretUserMessage } = require('../conversation/v3/interpreter/minimalInterpreter');
const { CONVERSATION_GOALS } = require('../conversation/v3/types/constants');
const { isLikelyFirstNameOnly } = require('../conversation/v3/interpreter/identityCompoundCapture');
const { leadTypesEquivalent } = require('../argos/scenarioRunner');

function lockedOfferState(over = {}) {
  return {
    conversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
    conversationGoalLocked: true,
    leadFlow: 'offer',
    operationType: 'sale',
    locationText: 'Cumbres',
    expectedPrice: 8_000_000,
    landingCaptureFlow: true,
    landingCaptureStage: 'property_type',
    awaitingField: 'property_type',
    collectedFields: {},
    ...over,
  };
}

describe('P0 sticky offer → rent demand break', () => {
  const matrix = [
    {
      ctx: 'Seller capture',
      msg: 'Busco casas en renta en Cumbres',
      expectOp: 'rent',
      expectLead: 'demand',
    },
    {
      ctx: 'Landlord capture',
      msg: 'Quiero rentar una casa para vivir',
      expectOp: 'rent',
      expectLead: 'demand',
    },
    {
      ctx: 'Sticky offer',
      msg: 'Muéstrame opciones de renta',
      expectOp: 'rent',
      expectLead: 'demand',
    },
    {
      ctx: 'Greeting + demanda',
      msg: 'Hola, busco casa en renta',
      expectOp: 'rent',
      expectLead: 'demand',
    },
    {
      ctx: 'Además comprar',
      msg: 'Además quiero comprar una casa',
      expectOp: 'sale',
      expectLead: 'demand',
      expectGoal: CONVERSATION_GOALS.BUY_PROPERTY,
    },
  ];

  for (const row of matrix) {
    it(`${row.ctx}: "${row.msg}" → ${row.expectLead}/${row.expectOp}`, () => {
      assert.equal(isRentOutOwnerPhrase(row.msg), false);
      if (/\brenta\b/.test(row.msg.toLowerCase()) || /\brentar\b/.test(row.msg.toLowerCase())) {
        if (!/comprar/.test(row.msg.toLowerCase())) {
          assert.equal(mentionsRentDemand(row.msg) || isExplicitFlowSwitchToRentDemand(row.msg), true);
        }
      }
      const r = interpretUserMessage(lockedOfferState(), row.msg);
      assert.equal(r.decision.explicitFlowSwitch, true);
      assert.equal(r.patch.leadFlow, row.expectLead);
      assert.equal(r.patch.operationType, row.expectOp);
      if (row.expectGoal) assert.equal(r.patch.conversationGoal, row.expectGoal);
      assert.equal(r.patch.landingCaptureFlow, false);
    });
  }

  it('Quiero rentar mi casa → offer rent (no demand break)', () => {
    const msg = 'Quiero rentar mi casa';
    assert.equal(isRentOutOwnerPhrase(msg), true);
    const r = interpretUserMessage(lockedOfferState({ landingCaptureFlow: false }), msg);
    assert.notEqual(r.patch.leadFlow, 'demand');
  });

  it('identity heuristics reject intent/refinement phrases', () => {
    assert.equal(isLikelyFirstNameOnly('Mejor quiero comprar'), false);
    assert.equal(isLikelyFirstNameOnly('Más cerca de avenida'), false);
    assert.equal(isLikelyFirstNameOnly('Perdón'), false);
    assert.equal(isLikelyFirstNameOnly('Héctor'), true);
  });

  it('lead_type offer ≡ supply in ARGOS harness', () => {
    assert.equal(leadTypesEquivalent('offer', 'supply'), true);
    assert.equal(leadTypesEquivalent('demand', 'demand'), true);
    assert.equal(leadTypesEquivalent('offer', 'demand'), false);
  });
});
