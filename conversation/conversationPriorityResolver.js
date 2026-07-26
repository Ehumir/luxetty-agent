'use strict';

/**
 * Prioridad obligatoria de intención (greeting nunca pisa seller/property/human).
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { isGreetingOnly } = require('../utils/messageChecks');
const { hasExplicitSellerKeywords } = require('./intent');
const { extractPropertyCode } = require('./propertyIntentResolver');
const { isExplicitHumanAdvisorRequest } = require('./humanEscalation');
const r0 = require('./r0ContextContinuity');
const {
  mentionsRentDemand,
  mentionsBuyDemand,
  isDemandSearchInbound,
} = require('./v3/interpreter/campaignIntake');

const PRIORITY = Object.freeze({
  HUMAN: 1,
  PROPERTY_SPECIFIC: 2,
  SELLER_CAPTURE: 3,
  META_GENERAL: 4,
  BUYER_SEARCH: 5,
  RENT_SEARCH: 6,
  SOCIAL: 7,
  GREETING: 8,
  UNKNOWN: 9,
});

function isMetaGeneralEntryText(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  return (
    t.includes('vi su pagina') ||
    t.includes('vi su página') ||
    t.includes('vi facebook') ||
    t.includes('navegando en facebook') ||
    t.includes('navegando en instagram') ||
    t.includes('vi su publicacion') ||
    t.includes('vi su publicación') ||
    t.includes('vi su anuncio') ||
    t.includes('me salio su anuncio') ||
    t.includes('me salió su anuncio') ||
    (t.includes('facebook') && (t.includes('pagina') || t.includes('página') || t.includes('vi '))) ||
    (t.includes('instagram') && (t.includes('vi ') || t.includes('pagina') || t.includes('página'))) ||
    t.includes('redes sociales') ||
    (t.includes('pagina inmobiliaria') || t.includes('página inmobiliaria'))
  );
}

function isSocialReferenceText(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t || isMetaGeneralEntryText(t)) return false;
  return (
    t.includes('me recomendaron') ||
    t.includes('me hablaron de') ||
    t.includes('me pasaron su') ||
    t.includes('me compartieron')
  );
}

function isBuyerSearchText(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t || hasExplicitSellerKeywords(t)) return false;
  if (mentionsBuyDemand(t)) return true;
  return (
    /\bbusco\b/.test(t) ||
    t.includes('quiero comprar') ||
    (t.includes('comprar') && (t.includes('casa') || t.includes('depa') || t.includes('propiedad')))
  );
}

function isRentSearchText(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t || hasExplicitSellerKeywords(t)) return false;
  if (t.includes('rentar mi') || t.includes('poner en renta')) return false;
  // Alineado con campaignIntake.mentionsRentDemand (inventario / cert).
  if (mentionsRentDemand(t)) return true;
  return (
    t.includes('quiero rentar') ||
    t.includes('busco renta') ||
    (t.includes('rentar') && !t.includes('mi casa') && !t.includes('mi propiedad'))
  );
}

function isGreetingOpeningText(text = '') {
  const raw = cleanSpaces(String(text || ''));
  if (!raw) return false;
  if (isGreetingOnly(raw)) return true;
  const t = normalizeText(raw);
  // Demanda clara (renta/compra/inventario) nunca es "solo saludo", aunque empiece con Hola.
  if (isRentSearchText(t) || isBuyerSearchText(t) || isDemandSearchInbound(t)) return false;
  if (/^(hola|hey|hi|buenas|buenos dias|buenos días|buenas tardes|buenas noches)\b/.test(t) && t.length < 48) {
    return !hasExplicitSellerKeywords(t) && !isMetaGeneralEntryText(t);
  }
  return false;
}

/** Demanda explícita de inventario: rompe sticky offer / greeting. */
function isExplicitDemandSearchText(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t || hasExplicitSellerKeywords(t)) return false;
  return (
    isRentSearchText(t) ||
    isBuyerSearchText(t) ||
    isDemandSearchInbound(t) ||
    r0.explicitDemandSearchIntent(t)
  );
}

/**
 * @returns {{ priority: number, key: string, entry_type: string|null, lead_flow: string|null, opening_type: string }}
 */
function resolvePriorityIntent(text = '', aiState = {}, parsedSignals = {}) {
  const st = aiState && typeof aiState === 'object' ? aiState : {};
  const sig = parsedSignals && typeof parsedSignals === 'object' ? parsedSignals : {};
  const code =
    extractPropertyCode(text) ||
    cleanSpaces(String(sig.property_code || st.property_code || st.direct_property_code || ''));

  if (isExplicitHumanAdvisorRequest(text, sig) || st.wants_human || st.handoff_sent) {
    return {
      priority: PRIORITY.HUMAN,
      key: 'human',
      entry_type: 'human_request',
      lead_flow: st.lead_flow || null,
      opening_type: 'human_request',
    };
  }

  if (
    code ||
    sig.property_specific_intent ||
    st.property_specific_intent ||
    st.direct_property_reference
  ) {
    return {
      priority: PRIORITY.PROPERTY_SPECIFIC,
      key: 'property_specific',
      entry_type: 'property_ad',
      lead_flow: 'demand',
      opening_type: 'property_specific',
    };
  }

  // Demanda explícita ANTES de sticky offer: "Hola, casas en renta…" / "quiero rentar"
  // no debe quedar atrapada en captación ni en menú greeting.
  const rentDemand =
    isRentSearchText(text) ||
    (sig.operation_type === 'rent' && (sig.lead_flow === 'demand' || isDemandSearchInbound(text))) ||
    (sig.lead_flow === 'demand' && sig.operation_type === 'rent');
  const buyDemand =
    isBuyerSearchText(text) ||
    (sig.lead_flow === 'demand' && sig.operation_type === 'sale') ||
    (sig.operation_type === 'sale' && mentionsBuyDemand(normalizeText(text)));

  if (rentDemand && !hasExplicitSellerKeywords(text)) {
    return {
      priority: PRIORITY.RENT_SEARCH,
      key: 'rent_search',
      entry_type: 'buyer_search',
      lead_flow: 'demand',
      opening_type: 'rent_search',
    };
  }

  if (buyDemand && !hasExplicitSellerKeywords(text)) {
    return {
      priority: PRIORITY.BUYER_SEARCH,
      key: 'buyer_search',
      entry_type: 'buyer_search',
      lead_flow: 'demand',
      opening_type: 'buyer_search',
    };
  }

  if (
    hasExplicitSellerKeywords(text) ||
    (!isExplicitDemandSearchText(text) &&
      (sig.lead_flow === 'offer' ||
        r0.isR0StickySaleCaptureThread(st) ||
        st.intent_lock_sale_owner))
  ) {
    return {
      priority: PRIORITY.SELLER_CAPTURE,
      key: 'seller_capture',
      entry_type: 'seller_capture_ad',
      lead_flow: 'offer',
      opening_type: 'seller_capture',
    };
  }

  if (isMetaGeneralEntryText(text)) {
    return {
      priority: PRIORITY.META_GENERAL,
      key: 'meta_general',
      entry_type: 'meta_general_entry',
      lead_flow: null,
      opening_type: 'meta_general',
    };
  }

  if (isSocialReferenceText(text)) {
    return {
      priority: PRIORITY.SOCIAL,
      key: 'social',
      entry_type: 'social_reference',
      lead_flow: null,
      opening_type: 'social_reference',
    };
  }

  if (isGreetingOpeningText(text)) {
    return {
      priority: PRIORITY.GREETING,
      key: 'greeting',
      entry_type: 'greeting',
      lead_flow: null,
      opening_type: 'greeting',
    };
  }

  return {
    priority: PRIORITY.UNKNOWN,
    key: 'unknown',
    entry_type: null,
    lead_flow: sig.lead_flow || st.lead_flow || null,
    opening_type: 'unknown',
  };
}

/**
 * Aplica prioridad sobre señales del parser (greeting/zona no pisan seller).
 */
function applyPriorityToSignals(parsedSignals = {}, text = '', previousAiState = {}) {
  const sig = parsedSignals && typeof parsedSignals === 'object' ? { ...parsedSignals } : {};
  const resolved = resolvePriorityIntent(text, previousAiState, sig);

  if (resolved.key === 'seller_capture') {
    sig.lead_flow = 'offer';
    if (!sig.operation_type) sig.operation_type = 'sale';
    sig.intent_lock_sale_owner = true;
  } else if (resolved.key === 'property_specific') {
    sig.lead_flow = sig.lead_flow || 'demand';
    sig.property_specific_intent = true;
  } else if (resolved.key === 'buyer_search' || resolved.key === 'rent_search') {
    // Demanda explícita siempre gana sobre sticky offer (incidente 8119086196).
    sig.lead_flow = 'demand';
    delete sig.intent_lock_sale_owner;
    if (resolved.key === 'rent_search' && !sig.operation_type) sig.operation_type = 'rent';
    if (resolved.key === 'buyer_search' && !sig.operation_type) sig.operation_type = 'sale';
  }

  sig.__priority_intent = resolved;
  return sig;
}

module.exports = {
  PRIORITY,
  isMetaGeneralEntryText,
  isSocialReferenceText,
  isGreetingOpeningText,
  isBuyerSearchText,
  isRentSearchText,
  isExplicitDemandSearchText,
  resolvePriorityIntent,
  applyPriorityToSignals,
};
