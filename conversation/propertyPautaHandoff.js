'use strict';

/**
 * Pauta de propiedad (demanda): respuesta única de handoff al asesor responsable.
 * Sin calificación genérica ni menús comprar/rentar/vender.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { resolvePautaPropertyCrmContext } = require('./pautaDetection');
const {
  isMetaLeadFormCompletionText,
  parseLabeledFormFields,
  mergeParsedLeadForm,
} = require('./metaLeadFormCapture');

const PROPERTY_PAUTA_HANDOFF_REPLY =
  'En breve te contactará el asesor que tiene esta propiedad asignada. Gracias por tu interés.';

function propertySnapshot(property = null) {
  const row = property?.raw && typeof property.raw === 'object' ? property.raw : property || {};
  return {
    title: cleanSpaces(String(property?.title || row.title || '')) || null,
    operation: cleanSpaces(String(property?.operation_type || row.operation_type || '')) || null,
    location:
      cleanSpaces(
        String(property?.neighborhood || row.neighborhood || property?.zone || row.zone || '')
      ) || null,
    price: Number(property?.price || row.price || 0) || null,
    currency: cleanSpaces(String(property?.currency_code || row.currency_code || 'MXN')) || 'MXN',
  };
}

function buildPropertyPautaReply({ parsed = {}, property = null, text = '' } = {}) {
  const snapshot = propertySnapshot(property);
  const action = normalizeText(String(parsed?.labeled?.operation_raw || text || ''));
  const asksVisit = /agendar\s+una\s+visita|visitar|conocer\s+la\s+propiedad/.test(action);
  const asksAdvisor = /hablar\s+con\s+un\s+asesor|asesor/.test(action);
  const propertyName = snapshot.title ? ` “${snapshot.title}”` : '';

  if (asksVisit) {
    if (!snapshot.title) {
      return 'Gracias, ya recibí tu solicitud de visita. Primero validaremos el anuncio de origen para no asociarla con otra propiedad. Un asesor te contactará para continuar.';
    }
    return `Gracias, ya recibí tus datos y tu solicitud para visitar${propertyName}. El asesor responsable confirmará contigo disponibilidad y horario.`;
  }
  if (asksAdvisor) {
    if (!snapshot.title) {
      return 'Gracias, ya recibí tu solicitud para hablar con un asesor. Te contactará para continuar.';
    }
    return `Gracias, ya recibí tus datos y tu interés en${propertyName}. El asesor responsable te contactará para continuar.`;
  }
  if (!snapshot.title) {
    return 'Gracias, ya recibí tus datos y tu solicitud de información. Primero validaremos el anuncio de origen para no darte datos de otra propiedad; un asesor te contactará para continuar.';
  }

  const facts = [];
  if (snapshot.operation) facts.push(snapshot.operation === 'rent' ? 'en renta' : 'en venta');
  if (snapshot.location) facts.push(`en ${snapshot.location}`);
  if (snapshot.price) {
    facts.push(
      `por ${new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: snapshot.currency,
        maximumFractionDigits: 0,
      }).format(snapshot.price)}`
    );
  }
  const detail = facts.length ? ` Está ${facts.join(' ') }.` : '';
  return `Gracias, ya recibí tus datos y tu interés en “${snapshot.title}”.${detail} El asesor responsable confirmará disponibilidad contigo y puede ayudarte a agendar una visita.`;
}

const DEMAND_FORM_ACTION_PATTERNS = [
  /recibir\s+mas\s+informaci/,
  /recibir\s+m[aá]s\s+informaci/,
  /mas\s+informaci/,
  /m[aá]s\s+informaci/,
  /solicitar\s+informaci/,
  /informacion\s+sobre/,
  /informaci[oó]n\s+sobre/,
  /me\s+interesa/,
  /quiero\s+ver/,
  /consultar/,
];

function normalizeOperationRaw(value) {
  return normalizeText(String(value || '')).replace(/[^\w\sáéíóúñ]/gi, ' ');
}

function hasMetaPropertyDemandFormBagSignals(raw) {
  const bag = normalizeText(String(raw || ''));
  if (!isMetaLeadFormCompletionText(raw)) return false;
  if (!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(String(raw || ''))) return false;
  if (DEMAND_FORM_ACTION_PATTERNS.some((re) => re.test(bag))) return true;
  if (/que deseas hacer|full name|phone number/.test(bag)) return true;
  return false;
}

function isPropertyDemandMetaLeadForm({ text, message, campaignContext, parsedSignals = {}, previousAiState = {} }) {
  void message;
  void parsedSignals;
  void previousAiState;

  const raw = String(text || '');
  if (!isMetaLeadFormCompletionText(raw)) return false;

  const labeled = parseLabeledFormFields(raw);
  const fieldCount = Object.keys(labeled).length;
  if (fieldCount < 2 && !hasMetaPropertyDemandFormBagSignals(raw)) return false;

  const camp =
    campaignContext && typeof campaignContext === 'object'
      ? campaignContext
      : previousAiState?.campaign_context && typeof previousAiState.campaign_context === 'object'
        ? previousAiState.campaign_context
        : {};

  if (camp.campaign_type === 'property_listing' || cleanSpaces(String(camp.property_code || ''))) {
    return true;
  }

  const opRaw = normalizeOperationRaw(labeled.operation_raw || '');
  if (DEMAND_FORM_ACTION_PATTERNS.some((re) => re.test(opRaw))) return true;

  const hasSellerFields = !!(
    labeled.location_text ||
    labeled.sale_decision_raw ||
    labeled.priority_zone_raw ||
    labeled.timeline_raw ||
    labeled.property_type_raw
  );
  if (hasSellerFields) return false;

  const bag = normalizeText([raw, opRaw, labeled.operation_raw].filter(Boolean).join(' '));
  if (DEMAND_FORM_ACTION_PATTERNS.some((re) => re.test(bag))) return true;
  if (/que\s+deseas\s+hacer|qu[eé]\s+deseas\s+hacer/.test(bag) && /informaci|interes/i.test(bag)) {
    return true;
  }

  return !!(labeled.full_name && labeled.email && fieldCount <= 4);
}

function isPropertyPautaHandoffThread(aiState = {}, campaignContext = null) {
  if (!aiState || typeof aiState !== 'object') return false;
  if (aiState.property_pauta_handoff_sent === true) return true;

  if (aiState.meta_lead_form_flow === true && aiState.lead_flow === 'demand') return true;
  if (aiState.intake_source === 'property_demand') return true;

  const camp =
    campaignContext && typeof campaignContext === 'object'
      ? campaignContext
      : aiState.campaign_context && typeof aiState.campaign_context === 'object'
        ? aiState.campaign_context
        : {};

  if (camp.campaign_type === 'seller_capture' || camp.campaign_type === 'valuation') return false;
  if (aiState.lead_flow === 'offer' || aiState.intent_lock_sale_owner === true) return false;

  const entry = aiState.entry_point_last && typeof aiState.entry_point_last === 'object'
    ? aiState.entry_point_last
    : {};
  if (entry.landing_key === 'property_demand') return true;

  const pautaCtx = resolvePautaPropertyCrmContext(aiState);
  const hasListingCampaign =
    camp.campaign_type === 'property_listing' ||
    !!cleanSpaces(String(camp.property_code || '')) ||
    !!pautaCtx.propertyCode ||
    !!pautaCtx.propertyId;

  if (entry.entry_type === 'property_ad' && (pautaCtx.hasCampaign || pautaCtx.hasReferral || hasListingCampaign)) {
    return true;
  }

  if ((pautaCtx.hasCampaign || pautaCtx.hasReferral) && hasListingCampaign) {
    return true;
  }

  return false;
}

function buildPropertyPautaHandoffStatePatch({
  parsed,
  campaignContext,
  previousAiState = {},
  fromMetaLeadForm = false,
}) {
  const campaignMerged = {
    ...(previousAiState.campaign_context && typeof previousAiState.campaign_context === 'object'
      ? previousAiState.campaign_context
      : {}),
    ...(campaignContext && typeof campaignContext === 'object' ? campaignContext : {}),
    source_context: fromMetaLeadForm ? 'meta_lead_form_property_demand' : 'property_pauta',
    capture_channel: 'whatsapp',
    lead_type: 'demand',
    lead_intent: 'property_interest',
  };

  return {
    property_pauta_handoff_sent: true,
    meta_lead_form_flow: fromMetaLeadForm ? true : previousAiState.meta_lead_form_flow === true,
    meta_lead_form_ack_sent: fromMetaLeadForm ? true : previousAiState.meta_lead_form_ack_sent === true,
    source_context: fromMetaLeadForm ? 'meta_lead_form_property_demand' : 'property_pauta',
    lead_flow: 'demand',
    lead_type: 'demand',
    operation_type: parsed?.operation_type === 'rent' ? 'rent' : 'purchase',
    intent_type: 'property_interest',
    property_specific_intent: true,
    full_name: parsed?.full_name || previousAiState.full_name || null,
    email: parsed?.email || null,
    handoff_sent: true,
    wants_human: true,
    conversation_mode: 'HUMAN_WAITING',
    advisor_contact_consent: 'ACCEPTED',
    awaiting_field: null,
    handoff_stage: 'HANDOFF_READY',
    conversation_stage: 'HANDOFF_READY',
    qualification_complete: true,
    crm_payload_ready: true,
    geo_qualified: true,
    value_qualified: true,
    campaign_context: campaignMerged,
    user_goal: 'property_interest',
    entry_point_last: {
      entry_type: fromMetaLeadForm ? 'meta_lead_form_property_demand' : 'property_ad',
      lead_flow: 'demand',
      landing_key: 'property_demand',
    },
    low_info_campaign_message: false,
  };
}

function buildPropertyPautaHandoffSignalsPatch(parsed = {}) {
  return {
    lead_flow: 'demand',
    operation_type: parsed.operation_type === 'rent' ? 'rent' : 'purchase',
    full_name: parsed.full_name || null,
    low_info_campaign_message: false,
    property_specific_intent: true,
  };
}

/**
 * @returns {{ handled: boolean, reply?: string, statePatch?: object, signalsPatch?: object, responseSource?: string }}
 */
function tryPropertyPautaHandoffTurn({
  text,
  message,
  campaignContext,
  property = null,
  previousAiState = {},
  parsedSignals = {},
}) {
  const demandMetaForm = isPropertyDemandMetaLeadForm({
    text,
    message,
    campaignContext,
    parsedSignals,
    previousAiState,
  });

  const inThread = isPropertyPautaHandoffThread(previousAiState, campaignContext);

  if (!demandMetaForm && !inThread) {
    return { handled: false };
  }

  // El gate de conversation_mode debe conservar el control después del
  // handoff. Nunca repetir el mismo mensaje ante un follow-up o ante un
  // mensaje del asesor dentro del hilo.
  if (!demandMetaForm && previousAiState.property_pauta_handoff_sent === true) {
    return { handled: false, reason: 'post_handoff_mode_gate' };
  }

  if (demandMetaForm) {
    const parsed = mergeParsedLeadForm({ text, message, parsedSignals, previousAiState });
    return {
      handled: true,
      reply: buildPropertyPautaReply({ parsed, property, text }),
      statePatch: buildPropertyPautaHandoffStatePatch({
        parsed,
        campaignContext,
        previousAiState,
        fromMetaLeadForm: true,
      }),
      signalsPatch: buildPropertyPautaHandoffSignalsPatch(parsed),
      responseSource: 'property_pauta_meta_lead_form',
    };
  }

  return {
    handled: true,
    reply: PROPERTY_PAUTA_HANDOFF_REPLY,
    statePatch: {
      property_pauta_handoff_sent: true,
      handoff_sent: true,
      advisor_contact_consent: 'ACCEPTED',
      awaiting_field: null,
      handoff_stage: 'HANDOFF_READY',
      conversation_stage: 'HANDOFF_READY',
    },
    signalsPatch: {
      lead_flow: 'demand',
      property_specific_intent: true,
    },
    responseSource: 'property_pauta_handoff',
  };
}

module.exports = {
  PROPERTY_PAUTA_HANDOFF_REPLY,
  buildPropertyPautaReply,
  isPropertyDemandMetaLeadForm,
  isPropertyPautaHandoffThread,
  tryPropertyPautaHandoffTurn,
};
