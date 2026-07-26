'use strict';

const { normalizeText, cleanSpaces } = require('../../../utils/text');
const { CONVERSATION_GOALS, CONVERSATION_STAGES, V3_INTENT, IDENTITY_STATES } = require('../types/constants');
const { normalizeLocationFromUserText } = require('./locationNormalizer');
const {
  extractLooseLocationPhrase,
  isDemandSearchInbound,
  isExplicitPropertyInquiryPhrase,
  mentionsRentDemand,
  mentionsBuyDemand,
  isRentOutOwnerPhrase,
  matchesSellerAcquisitionPattern,
} = require('./campaignIntake');
const { extractPropertyListingCode } = require('./propertyListingCode');
const { extractBridgeToken } = require('../../../services/intake/extractBridgeToken');
const { parsePropertyType } = require('./propertyTypeParser');
const { isExplicitHumanRequest } = require('./objectionClassifier');
const {
  isExplicitFlowSwitchToSellFromRent,
  isExplicitFlowSwitchToRentOut,
} = require('./campaignIntake');
const { splitNameAndTail, isLikelyFirstNameOnly } = require('./identityCompoundCapture');
const { parseMoneyAmount } = require('./moneyParser');
const { forceHandoff } = require('../planner/handoffPlanner');
const { mergeConversationState } = require('../types/conversationState');

const LANDING_SLUG = '/vende-tu-propiedad-en-cumbres';
const CAMPAIGN_CONTEXT_KEY = 'prevaluacion_cumbres';

/** Único copy de handoff para landing capture (no combinar con forcedHandoffComposer). */
const LANDING_CAPTURE_HANDOFF_REPLY =
  'Para darte una orientación más precisa, voy a canalizar tu caso con un asesor inmobiliario de Luxetty que podrá revisar los detalles contigo por este mismo medio. ¿Está bien si te contactan por este mismo número?';

const LANDING_CAPTURE_FALLBACK_REPLY = LANDING_CAPTURE_HANDOFF_REPLY;

const REPLY_WELCOME =
  'Hola, soy el asistente IA de Luxetty. Con gusto te ayudo a iniciar tu prevaluación comercial.\n\nPara orientarte mejor, ¿me compartes por favor tu nombre y en qué colonia o zona se encuentra la propiedad?';

const REPLY_COST =
  'La prevaluación comercial inicial no tiene costo. Sirve para darte una primera orientación sobre el potencial de tu propiedad. Si después decides avanzar, un asesor de Luxetty puede explicarte el proceso y las condiciones de trabajo.';

const REPLY_NOT_APPRAISAL =
  'No. Es una prevaluación comercial inicial, no un avalúo bancario, fiscal, catastral ni pericial. Te ayuda a tener una primera referencia comercial antes de decidir vender o rentar.';

/**
 * Handoff post-formulario APA (property_demand) o consulta explícita por listing.
 * No debe activar captación Cumbres aunque la zona diga "Cumbres".
 * @param {string} input
 */
function isPropertyDemandHandoffInbound(input) {
  const raw = String(input || '');
  const text = normalizeText(raw);
  if (!text) return false;
  if (extractBridgeToken(raw)) return true;
  if (extractPropertyListingCode(raw)) return true;
  if (isExplicitPropertyInquiryPhrase(raw)) return true;
  return false;
}

/**
 * @param {string} t normalized
 */
function matchesLandingCaptureInbound(input) {
  const text = normalizeText(String(input || ''));
  if (!text) return false;
  if (isDemandSearchInbound(text)) return false;
  if (isPropertyDemandHandoffInbound(input)) return false;

  let score = 0;
  if (/prevaluaci[oó]n/.test(text)) score += 1;
  if (/cumbres|zona\s+poniente/.test(text)) score += 1;
  if (/propiedad/.test(text) && /(cumbres|poniente|colonia|zona)/.test(text)) score += 1;
  if (/\b(mi\s+)?casa\b/.test(text) && /cumbres/.test(text)) score += 2;
  if (/venta\s+o\s+renta|mejor\s+opci[oó]n/.test(text)) score += 1;
  if (/campa[nñ]a\s+de\s+prevaluaci[oó]n/.test(text)) score += 2;
  if (/hola\s+luxetty/.test(text)) score += 1;
  if (/quiero\s+(?:recibir\s+)?una\s+prevaluaci[oó]n/.test(text)) score += 2;
  if (/me\s+interesa\s+una\s+prevaluaci[oó]n/.test(text)) score += 2;
  if (/prevaluaci[oó]n\s+comercial\s+inicial/.test(text)) score += 2;
  if (/quiero\s+una\s+prevaluaci[oó]n/.test(text)) score += 2;

  return score >= 2;
}

function isLandingCaptureActive(state) {
  return state.landingCaptureFlow === true;
}

function buildLandingCaptureBootstrapPatch() {
  return {
    landingCaptureFlow: true,
    sourceContext: 'campaign_landing',
    campaignContextKey: CAMPAIGN_CONTEXT_KEY,
    landingSlug: LANDING_SLUG,
    captureChannel: 'whatsapp',
    conversationGoal: CONVERSATION_GOALS.SELL_PROPERTY,
    conversationGoalLocked: true,
    leadFlow: 'offer',
    operationTypePending: true,
    operationType: null,
    propertySpecificIntent: false,
    campaign_context: {
      source_context: 'campaign_landing',
      campaign_context: CAMPAIGN_CONTEXT_KEY,
      landing_slug: LANDING_SLUG,
      capture_channel: 'whatsapp',
      lead_intent: 'capture_property',
      lead_type: 'supply',
      operation_type: 'pending_confirmation',
    },
    user_goal: 'capture_property',
    lead_type: 'supply',
    landingCaptureStage: 'name_zone',
    conversationStage: CONVERSATION_STAGES.QUALIFYING,
    awaitingField: 'full_name',
    lastAskedField: 'full_name',
  };
}

function formatStoredName(name) {
  let s = cleanSpaces(String(name || ''))
    .replace(/^soy\s+/i, '')
    .replace(/[….]+\s*$/g, '')
    .replace(/[.,!?]+\s*$/g, '')
    .trim();
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?]+$/g, '').charAt(0).toUpperCase() + w.replace(/[.,!?]+$/g, '').slice(1).toLowerCase())
    .join(' ');
}

function resolveZonePhrase(phrase) {
  const raw = cleanSpaces(String(phrase || ''));
  if (!raw || !isPlausibleZone(raw)) return null;
  // Precio / valuación no es zona ("Vale como 8 millones").
  if (parseMoneyAmount(raw) != null && !normalizeLocationFromUserText(raw)) return null;
  if (/\b(?:vale|cuesta|precio|presupuesto)\b/i.test(raw) && /\b(?:millon|millones|mil|mdp)\b/i.test(raw)) {
    return null;
  }
  const norm = normalizeLocationFromUserText(raw);
  if (!norm) return raw;
  if (raw.length >= norm.length && raw.split(/\s+/).length >= norm.split(/\s+/).length) {
    return raw;
  }
  return isPlausibleZone(norm) ? norm : raw;
}

function isPlausibleZone(zone) {
  const z = cleanSpaces(String(zone || ''));
  if (!z || z.length < 3) return false;
  if (/^[%?#@$*+]+$/i.test(z)) return false;
  if (/^[^a-záéíóúñ0-9\s.,-]{2,}$/i.test(z)) return false;
  return /[a-záéíóúñ]/i.test(z);
}

function cleanLeadingNameToken(head) {
  let name = cleanSpaces(String(head || ''))
    .replace(/^soy\s+/i, '')
    .replace(/[….]+\s*$/g, '')
    .replace(/[.,!?]+\s*$/g, '')
    .trim();
  if (!name || !isLikelyFirstNameOnly(name)) return null;
  const parts = name.split(/\s+/);
  if (parts.length > 3) name = parts.slice(0, 2).join(' ');
  if (name.length > 48) name = name.slice(0, 48);
  return name;
}

function parseNameAndZone(raw) {
  const t = normalizeText(String(raw || ''));
  let name = null;
  let zone = null;

  const casaEsta = t.match(
    /^(.+?)\s+(?:la\s+)?(?:casa|depa|departamento|propiedad|terreno|local)\s+est[aá]\s+en\s+(.+)$/i,
  );
  if (casaEsta) {
    name = cleanLeadingNameToken(casaEsta[1]);
    zone = resolveZonePhrase(casaEsta[2]);
  }

  const soyZone = t.match(
    /^soy\s+([a-záéíóúñ][a-záéíóúñ.'-]{1,24})(?:\s+y\s+|\s*[.,…]\s*|\s+)(?:esta|est[aá]|estan|est[aá]n)?\s*(?:en\s+)?(.+)$/i,
  );
  if (soyZone && !name) {
    name = cleanSpaces(soyZone[1].replace(/\.+$/g, '').replace(/…+$/g, ''));
    if (!zone) {
      zone = resolveZonePhrase(soyZone[2]);
    }
  }

  const soyShort = t.match(/^soy\s+([a-záéíóúñ][a-záéíóúñ.'-]{1,24})(?:\s*[.,]|\s+est[aá]|\s+y\s+|$)/);
  if (soyShort && !name) {
    name = cleanSpaces(soyShort[1]);
  }

  const estaEn = t.match(/\best[aá]\s+en\s+(.+?)(?:\s*[.!?]|$)/);
  if (estaEn) {
    if (!zone) {
      zone = resolveZonePhrase(estaEn[1]);
    }
    if (!name) {
      const before = t.slice(0, estaEn.index).trim();
      name = cleanLeadingNameToken(before);
    }
  }

  const compound = splitNameAndTail(raw);
  if (compound && !name) {
    name = compound.name;
    if (!zone) {
      zone = resolveZonePhrase(compound.tail) || extractLooseLocationPhrase(compound.tail) || cleanSpaces(compound.tail);
    }
  }

  if (!zone) {
    zone = resolveZonePhrase(raw) || extractLooseLocationPhrase(raw);
  }

  if (!name && isLikelyFirstNameOnly(raw) && !zone) {
    name = cleanSpaces(raw);
  }

  if (name) name = formatStoredName(name);
  if (name && name.length > 48) name = name.slice(0, 48);
  if (zone && zone.length > 80) zone = zone.slice(0, 80);

  return { name, zone };
}

function parseOperationIntent(raw) {
  const t = normalizeText(String(raw || ''));
  if (
    /\b(explorando|no\s+se|no\s+sé|aun\s+no|aún\s+no|todavia\s+no|todavía\s+no|depende|conocer\s+opciones|estoy\s+explorando)\b/.test(
      t,
    )
  ) {
    return 'exploring';
  }
  if (
    isExplicitFlowSwitchToSellFromRent(raw) ||
    /\b(quiero\s+vender|venderla|ponerla\s+en\s+venta|poner\s+en\s+venta|en\s+realidad\s+quiero\s+vender)\b/.test(
      t,
    )
  ) {
    return 'sale';
  }
  if (
    isExplicitFlowSwitchToRentOut(raw) ||
    (/\b(quiero\s+rentar|rentarla|ponerla\s+en\s+renta|arrendar)\b/.test(t) &&
      /\b(mi|propiedad|casa|depa|departamento)\b/.test(t))
  ) {
    return 'rent';
  }
  return null;
}

function isValuationCostQuestion(t) {
  return /\b(cu[aá]nto\s+cuesta|tiene\s+costo|es\s+gratis|costo\s+de\s+la\s+prevaluaci[oó]n)\b/.test(t);
}

function isAppraisalQuestion(t) {
  return /\b(aval[uú]o|avaluo|aval[uú]o\s+bancario|aval[uú]o\s+fiscal|aval[uú]o\s+catastral|aval[uú]o\s+pericial)\b/.test(
    t,
  );
}

function firstNameFromState(state) {
  const full = cleanSpaces(String(state.collectedFields?.fullName || ''));
  if (!full) return null;
  return full.split(/\s+/)[0];
}

function propertyTypeLabel(type) {
  const map = {
    house: 'casa',
    apartment: 'departamento',
    land: 'terreno',
    commercial: 'local',
  };
  return map[type] || 'inmueble';
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} raw
 */
function advanceLandingCaptureStage(state, raw) {
  const t = normalizeText(raw);
  const stage = state.landingCaptureStage || 'name_zone';
  const nm = firstNameFromState(state);

  if (isValuationCostQuestion(t)) {
    return { reply: REPLY_COST, patch: {}, handoff: false, intent: V3_INTENT.LANDING_CAPTURE };
  }
  if (isAppraisalQuestion(t)) {
    return { reply: REPLY_NOT_APPRAISAL, patch: {}, handoff: false, intent: V3_INTENT.LANDING_CAPTURE };
  }

  if (stage === 'name_zone') {
    const { name, zone } = parseNameAndZone(raw);
    if (!name && !zone) {
      const amountOnly = parseMoneyAmount(raw);
      if (amountOnly != null && amountOnly > 0) {
        return {
          reply:
            'Gracias, tomo esa referencia de precio. ¿Me compartes tu nombre y en qué colonia o zona se encuentra la propiedad?',
          patch: {
            expectedPrice: amountOnly,
            collectedFields: { ...(state.collectedFields || {}), expectedPrice: amountOnly },
          },
          handoff: false,
          intent: V3_INTENT.SELLER_PRICE,
        };
      }
      return { reply: null, patch: {}, handoff: true, intent: V3_INTENT.UNKNOWN };
    }
    const patch = {
      landingCaptureStage: 'property_type',
      awaitingField: 'property_type',
      lastAskedField: 'property_type',
    };
    if (name) {
      patch.collectedFields = { ...(state.collectedFields || {}), fullName: name };
      patch.identityState = name.length >= 2 ? IDENTITY_STATES.CONFIRMED : IDENTITY_STATES.PARTIAL;
    }
    if (zone) {
      patch.locationText = zone;
      patch.zone = zone;
    }
    const first = name ? name.split(/\s+/)[0].replace(/[.,!?]+$/, '') : null;
    const greet = first ? `Gracias, ${first}.` : 'Gracias.';
    const zonePart = zone ? ` Tomo nota de que la propiedad está en ${zone}.` : '';
    const reply = `${greet}${zonePart}\n\n¿La propiedad es casa, departamento, terreno o local?`;
    return { reply, patch, handoff: false, intent: V3_INTENT.LANDING_CAPTURE };
  }

  if (stage === 'property_type') {
    const prop = parsePropertyType(raw);
    if (!prop) {
      return { reply: null, patch: {}, handoff: true, intent: V3_INTENT.UNKNOWN };
    }
    const patch = {
      propertyType: prop,
      collectedFields: { ...(state.collectedFields || {}), propertyType: prop },
      landingCaptureStage: 'operation',
      awaitingField: 'operation_type',
      lastAskedField: 'operation_type',
    };
    return {
      reply: 'Perfecto. ¿Estás pensando venderla, rentarla o todavía estás explorando opciones?',
      patch,
      handoff: false,
      intent: V3_INTENT.LANDING_CAPTURE,
    };
  }

  if (stage === 'operation') {
    const op = parseOperationIntent(raw);
    if (!op) {
      return { reply: null, patch: {}, handoff: true, intent: V3_INTENT.UNKNOWN };
    }
    const patch = {
      landingCaptureStage: 'price',
      awaitingField: 'expected_price',
      lastAskedField: 'expected_price',
      is_exploring_sale: op === 'exploring',
    };
    if (op === 'sale') {
      patch.operationType = 'sale';
      patch.operationTypePending = false;
      patch.leadFlow = 'offer';
      return {
        reply:
          'Excelente. Para darte una primera orientación comercial, ¿tienes algún precio aproximado en mente o prefieres que lo revisemos contigo?',
        patch,
        handoff: false,
        intent: V3_INTENT.LANDING_CAPTURE,
      };
    }
    if (op === 'rent') {
      patch.operationType = 'rent';
      patch.operationTypePending = false;
      patch.leadFlow = 'offer';
      return {
        reply:
          'Perfecto. Para orientarte mejor sobre la renta, ¿tienes algún rango mensual esperado o prefieres que lo revisemos contigo?',
        patch,
        handoff: false,
        intent: V3_INTENT.LANDING_CAPTURE,
      };
    }
    patch.operationTypePending = true;
    patch.operationType = null;
    return {
      reply:
        'Claro, es válido explorarlo antes de decidir. Podemos ayudarte a entender el potencial comercial de tu propiedad.\n\n¿Tienes algún rango de precio o renta en mente, o prefieres que primero revisemos la información básica contigo?',
      patch,
      handoff: false,
      intent: V3_INTENT.LANDING_CAPTURE,
    };
  }

  if (stage === 'price') {
    const amount = parseMoneyAmount(raw);
    const patch = {
      landingCaptureStage: 'done',
      awaitingField: null,
      qualificationComplete: false,
    };
    if (amount != null) {
      patch.expectedPrice = amount;
      patch.collectedFields = { ...(state.collectedFields || {}), expectedPrice: amount };
    }
    const greet = nm ? `${nm}, ` : '';
    return {
      reply: `${greet}con lo que me compartiste ya tengo una base para orientarte. Si quieres, podemos seguir afinando algún detalle por aquí.`,
      patch,
      handoff: false,
      intent: V3_INTENT.LANDING_CAPTURE,
    };
  }

  return { reply: null, patch: {}, handoff: true, intent: V3_INTENT.UNKNOWN };
}

function isExplicitDemandPivotAwayFromLanding(t, raw) {
  // Nunca pivotea fuera de captación si el inbound es de propietario/prevaluación.
  if (matchesSellerAcquisitionPattern(t)) return false;
  if (mentionsRentDemand(t) && !isRentOutOwnerPhrase(t)) return true;
  if (mentionsBuyDemand(t)) return true;
  if (isDemandSearchInbound(raw) && !matchesSellerAcquisitionPattern(t)) return true;
  return false;
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} raw
 * @param {string} t
 * @param {Partial<import('../types/conversationState').ConversationState>} patch
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 */
function tryInterpretLandingCapture(state, raw, t, patch, decision) {
  if (state.awaitingField === 'advisor_contact_consent') {
    return null;
  }

  if (isExplicitHumanRequest(raw) || /\b(prefiero\s+hablar|quiero\s+una\s+persona|asesor\s+humano)\b/.test(t)) {
    if (isLandingCaptureActive(state) || matchesLandingCaptureInbound(t)) {
      decision.detectedIntent = V3_INTENT.LANDING_CAPTURE;
      decision.confidence = 0.95;
      decision.landingCaptureHandoff = true;
      decision.landingCaptureReply = LANDING_CAPTURE_HANDOFF_REPLY;
      decision.landingCaptureSkipForcedComposer = true;
      patch.landingCaptureFlow = true;
      return { patch, decision };
    }
  }

  if (isLandingCaptureActive(state)) {
    // Demanda explícita (renta/compra) prevalece sobre sticky de captación.
    if (isExplicitDemandPivotAwayFromLanding(t, raw)) {
      return null;
    }
    const advanced = advanceLandingCaptureStage(state, raw);
    decision.detectedIntent = advanced.intent;
    decision.confidence = advanced.handoff ? 0.4 : 0.92;
    decision.explicitFlowSwitch = false;
    if (advanced.handoff) {
      decision.landingCaptureHandoff = true;
      decision.landingCaptureReply = LANDING_CAPTURE_HANDOFF_REPLY;
      decision.landingCaptureSkipForcedComposer = true;
      return { patch, decision };
    }
    Object.assign(patch, advanced.patch);
    decision.landingCaptureReply = advanced.reply;
    return { patch, decision };
  }

  if (matchesLandingCaptureInbound(raw)) {
    // No secuestrar inbound de demanda como captación vendedor.
    if (isExplicitDemandPivotAwayFromLanding(t, raw)) {
      return null;
    }
    Object.assign(patch, buildLandingCaptureBootstrapPatch());
    decision.detectedIntent = V3_INTENT.LANDING_CAPTURE;
    decision.confidence = 0.94;
    decision.explicitFlowSwitch = true;
    decision.landingCaptureReply = REPLY_WELCOME;
    return { patch, decision };
  }

  return null;
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 */
function composeLandingCaptureReply(state, decision) {
  if (decision.landingCaptureReply) return String(decision.landingCaptureReply);
  if (decision.landingCaptureHandoff) return LANDING_CAPTURE_HANDOFF_REPLY;
  if (isLandingCaptureActive(state)) return REPLY_WELCOME;
  return null;
}

/**
 * Aplica estado de handoff sin segundo composer (un solo mensaje premium).
 * @param {import('../types/conversationState').ConversationState} state
 * @param {import('../types/conversationDecision').ConversationDecision} decision
 * @param {string} [reason]
 */
function applyLandingCaptureHandoffState(state, decision, reason = 'landing_capture_fallback') {
  const handoffOut = forceHandoff(state, { reason, decision });
  return mergeConversationState(state, {
    ...handoffOut.patch,
    landingCaptureFlow: true,
    lastComposerIntent: `landing_capture_handoff|${reason}`,
  });
}

module.exports = {
  LANDING_SLUG,
  CAMPAIGN_CONTEXT_KEY,
  LANDING_CAPTURE_HANDOFF_REPLY,
  LANDING_CAPTURE_FALLBACK_REPLY,
  applyLandingCaptureHandoffState,
  isPropertyDemandHandoffInbound,
  matchesLandingCaptureInbound,
  isLandingCaptureActive,
  tryInterpretLandingCapture,
  composeLandingCaptureReply,
  buildLandingCaptureBootstrapPatch,
};
