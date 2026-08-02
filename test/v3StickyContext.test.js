'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  stampStickyContext,
  enforceStickyContext,
  isStickyContextActive,
  releaseStickyContext,
} = require('../conversation/v3/ownership/stickyContext');
const { CONVERSATION_GOALS } = require('../conversation/v3/types/constants');
const { createInitialConversationState } = require('../conversation/v3/types/conversationState');
const { mergeEffectiveRuntimeState } = require('../conversation/v3/state/effectiveStateMerge');

describe('v3StickyContext', () => {
  it('stamps sticky fields on goal lock', () => {
    const patch = {
      conversationGoalLocked: true,
      conversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      leadFlow: 'offer',
      operationType: 'sale',
    };
    stampStickyContext(patch);
    assert.equal(patch.stickyLeadFlow, 'offer');
    assert.equal(patch.stickyOperationType, 'sale');

    const base = createInitialConversationState({ conversationId: 'merge-protected' });
    base.operationType = 'sale';
    base.locationText = 'Cumbres';
    base.collectedFields.fullName = 'Jorge';
    const weak = mergeEffectiveRuntimeState(
      base,
      { operationType: 'rent', locationText: null, collectedFields: { fullName: '' } },
      { source: 'classifier_inference', confidence: 0.4, reason: 'weak_classifier' },
    );
    assert.equal(weak.operationType, 'sale');
    assert.equal(weak.locationText, 'Cumbres');
    assert.equal(weak.collectedFields.fullName, 'Jorge');
    assert.equal(weak.rejectedStateMutations.length, 3);
  });

  it('blocks offer to demand flip without explicit switch', () => {
    const state = {
      conversationGoalLocked: true,
      stickyLeadFlow: 'offer',
      stickyOperationType: 'sale',
      stickyConversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      conversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      leadFlow: 'offer',
    };
    const patch = enforceStickyContext(
      state,
      { leadFlow: 'demand', conversationGoal: CONVERSATION_GOALS.BUY_PROPERTY },
      { explicitFlowSwitch: false }
    );
    assert.equal(patch.leadFlow, 'offer');
    assert.equal(isStickyContextActive(state), true);
  });

  it('releases sticky on explicitFlowSwitch', () => {
    const patch = {
      stickyLeadFlow: 'offer',
      stickyOperationType: 'sale',
      stickyConversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
    };
    releaseStickyContext(patch);
    assert.equal(patch.stickyLeadFlow, null);
    const out = enforceStickyContext(
      { stickyLeadFlow: 'offer', conversationGoalLocked: true },
      { leadFlow: 'demand', conversationGoal: CONVERSATION_GOALS.BUY_PROPERTY },
      { explicitFlowSwitch: true }
    );
    assert.equal(out.leadFlow, 'demand');
    assert.equal(out.stickyLeadFlow, null);

    const base = createInitialConversationState({ conversationId: 'merge-explicit' });
    base.operationType = 'sale';
    const changed = mergeEffectiveRuntimeState(base, { operationType: 'rent' }, {
      source: 'customer_current_turn',
      confidence: 0.95,
      reason: 'customer_explicitly_requested_rent',
      explicitFields: ['operationType'],
    });
    assert.equal(changed.operationType, 'rent');
    assert.equal(changed.lastStateMutation.previous_value, 'sale');
    assert.equal(changed.lastStateMutation.new_value, 'rent');
    assert.equal(changed.lastStateMutation.reason, 'customer_explicitly_requested_rent');
  });

  it('allows buy patch when explicitFlowSwitch after sell sticky', () => {
    const state = {
      conversationGoalLocked: true,
      stickyLeadFlow: 'offer',
      stickyOperationType: 'sale',
      stickyConversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      conversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      leadFlow: 'offer',
    };
    const patch = enforceStickyContext(
      state,
      {
        conversationGoal: CONVERSATION_GOALS.BUY_PROPERTY,
        leadFlow: 'demand',
        operationType: 'sale',
        conversationGoalLocked: true,
      },
      { explicitFlowSwitch: true }
    );
    assert.equal(patch.leadFlow, 'demand');
    assert.equal(patch.conversationGoal, CONVERSATION_GOALS.BUY_PROPERTY);
    stampStickyContext(patch);
    assert.equal(patch.stickyLeadFlow, 'demand');
  });

  it('maps budget to expectedPrice on sell sticky', () => {
    const state = {
      conversationGoalLocked: true,
      stickyConversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
      stickyLeadFlow: 'offer',
      stickyOperationType: 'sale',
    };
    const patch = enforceStickyContext(state, { budget: 5000000 }, { explicitFlowSwitch: false });
    assert.equal(patch.expectedPrice, 5000000);
    assert.equal(patch.budget, null);
  });
});
