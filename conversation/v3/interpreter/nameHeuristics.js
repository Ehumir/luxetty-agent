'use strict';

const { normalizeText } = require('../../../utils/text');
const { CONVERSATION_STAGES } = require('../types/constants');
const { isLikelyFirstNameOnly } = require('./identityCompoundCapture');
const { normalizeLocationFromUserText, isBareKnownZoneToken } = require('./locationNormalizer');

const NON_NAME_EXACT = new Set([
  'nada',
  'no',
  'nop',
  'ya',
  'ok',
  'vale',
  'claro',
  'si',
  'sí',
  'bueno',
  'ninguno',
  'ninguna',
  'gracias',
  'va',
  'hola',
  'perdon',
  'perdón',
  'disculpa',
]);

const NON_NAME_PATTERNS = [
  /ya te dije/,
  /por que preguntas/,
  /por qué preguntas/,
  /preguntas eso/,
  /no entiendes/,
  /no entiendo/,
  /no estas entendiendo/,
  /no estás entendiendo/,
  /solo dime/,
  /\bprecio\b/,
  /\bopciones\b/,
  /\bnada\b/,
  /\?$/,
  /\b(desocupad|ocupad|habitad|libre|rentad)\b/,
  /\best[aá]\s+(en|desocupad|libre|ocupad)/,
  /\b(?:quiero|busco|necesito)\s+(?:comprar|vender|rentar)\b/,
  /\ben\s+realidad\b/,
  /\b(?:perdon|perdón|disculpa)\b/,
  /\b(?:cerca|avenida|anuncio|campa[nñ]a|presupuesto|millones?)\b/,
  /\bvi\s+su\s+anuncio\b/,
  /^(ok\s+)?sigue$/,
  /\b(?:la\s+m[aá]s\s+barata|sin\s+ruido|con\s+vigilancia|ok\s+sigue)\b/,
];

/**
 * @param {string} text
 */
function isNonNameUtterance(text) {
  const t = normalizeText(String(text || ''));
  if (!t) return true;
  if (NON_NAME_EXACT.has(t)) return true;
  if (NON_NAME_PATTERNS.some((p) => p.test(t))) return true;
  if (t.split(/\s+/).length > 6) return true;
  return false;
}

/**
 * Tonos Luxetty: reconoce solicitud de nombre profesional (no "¿cómo te llamo/llamas?").
 * @param {import('../types/conversationState').ConversationState} state
 */
function isAwaitingIdentityName(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.awaitingField === 'full_name') return true;
  if (state.conversationStage === CONVERSATION_STAGES.IDENTITY_PENDING) return true;
  const q = String(state.lastAssistantQuestion || state.lastAssistantReply || '');
  return (
    /compartes tu nombre|comparte tu nombre/i.test(q) ||
    /me dices tu nombre|me dices como te llamas/i.test(q) ||
    /c[oó]mo te llamas/i.test(q) ||
    /qui[eé]n tengo el gusto/i.test(q) ||
    /me ayudas con tu nombre/i.test(q) ||
    /para continuar.*nombre/i.test(q) ||
    /para seguir.*nombre/i.test(q) ||
    /me compartes.*tu nombre/i.test(q) ||
    /zona y tu nombre/i.test(q) ||
    /en qu[eé] zona.*nombre/i.test(q)
  );
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} text
 * @param {{ explicitNameMatch?: boolean }} [opts]
 */
function shouldAcceptAsIdentityName(state, text, opts = {}) {
  if (state.collectedFields?.fullName) return false;
  if (opts.explicitNameMatch) return !isNonNameUtterance(text);
  if (!isAwaitingIdentityName(state) && !isHandoffPendingMissingName(state)) return false;
  if (isNonNameUtterance(text)) return false;
  const raw = String(text || '').trim();
  if (isBareKnownZoneToken(raw) || normalizeLocationFromUserText(raw)) return false;
  if (!raw) return false;
  if (/\bwhatsapp\b|por\s+whatsapp|por\s+wa\b/i.test(raw)) return false;
  if (!isLikelyFirstNameOnly(raw)) return false;
  return true;
}

/**
 * Durante handoff pendiente el usuario puede responder con su nombre antes del consentimiento explícito.
 */
function isHandoffPendingMissingName(state) {
  if (!state || state.collectedFields?.fullName) return false;
  const stage = state.conversationStage || state.handoffStage;
  if (stage !== CONVERSATION_STAGES.HANDOFF_PENDING) return false;
  if (state.awaitingField === 'advisor_contact_consent') return true;
  return state.advisorContactConsent === 'REQUESTED';
}

module.exports = {
  isNonNameUtterance,
  isAwaitingIdentityName,
  isHandoffPendingMissingName,
  shouldAcceptAsIdentityName,
};
