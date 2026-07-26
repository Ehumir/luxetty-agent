'use strict';

const { normalizeText } = require('../../../utils/text');
const { CONVERSATION_STAGES, ADVISOR_CONTACT_CONSENT, CONVERSATION_GOALS } = require('../types/constants');
const { isSellValuationUnknownRequest } = require('./sellValuationSignals');

/** @typedef {'post_close_ack'|'handoff_pending_frustration'|'bot_identity'|'sell_valuation_unknown'|'sale_urgency_emotional'|'frustration_not_understood'|'useless'|'curt_direct_question'|'human_request'|'commission'|'competitor_price'|'no_exclusivity'|'already_listed'} ObjectionKind */

function isSaleUrgencyEmotional(text) {
  const t = normalizeText(String(text || ''));
  // "Ya te dije que renta" es corrección de operación, no urgencia de venta.
  if (/\bya\s+te\s+dije\b/.test(t) || /\bte\s+dije\s+que\b/.test(t)) return false;
  const urgent =
    /\b(?:urgente|urgencia|r[aá]pido|pronto|ya|inmediat|lo antes posible)\b/.test(t) ||
    /\b(?:preocupad|ansios|estresad|nervios|angustiad)\w*\b/.test(t);
  const sellRent =
    /\b(?:vender|venta|rentar|renta|publicar)\b/.test(t) ||
    /\b(?:mi\s+casa|mi\s+depa|mi\s+departamento|mi\s+propiedad)\b/.test(t);
  return urgent && sellRent;
}

function isShortPostCloseAck(text) {
  const { isHumanShortAck } = require('./humanTextRobustness');
  return isHumanShortAck(text);
}

function isPositiveHandoffAck(text) {
  const t = normalizeText(String(text || ''));
  if (isShortPostCloseAck(text)) return true;
  const { isFlexConsentAccept } = require('../../flexibility/shortReplyLexicon');
  if (isFlexConsentAccept(text)) return true;
  return (
    /^(?:si|sí|me parece muy bien|me parece bien|de acuerdo|perfecto|excelente|muy bien|va|ok|vale|claro)(?:\s+gracias)?$/i.test(
      t,
    ) || /\b(me parece\s+(?:muy\s+)?bien)\b/.test(t)
  );
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 */
function isHandoffFlowActive(state) {
  if (!state) return false;
  if (state.advisorContactConsent === ADVISOR_CONTACT_CONSENT.ACCEPTED) return true;
  const stage = state.conversationStage;
  if (
    stage === CONVERSATION_STAGES.HANDOFF_PENDING ||
    stage === CONVERSATION_STAGES.HANDOFF_READY ||
    stage === CONVERSATION_STAGES.CRM_READY
  ) {
    return true;
  }
  if (
    state.handoffStage === CONVERSATION_STAGES.HANDOFF_PENDING ||
    state.handoffStage === CONVERSATION_STAGES.HANDOFF_READY
  ) {
    return true;
  }
  return state.advisorContactConsent === ADVISOR_CONTACT_CONSENT.REQUESTED;
}

function isPostHandoffTerminalState(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.handoffWaitingFinalConfirmation === true || state.conversationSoftClosed === true) {
    return true;
  }
  const stage = state.conversationStage;
  return stage === CONVERSATION_STAGES.CRM_READY || stage === CONVERSATION_STAGES.HANDOFF_READY;
}

function isHandoffPendingState(state) {
  if (!state) return false;
  return (
    state.conversationStage === CONVERSATION_STAGES.HANDOFF_PENDING ||
    state.handoffStage === CONVERSATION_STAGES.HANDOFF_PENDING ||
    state.advisorContactConsent === ADVISOR_CONTACT_CONSENT.REQUESTED
  );
}

function isBotIdentityQuestion(text) {
  const t = normalizeText(String(text || ''))
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .trim();
  return /\b(eres\s+un?\s*)?bot\b|\binteligencia\s+artificial\b|\bsoy\s+ia\b/i.test(t);
}

function isExplicitHumanRequest(text) {
  const t = normalizeText(String(text || ''));
  return (
    /\bhablar\s+con\s+(alguien|una\s+persona|un\s+asesor|un\s+humano)\b/i.test(t) ||
    /\b(persona\s+real|humano\s+real)\b/i.test(t) ||
    /\bquiero\s+un\s+asesor\b/i.test(t)
  );
}

/**
 * @param {string} text
 * @param {import('../types/conversationState').ConversationState} state
 * @returns {ObjectionKind|null}
 */
function classifyObjection(text, state) {
  const t = normalizeText(String(text || ''));
  if (!t) return null;

  if (isPostHandoffTerminalState(state) && isShortPostCloseAck(text)) {
    return 'post_close_ack';
  }

  if (isHandoffPendingState(state) && !isPostHandoffTerminalState(state)) {
    if (/no\s+me\s+est[aá]s?\s+entendiendo|no\s+entiendes|no\s+est[aá]s?\s+entendiendo/i.test(t)) {
      return 'handoff_pending_frustration';
    }
    if (/esto\s+no\s+sirve|no\s+sirve|no\s+funciona/i.test(t)) {
      return 'handoff_pending_frustration';
    }
  }

  if (isBotIdentityQuestion(text) && !isExplicitHumanRequest(text)) {
    return 'bot_identity';
  }

  if (isSaleUrgencyEmotional(text)) {
    return 'sale_urgency_emotional';
  }

  if (
    state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY &&
    state.awaitingField === 'expected_price' &&
    isSellValuationUnknownRequest(text)
  ) {
    return 'sell_valuation_unknown';
  }

  if (isExplicitHumanRequest(text)) return 'human_request';
  if (/\bsolo\s+dime\b/i.test(t) && /\b(precio|opciones|depas|casas|propiedades)\b/i.test(t)) {
    return 'curt_direct_question';
  }
  if (/^solo\s+precio$/i.test(t)) return 'curt_direct_question';
  if (/no\s+me\s+est[aá]s?\s+entendiendo|no\s+entiendes|no\s+entiendo/i.test(t)) {
    return 'frustration_not_understood';
  }
  if (/esto\s+no\s+sirve|no\s+sirve/i.test(t)) return 'useless';

  if (/\bcomisi[oó]n\b|\bcu[aá]nto\s+cobran\b|\bqu[eé]\s+%\s+cobran/i.test(t)) return 'commission';
  if (/otra\s+inmobiliaria|cobran\s+menos|m[aá]s\s+barato/i.test(t)) return 'competitor_price';
  if (/no\s+quiero\s+exclusiva|sin\s+exclusiva|exclusiva\s+no/i.test(t)) return 'no_exclusivity';
  if (/ya\s+la\s+tengo\s+publicada|ya\s+est[aá]\s+publicada|ya\s+la\s+publiqu[eé]/i.test(t)) {
    return 'already_listed';
  }

  return null;
}

module.exports = {
  classifyObjection,
  isSaleUrgencyEmotional,
  isShortPostCloseAck,
  isPositiveHandoffAck,
  isPostHandoffTerminalState,
  isHandoffPendingState,
  isHandoffFlowActive,
  isBotIdentityQuestion,
  isExplicitHumanRequest,
};
