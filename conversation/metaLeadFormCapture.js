'use strict';

/**
 * Meta Lead Form / campañas C1 captación propietarios.
 * Solo cuando el usuario envía el payload del formulario ya completado.
 * Respuesta única; sin filtro por zona ni preguntas extra.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { isUsefulContactName, isInvalidContactName } = require('../utils/helpers');

const META_LEAD_FORM_ACK_REPLY =
  'Gracias por compartir tu información.\n' +
  'Ya revisé tus datos y voy a canalizar tu caso con un asesor de Luxetty para brindarte una orientación inmobiliaria inicial sobre tu propiedad.\n' +
  'En breve te estaremos contactando para dar seguimiento.';

const META_FORM_COMPLETION_PHRASES = [
  'complete el formulario',
  'completé el formulario',
  'completo el formulario',
  'llene el formulario',
  'llene el form',
  'formulario y me gustaria obtener',
  'formulario y me gustaría obtener',
  'filled out your form',
  'filled out the form',
  'completed the form',
  'completed your form',
  'preenchi seu formulario',
  'preenchi seu formulário',
  'preenchi o formulario',
  'preenchi o formulário',
];

function normalizeLabelKey(label) {
  return normalizeText(String(label || ''))
    .replace(/[?¿]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchLabelField(labelNorm) {
  if (!labelNorm) return null;
  if (/nombre completo|^nombre$|full name/.test(labelNorm)) return 'full_name';
  if (/numero de telefono|telefono|celular|whatsapp|phone number|^phone$/.test(labelNorm)) return 'phone';
  if (/en que colonia|colonia se encuentra|^colonia$|^zona$|ubicacion|sector/.test(labelNorm)) {
    return 'location_text';
  }
  if (/que tipo de propiedad|tipo de propiedad|^tipo$/.test(labelNorm)) return 'property_type_raw';
  if (/que te gustaria hacer|gustaria hacer|objetivo|operacion|que deseas hacer|qu[eé] deseas hacer/.test(labelNorm)) {
    return 'operation_raw';
  }
  if (/decision sobre la venta|venta o renta/.test(labelNorm)) return 'sale_decision_raw';
  if (/cuanto tiempo|en cuanto tiempo|timeline/.test(labelNorm)) return 'timeline_raw';
  if (/cumbres.*garcia|zona poniente|esta en cumbres/.test(labelNorm)) return 'priority_zone_raw';
  if (/correo|email|e mail/.test(labelNorm)) return 'email';
  return null;
}

function normalizePropertyTypeFromForm(value) {
  const t = normalizeText(String(value || ''));
  if (!t) return null;
  if (/\b(casa|house)\b/.test(t)) return 'house';
  if (/\b(depa|departamento|apartment|condo)\b/.test(t)) return 'apartment';
  if (/\b(terreno|land|lote)\b/.test(t)) return 'land';
  if (/\b(local|comercial|oficina|bodega)\b/.test(t)) return 'commercial';
  return null;
}

function normalizeOperationFromForm(value) {
  const t = normalizeText(String(value || ''));
  if (!t) return 'sale';
  if (/\b(rent|renta|arrendar|rentar)\b/.test(t) && !/\b(vender|venta)\b/.test(t)) return 'rent';
  return 'sale';
}

function formatPersonName(name) {
  let s = cleanSpaces(String(name || '')).replace(/[.,!?]+$/g, '');
  if (s.includes('|')) s = cleanSpaces(s.split('|')[0]);
  if (!s || !isUsefulContactName(s) || isInvalidContactName(s)) return null;
  return s
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?]+$/g, '').charAt(0).toUpperCase() + w.replace(/[.,!?]+$/g, '').slice(1).toLowerCase())
    .join(' ');
}

function parseFormLine(trimmed) {
  const metaQuestion = trimmed.match(/^(.+?\?)\s*:\s*(.+)$/);
  if (metaQuestion) {
    return { label: metaQuestion[1], value: metaQuestion[2] };
  }
  const plain = trimmed.match(/^(.+?):\s*(.+)$/);
  if (plain) {
    return { label: plain[1], value: plain[2] };
  }
  return null;
}

function parseLabeledFormFieldsFromLines(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const raw = String(text || '');
  for (const line of raw.split(/\n+/)) {
    const trimmed = cleanSpaces(line.replace(/^[\s•●▪*-]+/, ''));
    if (!trimmed) continue;
    const parsed = parseFormLine(trimmed);
    if (!parsed) continue;
    const field = matchLabelField(normalizeLabelKey(parsed.label));
    const value = cleanSpaces(parsed.value.replace(/[.!?]+$/g, ''));
    if (!field || !value) continue;
    out[field] = value;
  }
  return out;
}

/**
 * Reconstruye segmentos cuando el webhook colapsó saltos de línea (cleanSpaces).
 * Meta Lead Form real: bullets •, labels snake_case, preguntas ¿...?:
 */
function expandCollapsedMetaFormText(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;

  const multilineSegments = raw.split(/\n+/).filter((line) => cleanSpaces(line));
  if (multilineSegments.length >= 2 && Object.keys(parseLabeledFormFieldsFromLines(raw)).length >= 2) {
    return raw;
  }

  let expanded = raw;

  if (/\s[•●▪]/.test(expanded) || /[•●▪]\s/.test(expanded)) {
    expanded = expanded.replace(/\s*[•●▪]\s*/g, '\n• ');
  }

  expanded = expanded.replace(/\s+(?=¿[^?\n]{2,160}\?\s*:)/g, '\n');

  expanded = expanded.replace(
    /\s+(?=[\p{L}\p{N}_]+(?:_[\p{L}\p{N}_áéíóúñÁÉÍÓÚÑ]+)+\s*:)/gu,
    '\n',
  );

  expanded = expanded.replace(
    /\s+(?=(?:Nombre(?:\s+completo)?|Full name|Phone number|Colonia|Tipo de propiedad|Operaci[oó]n|N[uú]mero de tel[eé]fono|T[eé]lefono|Email|Correo|E mail)\s*:)/gi,
    '\n',
  );

  return expanded.trim();
}

function parseLabeledFormFields(text) {
  return parseLabeledFormFieldsFromLines(expandCollapsedMetaFormText(text));
}

function isMetaLeadFormCompletionText(text) {
  const t = normalizeText(text);
  return META_FORM_COMPLETION_PHRASES.some((p) => t.includes(normalizeText(p)));
}

function countLabeledFields(text) {
  return Object.keys(parseLabeledFormFields(text)).length;
}

function parseNfmLeadFormFields(message) {
  const raw = message?.interactive?.nfm_reply?.response_json;
  if (!raw) return null;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (value == null || typeof value === 'object') continue;
      const field = matchLabelField(normalizeLabelKey(key));
      if (field) out[field] = cleanSpaces(String(value));
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function isC1SellerCaptureCampaign(campaignContext) {
  if (!campaignContext || typeof campaignContext !== 'object') return false;
  if (campaignContext.campaign_type === 'seller_capture' || campaignContext.campaign_type === 'valuation') {
    return true;
  }
  const bag = normalizeText(
    [campaignContext.campaign_name, campaignContext.ad_name, campaignContext.headline, campaignContext.ad_body]
      .filter(Boolean)
      .join(' '),
  );
  return /(captaci[oó]n|c1|propietari|vende tu propiedad|vender tu casa|valuaci[oó]n comercial)/i.test(bag);
}

function hasStructuredFormPayload(text, message) {
  if (countLabeledFields(text) >= 2) return true;
  const nfm = parseNfmLeadFormFields(message);
  return !!(nfm && Object.keys(nfm).length >= 2);
}

function mergeParsedLeadForm({ text, message, parsedSignals = {}, previousAiState = {} }) {
  const labeled = {
    ...parseLabeledFormFields(text),
    ...(parseNfmLeadFormFields(message) || {}),
  };

  const fullName =
    formatPersonName(labeled.full_name) ||
    formatPersonName(parsedSignals.full_name) ||
    cleanSpaces(String(previousAiState.full_name || '')) ||
    null;

  const locationText =
    cleanSpaces(labeled.location_text || parsedSignals.location_text || previousAiState.location_text || '') ||
    null;

  const propertyType =
    normalizePropertyTypeFromForm(labeled.property_type_raw) ||
    parsedSignals.property_type ||
    previousAiState.property_type ||
    null;

  const operationType =
    normalizeOperationFromForm(labeled.operation_raw) ||
    parsedSignals.operation_type ||
    previousAiState.operation_type ||
    'sale';

  const exploring =
    labeled.sale_decision_raw &&
    /\b(explorando|explor|no se|no sé|aun no|todavia|todavía|depende)\b/i.test(
      normalizeText(labeled.sale_decision_raw),
    );

  return {
    full_name: fullName,
    location_text: locationText,
    property_type: propertyType,
    operation_type: operationType,
    email: labeled.email || null,
    phone: labeled.phone || null,
    is_exploring_sale: exploring === true,
    labeled,
  };
}

function isMetaLeadFormStructuredInbound({
  text,
  message,
  campaignContext,
  previousAiState = {},
  parsedSignals = {},
}) {
  void parsedSignals;

  try {
    const { isPropertyDemandMetaLeadForm } = require('./propertyPautaHandoff');
    if (
      isPropertyDemandMetaLeadForm({
        text,
        message,
        campaignContext,
        parsedSignals,
        previousAiState,
      })
    ) {
      return false;
    }
  } catch (_e) {
    /* optional in isolated tests */
  }

  if (previousAiState.meta_lead_form_ack_sent === true) return false;
  if (previousAiState.meta_lead_form_flow === true && previousAiState.handoff_sent === true) {
    return false;
  }

  if (!hasStructuredFormPayload(text, message)) return false;

  // Solo payloads Meta Lead Form completados (WhatsApp).
  if (isMetaLeadFormCompletionText(text) && countLabeledFields(text) >= 2) {
    return true;
  }

  const nfm = parseNfmLeadFormFields(message);
  if (nfm && Object.keys(nfm).length >= 2) {
    return true;
  }

  return false;
}

function buildMetaLeadFormStatePatch(parsed, campaignContext, previousAiState = {}) {
  const campaignMerged = {
    ...(previousAiState.campaign_context && typeof previousAiState.campaign_context === 'object'
      ? previousAiState.campaign_context
      : {}),
    ...(campaignContext && typeof campaignContext === 'object' ? campaignContext : {}),
    source_context: 'meta_lead_form',
    capture_channel: 'whatsapp',
    lead_type: 'supply',
    lead_intent: 'capture_property',
  };

  return {
    meta_lead_form_flow: true,
    meta_lead_form_ack_sent: true,
    source_context: 'meta_lead_form',
    budget_max: null,
    budget_min: null,
    lead_flow: 'offer',
    operation_type: parsed.operation_type || 'sale',
    conversation_goal_locked: true,
    intent_lock_sale_owner: true,
    intent_type: 'sell',
    full_name: parsed.full_name || null,
    location_text: parsed.location_text || null,
    property_type: parsed.property_type || null,
    is_exploring_sale: parsed.is_exploring_sale === true,
    geo_qualified: true,
    value_qualified: true,
    handoff_sent: true,
    wants_human: true,
    advisor_contact_consent: 'ACCEPTED',
    awaiting_field: null,
    handoff_stage: 'HANDOFF_READY',
    conversation_stage: 'HANDOFF_READY',
    qualification_complete: true,
    crm_payload_ready: true,
    campaign_context: campaignMerged,
    user_goal: 'capture_property',
    lead_type: 'supply',
    crm_structured_summary: {
      source: 'meta_lead_form',
      contact_name: parsed.full_name || null,
      zone: parsed.location_text || null,
      property_type: parsed.property_type || null,
      operation_type: parsed.operation_type || 'sale',
      email: parsed.email || null,
      phone: parsed.phone || null,
      form_fields: parsed.labeled || {},
    },
    entry_point_last: { entry_type: 'meta_lead_form_c1', lead_flow: 'offer' },
    low_info_campaign_message: false,
  };
}

function buildMetaLeadFormSignalsPatch(parsed) {
  return {
    lead_flow: 'offer',
    operation_type: parsed.operation_type || 'sale',
    full_name: parsed.full_name || null,
    location_text: parsed.location_text || null,
    property_type: parsed.property_type || null,
    low_info_campaign_message: false,
    intent_lock_sale_owner: true,
    is_exploring_sale: parsed.is_exploring_sale === true,
  };
}

/**
 * @returns {{ handled: boolean, reply?: string, statePatch?: object, signalsPatch?: object, responseSource?: string }}
 */
function tryMetaLeadFormCaptureTurn({
  text,
  message,
  campaignContext,
  previousAiState = {},
  parsedSignals = {},
}) {
  if (
    !isMetaLeadFormStructuredInbound({
      text,
      message,
      campaignContext,
      previousAiState,
      parsedSignals,
    })
  ) {
    return { handled: false };
  }

  const parsed = mergeParsedLeadForm({ text, message, parsedSignals, previousAiState });
  const statePatch = buildMetaLeadFormStatePatch(parsed, campaignContext, previousAiState);
  const signalsPatch = buildMetaLeadFormSignalsPatch(parsed);

  return {
    handled: true,
    reply: META_LEAD_FORM_ACK_REPLY,
    statePatch,
    signalsPatch,
    responseSource: 'meta_lead_form_c1',
  };
}

module.exports = {
  META_LEAD_FORM_ACK_REPLY,
  isC1SellerCaptureCampaign,
  isMetaLeadFormCompletionText,
  isMetaLeadFormStructuredInbound,
  expandCollapsedMetaFormText,
  parseLabeledFormFields,
  mergeParsedLeadForm,
  tryMetaLeadFormCaptureTurn,
};
