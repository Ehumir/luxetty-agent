'use strict';

const { cleanSpaces } = require('../../../utils/text');
const {
  isShortPostCloseAck,
  isPostHandoffTerminalState,
  isHandoffPendingState,
  isPositiveHandoffAck,
} = require('../interpreter/objectionClassifier');

function firstName(state) {
  const full = cleanSpaces(String(state.collectedFields?.fullName || ''));
  if (!full) return null;
  return full.split(/\s+/)[0];
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 */
function composePostHandoffAck(state) {
  const nm = firstName(state);
  const head = nm ? `Con gusto, ${nm}.` : 'Con gusto.';
  return {
    responseText: `${head} Un asesor de Luxetty continuará contigo por este medio. Si surge algo más, me avisas.`,
    followUpQuestion: null,
    awaitingField: null,
    toneFlags: { consultive: true, postClose: true },
  };
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 */
function composeHandoffPendingPositiveAck(state) {
  const nm = firstName(state);
  const head = nm ? `Perfecto, ${nm}.` : 'Perfecto.';
  return {
    responseText: `${head} Quedó anotado; en breve un asesor de Luxetty te escribe por aquí.`,
    followUpQuestion: null,
    awaitingField: null,
    toneFlags: { consultive: true, handoffAck: true },
  };
}

function composeHandoffPendingContinuity(state) {
  const nm = firstName(state);
  const head = nm ? `Lamento la confusión, ${nm}.` : 'Lamento la confusión.';
  return {
    responseText: `${head} Ya tengo anotado el contexto y voy a canalizarlo con un asesor de Luxetty. Si te parece bien el contacto por este medio, un “sí” me ayuda a confirmarlo.`,
    followUpQuestion: null,
    awaitingField: state.awaitingField === 'advisor_contact_consent' ? 'advisor_contact_consent' : null,
    toneFlags: { consultive: true, handoffContinuity: true },
  };
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} text
 */
function tryComposePostHandoffTurn(state, text) {
  if (state.handoffWaitingFinalConfirmation || state.conversationSoftClosed) {
    const { tryResolveClosureIntegrityTurn } = require('../runtime/closureIntegrity');
    const closure = tryResolveClosureIntegrityTurn({ state, text });
    if (closure?.handled) {
      return {
        responseText: closure.reply,
        followUpQuestion: null,
        awaitingField: null,
        toneFlags: { consultive: true, closureIntegrity: true },
      };
    }
  }
  if (isPostHandoffTerminalState(state) && isShortPostCloseAck(text)) {
    return composePostHandoffAck(state);
  }
  if (isHandoffPendingState(state) && !isPostHandoffTerminalState(state)) {
    if (isPositiveHandoffAck(text)) {
      return composeHandoffPendingPositiveAck(state);
    }
    const t = String(text || '').toLowerCase();
    if (
      /no\s+me\s+est[aá]s?\s+entendiendo|no\s+entiendes|esto\s+no\s+sirve|no\s+sirve/i.test(t)
    ) {
      return composeHandoffPendingContinuity(state);
    }
  }
  return null;
}

module.exports = {
  composePostHandoffAck,
  composeHandoffPendingPositiveAck,
  composeHandoffPendingContinuity,
  tryComposePostHandoffTurn,
  firstName,
};
