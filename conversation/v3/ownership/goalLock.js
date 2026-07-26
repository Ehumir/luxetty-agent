'use strict';

const { CONVERSATION_GOALS } = require('../types/constants');
const { isLandingCaptureActive } = require('../interpreter/landingCaptureFlow');
const { releaseStickyContext, stampStickyContext, enforceStickyContext } = require('./stickyContext');

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {Partial<import('../types/conversationState').ConversationState>} patch
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 * @returns {Partial<import('../types/conversationState').ConversationState>}
 */
function applyGoalOwnership(state, patch, decision) {
  const out = { ...patch };

  if (out.crossIntentPrimaryRail === 'demand') {
    out.conversationGoal = CONVERSATION_GOALS.BUY_PROPERTY;
    out.conversationGoalLocked = true;
    out.goalConfidence = Math.max(state.goalConfidence || 0, 0.88);
    out.leadFlow = 'demand';
    out.operationType = out.operationType === 'rent' ? 'rent' : 'sale';
    out.propertySpecificIntent = false;
    delete out.crossIntentPrimaryRail;
    return enforceStickyContext(state, out, decision);
  }

  if (decision.explicitFlowSwitch) {
    releaseStickyContext(out);
  }

  // Landing sticky solo mientras el flujo de captación sigue activo.
  // Si el intérprete pivota a demanda (explicitFlowSwitch) o apaga landing en el patch, no forzar offer.
  const landingStillActive =
    out.landingCaptureFlow !== false &&
    (out.landingCaptureFlow === true || isLandingCaptureActive(state));

  if (landingStillActive && !decision.explicitFlowSwitch) {
    out.conversationGoal = CONVERSATION_GOALS.SELL_PROPERTY;
    out.conversationGoalLocked = true;
    out.leadFlow = 'offer';
    out.propertySpecificIntent = false;
    if (out.operationType !== 'sale' && out.operationType !== 'rent') {
      out.operationTypePending = true;
      delete out.operationType;
    } else {
      out.operationTypePending = false;
    }
    stampStickyContext(out);
    return enforceStickyContext(state, out, decision);
  }

  if (state.conversationGoalLocked && !decision.explicitFlowSwitch) {
    if (out.conversationGoal != null && out.conversationGoal !== state.conversationGoal) {
      delete out.conversationGoal;
      delete out.leadFlow;
      delete out.operationType;
    }
  }

  if (decision.detectedIntent === 'SELL_PROPERTY' || out.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY) {
    if (!state.conversationGoalLocked || decision.explicitFlowSwitch || state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY) {
      out.conversationGoal = CONVERSATION_GOALS.SELL_PROPERTY;
      out.conversationGoalLocked = true;
      out.goalConfidence = Math.max(state.goalConfidence || 0, decision.confidence || 0.85);
      out.leadFlow = 'offer';
      if (!isLandingCaptureActive(state) && out.landingCaptureFlow !== true) {
        out.operationType = 'sale';
      }
      out.propertySpecificIntent = false;
    }
  }

  if (
    decision.detectedIntent === 'PROPERTY_INQUIRY' ||
    out.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY
  ) {
    if (!state.conversationGoalLocked || decision.explicitFlowSwitch) {
      out.conversationGoal = CONVERSATION_GOALS.PROPERTY_INQUIRY;
      out.conversationGoalLocked = true;
      out.goalConfidence = Math.max(state.goalConfidence || 0, decision.confidence || 0.88);
      out.leadFlow = 'demand';
      out.operationType = out.operationType === 'rent' ? 'rent' : 'sale';
      out.propertySpecificIntent = true;
    }
  }

  if (decision.detectedIntent === 'BUY_PROPERTY' || out.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY) {
    if (!state.conversationGoalLocked || decision.explicitFlowSwitch) {
      out.conversationGoal = CONVERSATION_GOALS.BUY_PROPERTY;
      out.conversationGoalLocked = true;
      out.goalConfidence = Math.max(state.goalConfidence || 0, decision.confidence || 0.8);
      out.leadFlow = 'demand';
      out.operationType = 'sale';
      out.propertySpecificIntent = false;
    }
  }

  if (decision.detectedIntent === 'RENT_PROPERTY') {
    if (!state.conversationGoalLocked || decision.explicitFlowSwitch) {
      out.conversationGoal = CONVERSATION_GOALS.RENT_PROPERTY;
      out.conversationGoalLocked = true;
      out.goalConfidence = Math.max(state.goalConfidence || 0, decision.confidence || 0.8);
      out.leadFlow = 'demand';
      out.operationType = 'rent';
    }
  }

  if (decision.detectedIntent === 'RENT_OUT_PROPERTY' || out.conversationGoal === CONVERSATION_GOALS.RENT_OUT_PROPERTY) {
    if (!state.conversationGoalLocked || decision.explicitFlowSwitch) {
      out.conversationGoal = CONVERSATION_GOALS.RENT_OUT_PROPERTY;
      out.conversationGoalLocked = true;
      out.goalConfidence = Math.max(state.goalConfidence || 0, decision.confidence || 0.85);
      out.leadFlow = 'offer';
      out.operationType = 'rent';
    }
  }

  if (state.conversationGoalLocked && !decision.explicitFlowSwitch) {
    if (state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY) {
      out.leadFlow = 'offer';
      if (isLandingCaptureActive(state) && (state.operationTypePending || out.operationTypePending)) {
        if (out.operationType !== 'sale' && out.operationType !== 'rent') {
          out.operationTypePending = true;
          delete out.operationType;
        }
      } else {
        out.operationType = 'sale';
      }
      if (out.budget != null) {
        out.expectedPrice = out.expectedPrice ?? out.budget;
        out.budget = null;
      }
    }
    if (state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY) {
      out.leadFlow = 'demand';
      out.operationType = 'sale';
    }
    if (state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY) {
      out.leadFlow = 'demand';
      out.operationType = 'rent';
    }
    if (state.conversationGoal === CONVERSATION_GOALS.RENT_OUT_PROPERTY) {
      out.leadFlow = 'offer';
      out.operationType = 'rent';
    }
    if (state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY) {
      out.leadFlow = 'demand';
      out.operationType = state.operationType === 'rent' ? 'rent' : 'sale';
      out.propertySpecificIntent = true;
      if (state.propertyListingCode && out.propertyListingCode === undefined) {
        out.propertyListingCode = state.propertyListingCode;
      }
    }
  }

  stampStickyContext(out);
  return enforceStickyContext(state, out, decision);
}

module.exports = {
  applyGoalOwnership,
};
