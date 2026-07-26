'use strict';

const { normalizeText, cleanSpaces } = require('../../../utils/text');
const { createEmptyDecision } = require('../types/conversationDecision');
const {
  CONVERSATION_STAGES,
  V3_INTENT,
  CONVERSATION_GOALS,
  ADVISOR_CONTACT_CONSENT,
} = require('../types/constants');
const { detectFrustration } = require('./frustrationDetector');
const { normalizeLocationFromUserText, isBareKnownZoneToken } = require('./locationNormalizer');
const { shouldAcceptAsIdentityName, isAwaitingIdentityName } = require('./nameHeuristics');
const { isExplicitHumanRequest, isHandoffFlowActive } = require('./objectionClassifier');
const { parsePropertyType } = require('./propertyTypeParser');
const { parseOccupancyStatus } = require('./occupancyParser');
const { tryParseSellLocation, tryParseQualificationLocation } = require('./sellLocationCapture');
const { tryResolveAwaitingFieldCapture } = require('./awaitingFieldCapture');
const { parseAdvisorContactConsent, shouldParseConsentTurn } = require('../planner/consentParser');
const { isV3HandoffEnabled } = require('../../../config/perseoV3Flags');
const { extractPropertyListingCode } = require('./propertyListingCode');
const {
  matchesSellerAcquisitionPattern,
  extractLooseLocationPhrase,
  isThinGenericInbound,
  mentionsRentDemand,
  isRentOutOwnerPhrase,
  inferOwnerOfferOperation,
  isC2SellerRetargetingEntry,
  isAmbiguousOwnerPropertyOrientation,
  mentionsBuyDemand,
  isExplicitFlowSwitchToRentDemand,
  isExplicitFlowSwitchToRentOut,
  isExplicitFlowSwitchToSellFromRent,
  isExplicitPropertyInquiryPhrase,
  isIntentCorrectionPhrase,
} = require('./campaignIntake');
const {
  matchesLandingCaptureInbound,
  tryInterpretLandingCapture,
  isLandingCaptureActive,
} = require('./landingCaptureFlow');
const { splitNameAndTail, parseChannelPreference, isLikelyFirstNameOnly } = require('./identityCompoundCapture');
const { extractAffirmationName } = require('./identityNameParser');
const { isOfferValuationUnknownRequest, isSellValuationLeadIntent } = require('./offerValuationSignals');
const { classifyPropertyInquiryTurn, classifyFactFamily } = require('./propertyInquiryQaClassifier');
const { parsePaymentMethod } = require('./paymentMethodParser');
const { isConversationalFlexEnabled } = require('../../../config/perseoM405Flags');
const { isFlexShortAck } = require('../../flexibility/shortReplyLexicon');
const { recordFlexApplied } = require('../../flexibility/flexTelemetry');
const { isSocialRapportMessage } = require('../composer/openingVariantPicker');
const { tryParseDemandRefinement } = require('./demandRefinement');
const { isSoftTopicDismissal, isBudgetDismissalOnly, parseTopicPivot } = require('./topicPivotSignals');
const { appendPropertyHistory, resolvePropertyReferenceCode } = require('../property/propertyHistory');

const { parseMoneyAmount } = require('./moneyParser');
const { normalizeConversationalTypos, isHumanShortAck } = require('./humanTextRobustness');

function isBareBuyMenuReply(t) {
  return /^(comprar|compra|quiero comprar|busco comprar)$/.test(t);
}

function hasSubstantiveIntentAfterGreeting(t, raw) {
  if (matchesBuyOpenSearchPattern(t, raw)) return true;
  if (matchesSellerAcquisitionPattern(t)) return true;
  if (mentionsRentDemand(t)) return true;
  if (isRentOutIntent(raw)) return true;
  if (isBareBuyMenuReply(t)) return true;
  if (/\b(?:comprar|vender|rentar|busco|quiero|necesito)\b/.test(t) && t.length > 8) return true;
  return false;
}

function matchesBuyOpenSearchPattern(t, raw) {
  if (mentionsRentDemand(t) && !isRentOutIntent(raw)) return false;
  if (mentionsBuyDemand(t)) return true;
  if (isExplicitFlowSwitchToBuy(raw)) return true;
  if (isBareBuyMenuReply(t)) return true;
  if (/\bbusco\b/.test(t) && /\bcasa\b/.test(t) && !/\brenta\b/.test(t)) return true;
  if (/\bbusco\b/.test(t) && /\b(depa|depto|departamento)\b/.test(t) && !/\brenta\b/.test(t)) return true;
  if (/\bbusco\b/.test(t) && /\bcomprar\b/.test(t)) return true;
  if (/\b(?:quiero|necesito)\s+comprar\b/.test(t)) return true;
  if (/\bme\s+interesa\s+comprar\b/.test(t)) return true;
  if (
    /\b(?:estoy\s+)?buscando\b/.test(t) &&
    /\b(?:casa|depa|departamento|inmueble)\b/.test(t) &&
    !/\b(?:vender|mi\s+)\b/.test(t)
  ) {
    return true;
  }
  if (/\bbusco\b/.test(t) && /\ben\s+[a-záéíóúñ]/i.test(String(raw || ''))) return true;
  if (/\bbusco\b/.test(t) && /\balgo\b/.test(t)) return true;
  if (/\bbusco\b/.test(t) && parseMoneyAmount(raw) != null) return true;
  if (/\b(?:presupuesto|credito|crédito)\b/.test(t) && /\b(?:comprar|casa|depa)\b/.test(t)) return true;
  return false;
}

function applyBuyDemandPatch(patch, raw, decision) {
  patch.conversationGoal = CONVERSATION_GOALS.BUY_PROPERTY;
  patch.leadFlow = 'demand';
  patch.operationType = 'sale';
  patch.landingCaptureFlow = false;
  patch.landingCaptureStage = null;
  patch.expectedPrice = null;
  const zoneBuy = normalizeLocationFromUserText(raw) || extractLooseLocationPhrase(raw);
  if (zoneBuy && !/^(busco|quiero|necesito)\b/i.test(normalizeText(zoneBuy))) {
    patch.locationText = zoneBuy;
    decision.extractedEntities.locationText = zoneBuy;
  }
  const prop = parsePropertyType(raw);
  if (prop) applyPropertyTypePatch(patch, prop);
  const amount = parseMoneyAmount(raw);
  if (amount != null) {
    patch.budget = amount;
    decision.extractedEntities.budget = amount;
  }
}

function applyRentDemandPatch(patch, raw, decision) {
  patch.conversationGoal = CONVERSATION_GOALS.RENT_PROPERTY;
  patch.leadFlow = 'demand';
  patch.operationType = 'rent';
  patch.landingCaptureFlow = false;
  patch.landingCaptureStage = null;
  patch.expectedPrice = null;
  const zoneRent = normalizeLocationFromUserText(raw) || extractLooseLocationPhrase(raw);
  if (zoneRent && !/^(busco|quiero|necesito|rentar)\b/i.test(normalizeText(zoneRent))) {
    patch.locationText = zoneRent;
    decision.extractedEntities.locationText = zoneRent;
  }
  const prop = parsePropertyType(raw);
  if (prop) applyPropertyTypePatch(patch, prop);
  const amount = parseMoneyAmount(raw);
  if (amount != null) {
    patch.budget = amount;
    decision.extractedEntities.budget = amount;
  }
  const br = parseBedrooms(raw);
  if (br != null) {
    patch.bedrooms = br;
    decision.extractedEntities.bedrooms = br;
  }
}

function parseBedrooms(text) {
  const t = normalizeText(text);
  const m = t.match(/(\d+)\s*(recamaras?|recámaras?|habitaciones?|cuartos?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 20 ? n : null;
}

function isExplicitFlowSwitchToBuy(text) {
  const t = normalizeText(text);
  if (mentionsRentDemand(t) && !isRentOutIntent(text)) return false;
  return (
    t.includes('ahora busco comprar') ||
    t.includes('en realidad busco') ||
    t.includes('mejor quiero comprar') ||
    (/\bno\s+quiero\s+vender\b/.test(t) && /\b(?:comprar|busco)\b/.test(t)) ||
    (/\bbusco\b/.test(t) && (t.includes('comprar') || (t.includes('casa') && !/\brenta\b/.test(t)))) ||
    t.includes('quiero comprar')
  );
}

function isExplicitFlowSwitchToSell(text) {
  const t = normalizeText(text);
  if (/\bno\s+quiero\s+vender\b/.test(t) && /\b(?:comprar|busco)\b/.test(t)) return false;
  return (
    (/\bquiero\s+vender\b/.test(t) && !/\bno\s+quiero\s+vender\b/.test(t)) ||
    t.includes('vender mi') ||
    t.includes('poner en venta') ||
    t.includes('mejor quiero vender') ||
    t.includes('en realidad quiero vender')
  );
}

function isRentOutIntent(text) {
  return isRentOutOwnerPhrase(normalizeText(text));
}

function isOfferFlow(state) {
  return (
    state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY ||
    state.conversationGoal === CONVERSATION_GOALS.RENT_OUT_PROPERTY ||
    state.leadFlow === 'offer'
  );
}

function sellOfferPriceSatisfied(state) {
  if (state.expectedPrice != null) return true;
  if (state.valuationRequested === true || state.priceUnknown === true) return true;
  if (state.collectedFields?.valuationRequested === true) return true;
  return false;
}

function isShortAck(text) {
  if (isHumanShortAck(text)) {
    if (isConversationalFlexEnabled() && isFlexShortAck(text)) {
      recordFlexApplied('short_ack');
    }
    return true;
  }
  const t = normalizeText(text);
  return t === 'nada' || t === 'no' || t === 'ya';
}

/** Mensaje de usuario que indica solo preferencia por WhatsApp (texto ya normalizado o mixto). */
const WHATSAPP_ONLY_REPLY = /^(?:wa|whatsapp|por\s+wa|por\s+whatsapp)$/i;

function applyPropertyTypePatch(patch, type) {
  if (!type) return;
  patch.propertyType = type;
  patch.collectedFields = { ...(patch.collectedFields || {}), propertyType: type };
}

function applyOccupancyPatch(patch, status) {
  if (!status) return;
  patch.occupancyStatus = status;
  patch.collectedFields = { ...(patch.collectedFields || {}), occupancyStatus: status };
  patch.awaitingField = null;
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} text
 * @param {{ campaignHeadline?: string|null }} [options]
 */
function interpretUserMessage(state, text, options = {}) {
  const raw = cleanSpaces(normalizeConversationalTypos(String(text || '')));
  const t = normalizeText(raw);
  const decision = createEmptyDecision();
  /** @type {Partial<import('../types/conversationState').ConversationState>} */
  const patch = { lastUserText: raw, topicPivotTurn: false, flowSwitchAck: false };

  const headline = options.campaignHeadline != null ? String(options.campaignHeadline).slice(0, 400) : null;
  if (headline) {
    patch.campaignHeadline = headline;
  }

  if (
    state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY &&
    matchesBuyOpenSearchPattern(t, raw)
  ) {
    decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
    decision.confidence = 0.88;
    decision.explicitFlowSwitch = true;
    patch.propertyListingCode = null;
    patch.propertySpecificIntent = false;
    patch.propertySubMode = null;
    patch.awaitingField = null;
    applyBuyDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  const sellFromRentLocked =
    state.conversationGoalLocked &&
    state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY &&
    isExplicitFlowSwitchToSellFromRent(text);

  const landingConsentPending =
    state.awaitingField === 'advisor_contact_consent' ||
    (state.handoffStage === CONVERSATION_STAGES.HANDOFF_PENDING &&
      state.advisorContactConsent === ADVISOR_CONTACT_CONSENT.REQUESTED);

  if (
    !landingConsentPending &&
    (isLandingCaptureActive(state) || matchesLandingCaptureInbound(t))
  ) {
    const landingEarly = tryInterpretLandingCapture(state, raw, t, patch, decision);
    if (landingEarly) return landingEarly;
  }

  const awaitingCapture = tryResolveAwaitingFieldCapture(state, raw, text, patch, decision);
  if (awaitingCapture) return awaitingCapture;

  if (
    isOfferFlow(state) &&
    (state.awaitingField === 'expected_price' || !sellOfferPriceSatisfied(state)) &&
    isOfferValuationUnknownRequest(text)
  ) {
    patch.priceUnknown = true;
    patch.valuationRequested = true;
    patch.collectedFields = {
      ...(patch.collectedFields || {}),
      valuationRequested: true,
    };
    patch.awaitingField = state.collectedFields?.fullName ? 'occupancy_status' : 'full_name';
    patch.lastAskedField = null;
    decision.detectedIntent = V3_INTENT.UNKNOWN;
    decision.confidence = 0.9;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const offerConsentEarly = parseAdvisorContactConsent(text);
  if (
    offerConsentEarly === 'ACCEPTED' &&
    !extractAffirmationName(raw) &&
    isOfferFlow(state) &&
    state.collectedFields?.fullName &&
    state.locationText &&
    sellOfferPriceSatisfied(state)
  ) {
    decision.detectedIntent = V3_INTENT.ADVISOR_CONSENT_CAPTURE;
    decision.confidence = 0.94;
    patch.advisorContactConsent = 'ACCEPTED';
    patch.awaitingField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (
    state.conversationGoalLocked &&
    !state.locationText &&
    isBareKnownZoneToken(raw) &&
    (state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY ||
      state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY)
  ) {
    const loc = normalizeLocationFromUserText(raw) || cleanSpaces(raw).slice(0, 120);
    if (loc) {
      decision.detectedIntent = V3_INTENT.LOCATION_CAPTURE;
      decision.confidence = 0.9;
      patch.locationText = loc;
      patch.awaitingField = null;
      decision.extractedEntities.locationText = loc;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  if (
    state.conversationGoalLocked &&
    (state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY ||
      state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY) &&
    (isSoftTopicDismissal(raw) || isBudgetDismissalOnly(raw))
  ) {
    const pivot = parseTopicPivot(raw);
    if (pivot.clearBudget) {
      patch.budget = null;
    }
    if (pivot.clearZone && !pivot.newZone) {
      patch.locationText = null;
    }
    if (pivot.newZone) {
      patch.locationText = pivot.newZone;
      decision.extractedEntities.locationText = pivot.newZone;
    }
    patch.topicPivotTurn = true;
    decision.detectedIntent = pivot.newZone ? V3_INTENT.LOCATION_CAPTURE : V3_INTENT.UNKNOWN;
    decision.confidence = 0.86;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const demandRefinement = tryParseDemandRefinement(state, raw, text, patch, decision);
  if (demandRefinement) return demandRefinement;

  if (
    state.conversationGoalLocked &&
    isOfferFlow(state) &&
    isExplicitFlowSwitchToRentDemand(text)
  ) {
    decision.detectedIntent = V3_INTENT.RENT_PROPERTY;
    decision.confidence = 0.9;
    decision.explicitFlowSwitch = true;
    applyRentDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  if (
    state.conversationGoalLocked &&
    isOfferFlow(state) &&
    isExplicitFlowSwitchToBuy(text)
  ) {
    decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
    decision.confidence = 0.88;
    decision.explicitFlowSwitch = true;
    applyBuyDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  if (
    state.conversationGoalLocked &&
    state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY &&
    isExplicitFlowSwitchToBuy(text)
  ) {
    decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
    decision.confidence = 0.9;
    decision.explicitFlowSwitch = true;
    applyBuyDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  const ownerOpEarly = inferOwnerOfferOperation(t);
  const rentOutEarly =
    !matchesLandingCaptureInbound(t) &&
    (isRentOutIntent(text) || ownerOpEarly === 'rent') &&
    matchesSellerAcquisitionPattern(t) &&
    (!state.conversationGoalLocked || isExplicitFlowSwitchToRentOut(text));
  if (rentOutEarly) {
    decision.detectedIntent = V3_INTENT.RENT_OUT_PROPERTY;
    decision.confidence = 0.9;
    decision.explicitFlowSwitch = state.conversationGoalLocked ? isExplicitFlowSwitchToRentOut(text) : true;
    patch.conversationGoal = CONVERSATION_GOALS.RENT_OUT_PROPERTY;
    patch.leadFlow = 'offer';
    patch.operationType = 'rent';
    applyPropertyTypePatch(patch, parsePropertyType(text) || 'house');
    const zoneRentOut = extractLooseLocationPhrase(raw);
    if (zoneRentOut) {
      patch.locationText = zoneRentOut;
      decision.extractedEntities.locationText = zoneRentOut;
    }
    decision.shouldAskName = !state.collectedFields?.fullName;
    if (isC2SellerRetargetingEntry(raw)) patch.offerC2Retargeting = true;
    decision.nextSuggestedStage = state.collectedFields?.fullName
      ? CONVERSATION_STAGES.QUALIFYING
      : CONVERSATION_STAGES.IDENTITY_PENDING;
    return { patch, decision };
  }

  if (isAmbiguousOwnerPropertyOrientation(text) && !state.conversationGoalLocked) {
    decision.detectedIntent = V3_INTENT.SELL_PROPERTY;
    decision.confidence = 0.75;
    patch.conversationGoal = CONVERSATION_GOALS.SELL_PROPERTY;
    patch.leadFlow = 'offer';
    patch.operationType = 'sale';
    decision.shouldAskName = !state.collectedFields?.fullName;
    decision.ambiguousOwnerIntent = true;
    return { patch, decision };
  }

  const strongSellEarly =
    !matchesLandingCaptureInbound(t) &&
    (isExplicitFlowSwitchToSell(text) ||
      matchesSellerAcquisitionPattern(t) ||
      isSellValuationLeadIntent(text) ||
      sellFromRentLocked);
  const weakSellEarly = t.includes('vender') && t.includes('casa') && !state.conversationGoalLocked;
  if (strongSellEarly || weakSellEarly) {
    decision.detectedIntent = V3_INTENT.SELL_PROPERTY;
    decision.confidence = 0.9;
    decision.explicitFlowSwitch =
      !state.conversationGoalLocked ||
      isExplicitFlowSwitchToSell(text) ||
      sellFromRentLocked ||
      matchesSellerAcquisitionPattern(t);
    if (decision.explicitFlowSwitch && state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY) {
      patch.flowSwitchAck = true;
    }
    patch.conversationGoal = CONVERSATION_GOALS.SELL_PROPERTY;
    patch.leadFlow = 'offer';
    patch.operationType = ownerOpEarly === 'mixed' ? 'sale' : ownerOpEarly === 'rent' ? 'rent' : 'sale';
    applyPropertyTypePatch(patch, parsePropertyType(text) || 'house');
    const zoneSellEarly = extractLooseLocationPhrase(raw);
    if (zoneSellEarly) {
      patch.locationText = zoneSellEarly;
      decision.extractedEntities.locationText = zoneSellEarly;
    }
    if (isC2SellerRetargetingEntry(raw)) patch.offerC2Retargeting = true;
    decision.shouldAskName = !state.collectedFields?.fullName;
    decision.nextSuggestedStage = state.collectedFields?.fullName
      ? CONVERSATION_STAGES.QUALIFYING
      : CONVERSATION_STAGES.IDENTITY_PENDING;
    return { patch, decision };
  }

  let codeHit = extractPropertyListingCode(raw);
  const refCode = !codeHit ? resolvePropertyReferenceCode(state, raw) : null;
  if (refCode) {
    codeHit = { raw: refCode, normalized: refCode };
  }
  const persistedCode = state.propertyListingCode || null;
  if (codeHit && persistedCode && codeHit.normalized !== persistedCode) {
    patch.propertyHistory = appendPropertyHistory(state.propertyHistory, persistedCode);
  }
  const effectiveCode = (codeHit && codeHit.normalized) || persistedCode;

  const lockedSellBlocksPropertyCode =
    state.conversationGoalLocked &&
    state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY &&
    !isExplicitPropertyInquiryPhrase(raw);

  /** Ya en PROPERTY_INQUIRY con código guardado: no re-disparar el bloque con cada turno (nombre, consentimiento, etc.). */
  const propertyInquiryContinuationOnly =
    state.conversationGoalLocked &&
    state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY &&
    persistedCode &&
    !codeHit &&
    !isExplicitPropertyInquiryPhrase(raw);

  /** Ya en Q&A de propiedad: no re-disparar intake por palabras sueltas ("precio", "disponible" en preguntas). */
  const skipPropertyIntakeReentry =
    state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY &&
    !!persistedCode &&
    state.propertySubMode === 'PROPERTY_QA' &&
    !(codeHit && codeHit.normalized && codeHit.normalized !== persistedCode);

  if (
    !skipPropertyIntakeReentry &&
    !lockedSellBlocksPropertyCode &&
    effectiveCode &&
    (codeHit || isExplicitPropertyInquiryPhrase(raw) || persistedCode) &&
    !propertyInquiryContinuationOnly
  ) {
    const rentAsDemand = mentionsRentDemand(t) && !isRentOutIntent(text);
    if (rentAsDemand) {
      decision.detectedIntent = V3_INTENT.RENT_PROPERTY;
      decision.confidence = 0.88;
      decision.explicitFlowSwitch = state.conversationGoalLocked ? isExplicitFlowSwitchToRentDemand(text) : true;
      patch.conversationGoal = CONVERSATION_GOALS.RENT_PROPERTY;
      patch.leadFlow = 'demand';
      patch.operationType = 'rent';
      patch.propertyListingCode = effectiveCode;
      patch.propertySpecificIntent = true;
      const zone = extractLooseLocationPhrase(raw);
      if (zone) {
        patch.locationText = zone;
        decision.extractedEntities.locationText = zone;
      }
      decision.shouldAskName = !state.collectedFields?.fullName;
      decision.shouldSearchProperty = true;
      return { patch, decision };
    }

    decision.detectedIntent = V3_INTENT.PROPERTY_INQUIRY;
    decision.confidence = codeHit ? 0.9 : 0.82;
    decision.explicitFlowSwitch =
      !state.conversationGoalLocked || !!codeHit || isExplicitPropertyInquiryPhrase(raw);
    patch.conversationGoal = CONVERSATION_GOALS.PROPERTY_INQUIRY;
    patch.leadFlow = 'demand';
    patch.operationType = 'sale';
    patch.propertyListingCode = effectiveCode;
    patch.propertySpecificIntent = true;
    // SoT facts first — no name gate for precio/zona publicables.
    const famOnIntake = classifyFactFamily(t);
    const infoish =
      famOnIntake ||
      (/\b(?:h[aá]blame|cu[eé]ntame|dime|info|informaci[oó]n)\b/.test(t) ? 'info' : null) ||
      (codeHit ? 'info' : null);
    if (infoish) {
      decision.detectedIntent = V3_INTENT.PROPERTY_FACT_QUESTION;
      decision.propertyInquiryFamily = infoish;
      patch.propertySubMode = 'PROPERTY_QA';
      decision.shouldAskName = false;
    } else {
      decision.shouldAskName = !state.collectedFields?.fullName;
    }
    decision.shouldSearchProperty = true;
    return { patch, decision };
  }

  const sellCtx = isOfferFlow(state);
  const qualLocation = isV3HandoffEnabled()
    ? tryParseQualificationLocation(state, raw)
    : tryParseSellLocation(state, raw);
  const sellLocation = qualLocation;
  if (sellLocation) {
    decision.detectedIntent = V3_INTENT.LOCATION_CAPTURE;
    decision.confidence = 0.9;
    patch.locationText = sellLocation;
    patch.awaitingField = null;
    decision.extractedEntities.locationText = sellLocation;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const fr = detectFrustration(text);
  if (fr.isFrustrated) {
    // Corrección de operación ("ya te dije que renta") no es frustración pura.
    if (isIntentCorrectionPhrase(text) && /\brenta\b/.test(t) && !isRentOutIntent(text)) {
      decision.detectedIntent = V3_INTENT.RENT_PROPERTY;
      decision.confidence = 0.86;
      decision.explicitFlowSwitch = true;
      applyRentDemandPatch(patch, raw, decision);
      decision.shouldAskName = !state.collectedFields?.fullName;
      return { patch, decision };
    }
    if (
      isIntentCorrectionPhrase(text) &&
      (/\b(?:compra|comprar)\b/.test(t) || mentionsBuyDemand(t))
    ) {
      decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
      decision.confidence = 0.86;
      decision.explicitFlowSwitch = true;
      applyBuyDemandPatch(patch, raw, decision);
      decision.shouldAskName = !state.collectedFields?.fullName;
      return { patch, decision };
    }
    const sellCtxFr =
      state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY || state.leadFlow === 'offer';
    const propOnFrustration = parsePropertyType(text);
    if (sellCtxFr && propOnFrustration) {
      applyPropertyTypePatch(patch, propOnFrustration);
    }
    decision.detectedIntent = V3_INTENT.FRUSTRATION;
    decision.confidence = 0.9;
    decision.shouldEscalateHuman = false;
    patch.frustrationState = fr.level;
    return { patch, decision };
  }

  const occupancyParsed = parseOccupancyStatus(text);
  if (occupancyParsed && sellCtx) {
    const existingOcc = state.occupancyStatus || state.collectedFields?.occupancyStatus;
    if (existingOcc && existingOcc === occupancyParsed) {
      decision.detectedIntent = V3_INTENT.UNKNOWN;
      decision.confidence = 0.75;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
    decision.detectedIntent = V3_INTENT.OCCUPANCY_CAPTURE;
    decision.confidence = 0.92;
    applyOccupancyPatch(patch, occupancyParsed);
    decision.explicitFlowSwitch = false;
    decision.nextSuggestedStage = CONVERSATION_STAGES.READY_FOR_CRM;
    return { patch, decision };
  }

  const awaitingNameCapture = isAwaitingIdentityName(state) && !state.collectedFields?.fullName;

  if (awaitingNameCapture && state.awaitingField === 'full_name') {
    const tw = normalizeText(raw);
    if (WHATSAPP_ONLY_REPLY.test(tw)) {
      decision.detectedIntent = V3_INTENT.UNKNOWN;
      decision.confidence = 0.58;
      patch.channelPreference = 'whatsapp';
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  if (awaitingNameCapture) {
    // No capturar nombre cuando el turno es corrección de dinero o cambio explícito de flujo.
    const moneyInTurn = parseMoneyAmount(raw);
    const flowPivot =
      isExplicitFlowSwitchToBuy(text) ||
      isExplicitFlowSwitchToRentDemand(text) ||
      (mentionsRentDemand(t) && !isRentOutIntent(text)) ||
      mentionsBuyDemand(t);
    if (moneyInTurn == null && !flowPivot) {
      const affName = extractAffirmationName(raw);
      if (affName && isLikelyFirstNameOnly(affName)) {
        patch.collectedFields = { ...(patch.collectedFields || {}), fullName: affName };
        decision.extractedEntities.fullName = affName;
        decision.shouldAskName = false;
        decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
        decision.confidence = 0.93;
        decision.explicitFlowSwitch = false;
        return { patch, decision };
      }
      const split = splitNameAndTail(raw);
      if (split && isLikelyFirstNameOnly(split.name)) {
        const tailNorm = normalizeText(split.tail);
        const ch = parseChannelPreference(tailNorm);
        const channelOnlyTail = WHATSAPP_ONLY_REPLY.test(tailNorm.trim());
        const consent = channelOnlyTail ? null : parseAdvisorContactConsent(split.tail);
        patch.collectedFields = { ...(patch.collectedFields || {}), fullName: split.name };
        decision.extractedEntities.fullName = split.name;
        decision.shouldAskName = false;
        if (ch) patch.channelPreference = ch;
        if (consent === 'ACCEPTED') {
          patch.advisorContactConsent = 'ACCEPTED';
          patch.awaitingField = null;
          decision.detectedIntent = V3_INTENT.ADVISOR_CONSENT_CAPTURE;
          decision.confidence = 0.94;
        } else {
          decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
          decision.confidence = 0.93;
        }
        decision.explicitFlowSwitch = false;
        return { patch, decision };
      }
    }
  }

  const qaTurnEarly = classifyPropertyInquiryTurn(state, text, raw);
  if (
    qaTurnEarly &&
    qaTurnEarly.kind === 'FACT' &&
    state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY &&
    (state.propertyListingCode || persistedCode)
  ) {
    decision.detectedIntent = V3_INTENT.PROPERTY_FACT_QUESTION;
    decision.propertyInquiryFamily = qaTurnEarly.family;
    decision.confidence = 0.84;
    decision.explicitFlowSwitch = false;
    if (state.collectedFields?.fullName) {
      patch.propertySubMode = 'PROPERTY_QA';
    }
    // Enter PROPERTY_QA without name when answering SoT facts.
    if (!state.propertySubMode || state.propertySubMode !== 'PROPERTY_QA') {
      patch.propertySubMode = 'PROPERTY_QA';
    }
    return { patch, decision };
  }

  const qaTurn = classifyPropertyInquiryTurn(state, text, raw);
  if (qaTurn && state.propertySubMode === 'PROPERTY_QA') {
    patch.propertyQaUserTurnCount = (state.propertyQaUserTurnCount || 0) + 1;
    if (qaTurn.kind === 'HUMAN_HANDOFF') {
      decision.detectedIntent = V3_INTENT.PROPERTY_HUMAN_HANDOFF_REQUEST;
      decision.confidence = 0.88;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
    if (qaTurn.kind === 'FACT') {
      decision.detectedIntent = V3_INTENT.PROPERTY_FACT_QUESTION;
      decision.propertyInquiryFamily = qaTurn.family;
      decision.confidence = 0.82;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
    if (qaTurn.kind === 'SOFT_CLOSE') {
      decision.detectedIntent = V3_INTENT.PROPERTY_QA_SOFT_CLOSE;
      decision.confidence = 0.72;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  let consentParsed = null;
  if (shouldParseConsentTurn(state)) {
    const tn = normalizeText(text);
    if (WHATSAPP_ONLY_REPLY.test(tn)) {
      consentParsed = 'ACCEPTED';
      patch.channelPreference = 'whatsapp';
    } else {
      consentParsed = parseAdvisorContactConsent(text);
    }
    if (
      !consentParsed &&
      !state.collectedFields?.fullName &&
      shouldAcceptAsIdentityName(state, text, { explicitNameMatch: false })
    ) {
      const nm = cleanSpaces(String(text || '').trim());
      if (nm) {
        decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
        decision.confidence = 0.9;
        decision.extractedEntities.fullName = nm;
        patch.collectedFields = { ...(patch.collectedFields || {}), fullName: nm };
        decision.shouldAskName = false;
        decision.explicitFlowSwitch = false;
        return { patch, decision };
      }
    }
  }
  if (consentParsed && shouldParseConsentTurn(state)) {
    decision.detectedIntent = V3_INTENT.ADVISOR_CONSENT_CAPTURE;
    decision.confidence = 0.93;
    patch.advisorContactConsent = consentParsed;
    patch.awaitingField = null;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (isExplicitHumanRequest(text) && isHandoffFlowActive(state)) {
    decision.detectedIntent = V3_INTENT.UNKNOWN;
    decision.confidence = 0.91;
    decision.explicitFlowSwitch = false;
    patch.lastAssistantReply = null;
    patch.lastAssistantReplySignature = null;
    return { patch, decision };
  }

  if (isShortAck(t) && state.conversationGoalLocked) {
    const ackAwaiting = tryResolveAwaitingFieldCapture(state, raw, text, patch, decision);
    if (ackAwaiting) return ackAwaiting;
    decision.detectedIntent = V3_INTENT.UNKNOWN;
    decision.confidence = 0.5;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (
    (t === 'hola' || t.startsWith('hola ') || t === 'buenas' || t.startsWith('buenas ') || t === 'hey') &&
    !hasSubstantiveIntentAfterGreeting(t, raw)
  ) {
    decision.detectedIntent = V3_INTENT.GREETING;
    decision.confidence = 0.7;
    decision.nextSuggestedStage = CONVERSATION_STAGES.UNDERSTANDING;
    return { patch, decision };
  }

  if (isBareBuyMenuReply(t) && !state.conversationGoalLocked) {
    decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
    decision.confidence = 0.82;
    decision.explicitFlowSwitch = false;
    applyBuyDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  if (isRentOutIntent(text) && (!state.conversationGoalLocked || isExplicitFlowSwitchToRentOut(text))) {
    decision.detectedIntent = V3_INTENT.RENT_OUT_PROPERTY;
    decision.confidence = 0.85;
    decision.explicitFlowSwitch = state.conversationGoalLocked ? isExplicitFlowSwitchToRentOut(text) : true;
    patch.conversationGoal = CONVERSATION_GOALS.RENT_OUT_PROPERTY;
    patch.leadFlow = 'offer';
    patch.operationType = 'rent';
    applyPropertyTypePatch(patch, parsePropertyType(text) || 'house');
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  const wantsRentPhrase =
    (mentionsRentDemand(t) && !isRentOutIntent(text)) ||
    t.includes('rentar') ||
    t.includes('arrendar') ||
    (t.includes('renta') && t.includes('busco'));
  if (wantsRentPhrase && (!state.conversationGoalLocked || isExplicitFlowSwitchToRentDemand(text))) {
    decision.detectedIntent = V3_INTENT.RENT_PROPERTY;
    decision.confidence = 0.8;
    decision.explicitFlowSwitch = state.conversationGoalLocked ? isExplicitFlowSwitchToRentDemand(text) : true;
    applyRentDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  if (
    matchesBuyOpenSearchPattern(t, raw) &&
    (!state.conversationGoalLocked || isExplicitFlowSwitchToBuy(text))
  ) {
    decision.detectedIntent = V3_INTENT.BUY_PROPERTY;
    decision.confidence = 0.85;
    decision.explicitFlowSwitch = !state.conversationGoalLocked || isExplicitFlowSwitchToBuy(text);
    applyBuyDemandPatch(patch, raw, decision);
    decision.shouldAskName = !state.collectedFields?.fullName;
    return { patch, decision };
  }

  const sellCtxEarly = isOfferFlow(state);
  const buyCtxEarly = state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY;
  const propTypeEarly = parsePropertyType(text);
  if (propTypeEarly && buyCtxEarly) {
    decision.detectedIntent = V3_INTENT.PROPERTY_TYPE_CAPTURE;
    decision.confidence = 0.9;
    applyPropertyTypePatch(patch, propTypeEarly);
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }
  if (propTypeEarly && sellCtxEarly) {
    decision.detectedIntent = V3_INTENT.PROPERTY_TYPE_CAPTURE;
    decision.confidence = 0.9;
    applyPropertyTypePatch(patch, propTypeEarly);
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const nameMatch = raw.match(/^(?:soy|me llamo|mi nombre es)\s+(.+)/i);
  const explicitName = !!nameMatch;
  if (
    shouldAcceptAsIdentityName(state, explicitName ? nameMatch[1] : raw, { explicitNameMatch: explicitName })
  ) {
    const nm = cleanSpaces(explicitName ? nameMatch[1] : raw);
    if (nm) {
      decision.detectedIntent = V3_INTENT.IDENTITY_CAPTURE;
      decision.confidence = 0.92;
      decision.extractedEntities.fullName = nm;
      patch.collectedFields = { ...(patch.collectedFields || {}), fullName: nm };
      decision.shouldAskName = false;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
  }

  const br = parseBedrooms(text);
  if (
    br != null &&
    (state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY ||
      state.conversationGoal === CONVERSATION_GOALS.RENT_PROPERTY)
  ) {
    decision.detectedIntent = V3_INTENT.BEDROOMS_CAPTURE;
    decision.confidence = 0.85;
    patch.bedrooms = br;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const payMethod = parsePaymentMethod(text);
  if (payMethod && state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY) {
    patch.paymentMethod = payMethod;
    decision.detectedIntent = V3_INTENT.UNKNOWN;
    decision.confidence = 0.8;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  const amount = parseMoneyAmount(text);
  if (amount != null && !matchesBuyOpenSearchPattern(t, raw)) {
    if (isOfferFlow(state)) {
      if (amount <= 0) {
        decision.detectedIntent = V3_INTENT.UNKNOWN;
        decision.confidence = 0.25;
        decision.explicitFlowSwitch = false;
        return { patch, decision };
      }
      decision.detectedIntent = V3_INTENT.SELLER_PRICE;
      patch.expectedPrice = amount;
      patch.budget = null;
      decision.extractedEntities.expectedPrice = amount;
    } else {
      decision.detectedIntent = V3_INTENT.BUYER_BUDGET;
      patch.budget = amount;
      decision.extractedEntities.budget = amount;
    }
    decision.confidence = 0.88;
    decision.explicitFlowSwitch = false;
    return { patch, decision };
  }

  if (
    isSocialRapportMessage(raw) ||
    (state.conversationGoalLocked && /\b(gracias|muchas gracias)\b/.test(t))
  ) {
    decision.detectedIntent = V3_INTENT.SOCIAL_RAPPORT;
    decision.confidence = 0.78;
    decision.explicitFlowSwitch = false;
    decision.nextSuggestedStage = CONVERSATION_STAGES.UNDERSTANDING;
    return { patch, decision };
  }

  if (isThinGenericInbound(t)) {
    if (state.conversationGoalLocked) {
      decision.detectedIntent = V3_INTENT.UNKNOWN;
      decision.confidence = 0.48;
      decision.explicitFlowSwitch = false;
      return { patch, decision };
    }
    decision.detectedIntent = V3_INTENT.CAMPAIGN_GENERIC_TOUCH;
    decision.confidence = headline ? 0.62 : 0.45;
    decision.explicitFlowSwitch = false;
    decision.nextSuggestedStage = CONVERSATION_STAGES.UNDERSTANDING;
    return { patch, decision };
  }

  decision.detectedIntent = V3_INTENT.UNKNOWN;
  decision.confidence = 0.25;
  decision.explicitFlowSwitch = false;
  return { patch, decision };
}

module.exports = {
  interpretUserMessage,
  parseMoneyAmount,
  parseBedrooms,
  normalizeLocationFromUserText,
};
