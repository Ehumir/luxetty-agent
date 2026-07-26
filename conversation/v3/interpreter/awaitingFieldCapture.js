'use strict';

const { parseMoneyAmount } = require('./moneyParser');
const { tryParseQualificationLocation } = require('./sellLocationCapture');
const { normalizeLocationFromUserText, isBareKnownZoneToken } = require('./locationNormalizer');
const { shouldAcceptAsIdentityName, isNonNameUtterance } = require('./nameHeuristics');
const { extractAffirmationName } = require('./identityNameParser');
const { isLikelyFirstNameOnly, parseChannelPreference } = require('./identityCompoundCapture');
const { parseAdvisorContactConsent } = require('../planner/consentParser');
const { parseOccupancyStatus } = require('./occupancyParser');
const { isSlotFilled } = require('../state/slotFillState');
const {
  mentionsRentDemand,
  mentionsBuyDemand,
  isExplicitFlowSwitchToRentDemand,
} = require('./campaignIntake');
const { normalizeText, cleanSpaces } = require('../../../utils/text');
const { V3_INTENT } = require('../types/constants');

/**
 * Campo que el asistente está esperando (prioridad sobre reclasificación de intención).
 * @param {import('../types/conversationState').ConversationState} state
 */
function resolveActiveAwaitingField(state) {
  if (state.awaitingField) return state.awaitingField;
  if (state.lastAskedField) return state.lastAskedField;
  return null;
}

function tryCapturePendingIdentity(state, raw, patch, decision) {
  if (state.collectedFields?.fullName) return null;

  const t = normalizeText(raw);
  if (parseMoneyAmount(raw) != null) return null;
  if (
    isExplicitFlowSwitchToRentDemand(raw) ||
    mentionsBuyDemand(t) ||
    (mentionsRentDemand(t) && !/\brentar\s+mi\b/.test(t))
  ) {
    return null;
  }

  const affName = extractAffirmationName(raw);
  if (affName && isLikelyFirstNameOnly(affName)) {
    patch.collectedFields = { ...(patch.collectedFields || {}), fullName: affName };
    decision.extractedEntities.fullName = affName;
    decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
    decision.confidence = 0.93;
    patch.awaitingField = state.locationText ? null : 'location_text';
    patch.lastAskedField = null;
    decision.shouldAskName = false;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (
    shouldAcceptAsIdentityName(state, raw, { explicitNameMatch: false }) &&
    !isNonNameUtterance(raw) &&
    !isBareKnownZoneToken(raw) &&
    !normalizeLocationFromUserText(raw)
  ) {
    const nameMatch = raw.match(/^(?:soy|me llamo|mi nombre es)\s+(.+)/i);
    const nm = cleanSpaces(nameMatch ? nameMatch[1] : String(raw || '').trim());
    if (nm && isLikelyFirstNameOnly(nm)) {
      patch.collectedFields = { ...(patch.collectedFields || {}), fullName: nm };
      decision.extractedEntities.fullName = nm;
      decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
      decision.confidence = 0.93;
      patch.awaitingField = state.locationText ? null : 'location_text';
      patch.lastAskedField = null;
      decision.shouldAskName = false;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  return null;
}

/**
 * Interpreta mensajes cortos como respuesta al campo pendiente.
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} raw
 * @param {string} text
 * @param {Partial<import('../types/conversationState').ConversationState>} patch
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 * @returns {{ patch: object, decision: object }|null}
 */
function tryResolveAwaitingFieldCapture(state, raw, text, patch, decision) {
  const field = resolveActiveAwaitingField(state);
  if (!field || !state.conversationGoalLocked) return null;

  const t = normalizeText(raw);
  // Demanda / pivotes explícitos no se interpretan como respuesta al slot pendiente.
  if (
    isExplicitFlowSwitchToRentDemand(raw) ||
    mentionsBuyDemand(t) ||
    (mentionsRentDemand(t) && !/\brentar\s+mi\b/.test(t))
  ) {
    return null;
  }

  if (
    !state.locationText &&
    (field === 'location_text' || field === 'full_name') &&
    (isBareKnownZoneToken(raw) || normalizeLocationFromUserText(raw))
  ) {
    const loc =
      normalizeLocationFromUserText(raw) ||
      tryParseQualificationLocation(state, raw) ||
      cleanSpaces(String(raw || '')).slice(0, 120);
    if (loc && loc.length >= 2) {
      decision.detectedIntent = V3_INTENT.LOCATION_CAPTURE;
      decision.confidence = 0.93;
      patch.locationText = loc;
      patch.awaitingField = null;
      patch.lastAskedField = null;
      decision.extractedEntities.locationText = loc;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  if (field === 'location_text' || field === 'full_name') {
    const identityCapture = tryCapturePendingIdentity(state, raw, patch, decision);
    if (identityCapture) return identityCapture;
  }

  if (field === 'location_text') {
    const loc = tryParseQualificationLocation(state, raw) || normalizeLocationFromUserText(raw);
    if (!loc || loc.length < 2) return null;
    decision.detectedIntent = V3_INTENT.LOCATION_CAPTURE;
    decision.confidence = 0.92;
    patch.locationText = loc;
    patch.awaitingField = null;
    patch.lastAskedField = null;
    decision.extractedEntities.locationText = loc;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (
    state.budget == null &&
    state.leadFlow === 'demand' &&
    field === 'budget' &&
    parseMoneyAmount(text) != null
  ) {
    const amount = parseMoneyAmount(text);
    decision.detectedIntent = V3_INTENT.BUYER_BUDGET;
    patch.budget = amount;
    decision.extractedEntities.budget = amount;
    decision.confidence = 0.9;
    patch.awaitingField = null;
    patch.lastAskedField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if ((field === 'budget' || field === 'expected_price') && !isSlotFilled(state, field)) {
    const amount = parseMoneyAmount(text);
    if (amount == null) return null;
    if (field === 'expected_price' || state.leadFlow === 'offer') {
      if (amount <= 0) return null;
      decision.detectedIntent = V3_INTENT.SELLER_PRICE;
      patch.expectedPrice = amount;
      patch.budget = null;
      decision.extractedEntities.expectedPrice = amount;
    } else {
      decision.detectedIntent = V3_INTENT.BUYER_BUDGET;
      patch.budget = amount;
      decision.extractedEntities.budget = amount;
    }
    decision.confidence = 0.9;
    patch.awaitingField = null;
    patch.lastAskedField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (field === 'occupancy_status') {
    const occ = parseOccupancyStatus(text);
    if (!occ) return null;
    patch.occupancyStatus = occ;
    patch.collectedFields = { ...(patch.collectedFields || {}), occupancyStatus: occ };
    decision.detectedIntent = V3_INTENT.OCCUPANCY_CAPTURE;
    decision.confidence = 0.92;
    patch.awaitingField = null;
    patch.lastAskedField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (field === 'advisor_contact_consent') {
    const consent = parseAdvisorContactConsent(text);
    if (!consent) return null;
    decision.detectedIntent = V3_INTENT.ADVISOR_CONSENT_CAPTURE;
    decision.confidence = 0.94;
    patch.advisorContactConsent = consent;
    const channel = parseChannelPreference(normalizeText(text));
    if (channel) patch.channelPreference = channel;
    patch.awaitingField = null;
    patch.lastAskedField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  return null;
}

module.exports = {
  resolveActiveAwaitingField,
  tryResolveAwaitingFieldCapture,
};
