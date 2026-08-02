'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tryParseDemandRefinement, isDemandRefinementMessage } = require('../conversation/v3/interpreter/demandRefinement');
const { createEmptyDecision } = require('../conversation/v3/types/conversationDecision');
const { CONVERSATION_GOALS, V3_INTENT } = require('../conversation/v3/types/constants');
const { createInitialConversationState } = require('../conversation/v3/types/conversationState');
const { resolvePropertyReferenceCode, appendPropertyHistory } = require('../conversation/v3/property/propertyHistory');

describe('demandRefinement', () => {
  it('detects refinement phrases', () => {
    assert.equal(isDemandRefinementMessage('quiero algo más grande'), true);
    assert.equal(isDemandRefinementMessage('mejor en otra zona'), true);
    assert.equal(isDemandRefinementMessage('con patio'), true);
  });

  it('parses zone refinement with explicit location', () => {
    const state = createInitialConversationState({ conversationId: 'r1' });
    state.conversationGoal = CONVERSATION_GOALS.BUY_PROPERTY;
    state.conversationGoalLocked = true;
    state.leadFlow = 'demand';
    state.operationType = 'sale';
    state.locationText = 'Cumbres';
    state.budget = 5_000_000;
    const decision = createEmptyDecision();
    const out = tryParseDemandRefinement(state, 'Mejor en San Pedro', 'Mejor en San Pedro', {}, decision);
    assert.ok(out);
    assert.equal(out.decision.detectedIntent, V3_INTENT.LOCATION_CAPTURE);
    assert.equal(out.patch.locationText, 'San Pedro');
  });

  it('property history resolves primera', () => {
    const state = createInitialConversationState({ conversationId: 'p1' });
    state.propertyHistory = appendPropertyHistory([], 'LUX-A0470');
    state.propertyListingCode = 'LUX-A0461';
    const code = resolvePropertyReferenceCode(state, '¿cuál era el precio de la primera?');
    assert.equal(code, 'LUX-A0470');

    state.showBatch = [{ code: 'LUX-A0461' }, { code: 'LUX-A0462' }];
    assert.equal(resolvePropertyReferenceCode(state, 'la segunda'), 'LUX-A0462');
    assert.equal(resolvePropertyReferenceCode(state, 'esa casa'), null);
    state.showBatch = [{ code: 'LUX-A0461' }];
    assert.equal(resolvePropertyReferenceCode(state, 'esa casa'), 'LUX-A0461');
  });
});
