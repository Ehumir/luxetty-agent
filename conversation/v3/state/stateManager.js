'use strict';

const { mergeConversationState } = require('../types/conversationState');
const { mergeEffectiveRuntimeState } = require('./effectiveStateMerge');
const { evaluateRuleGuard } = require('../rules/ruleGuard');
const { resolveNextStage } = require('../stages/stageEngine');
const { resolveIdentityState } = require('../identity/identityResolver');
const { applyGoalOwnership } = require('../ownership/goalLock');
const { v3Log } = require('../core/v3Logger');

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {Partial<import('../types/conversationState').ConversationState>} patch
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 */
function applyV3StateTransition(state, patch, decision) {
  const prevStage = state.conversationStage;
  const prevIdentity = state.identityState;
  const ownedPatch = applyGoalOwnership(state, patch, decision);
  const entityFields = Object.keys(decision.extractedEntities || {}).map((field) =>
    field === 'fullName' ? 'collectedFields.fullName' : field,
  );
  const explicitFields = new Set(entityFields);
  if (decision.explicitFlowSwitch) {
    for (const field of ['operationType', 'propertyListingCode', 'activeProperty']) {
      if (ownedPatch[field] !== undefined) explicitFields.add(field);
    }
  }
  let next = mergeEffectiveRuntimeState(state, ownedPatch, {
    source: 'customer_current_turn',
    confidence: decision.confidence || 0,
    reason: decision.detectedIntent || 'interpreted_customer_turn',
    explicitFields: [...explicitFields],
    allowClearFields: decision.explicitFlowSwitch
      ? ['propertyListingCode', 'activeProperty', 'showBatch']
      : [],
  });
  next = mergeConversationState(next, { identityState: resolveIdentityState(next) });
  const stage = resolveNextStage(next.conversationStage, decision, next);
  next = mergeConversationState(next, { conversationStage: stage });
  const guard = evaluateRuleGuard(next, decision, {});

  if (stage !== prevStage) {
    v3Log('stage_transition', {
      from: prevStage,
      to: stage,
      conversation_id: next.conversationId,
    });
  }
  if (next.identityState !== prevIdentity) {
    v3Log('identity_change', {
      from: prevIdentity,
      to: next.identityState,
      conversation_id: next.conversationId,
    });
  }
  if (next.conversationGoalLocked) {
    v3Log('goal_locked', {
      goal: next.conversationGoal,
      confidence: next.goalConfidence,
      conversation_id: next.conversationId,
    });
  }
  if (!guard.allowed) {
    v3Log('rule_block', {
      violations: guard.violations,
      conversation_id: next.conversationId,
    });
  }

  return { state: next, guard };
}

module.exports = {
  applyV3StateTransition,
};
