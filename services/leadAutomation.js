const { nowIso, normalizePhoneNumber } = require('../utils/helpers');
const { normalizeText } = require('../utils/text');
const { preferredZonesFromAiState } = require('../utils/preferredZoneSanitizer');
const { getPerseoV3Config, isPhoneOnV3Allowlist } = require('../config/perseoV3Flags');
const { resolveAssignmentDecision } = require('./assignmentDecision');
const { generateLeadNotesSummaryOpenAI } = require('./leadNotesSummaryOpenAI');
const { emitLeadUnassigned, emitCrmError } = require('./notificationEmitter');

function log(logger, label, payload = {}) {
  const writer = logger && typeof logger.info === 'function' ? logger.info.bind(logger) : console.log;
  writer(label, payload);
}

function logWarn(logger, label, payload = {}) {
  const writer = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
  writer(label, payload);
}

function notifyLeadUnassigned(supabase, ctx, logger) {
  emitLeadUnassigned(
    supabase,
    ctx,
    (type, payload) => log(logger, type, payload)
  );
}

async function saveConversationEvent(supabase, conversationId, type, payload = {}) {
  if (!supabase || !conversationId || !type) return;

  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: conversationId,
    type,
    payload,
  });

  if (error) {
    console.error('LEAD_AUTOMATION_EVENT_ERROR', { type, error: error.message });
  }
}

/**
 * QA F6.1: tras !resetcrm, forzar INSERT de lead aunque exista compatible por teléfono/propiedad.
 * Solo allowlist V3 + PERSEO_V3_CRM_EXECUTE=true (no afecta producción).
 */
function shouldForceNewLeadForQaCrm(aiState = {}, conversation = {}) {
  if (aiState?.qa_crm_force_new_lead !== true) return false;
  const cfg = getPerseoV3Config();
  if (!cfg.crmExecute) return false;
  const phone = normalizePhoneNumber(conversation?.phone) || conversation?.phone || null;
  if (!phone || !isPhoneOnV3Allowlist(phone)) return false;
  return true;
}

/** Demanda: compra, renta o consulta por propiedad específica. */
function isDemandLeadContext(leadType, aiState = {}) {
  if (leadType === 'demand') return true;
  if (aiState?.lead_type === 'demand') return true;
  if (aiState?.lead_flow === 'demand') return true;
  const goal = normalizeText(aiState.conversation_goal || aiState.user_goal || '');
  return goal === 'buy_property' || goal === 'rent_property' || goal === 'property_inquiry';
}

function resolvePropertyAgentId(property) {
  if (!property || typeof property !== 'object') return null;
  return property.agent_profile_id || property.assigned_agent_profile_id || null;
}

/**
 * Prioridad oficial de asignación para demanda:
 * - contacto existente con dueño → contacto (nunca asesor de propiedad).
 * - contacto nuevo + propiedad → asesor de la propiedad.
 * - resto → propiedad / campaña / contacto / conversación (supply u otros).
 */
function buildAssignmentPriorityCandidates(context = {}, logger) {
  const propertyAgentId = resolvePropertyAgentId(context.property);
  const campaignAgentId = context.campaignAgentProfileId || null;
  const contactAgentId = context.contactAssignedAgentProfileId || null;
  const conversationAgentId = context.conversationAssignedAgentProfileId || null;
  const isDemand = isDemandLeadContext(context.leadType, context.aiState);
  const contactIsNew = context.contactWasCreated === true;
  const contactHasOwner = !!contactAgentId;

  if (isDemand && contactHasOwner && !contactIsNew) {
    log(logger, 'assignment_owner_contact_priority', {
      lead_id: context.leadId || null,
      conversation_id: context.conversationId || null,
      contact_assigned_agent_profile_id: contactAgentId,
      property_id: context.propertyId || null,
    });
    return [
      {
        agentId: contactAgentId,
        strategy: 'contact_owner',
        reason: 'assigned_by_contact_owner',
      },
      campaignAgentId
        ? {
            agentId: campaignAgentId,
            strategy: 'campaign_agent',
            reason: 'assigned_by_campaign_context',
          }
        : null,
      conversationAgentId
        ? {
            agentId: conversationAgentId,
            strategy: 'conversation_owner',
            reason: 'assigned_by_conversation_owner',
          }
        : null,
    ].filter(Boolean);
  }

  if (contactIsNew && propertyAgentId) {
    log(logger, 'assignment_property_owner_for_new_contact', {
      lead_id: context.leadId || null,
      conversation_id: context.conversationId || null,
      property_assigned_agent_profile_id: propertyAgentId,
      property_id: context.propertyId || null,
    });
  }

  return [
    propertyAgentId
      ? {
          agentId: propertyAgentId,
          strategy: 'property_owner_agent',
          reason: 'assigned_by_property_owner_agent',
        }
      : null,
    campaignAgentId
      ? {
          agentId: campaignAgentId,
          strategy: 'campaign_agent',
          reason: 'assigned_by_campaign_context',
        }
      : null,
    contactAgentId
      ? {
          agentId: contactAgentId,
          strategy: 'contact_owner',
          reason: 'assigned_by_contact_owner',
        }
      : null,
    conversationAgentId
      ? {
          agentId: conversationAgentId,
          strategy: 'conversation_owner',
          reason: 'assigned_by_conversation_owner',
          }
        : null,
  ].filter(Boolean);
}

function resolveLeadType(aiState = {}) {
  if (aiState.lead_type === 'supply' || aiState.lead_type === 'demand') return aiState.lead_type;
  if (aiState.lead_flow === 'offer') return 'supply';
  if (aiState.lead_flow === 'demand') return 'demand';
  if (aiState.direct_property_reference || aiState.property_code || aiState.direct_property_code) return 'demand';

  const campaignCode =
    aiState.campaign_context && typeof aiState.campaign_context === 'object'
      ? aiState.campaign_context.property_code
      : null;
  if (campaignCode) return 'demand';

  const goal = normalizeText(aiState.user_goal || '');
  if (goal.includes('capture')) return 'supply';
  if (goal.includes('search')) return 'demand';

  return null;
}

function clampLeadScore(score) {
  return Math.max(0, Math.min(100, Number(score) || 0));
}

function getLeadTemperature(score) {
  if (score <= 40) return 'cold';
  if (score <= 70) return 'warm';
  return 'hot';
}

function hasAmbiguousIntent(aiState = {}, intent = {}) {
  const confidence = normalizeText(aiState.confidence || intent.confidence || '');
  const leadType = intent.leadType || intent.lead_type || aiState.lead_type || resolveLeadType(aiState);

  if (!leadType) return true;

  if (
    confidence === 'low' &&
    !aiState.budget_max &&
    !aiState.location_text &&
    !aiState.property_code &&
    !aiState.direct_property_code
  ) {
    return true;
  }

  return false;
}

function calculateLeadScore({ aiState = {}, intent = {} } = {}) {
  let score = 0;

  if (aiState.budget_min != null || aiState.budget_max != null || intent.budget_min != null || intent.budget_max != null) {
    score += 30;
  }

  if (aiState.location_text || aiState.matched_location_from_catalog || intent.location_text) {
    score += 20;
  }

  if (
    aiState.property_code ||
    aiState.direct_property_code ||
    aiState.direct_property_reference ||
    intent.property_code ||
    intent.direct_property_reference
  ) {
    score += 30;
  }

  if (
    aiState.wants_visit ||
    aiState.wants_human ||
    aiState.asks_property_details ||
    intent.wants_visit ||
    intent.wants_human ||
    intent.asks_property_details
  ) {
    score += 20;
  }

  if (hasAmbiguousIntent(aiState, intent)) {
    score -= 20;
  }

  const leadScore = clampLeadScore(score);

  return {
    lead_score: leadScore,
    lead_temperature: getLeadTemperature(leadScore),
  };
}

function hasSupplyCompleteData(lead = {}) {
  const preferredZones = Array.isArray(lead.preferred_zones) ? lead.preferred_zones : [];
  const notes = normalizeText(lead.notes_summary || '');

  return (
    lead.lead_type === 'supply' &&
    lead.budget_max != null &&
    preferredZones.length > 0 &&
    (
      !!lead.property_type ||
      notes.includes('tipo:')
    )
  );
}

function shouldTriggerHandoff(lead = {}) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.assigned_agent_profile_id) return false;

  if (lead.wants_human || lead.wants_visit || lead.asks_property_details) return true;

  if (Number(lead.lead_score || 0) > 70) return true;
  if (
    lead.intent_type === 'property_interest' ||
    lead.property_interest === true ||
    !!lead.interested_property_id
  ) {
    return true;
  }

  if (hasSupplyCompleteData(lead)) return true;

  return false;
}

function sameNullableValue(left, right) {
  return (left || null) === (right || null);
}

function isLeadCompatible(lead, { contactId, leadType, operation, propertyId }) {
  if (!lead) return false;
  if (!sameNullableValue(lead.contact_id, contactId)) return false;
  if (!sameNullableValue(lead.lead_type, leadType)) return false;
  if (!sameNullableValue(lead.interested_in_operation, operation || null)) return false;
  if (!sameNullableValue(lead.interested_property_id, propertyId || null)) return false;
  if (lead.is_active === false || lead.is_archived === true) return false;
  return true;
}

function buildResetAiStateAfterLeadCreated(aiState = {}, lead, assignment = {}) {
  const preserveDemandMemory = (lead?.lead_type || aiState?.lead_flow) === 'demand';
  return {
    lead_flow: preserveDemandMemory ? aiState.lead_flow || 'demand' : null,
    operation_type: preserveDemandMemory ? aiState.operation_type || lead?.interested_in_operation || null : null,
    property_type: preserveDemandMemory ? aiState.property_type || null : null,
    location_text: preserveDemandMemory ? aiState.location_text || null : null,
    matched_location_from_catalog: preserveDemandMemory ? aiState.matched_location_from_catalog || null : null,
    location_any: preserveDemandMemory ? !!aiState.location_any : false,
    budget_min: preserveDemandMemory ? aiState.budget_min ?? null : null,
    budget_max: preserveDemandMemory ? aiState.budget_max ?? null : null,
    budget_currency: preserveDemandMemory ? aiState.budget_currency || null : null,
    bedrooms: preserveDemandMemory ? aiState.bedrooms ?? null : null,
    bedrooms_any: preserveDemandMemory ? !!aiState.bedrooms_any : false,
    bathrooms: null,
    must_have_features: [],
    timeline_text: null,
    urgency_level: null,
    full_name: aiState.full_name || null,
    owner_relation: null,
    contact_preference: aiState.contact_preference || null,
    contact_number_confirmed: aiState.contact_number_confirmed ?? null,
    awaiting_field: null,
    last_change_type: 'context_reset_after_lead_created',
    intent_version: (aiState.intent_version || 1) + 1,
    needs_fresh_search: false,
    last_search_filters: null,
    last_search_result_count: 0,
    last_shown_property_ids: [],
    wants_human: false,
    user_goal: null,
    confidence: 'low',
    geo_qualified: null,
    value_qualified: null,
    capture_qualified: null,
    handoff_ready: false,
    handoff_sent: false,
    closing_message_sent: false,
    lead_id: lead.id,
    assigned_agent_profile_id:
      assignment.assignedAgentProfileId || lead.assigned_agent_profile_id || null,
    last_completed_lead: {
      lead_id: lead.id,
      lead_type: lead.lead_type || null,
      interested_in_operation: lead.interested_in_operation || null,
      interested_property_id: lead.interested_property_id || null,
      completed_at: nowIso(),
    },
    ai_context_reset_after_lead_created_at: nowIso(),
    // Sprint 5B: preservar contexto de campaña e integration_contract tras reset
    whatsapp_referral: aiState.whatsapp_referral || null,
    campaign_context: aiState.campaign_context || null,
    integration_contract: aiState.integration_contract
      ? {
          ...aiState.integration_contract,
          lead_id: lead.id,
          contact_id: lead.contact_id || null,
          assigned_agent_profile_id:
            assignment.assignedAgentProfileId || lead.assigned_agent_profile_id || null,
          linked_at: aiState.integration_contract.linked_at || nowIso(),
        }
      : null,
  };
}

function resolveOperation(aiState = {}, property = null) {
  const propertyOperation = property?.operation_type || null;
  const stateOperation = aiState.operation_type || aiState.interested_in_operation || null;
  // P0: la propiedad/campaña nunca puede reescribir una operación ya expresada
  // por el cliente. "purchase" es el alias conversacional de sale en CRM.
  const normalizedStateOperation = stateOperation === 'purchase' ? 'sale' : stateOperation;
  const operation = normalizedStateOperation || propertyOperation;

  if (operation === 'sale' || operation === 'rent') return operation;
  return null;
}

function hasCommercialContext(aiState = {}, propertyId = null) {
  if (propertyId) return true;
  if (aiState.direct_property_reference && (aiState.property_code || aiState.direct_property_code)) return false;

  return Boolean(
    aiState.location_text ||
      aiState.location_any ||
      aiState.property_type ||
      aiState.budget_min != null ||
      aiState.budget_max != null ||
      aiState.wants_visit ||
      aiState.asks_property_details ||
      aiState.wants_human ||
      aiState.shows_high_interest
  );
}

function hasClearIntent(aiState = {}, propertyId = null) {
  if (propertyId) return true;

  const leadType = resolveLeadType(aiState);
  if (!leadType) return false;

  if (leadType === 'supply') return hasCommercialContext(aiState, propertyId);

  if (aiState.shows_high_interest && !aiState.property_type && !aiState.location_text && !aiState.budget_max) {
    return false;
  }

  return hasCommercialContext(aiState, propertyId);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function extractReferralFromRawPayload(rawPayload = null) {
  if (!isPlainObject(rawPayload)) return null;

  const direct = rawPayload?.perseo_metadata?.whatsapp_referral;
  if (isPlainObject(direct)) return direct;

  const messageReferral = rawPayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.referral;
  if (isPlainObject(messageReferral)) return messageReferral;

  const contextReferral = rawPayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context?.referral;
  if (isPlainObject(contextReferral)) return contextReferral;

  return null;
}

function parseUtmFromUrl(rawUrl) {
  const sourceUrl = firstNonEmptyString(rawUrl);
  if (!sourceUrl) return null;

  try {
    const parsed = new URL(sourceUrl);
    const pick = (name) => firstNonEmptyString(parsed.searchParams.get(name));
    const utm = {
      utm_source: pick('utm_source'),
      utm_medium: pick('utm_medium'),
      utm_campaign: pick('utm_campaign'),
      utm_term: pick('utm_term'),
      utm_content: pick('utm_content'),
    };
    const hasAny = Object.values(utm).some(Boolean);
    return hasAny ? utm : null;
  } catch (_err) {
    return null;
  }
}

function inferPropertyCodeFromText(rawText = '') {
  const text = String(rawText || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–—−_./,#:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const fullMatch = text.match(/\bLUX\s*([A-Z])\s*(\d{4})\b/);
  if (fullMatch) return `LUX-${fullMatch[1]}${fullMatch[2]}`;

  const shortMatch = text.match(/\b([A-Z])\s*(\d{4})\b/);
  if (shortMatch) return `LUX-${shortMatch[1]}${shortMatch[2]}`;

  return null;
}

function classifyCampaignType({ campaignName, adName, adBody, headline, sourceUrl, operationHint, propertyCode }) {
  const bag = normalizeText(
    [campaignName, adName, adBody, headline, sourceUrl, operationHint].filter(Boolean).join(' ')
  );

  if (propertyCode) return 'property_listing';
  if (/(valuacion|valuacion inicial|cuanto vale|cuánto vale|valor de tu propiedad|avaluo)/i.test(bag)) {
    return 'valuation';
  }
  if (/(propietari|vende tu propiedad|vender tu casa|captacion|captación)/i.test(bag)) {
    return 'seller_capture';
  }
  if (/(renta|rentar|alquiler)/i.test(bag) && !/(vender|venta tu propiedad)/i.test(bag)) {
    return 'rental';
  }
  if (/(compra|comprar|busca casa|propiedades disponibles|inmueble)/i.test(bag)) {
    return 'buyer_search';
  }
  if (/(luxetty|marca|branding|conocenos|conócenos)/i.test(bag)) {
    return 'brand_generic';
  }

  return 'unknown';
}

function extractCampaignReferralContext({ aiState = {}, referral = null, rawPayload = null, messageText = '' } = {}) {
  const referralCandidate =
    (isPlainObject(referral) && referral) ||
    (isPlainObject(aiState?.whatsapp_referral) && aiState.whatsapp_referral) ||
    extractReferralFromRawPayload(rawPayload) ||
    null;

  const sourceUrl = firstNonEmptyString(
    referralCandidate?.source_url,
    referralCandidate?.sourceUrl,
    referralCandidate?.url,
    referralCandidate?.link
  );

  const sourceType = firstNonEmptyString(
    referralCandidate?.source_type,
    referralCandidate?.sourceType,
    referralCandidate?.type
  );

  const text = normalizeText(messageText || '');
  const sourcePlatform =
    (sourceUrl && /instagram\.com/i.test(sourceUrl) && 'instagram') ||
    (sourceUrl && /(facebook\.com|fb\.com)/i.test(sourceUrl) && 'facebook') ||
    (text.includes('instagram') && 'instagram') ||
    (text.includes('facebook') && 'facebook') ||
    (text.includes('meta ads') && 'meta') ||
    null;

  const campaignContext = {
    source_type: sourceType,
    source_id: firstNonEmptyString(referralCandidate?.source_id, referralCandidate?.sourceId),
    source_url: sourceUrl,
    ad_id: firstNonEmptyString(referralCandidate?.ad_id, referralCandidate?.adId, referralCandidate?.ad?.id),
    ad_name: firstNonEmptyString(
      referralCandidate?.ad_name,
      referralCandidate?.adName,
      referralCandidate?.ad_title,
      referralCandidate?.ad?.name
    ),
    headline: firstNonEmptyString(
      referralCandidate?.headline,
      referralCandidate?.ad_headline,
      referralCandidate?.ad?.headline
    ),
    ad_body: firstNonEmptyString(referralCandidate?.ad_body, referralCandidate?.body, referralCandidate?.text),
    media_url: firstNonEmptyString(
      referralCandidate?.media_url,
      referralCandidate?.image_url,
      referralCandidate?.video_url,
      referralCandidate?.creative_url
    ),
    adgroup_id: firstNonEmptyString(
      referralCandidate?.adgroup_id,
      referralCandidate?.adgroupId,
      referralCandidate?.adset_id,
      referralCandidate?.ad_set_id,
      referralCandidate?.adsetId
    ),
    campaign_id: firstNonEmptyString(referralCandidate?.campaign_id, referralCandidate?.campaignId, referralCandidate?.campaign?.id),
    campaign_name: firstNonEmptyString(referralCandidate?.campaign_name, referralCandidate?.campaignName, referralCandidate?.campaign?.name),
    ctwa_clid: firstNonEmptyString(referralCandidate?.ctwa_clid, referralCandidate?.ctwaClid, referralCandidate?.clid),
    campaign_agent_profile_id: firstNonEmptyString(
      referralCandidate?.agent_profile_id,
      referralCandidate?.assigned_agent_profile_id,
      referralCandidate?.campaign_agent_profile_id,
      referralCandidate?.campaign?.agent_profile_id
    ),
    ad_text: firstNonEmptyString(referralCandidate?.ad_text, referralCandidate?.ad_copy),
    source_platform: sourcePlatform,
    utm: parseUtmFromUrl(sourceUrl),
  };

  const inferredPropertyCode =
    inferPropertyCodeFromText(
      firstNonEmptyString(
        referralCandidate?.property_code,
        referralCandidate?.listing_id,
        referralCandidate?.property?.listing_id,
        referralCandidate?.source_url,
        campaignContext.ad_body,
        campaignContext.ad_name,
        campaignContext.headline,
        campaignContext.ad_text
      )
    );

  if (inferredPropertyCode) {
    campaignContext.property_code = inferredPropertyCode;
  }

  const campaignContextForPresence = { ...campaignContext };
  const hasCampaignContext = Object.values(campaignContextForPresence).some((value) => {
    if (value == null) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return String(value).trim() !== '';
  });

  if (!hasCampaignContext) {
    return {
      referralContext: referralCandidate,
      campaignContext: null,
      rawReferral: referralCandidate,
      hasCampaignContext: false,
    };
  }

  campaignContext.campaign_type = classifyCampaignType({
    campaignName: campaignContext.campaign_name,
    adName: campaignContext.ad_name,
    adBody: campaignContext.ad_body,
    headline: campaignContext.headline,
    sourceUrl: campaignContext.source_url,
    operationHint: messageText,
    propertyCode: campaignContext.property_code,
  });

  return {
    referralContext: referralCandidate,
    campaignContext: hasCampaignContext ? campaignContext : null,
    rawReferral: referralCandidate,
    hasCampaignContext,
  };
}

function detectLeadCreationOpportunity({ aiState = {}, propertyId = null, propertyCode = null, messageText = '', hasCampaignContext = false, unifiedContext = null } = {}) {
  const text = normalizeText(messageText || '');
  if (aiState?.non_real_estate_or_provider) {
    return { shouldCreate: false, reason: 'non_real_estate_or_provider' };
  }

  if (unifiedContext?.normalizedIntent?.category === 'not_interested') {
    return { shouldCreate: false, reason: 'user_not_interested' };
  }

  if (unifiedContext?.sourceSignals) {
    const s = unifiedContext.sourceSignals;
    const hasOnlyMediaContext = !!(
      !s.hasText &&
      !s.hasCaption &&
      !s.hasAudioTranscription &&
      (s.hasImageVision || s.hasLocation) &&
      !s.hasInteractive &&
      !s.hasCampaignContext &&
      !s.hasPropertyContext
    );

    if (hasOnlyMediaContext && !unifiedContext?.shouldCreateOrUpdateLead) {
      return { shouldCreate: false, reason: 'media_without_actionable_intent' };
    }
  }

  if (unifiedContext?.shouldCreateOrUpdateLead === true) {
    const leadType = unifiedContext?.crmAction?.leadType || null;
    const fallbackLeadType = resolveLeadType(aiState);
    if (leadType || fallbackLeadType || propertyId) {
      return {
        shouldCreate: true,
        reason: unifiedContext?.crmAction?.reason || 'context_fusion_actionable',
      };
    }
  }

  const leadType = resolveLeadType(aiState);
  const hasPropertyReference = !!(
    propertyId ||
    aiState.direct_property_reference ||
    aiState.property_code ||
    aiState.direct_property_code ||
    propertyCode
  );

  const shortInfoPing =
    text === 'info' ||
    text === 'informacion' ||
    text === 'información' ||
    text.startsWith('info ') ||
    text.includes('sigue disponible') ||
    text.includes('aun disponible') ||
    text.includes('aún disponible') ||
    text.includes('todavia disponible') ||
    text.includes('todavía disponible');

  const explicitCommercialSignals = !!(
    aiState.wants_visit ||
    aiState.asks_property_details ||
    aiState.wants_human ||
    aiState.shows_high_interest ||
    text.includes('me interesa') ||
    text.includes('quiero informacion') ||
    text.includes('quiero información') ||
    text.includes('quiero detalles') ||
    text.includes('precio') ||
    text.includes('disponible') ||
    text.includes('visita') ||
    shortInfoPing
  );

  if (!hasPropertyReference && !explicitCommercialSignals && !hasCampaignContext) {
    return { shouldCreate: false, reason: 'ambiguous_or_non_commercial' };
  }

  if (!propertyId && hasPropertyReference) {
    return { shouldCreate: false, reason: 'property_not_found_for_reference' };
  }

  if (!leadType && !propertyId) {
    return { shouldCreate: false, reason: 'missing_lead_type' };
  }

  if (propertyId && explicitCommercialSignals) {
    return { shouldCreate: true, reason: 'property_interest_detected' };
  }

  if (propertyId && hasCampaignContext) {
    return { shouldCreate: true, reason: 'campaign_property_interest_detected' };
  }

  if (
    unifiedContext?.normalizedIntent?.category === 'valuate_property' &&
    unifiedContext?.normalizedIntent?.userAcceptedAdvisor
  ) {
    return { shouldCreate: true, reason: 'valuation_with_advisor_acceptance' };
  }

  return { shouldCreate: false, reason: 'not_enough_context' };
}

function buildLeadContextFromConversation({
  conversation = null,
  aiState = {},
  property = null,
  propertyId = null,
  propertyCode = null,
  propertySlug = null,
  contactId = null,
  referralContext = null,
  campaignContext = null,
  rawReferral = null,
} = {}) {
  const normalizedPhone = normalizePhoneNumber(conversation?.phone) || conversation?.phone || null;

  return {
    normalizedPhone,
    contactId: contactId || conversation?.contact_id || null,
    conversationId: conversation?.id || null,
    propertyId: propertyId || property?.id || aiState?.interested_property_id || null,
    propertyCode: propertyCode || property?.listing_id || aiState?.property_code || aiState?.direct_property_code || null,
    propertySlug: propertySlug || property?.slug || null,
    userIntent: aiState?.intent_type || aiState?.lead_flow || null,
    sourceChannel: conversation?.channel || null,
    referralContext: referralContext || null,
    campaignContext: campaignContext || null,
    rawReferral: rawReferral || null,
    needsName: !aiState?.full_name,
    shouldAskForAdvisorContact: !!(
      aiState?.direct_property_reference ||
      aiState?.wants_visit ||
      aiState?.asks_property_details ||
      aiState?.shows_high_interest
    ),
  };
}

function buildNotesSummary(aiState = {}, property = null) {
  const parts = [];
  const leadType = resolveLeadType(aiState);
  const operation = resolveOperation(aiState, property);

  if (leadType === 'supply') {
    parts.push(`Solicitud de oferta para ${operation === 'rent' ? 'poner en renta' : 'vender'} propiedad.`);
  } else {
    parts.push(`Solicitud de demanda para ${operation === 'rent' ? 'rentar' : 'comprar'} propiedad.`);
  }

  if (property?.listing_id) parts.push(`Propiedad: ${property.listing_id}.`);
  if (aiState.property_code) parts.push(`Codigo mencionado: ${aiState.property_code}.`);
  if (aiState.property_type) parts.push(`Tipo: ${aiState.property_type}.`);
  if (aiState.location_text) parts.push(`Zona: ${aiState.location_text}.`);
  if (aiState.budget_max != null) parts.push(`Presupuesto max: ${aiState.budget_max} ${aiState.budget_currency || 'MXN'}.`);
  if (aiState.terrain_m2 != null) parts.push(`Terreno: ${aiState.terrain_m2} m2.`);
  if (aiState.construction_m2 != null) parts.push(`Construccion: ${aiState.construction_m2} m2.`);
  if (aiState.floors_count != null) parts.push(`Plantas: ${aiState.floors_count}.`);
  if (aiState.bedrooms != null) parts.push(`Recamaras: ${aiState.bedrooms}.`);
  if (aiState.bathrooms != null) parts.push(`Banos: ${aiState.bathrooms}.`);
  if (aiState.garage_spaces != null) parts.push(`Cochera: ${aiState.garage_spaces}.`);
  if (aiState.has_terrace_patio === true) parts.push('Con terraza/patio.');
  if (aiState.has_terrace_patio === false) parts.push('Sin terraza/patio.');
  if (aiState.occupancy_status === 'occupied') parts.push('Propiedad habitada.');
  if (aiState.occupancy_status === 'vacant') parts.push('Propiedad desocupada.');
  if (aiState.legal_deeded === true) parts.push('Escriturada.');
  if (aiState.has_mortgage === true) parts.push('Con credito hipotecario.');
  if (aiState.works_with_realtor === true) parts.push('Ya trabaja con inmobiliaria.');
  if (aiState.works_with_realtor === false) parts.push('No trabaja con inmobiliaria actualmente.');
  if (aiState.exclusivity_type === 'exclusive') parts.push('Esquema en exclusiva.');
  if (aiState.exclusivity_type === 'open') parts.push('Esquema abierto/sin exclusividad.');
  if (aiState.expected_price != null) parts.push(`Precio esperado: ${aiState.expected_price} ${aiState.budget_currency || 'MXN'}.`);
  if (aiState.sale_motivation) parts.push(`Motivacion: ${aiState.sale_motivation}.`);
  if (aiState.urgency_level) parts.push(`Urgencia: ${aiState.urgency_level}.`);
  if (aiState.accepted_visit === true) parts.push('Acepto visita de asesor.');
  if (aiState.wants_visit) parts.push('Quiere visita.');
  if (aiState.asks_property_details) parts.push('Pidio detalles.');
  if (aiState.wants_human) parts.push('Pidio asesor humano.');

  return parts.filter(Boolean).join(' ').slice(0, 1500);
}

function summarizeRelevantMessageSignals(aiState = {}) {
  const signals = [];
  if (aiState.wants_visit) signals.push('quiere_visita');
  if (aiState.asks_property_details) signals.push('pide_detalles_propiedad');
  if (aiState.wants_human) signals.push('pidio_asesor_humano');
  if (aiState.shows_high_interest) signals.push('mostro_alto_interes');
  if (aiState.location_text) signals.push(`zona:${aiState.location_text}`);
  if (aiState.budget_max != null) signals.push(`presupuesto_max:${aiState.budget_max}`);
  if (aiState.property_type) signals.push(`tipo:${aiState.property_type}`);
  if (aiState.terrain_m2 != null) signals.push(`terreno_m2:${aiState.terrain_m2}`);
  if (aiState.construction_m2 != null) signals.push(`construccion_m2:${aiState.construction_m2}`);
  if (aiState.occupancy_status) signals.push(`ocupacion:${aiState.occupancy_status}`);
  if (aiState.has_mortgage === true) signals.push('con_credito_hipotecario');
  if (aiState.works_with_realtor === true) signals.push('ya_tiene_inmobiliaria');
  if (aiState.exclusivity_type) signals.push(`exclusividad:${aiState.exclusivity_type}`);
  if (aiState.accepted_visit === true) signals.push('acepto_visita');
  if (aiState.has_audio_without_transcription) signals.push('audio_sin_transcripcion');
  if (aiState.last_media_type) signals.push(`ultimo_media:${aiState.last_media_type}`);
  return signals;
}

function buildStructuredSellerCrmSummary({ aiState = {}, conversation = {}, property = null } = {}) {
  const sellerIntent = resolveLeadType(aiState) === 'supply';
  const riskFlags = [];

  if (aiState.legal_sensitive) riskFlags.push('legal_sensitive');
  if (aiState.occupancy_status === 'occupied') riskFlags.push('occupied_property');
  if (aiState.primary_seller_scenario) riskFlags.push(aiState.primary_seller_scenario);
  if (Array.isArray(aiState.risk_flags)) {
    aiState.risk_flags.forEach((flag) => {
      if (!riskFlags.includes(flag)) riskFlags.push(flag);
    });
  }

  const missingInformation = [];

  if (!aiState.property_type) missingInformation.push('property_type');
  if (!aiState.location_text) missingInformation.push('zone');
  if (!aiState.neighborhood_text) missingInformation.push('neighborhood');
  if (aiState.expected_price == null && aiState.budget_max == null) missingInformation.push('expected_price');
  if (!aiState.sale_motivation) missingInformation.push('motivation_to_sell');
  if (aiState.has_documents == null) missingInformation.push('has_documents');
  if (!aiState.occupancy_status) missingInformation.push('occupancy_status');

  const recommendedNextStep = aiState.legal_sensitive
    ? 'Revision especializada comercial-juridica antes de salida comercial normal'
    : aiState.accepted_visit === true || aiState.wants_visit
    ? 'Agendar visita con asesora especialista'
    : 'Completar datos clave y proponer llamada/visita de 20 minutos';

  const propertyDescriptionParts = [
    aiState.property_type ? `Tipo: ${aiState.property_type}` : null,
    aiState.terrain_m2 != null ? `Terreno: ${aiState.terrain_m2} m2` : null,
    aiState.construction_m2 != null ? `Construccion: ${aiState.construction_m2} m2` : null,
    aiState.floors_count != null ? `Niveles: ${aiState.floors_count}` : null,
    aiState.bedrooms != null ? `Recamaras: ${aiState.bedrooms}` : null,
    aiState.bathrooms != null ? `Banos: ${aiState.bathrooms}` : null,
    aiState.has_terrace_patio === true ? 'Con terraza/patio' : null,
    aiState.occupancy_status === 'occupied' ? 'Habitada/ocupada' : null,
  ].filter(Boolean);

  const summary = {
    contact_name: aiState.full_name || null,
    phone: conversation?.phone || null,
    seller_intent: sellerIntent,
    property_type: aiState.property_type || null,
    zone: aiState.location_text || null,
    municipality: aiState.municipality_text || null,
    neighborhood: aiState.neighborhood_text || null,
    property_description: propertyDescriptionParts.join('. ') || null,
    motivation_to_sell: aiState.sale_motivation || null,
    already_listed: aiState.already_listed ?? null,
    listing_duration: aiState.listing_duration_days || null,
    has_documents: aiState.has_documents ?? aiState.legal_deeded ?? null,
    occupancy_status: aiState.occupancy_status || null,
    legal_sensitive: !!aiState.legal_sensitive,
    estimated_price: property?.price || null,
    expected_price: aiState.expected_price ?? aiState.budget_max ?? null,
    recommended_next_step: recommendedNextStep,
    assigned_agent_suggestion: aiState.assigned_agent_profile_id || null,
    conversation_summary: buildNotesSummary(aiState, property),
    risk_flags: riskFlags,
    missing_information: missingInformation,
  };

  return summary;
}

function buildDetailedNotesSummary({ aiState = {}, conversation = {}, property = null, contactOwnerAssigned = false }) {
  const parts = [];
  const operation = resolveOperation(aiState, property);
  const leadType = resolveLeadType(aiState);
  const referral = aiState?.whatsapp_referral || aiState?.referral || aiState?.last_referral || null;

  parts.push(`Origen conversacion: ${conversation?.channel || 'unknown'} (conversation_id: ${conversation?.id || 'n/a'}).`);
  parts.push(`Telefono/WhatsApp: ${conversation?.phone || 'n/a'}.`);

  if (leadType || operation) {
    parts.push(`Intencion detectada: ${leadType || 'n/a'}${operation ? `/${operation}` : ''}.`);
  }

  if (property?.id || property?.listing_id || aiState?.interested_property_id || aiState?.property_code || aiState?.direct_property_code) {
    parts.push(
      `Propiedad interesada: ${property?.listing_id || aiState?.property_code || aiState?.direct_property_code || 'n/a'} (property_id: ${property?.id || aiState?.interested_property_id || 'n/a'}).`
    );
  }

  if (referral && typeof referral === 'object') {
    parts.push(`Referral: ${JSON.stringify(referral)}.`);
  }

  if (aiState?.campaign_context && typeof aiState.campaign_context === 'object') {
    parts.push(`Contexto de campaña: ${JSON.stringify(aiState.campaign_context)}.`);
  }

  const relevantSignals = summarizeRelevantMessageSignals(aiState);
  if (relevantSignals.length > 0) {
    parts.push(`Resumen mensajes relevantes: ${relevantSignals.join(', ')}.`);
  }

  if (contactOwnerAssigned) {
    parts.push('Motivo de asignacion: contacto ya registrado con agente asignado.');
  }

  const baseSummary = buildNotesSummary(aiState, property);
  if (baseSummary) parts.push(`Resumen caso: ${baseSummary}`);

  const structuredSummary =
    aiState?.crm_structured_summary && typeof aiState.crm_structured_summary === 'object'
      ? aiState.crm_structured_summary
      : buildStructuredSellerCrmSummary({ aiState, conversation, property });

  if (structuredSummary && typeof structuredSummary === 'object') {
    parts.push(`CRM estructurado: ${JSON.stringify(structuredSummary)}.`);
  }

  return parts.filter(Boolean).join(' ').slice(0, 1500);
}

function mergeLeadNotes(existingNotes, newNotes) {
  const previous = String(existingNotes || '').trim();
  const incoming = String(newNotes || '').trim();

  if (!incoming) return previous || null;
  if (!previous) return incoming;
  if (previous.includes(incoming)) return previous;

  return `${previous}\n\n---\n${incoming}`.slice(0, 1500);
}

function resolveContactAssignedAgentField(contact = {}) {
  if (!contact || typeof contact !== 'object') return { field: null, assignedAgentProfileId: null };

  const candidates = [
    'assigned_agent_profile_id',
    'agent_profile_id',
    'owner_profile_id',
    'assigned_to',
  ];

  for (const field of candidates) {
    const value = contact[field];
    if (value != null && String(value).trim() !== '') {
      return {
        field,
        assignedAgentProfileId: String(value).trim(),
      };
    }
  }

  return { field: null, assignedAgentProfileId: null };
}

async function findContactById(supabase, contactId) {
  if (!supabase || !contactId) return null;

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .maybeSingle();

  if (error) {
    console.error('LEAD_AUTOMATION_CONTACT_LOOKUP_ERROR', {
      contact_id: contactId,
      error: error.message,
    });
    return null;
  }

  return data || null;
}

async function getInitialPipelineStageId(supabase, leadType) {
  if (!supabase || !leadType) return null;

  if (process.env.PERSEO_QUALIFIED_APPLICANTS_V2 !== 'true') {
    let legacyResult = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('code', 'new')
      .eq('lead_type', leadType)
      .eq('is_active', true)
      .order('stage_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!legacyResult.error && legacyResult.data?.id) return legacyResult.data.id;

    legacyResult = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('code', 'new')
      .is('lead_type', null)
      .eq('is_active', true)
      .order('stage_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    return legacyResult.data?.id || null;
  }

  // Demand: prefer active COS stages (new is inactive in prod).
  const preferredCodes =
    leadType === 'demand'
      ? ['contact_qualification', 'need_establishment', 'new']
      : ['new', 'contact_qualification', 'need_establishment'];

  for (const code of preferredCodes) {
    const result = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('code', code)
      .eq('lead_type', leadType)
      .eq('is_active', true)
      .order('stage_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!result.error && result.data?.id) return result.data.id;
  }

  const fallback = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('code', 'new')
    .is('lead_type', null)
    .eq('is_active', true)
    .order('stage_order', { ascending: true })
    .limit(1)
    .maybeSingle();

  return fallback.data?.id || null;
}

function mapUrgencyToDemandCatalog(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (!v) return null;
  if (['immediate_0_30_days', 'inmediato', 'immediate', '0_30', 'urgente'].includes(v)) {
    return 'immediate_0_30_days';
  }
  if (['high_1_3_months', 'high', 'alta', '1_3_meses', '1-3'].includes(v)) {
    return 'high_1_3_months';
  }
  if (['medium_3_6_months', 'medium', 'media', '3_6_meses', '3-6'].includes(v)) {
    return 'medium_3_6_months';
  }
  if (['low_over_6_months', 'low', 'baja', '6_meses', '+6'].includes(v)) {
    return 'low_over_6_months';
  }
  if (['exploratory', 'explorando', 'explorando_opciones'].includes(v)) {
    return 'exploratory';
  }
  return null;
}

async function filterReusableDemandLeads(supabase, leads = []) {
  const list = Array.isArray(leads) ? leads.filter(Boolean) : [];
  if (list.length === 0) return [];
  if (process.env.PERSEO_QUALIFIED_APPLICANTS_V2 !== 'true') return list;

  const demandIds = list.filter((l) => l.lead_type === 'demand').map((l) => l.id);
  if (demandIds.length === 0) return list;

  let data;
  let error;
  try {
    ({ data, error } = await supabase
      .from('lead_demand_profiles')
      .select('lead_id, qualified_applicant_status')
      .in('lead_id', demandIds));
  } catch (queryError) {
    error = queryError;
  }

  if (error) {
    console.warn('LEAD_AUTOMATION_DEMAND_PROFILE_FILTER_SKIP', { error: error.message });
    if (process.env.PERSEO_QUALIFIED_APPLICANTS_PERSEO_GATE === 'true') {
      throw error;
    }
    return list;
  }

  const blocked = new Set(
    (data || [])
      .filter((p) => ['resolved', 'closed'].includes(p.qualified_applicant_status))
      .map((p) => p.lead_id)
  );

  return list.filter((l) => l.lead_type !== 'demand' || !blocked.has(l.id));
}

async function syncLeadDemandProfile(supabase, lead, aiState = {}, logger) {
  if (!supabase || !lead?.id || lead.lead_type !== 'demand') return null;
  if (process.env.PERSEO_QUALIFIED_APPLICANTS_V2 !== 'true') return null;

  const urgency =
    mapUrgencyToDemandCatalog(aiState.urgency_level || aiState.urgency) || null;
  const operation = lead.interested_in_operation || aiState.operation || null;
  const budgetPeriod =
    operation === 'rent' || operation === 'renta' ? 'monthly' : operation ? 'total' : null;

  const patch = {};
  const budgetMin = aiState.budget_min != null ? Number(aiState.budget_min) : lead.budget_min;
  const budgetMax = aiState.budget_max != null ? Number(aiState.budget_max) : lead.budget_max;
  if (Number.isFinite(Number(budgetMin)) && Number(budgetMin) > 0) {
    patch.budget_min = Number(budgetMin);
  }
  if (Number.isFinite(Number(budgetMax)) && Number(budgetMax) > 0) {
    patch.budget_max = Number(budgetMax);
  }
  if (aiState.budget_currency) patch.budget_currency = aiState.budget_currency;
  if (aiState.budget_period || budgetPeriod) {
    patch.budget_period = aiState.budget_period || budgetPeriod;
  }
  if (urgency) patch.demand_urgency_code = urgency;

  const requirementText =
    aiState.requirement_text || aiState.requirement_summary || lead.notes_summary || null;
  const propertyTypes = Array.isArray(aiState.property_types)
    ? aiState.property_types.filter(Boolean)
    : aiState.property_type
      ? [aiState.property_type]
      : [];
  if (requirementText || propertyTypes.length > 0) {
    if (requirementText) patch.requirement_summary = requirementText;
    patch.requirement_source = 'perseo';
    patch.requirement_schema_version = 1;
    const requirementData = {
      schema_version: 1,
    };
    if (propertyTypes.length > 0) requirementData.property_types = propertyTypes;
    if (requirementText) requirementData.free_text = requirementText;
    for (const key of [
      'bedrooms_min',
      'bathrooms_min',
      'parking_min',
      'surface_min_m2',
    ]) {
      if (aiState[key] != null) requirementData[key] = aiState[key];
    }
    patch.requirement_data = requirementData;
  }

  if (Array.isArray(aiState.preferred_zone_ids) && aiState.preferred_zone_ids.length) {
    patch.preferred_zone_ids = aiState.preferred_zone_ids;
  }
  if (Array.isArray(lead.raw_preferred_locations) && lead.raw_preferred_locations.length) {
    patch.raw_preferred_locations = lead.raw_preferred_locations;
  } else if (Array.isArray(lead.preferred_zones) && lead.preferred_zones.length) {
    patch.raw_preferred_locations = lead.preferred_zones;
  }

  const { data, error } = await supabase.rpc('upsert_lead_demand_profile', {
    p_lead_id: lead.id,
    p_patch: patch,
    p_actor_type: 'perseo',
    p_actor_service_name: 'perseo_lead_automation',
  });

  if (error) {
    console.error('LEAD_AUTOMATION_DEMAND_PROFILE_SYNC_ERROR', {
      lead_id: lead.id,
      error: error.message,
    });
    if (process.env.PERSEO_QUALIFIED_APPLICANTS_PERSEO_GATE === 'true') {
      throw error;
    }
    return null;
  }

  const { data: validation, error: validationError } = await supabase.rpc(
    'assert_qualified_demand_gate',
    {
      p_lead_id: lead.id,
      p_context: 'perseo',
      p_actor_service_name: 'perseo_lead_automation',
    }
  );
  if (validationError) {
    console.error('LEAD_AUTOMATION_DEMAND_GATE_ERROR', {
      lead_id: lead.id,
      error: validationError.message,
    });
    if (process.env.PERSEO_QUALIFIED_APPLICANTS_PERSEO_GATE === 'true') {
      throw validationError;
    }
  }

  log(logger, 'LEAD_DEMAND_PROFILE_SYNCED', { lead_id: lead.id, profile_id: data });
  return { profileId: data, validation: validation || null };
}

async function findLeadByConversation(supabase, leadId) {
  if (!leadId) return null;
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .maybeSingle();

  if (error) {
    console.error('LEAD_AUTOMATION_FIND_BY_CONVERSATION_ERROR', { error: error.message });
    return null;
  }

  const reusable = await filterReusableDemandLeads(supabase, data ? [data] : []);
  return reusable[0] || null;
}

async function findCompatibleLead(supabase, { contactId, leadType, operation, propertyId }) {
  let query = supabase
    .from('leads')
    .select('*')
    .eq('contact_id', contactId)
    .eq('lead_type', leadType)
    .order('created_at', { ascending: false })
    .limit(25);

  if (operation) query = query.eq('interested_in_operation', operation);
  else query = query.is('interested_in_operation', null);
  if (propertyId) query = query.eq('interested_property_id', propertyId);
  else query = query.is('interested_property_id', null);

  query = query.eq('is_active', true).eq('is_archived', false);

  const { data, error } = await query;
  if (error) {
    console.error('LEAD_AUTOMATION_FIND_COMPATIBLE_ERROR', { error: error.message });
    return [];
  }

  return filterReusableDemandLeads(supabase, Array.isArray(data) ? data : []);
}

async function findCompatibleLeadByPhoneAndProperty(supabase, { normalizedPhone, leadType, operation, propertyId }) {
  if (!normalizedPhone || !propertyId) return [];

  let query = supabase
    .from('leads')
    .select('*')
    .eq('phone', normalizedPhone)
    .eq('lead_type', leadType)
    .eq('interested_property_id', propertyId)
    .eq('is_active', true)
    .eq('is_archived', false)
    .order('created_at', { ascending: false })
    .limit(25);

  if (operation) query = query.eq('interested_in_operation', operation);

  const { data, error } = await query;
  if (error) {
    console.error('LEAD_AUTOMATION_FIND_COMPATIBLE_PHONE_ERROR', { error: error.message });
    return [];
  }

  return filterReusableDemandLeads(supabase, Array.isArray(data) ? data : []);
}

async function findCompatibleLeadByWhatsapp(supabase, { normalizedWhatsapp, leadType, operation, propertyId }) {
  if (!normalizedWhatsapp) return [];

  let query = supabase
    .from('leads')
    .select('*')
    .eq('whatsapp', normalizedWhatsapp)
    .eq('lead_type', leadType)
    .eq('is_active', true)
    .eq('is_archived', false)
    .order('created_at', { ascending: false })
    .limit(25);

  if (operation) query = query.eq('interested_in_operation', operation);
  if (propertyId) query = query.eq('interested_property_id', propertyId);

  const { data, error } = await query;
  if (error) {
    console.error('LEAD_AUTOMATION_FIND_COMPATIBLE_WHATSAPP_ERROR', { error: error.message });
    return [];
  }

  return filterReusableDemandLeads(supabase, Array.isArray(data) ? data : []);
}

function chooseCanonicalCompatibleLead(leads = []) {
  const list = Array.isArray(leads) ? leads.filter(Boolean) : [];
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => {
    const aAssigned = a?.assigned_agent_profile_id ? 1 : 0;
    const bAssigned = b?.assigned_agent_profile_id ? 1 : 0;
    if (aAssigned !== bAssigned) return bAssigned - aAssigned;
    const aHasProperty = a?.interested_property_id ? 1 : 0;
    const bHasProperty = b?.interested_property_id ? 1 : 0;
    if (aHasProperty !== bHasProperty) return bHasProperty - aHasProperty;
    const aUpdated = new Date(a?.updated_at || 0).getTime();
    const bUpdated = new Date(b?.updated_at || 0).getTime();
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    const aCreated = new Date(a?.created_at || 0).getTime();
    const bCreated = new Date(b?.created_at || 0).getTime();
    if (aCreated !== bCreated) return bCreated - aCreated;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
  return sorted[0] || null;
}

async function insertLeadWithSourceFallback(supabase, payload) {
  const { data, error } = await supabase
    .from('leads')
    .insert(payload)
    .select()
    .single();

  if (!error) return { data, error: null };

  const looksLikeSourceEnumError =
    String(error.message || '').includes('lead_source') ||
    String(error.message || '').includes('invalid input value for enum') ||
    String(error.message || '').includes('source');

  if (payload.source === 'whatsapp' && looksLikeSourceEnumError) {
    const fallbackPayload = { ...payload, source: 'manual' };
    return supabase.from('leads').insert(fallbackPayload).select().single();
  }

  return { data: null, error };
}

async function updateLeadScoring(supabase, leadId, scoring) {
  if (!supabase || !leadId || !scoring) return null;

  const { data, error } = await supabase
    .from('leads')
    .update({
      lead_score: scoring.lead_score,
      lead_temperature: scoring.lead_temperature,
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    console.error('LEAD_AUTOMATION_SCORING_UPDATE_ERROR', {
      lead_id: leadId,
      error: error.message,
    });
    return null;
  }

  return data || null;
}

async function syncConversation(supabase, conversationId, payload) {
  if (!conversationId) return { ok: false, error: 'missing_conversation_id' };
  const { error } = await supabase
    .from('conversations')
    .update({
      ...payload,
      updated_at: nowIso(),
    })
    .eq('id', conversationId);

  if (error) {
    console.error('LEAD_AUTOMATION_CONVERSATION_SYNC_ERROR', {
      conversation_id: conversationId,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
  return { ok: true, error: null };
}

async function createAssignmentAuditLog(supabase, payload = {}) {
  if (!supabase || !payload?.lead_id) return;

  const insertPayload = {
    lead_id: payload.lead_id,
    conversation_id: payload.conversation_id || null,
    assigned_agent_profile_id: payload.assigned_agent_profile_id || null,
    strategy: payload.strategy || null,
    reason: payload.reason || null,
    payload: payload.payload || null,
    created_at: nowIso(),
  };

  try {
    await supabase.from('assignment_logs').insert(insertPayload);
  } catch (_err) {
    // best-effort audit table
  }
}

async function upsertCurrentLeadAssignment(supabase, {
  leadId,
  conversationId,
  assignedAgentProfileId,
  strategy,
  reason,
}) {
  if (!leadId || !assignedAgentProfileId) return;

  try {
    const { data: currentRows } = await supabase
      .from('lead_assignments')
      .select('*')
      .eq('lead_id', leadId)
      .eq('is_current', true)
      .limit(5);

    const hasSameCurrent = Array.isArray(currentRows)
      ? currentRows.some((row) => row.assigned_agent_profile_id === assignedAgentProfileId)
      : false;

    if (!hasSameCurrent) {
      await supabase
        .from('lead_assignments')
        .update({
          is_current: false,
          ended_at: nowIso(),
        })
        .eq('lead_id', leadId)
        .eq('is_current', true);

      await supabase
        .from('lead_assignments')
        .insert({
          lead_id: leadId,
          conversation_id: conversationId || null,
          assigned_agent_profile_id: assignedAgentProfileId,
          is_current: true,
          assigned_at: nowIso(),
          strategy: strategy || null,
          reason: reason || null,
        });
    }
  } catch (_err) {
    // best-effort assignment trail
  }
}

async function applyAgentAssignment({
  supabase,
  leadId,
  conversationId,
  assignedAgentProfileId,
  strategy,
  reason,
  logger,
}) {
  if (!assignedAgentProfileId) {
    return {
      assignedAgentProfileId: null,
      assignmentResult: { success: false, reason: reason || 'no_assignment_available' },
    };
  }

  const { data: updatedLead, error } = await supabase
    .from('leads')
    .update({
      assigned_agent_profile_id: assignedAgentProfileId,
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    logWarn(logger, 'LEAD_AUTOMATION_ASSIGNMENT_FAILED', {
      lead_id: leadId,
      assigned_agent_profile_id: assignedAgentProfileId,
      reason,
      error: error.message,
    });

    await saveConversationEvent(supabase, conversationId, 'lead_assignment_failed', {
      lead_id: leadId,
      reason: 'lead_assignment_update_failed',
      error: error.message,
      strategy,
      source: 'ai_agent',
    });

    notifyLeadUnassigned(supabase, {
      conversationId,
      leadId,
      reason: 'lead_assignment_update_failed',
    }, logger);

    await createAssignmentAuditLog(supabase, {
      lead_id: leadId,
      conversation_id: conversationId,
      assigned_agent_profile_id: assignedAgentProfileId,
      strategy,
      reason: 'lead_assignment_update_failed',
      payload: { error: error.message, requested_reason: reason },
    });

    return {
      assignedAgentProfileId: null,
      assignmentResult: {
        success: false,
        reason: 'lead_assignment_update_failed',
        error: error.message,
      },
    };
  }

  await syncConversation(supabase, conversationId, {
    assigned_agent_profile_id: assignedAgentProfileId,
  });

  await upsertCurrentLeadAssignment(supabase, {
    leadId,
    conversationId,
    assignedAgentProfileId,
    strategy,
    reason,
  });

  await saveConversationEvent(supabase, conversationId, 'lead_assigned', {
    lead_id: leadId,
    assigned_agent_profile_id: assignedAgentProfileId,
    strategy,
    reason,
    source: 'ai_agent',
  });

  await createAssignmentAuditLog(supabase, {
    lead_id: leadId,
    conversation_id: conversationId,
    assigned_agent_profile_id: assignedAgentProfileId,
    strategy,
    reason,
    payload: null,
  });

  log(logger, 'LEAD_AUTOMATION_ASSIGNED', {
    lead_id: leadId,
    assigned_agent_profile_id: assignedAgentProfileId,
    strategy,
    reason,
  });

  return {
    assignedAgentProfileId: assignedAgentProfileId,
    assignmentResult: {
      success: true,
      strategy,
      reason,
      assigned_agent_profile_id: assignedAgentProfileId,
    },
    lead: updatedLead || null,
  };
}

function ruleMatchesContext(rule = {}, ctx = {}) {
  const operation = ctx.operationType || null;
  const propertyType = ctx.propertyType || null;
  const budget = Number(ctx.budgetMax || ctx.budgetMin || 0) || null;

  if (rule?.operation_type && operation && rule.operation_type !== operation) return false;
  if (rule?.property_type && propertyType && rule.property_type !== propertyType) return false;
  if (rule?.min_budget != null && budget != null && budget < Number(rule.min_budget)) return false;
  if (rule?.max_budget != null && budget != null && budget > Number(rule.max_budget)) return false;

  return true;
}

/**
 * Solo motor DIOS/engine (sin recorrer candidatos de prioridad).
 */
async function assignLeadViaEngineOnly(supabase, leadId, conversationId, logger, context = {}) {
  await saveConversationEvent(supabase, conversationId, 'lead_assignment_attempted', {
    lead_id: leadId,
    source: 'ai_agent',
    path: 'engine_only',
  });

  const { data: godModes } = await supabase
    .from('assignment_god_modes')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: true })
    .limit(1);

  const godMode = Array.isArray(godModes) ? godModes[0] : null;
  if (godMode?.target_agent_profile_id) {
    log(logger, 'assignment_engine_fallback_used', {
      lead_id: leadId,
      conversation_id: conversationId,
      path: 'god_mode',
    });
    return applyAgentAssignment({
      supabase,
      leadId,
      conversationId,
      assignedAgentProfileId: godMode.target_agent_profile_id,
      strategy: 'god_mode',
      reason: 'assigned_by_god_mode',
      logger,
    });
  }

  const { data: rules } = await supabase
    .from('assignment_rules')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: true })
    .limit(25);

  if (Array.isArray(rules) && rules.length > 0) {
    for (const rule of rules) {
      if (!ruleMatchesContext(rule, context)) continue;

      const { data: ruleAgents } = await supabase
        .from('assignment_rule_agents')
        .select('*')
        .eq('assignment_rule_id', rule.id)
        .eq('is_active', true)
        .order('priority', { ascending: true })
        .limit(5);

      const selectedAgent = Array.isArray(ruleAgents) ? ruleAgents[0] : null;
      if (selectedAgent?.agent_profile_id) {
        log(logger, 'assignment_engine_fallback_used', {
          lead_id: leadId,
          conversation_id: conversationId,
          path: 'assignment_rule',
        });
        return applyAgentAssignment({
          supabase,
          leadId,
          conversationId,
          assignedAgentProfileId: selectedAgent.agent_profile_id,
          strategy: 'assignment_rule',
          reason: 'assigned_by_rule',
          logger,
        });
      }
    }
  }

  log(logger, 'assignment_engine_fallback_used', {
    lead_id: leadId,
    conversation_id: conversationId,
    path: 'assign_lead_via_engine',
  });

  const { data, error } = await supabase.rpc('assign_lead_via_engine', {
    p_lead_id: leadId,
    p_triggered_by: null,
  });

  if (error) {
    logWarn(logger, 'LEAD_AUTOMATION_ASSIGNMENT_FAILED', { lead_id: leadId, error: error.message });
    await saveConversationEvent(supabase, conversationId, 'lead_assignment_failed', {
      lead_id: leadId,
      reason: 'assignment_rpc_error',
      error: error.message,
    });
    notifyLeadUnassigned(supabase, {
      conversationId,
      leadId,
      reason: 'assignment_rpc_error',
    }, logger);
    return {
      assignedAgentProfileId: null,
      assignmentResult: { success: false, reason: 'assignment_rpc_error', error: error.message },
    };
  }

  const assignedAgentProfileId =
    data?.assigned_agent_profile_id || data?.suggested_agent_profile_id || null;

  if (assignedAgentProfileId) {
    return applyAgentAssignment({
      supabase,
      leadId,
      conversationId,
      assignedAgentProfileId,
      strategy: data?.strategy || 'assignment_engine',
      reason: data?.reason || 'assigned_by_engine',
      logger,
    });
  }

  const { data: settings } = await supabase
    .from('assignment_settings')
    .select('*')
    .eq('is_active', true)
    .limit(1);

  const fallbackAgentProfileId = Array.isArray(settings)
    ? settings[0]?.fallback_agent_profile_id || null
    : null;

  if (fallbackAgentProfileId) {
    log(logger, 'assignment_engine_fallback_used', {
      lead_id: leadId,
      conversation_id: conversationId,
      path: 'assignment_settings_fallback',
    });
    await saveConversationEvent(supabase, conversationId, 'assignment_fallback_used', {
      lead_id: leadId,
      fallback_agent_profile_id: fallbackAgentProfileId,
      source: 'ai_agent',
    });
    const fallbackAttempt = await applyAgentAssignment({
      supabase,
      leadId,
      conversationId,
      assignedAgentProfileId: fallbackAgentProfileId,
      strategy: 'fallback',
      reason: 'assigned_by_fallback_agent',
      logger,
    });

    if (fallbackAttempt?.assignedAgentProfileId) {
      return fallbackAttempt;
    }

    await saveConversationEvent(supabase, conversationId, 'lead_assignment_failed', {
      lead_id: leadId,
      reason: 'fallback_assignment_failed',
      source: 'ai_agent',
    });

    notifyLeadUnassigned(supabase, {
      conversationId,
      leadId,
      reason: 'fallback_assignment_failed',
    }, logger);

    return {
      assignedAgentProfileId: null,
      assignmentResult: {
        success: false,
        reason: 'fallback_assignment_failed',
      },
    };
  }

  await saveConversationEvent(supabase, conversationId, 'lead_assignment_failed', {
    lead_id: leadId,
    reason: 'no_assignment_available',
    strategy: data?.strategy || null,
    source: 'ai_agent',
  });

  notifyLeadUnassigned(supabase, {
    conversationId,
    leadId,
    reason: 'no_assignment_available',
  }, logger);

  await createAssignmentAuditLog(supabase, {
    lead_id: leadId,
    conversation_id: conversationId,
    assigned_agent_profile_id: null,
    strategy: data?.strategy || null,
    reason: 'no_assignment_available',
    payload: { engine_reason: data?.reason || null },
  });

  return {
    assignedAgentProfileId: null,
    assignmentResult: {
      success: false,
      reason: 'no_assignment_available',
      strategy: data?.strategy || null,
    },
  };
}

/**
 * Aplica una decisión de `resolveAssignmentDecision` (writes CRM).
 */
async function applyAssignmentDecision(decision, ctx) {
  const {
    supabase,
    lead,
    conversationId,
    logger,
    contactOwner,
    detailedNotesSummary,
    assignContext,
  } = ctx;

  if (decision.path === 'contact_owner_bypass') {
    return assignLeadToContactOwner({
      supabase,
      lead,
      conversationId,
      assignedAgentProfileId: decision.assignedAgentProfileId,
      assignmentField: contactOwner?.field,
      notesSummary: detailedNotesSummary,
      logger,
    });
  }

  if (!decision.willAssign) {
    return {
      assignedAgentProfileId: null,
      assignmentResult: { success: false, reason: decision.reason || decision.path },
    };
  }

  if (decision.path === 'engine_rpc' || decision.wouldInvokeRpc) {
    return assignLeadViaEngineOnly(supabase, lead.id, conversationId, logger, assignContext);
  }

  return applyAgentAssignment({
    supabase,
    leadId: lead.id,
    conversationId,
    assignedAgentProfileId: decision.assignedAgentProfileId,
    strategy: decision.strategy,
    reason: decision.reason || decision.path,
    logger,
  });
}

async function assignLead(supabase, leadId, conversationId, logger, context = {}) {
  await saveConversationEvent(supabase, conversationId, 'lead_assignment_attempted', {
    lead_id: leadId,
    source: 'ai_agent',
  });

  const leadRow = context.leadRow || { id: leadId };
  const decision = await resolveAssignmentDecision(
    {
      mode: 'execute',
      lead: leadRow,
      leadType: context.leadType,
      aiState: context.aiState,
      contactWasCreated: context.contactWasCreated,
      contactOwner: {
        assignedAgentProfileId: context.contactAssignedAgentProfileId || null,
        field: null,
      },
      property: context.property,
      propertyId: context.propertyId,
      campaignAgentProfileId: context.campaignAgentProfileId,
      conversationAssignedAgentProfileId: context.conversationAssignedAgentProfileId,
      conversationId,
      operationType: context.operationType,
      propertyType: context.propertyType,
      budgetMin: context.budgetMin,
      budgetMax: context.budgetMax,
    },
    { supabase, logger },
  );

  for (const candidate of decision.candidates) {
    if (!candidate.agentId) continue;
    const attempt = await applyAgentAssignment({
      supabase,
      leadId,
      conversationId,
      assignedAgentProfileId: candidate.agentId,
      strategy: candidate.strategy,
      reason: candidate.reason,
      logger,
    });

    if (attempt?.assignedAgentProfileId) {
      if (candidate.strategy === 'property_owner_agent') {
        log(logger, 'ASSIGNMENT_PROPERTY_AGENT', {
          lead_id: leadId,
          assigned_agent_profile_id: candidate.agentId,
          conversation_id: conversationId,
        });
      }
      return attempt;
    }
  }

  if (decision.willAssign && decision.assignedAgentProfileId && decision.path === 'priority_candidate') {
    return applyAgentAssignment({
      supabase,
      leadId,
      conversationId,
      assignedAgentProfileId: decision.assignedAgentProfileId,
      strategy: decision.strategy,
      reason: decision.reason || decision.path,
      logger,
    });
  }

  return assignLeadViaEngineOnly(supabase, leadId, conversationId, logger, context);
}

async function assignLeadToContactOwner({
  supabase,
  lead,
  conversationId,
  assignedAgentProfileId,
  assignmentField,
  notesSummary,
  logger,
}) {
  if (!supabase || !lead?.id || !assignedAgentProfileId) {
    return {
      assignedAgentProfileId: null,
      assignmentResult: { success: false, reason: 'missing_contact_owner_assignment_data' },
      lead: lead || null,
    };
  }

  const updatePayload = {
    assigned_agent_profile_id: assignedAgentProfileId,
    notes_summary: mergeLeadNotes(lead.notes_summary, notesSummary),
  };

  if (Object.prototype.hasOwnProperty.call(lead, 'assignment_source')) {
    updatePayload.assignment_source = 'contact_owner';
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updatePayload)
    .eq('id', lead.id)
    .select()
    .single();

  if (error) {
    logWarn(logger, 'LEAD_AUTOMATION_CONTACT_OWNER_ASSIGNMENT_FAILED', {
      lead_id: lead.id,
      assigned_agent_profile_id: assignedAgentProfileId,
      error: error.message,
    });
    await saveConversationEvent(supabase, conversationId, 'lead_assignment_failed', {
      lead_id: lead.id,
      reason: 'contact_owner_assignment_update_failed',
      error: error.message,
      source: 'contact_owner',
    });

    notifyLeadUnassigned(supabase, {
      conversationId,
      leadId: lead.id,
      reason: 'contact_owner_assignment_update_failed',
    }, logger);

    return {
      assignedAgentProfileId: null,
      assignmentResult: {
        success: false,
        reason: 'contact_owner_assignment_update_failed',
        error: error.message,
      },
      lead,
    };
  }

  await saveConversationEvent(supabase, conversationId, 'lead_assigned', {
    lead_id: lead.id,
    assigned_agent_profile_id: assignedAgentProfileId,
    assignment_source: 'contact_owner',
    contact_assignment_field: assignmentField,
    source: 'ai_agent',
  });

  log(logger, 'LEAD_AUTOMATION_ASSIGNED_CONTACT_OWNER', {
    lead_id: lead.id,
    assigned_agent_profile_id: assignedAgentProfileId,
    contact_assignment_field: assignmentField,
  });

  return {
    assignedAgentProfileId: assignedAgentProfileId,
    assignmentResult: {
      success: true,
      reason: 'contact_owner',
      assignment_source: 'contact_owner',
      contact_assignment_field: assignmentField,
    },
    lead: data || lead,
  };
}

function canUpdateLeadPropertyInterestOnly(lead, expected) {
  if (!lead || !expected?.propertyId) return false;
  if (!sameNullableValue(lead.contact_id, expected.contactId)) return false;
  if (!sameNullableValue(lead.lead_type, expected.leadType)) return false;
  if (!sameNullableValue(lead.interested_in_operation, expected.operation || null)) return false;
  return String(lead.interested_property_id || '') !== String(expected.propertyId);
}

async function updateLeadInterestedProperty({
  supabase,
  conversationId,
  lead,
  propertyId,
  property,
  logger,
}) {
  const prevPid = lead.interested_property_id || null;
  const { data, error } = await supabase
    .from('leads')
    .update({
      interested_property_id: propertyId,
      notes_summary: mergeLeadNotes(
        lead.notes_summary,
        `Interés actualizado a propiedad ${property?.listing_id || propertyId} (antes: ${prevPid || 'n/a'}).`
      ),
    })
    .eq('id', lead.id)
    .select()
    .single();
  if (error || !data) {
    logWarn(logger, 'LEAD_PROPERTY_INTEREST_UPDATE_FAILED', { lead_id: lead.id, error: error?.message });
    return null;
  }
  await saveConversationEvent(supabase, conversationId, 'property_interest_changed', {
    lead_id: lead.id,
    previous_interested_property_id: prevPid,
    next_interested_property_id: propertyId,
    listing_id: property?.listing_id || null,
    source: 'ai_agent',
  });
  return data;
}

async function createOrReuseLeadFromConversation({
  supabase,
  conversation,
  aiState,
  contactId,
  propertyId,
  property = null,
  contactWasCreated = false,
  logger,
}) {
  const conversationId = conversation?.id || null;

  if (
    conversation?.ai_state &&
    typeof conversation.ai_state === 'object' &&
    conversation.ai_state.qa_crm_force_new_lead === true &&
    aiState &&
    typeof aiState === 'object'
  ) {
    aiState.qa_crm_force_new_lead = true;
  }

  try {
    log(logger, 'LEAD_AUTOMATION_START', {
      conversation_id: conversationId,
      contact_id: contactId || null,
      property_id: propertyId || null,
    });

    if (!contactId) {
      logWarn(logger, 'LEAD_CREATION_FAILED', { conversation_id: conversationId, reason: 'missing_contact' });
      logWarn(logger, 'LEAD_AUTOMATION_SKIPPED_MISSING_CONTACT', {
        conversation_id: conversationId,
        property_id: propertyId || null,
      });
      await saveConversationEvent(supabase, conversationId, 'lead_contact_missing_but_property_interest_detected', {
        property_id: propertyId || null,
        reason: 'contact_missing_property_interest',
      });
      return {
        success: false,
        lead: null,
        leadId: null,
        wasCreated: false,
        assignedAgentProfileId: null,
        assignmentResult: null,
        reason: 'missing_contact',
      };
    }

    if (aiState?.direct_property_reference && (aiState.property_code || aiState.direct_property_code) && !propertyId) {
      logWarn(logger, 'LEAD_CREATION_FAILED', {
        conversation_id: conversationId,
        reason: 'missing_property',
        property_code: aiState.property_code || aiState.direct_property_code,
      });
      logWarn(logger, 'LEAD_AUTOMATION_SKIPPED_MISSING_PROPERTY', {
        conversation_id: conversationId,
        property_code: aiState.property_code || aiState.direct_property_code,
      });
      await saveConversationEvent(supabase, conversationId, 'lead_not_created_missing_property', {
        property_code: aiState.property_code || aiState.direct_property_code,
        reason: 'missing_property',
      });
      return {
        success: false,
        lead: null,
        leadId: null,
        wasCreated: false,
        assignedAgentProfileId: null,
        assignmentResult: null,
        reason: 'missing_property',
      };
    }

    if (!hasClearIntent(aiState, propertyId)) {
      logWarn(logger, 'LEAD_CREATION_FAILED', {
        conversation_id: conversationId,
        reason: 'low_confidence',
        lead_flow: aiState?.lead_flow || null,
        confidence: aiState?.confidence || null,
      });
      log(logger, 'LEAD_AUTOMATION_SKIPPED_LOW_CONFIDENCE', {
        conversation_id: conversationId,
        lead_flow: aiState?.lead_flow || null,
        confidence: aiState?.confidence || null,
      });
      await saveConversationEvent(supabase, conversationId, 'lead_not_created_low_confidence', {
        lead_flow: aiState?.lead_flow || null,
        confidence: aiState?.confidence || null,
        reason: 'low_confidence_or_ambiguous_intent',
      });
      return {
        success: false,
        lead: null,
        leadId: null,
        wasCreated: false,
        assignedAgentProfileId: null,
        assignmentResult: null,
        reason: 'low_confidence',
      };
    }

    if (propertyId || aiState?.campaign_context?.property_code) {
      log(logger, 'PROPERTY_CONTEXT_FOUND', {
        conversation_id: conversationId,
        property_id: propertyId || null,
        listing_id: property?.listing_id || aiState?.property_code || aiState?.campaign_context?.property_code || null,
      });
    }

    const leadType = resolveLeadType(aiState) || (propertyId ? 'demand' : null);
    if (!leadType) {
      logWarn(logger, 'LEAD_CREATION_FAILED', {
        conversation_id: conversationId,
        reason: 'missing_lead_type',
        property_id: propertyId || null,
      });
      await saveConversationEvent(supabase, conversationId, 'lead_not_created_missing_lead_type', {
        property_id: propertyId || null,
      });
      return {
        success: false,
        lead: null,
        leadId: null,
        wasCreated: false,
        assignedAgentProfileId: null,
        assignmentResult: null,
        reason: 'missing_lead_type',
      };
    }

    const operation = resolveOperation(aiState, property);
    const normalizedConversationPhone = normalizePhoneNumber(conversation?.phone) || conversation?.phone || null;
    const contact = await findContactById(supabase, contactId);
    if (contactId) {
      log(logger, 'CONTACT_FOUND', { conversation_id: conversationId, contact_id: contactId });
    }
    const contactOwner = resolveContactAssignedAgentField(contact || {});
    const hasContactOwnerAssignedAgent = !!contactOwner.assignedAgentProfileId;
    const scoringIntent = {
      leadType,
      operationType: operation,
      property_code: aiState?.property_code || aiState?.direct_property_code || null,
      direct_property_reference: !!(aiState?.direct_property_reference || propertyId),
      budget_min: aiState?.budget_min,
      budget_max: aiState?.budget_max,
      location_text: aiState?.location_text,
      wants_visit: aiState?.wants_visit,
      wants_human: aiState?.wants_human,
      asks_property_details: aiState?.asks_property_details,
      confidence: aiState?.confidence,
    };
    const leadScoring = calculateLeadScore({
      aiState: {
        ...(aiState || {}),
        direct_property_reference: !!(aiState?.direct_property_reference || propertyId),
      },
      intent: scoringIntent,
    });
    const expected = {
      contactId,
      leadType,
      operation,
      propertyId: propertyId || null,
    };

    const campaignAgentProfileId =
      aiState?.campaign_context?.campaign_agent_profile_id ||
      aiState?.campaign_context?.agent_profile_id ||
      null;

    const conversationAssignedAgentProfileId = conversation?.assigned_agent_profile_id || null;

    const templateNotesSummary = buildDetailedNotesSummary({
      aiState,
      conversation,
      property,
      contactOwnerAssigned: hasContactOwnerAssignedAgent,
    });
    const detailedNotesSummary = await generateLeadNotesSummaryOpenAI({
      supabase,
      conversationId,
      aiState,
      conversation,
      property,
      referralContext:
        aiState?.whatsapp_referral ||
        aiState?.referral ||
        aiState?.last_referral ||
        null,
      fallbackSummary: templateNotesSummary,
    });

    await saveConversationEvent(supabase, conversationId, 'lead_intent_detected', {
      lead_type: leadType,
      interested_in_operation: operation,
      interested_property_id: propertyId || null,
      lead_score: leadScoring.lead_score,
      lead_temperature: leadScoring.lead_temperature,
      campaign_type: aiState?.campaign_context?.campaign_type || null,
      source: 'ai_agent',
    });

    await saveConversationEvent(
      supabase,
      conversationId,
      leadType === 'supply' ? 'lead_type_detected_supply' : 'lead_type_detected_demand',
      {
        lead_type: leadType,
        interested_in_operation: operation,
        interested_property_id: propertyId || null,
        source: 'ai_agent',
      }
    );

    const qaForceNewLead = shouldForceNewLeadForQaCrm(aiState, conversation);
    if (qaForceNewLead) {
      log(logger, 'LEAD_AUTOMATION_QA_FORCE_NEW_LEAD', {
        conversation_id: conversationId,
        source: 'qa_resetcrm',
      });
      await saveConversationEvent(supabase, conversationId, 'qa_crm_force_new_lead_active', {
        source: 'qa_resetcrm',
      });
    }

    let lead = qaForceNewLead
      ? null
      : await findLeadByConversation(supabase, conversation?.lead_id || aiState?.lead_id || null);
    let wasCreated = false;
    let intentChanged = false;

    async function applyCompatibleLeadSelection(candidates, reason, extra = {}) {
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const canonicalLead = chooseCanonicalCompatibleLead(candidates);
      if (!canonicalLead) return null;
      if (candidates.length > 1) {
        const duplicateLeadIds = candidates
          .map((item) => item?.id)
          .filter((id) => id && id !== canonicalLead.id);
        await saveConversationEvent(supabase, conversationId, 'multiple_compatible_leads_detected', {
          candidate_count: candidates.length,
          canonical_lead_id: canonicalLead.id,
          duplicate_lead_ids: duplicateLeadIds,
          reason,
          source: 'ai_agent',
          ...extra,
        });
        await saveConversationEvent(supabase, conversationId, 'canonical_lead_selected', {
          lead_id: canonicalLead.id,
          candidate_count: candidates.length,
          reason,
          source: 'ai_agent',
          ...extra,
        });
        await saveConversationEvent(supabase, conversationId, 'lead_duplicate_prevented', {
          lead_id: canonicalLead.id,
          prevented_duplicate_count: duplicateLeadIds.length,
          duplicate_lead_ids: duplicateLeadIds,
          reason,
          source: 'ai_agent',
          ...extra,
        });
      }
      await saveConversationEvent(supabase, conversationId, 'lead_reused', {
        lead_id: canonicalLead.id,
        reason,
        source: 'ai_agent',
      });
      return canonicalLead;
    }

    if (lead) {
      if (isLeadCompatible(lead, expected)) {
        log(logger, 'LEAD_AUTOMATION_REUSE_BY_CONVERSATION', {
          conversation_id: conversationId,
          lead_id: lead.id,
        });
        await saveConversationEvent(supabase, conversationId, 'lead_reused', {
          lead_id: lead.id,
          reason: 'conversation_lead_id',
          source: 'ai_agent',
        });
      } else if (canUpdateLeadPropertyInterestOnly(lead, expected)) {
        const updated = await updateLeadInterestedProperty({
          supabase,
          conversationId,
          lead,
          propertyId,
          property,
          logger,
        });
        if (updated) {
          lead = updated;
          log(logger, 'LEAD_AUTOMATION_PROPERTY_INTEREST_UPDATED', {
            conversation_id: conversationId,
            lead_id: lead.id,
            interested_property_id: propertyId || null,
          });
          await saveConversationEvent(supabase, conversationId, 'lead_reused', {
            lead_id: lead.id,
            reason: 'conversation_lead_id_property_updated',
            source: 'ai_agent',
          });
        } else {
          intentChanged = true;
          await saveConversationEvent(supabase, conversationId, 'lead_intent_changed', {
            previous_lead_id: lead.id,
            previous_lead_type: lead.lead_type || null,
            previous_interested_in_operation: lead.interested_in_operation || null,
            previous_interested_property_id: lead.interested_property_id || null,
            next_lead_type: leadType,
            next_interested_in_operation: operation,
            next_interested_property_id: propertyId || null,
            source: 'ai_agent',
          });
          lead = null;
        }
      } else {
        intentChanged = true;
        await saveConversationEvent(supabase, conversationId, 'lead_intent_changed', {
          previous_lead_id: lead.id,
          previous_lead_type: lead.lead_type || null,
          previous_interested_in_operation: lead.interested_in_operation || null,
          previous_interested_property_id: lead.interested_property_id || null,
          next_lead_type: leadType,
          next_interested_in_operation: operation,
          next_interested_property_id: propertyId || null,
          source: 'ai_agent',
        });
        lead = null;
      }
    }

    if (!lead && !qaForceNewLead && contactId) {
      const compatibleLeads = await findCompatibleLead(supabase, {
        contactId,
        leadType,
        operation,
        propertyId: propertyId || null,
      });
      lead = await applyCompatibleLeadSelection(compatibleLeads, 'compatible_active_lead');
      if (lead) {
        log(logger, 'LEAD_AUTOMATION_REUSE_BY_MATCH', {
          conversation_id: conversationId,
          lead_id: lead.id,
        });
      }
    }

    if (!lead && !qaForceNewLead) {
      const compatibleLeadsByPhone = await findCompatibleLeadByPhoneAndProperty(supabase, {
        normalizedPhone: normalizedConversationPhone,
        leadType,
        operation,
        propertyId: propertyId || null,
      });
      lead = await applyCompatibleLeadSelection(
        compatibleLeadsByPhone,
        'compatible_active_lead_by_phone_property',
        { property_id: propertyId || null }
      );
      if (lead) {
        log(logger, 'LEAD_AUTOMATION_REUSE_BY_PHONE_PROPERTY', {
          conversation_id: conversationId,
          lead_id: lead.id,
          property_id: propertyId || null,
        });
      }
    }

    if (!lead && !qaForceNewLead) {
      const compatibleLeadsByWhatsapp = await findCompatibleLeadByWhatsapp(supabase, {
        normalizedWhatsapp: normalizedConversationPhone,
        leadType,
        operation,
        propertyId: propertyId || null,
      });
      lead = await applyCompatibleLeadSelection(
        compatibleLeadsByWhatsapp,
        'compatible_active_lead_by_whatsapp',
        { whatsapp: normalizedConversationPhone }
      );
      if (lead) {
        log(logger, 'LEAD_AUTOMATION_REUSE_BY_WHATSAPP', {
          conversation_id: conversationId,
          lead_id: lead.id,
          whatsapp: normalizedConversationPhone,
        });
      }
    }

    if (!lead) {
      const pipelineStageId = await getInitialPipelineStageId(supabase, leadType);

      const payload = {
        contact_id: contactId,
        lead_type: leadType,
        source: 'whatsapp',
        interested_property_id: propertyId || null,
        interested_in_operation: operation,
        notes_summary: detailedNotesSummary || null,
        budget_min: aiState?.budget_min != null ? Number(aiState.budget_min) : null,
        budget_max: aiState?.budget_max != null ? Number(aiState.budget_max) : null,
        preferred_zones: preferredZonesFromAiState(aiState),
        lead_score: leadScoring.lead_score,
        lead_temperature: leadScoring.lead_temperature,
        pipeline_stage_id: pipelineStageId,
        status: 'new',
        is_active: true,
        is_archived: false,
        phone: normalizedConversationPhone,
        whatsapp: conversation?.channel === 'whatsapp' ? normalizedConversationPhone : null,
        next_action: leadType === 'supply' ? 'Contactar propietario' : 'Contactar lead',
        next_action_due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        // Sprint 5C: incluir assigned_agent_profile_id en el INSERT inicial para respetar
        // la regla ATENA de "lead sin assigned_agent_profile_id no debe existir".
        // Se usa el mejor valor disponible en este punto del flujo.
        // El motor de asignación posterior puede sobreescribir si resuelve uno mejor.
        assigned_agent_profile_id: contactOwner?.assignedAgentProfileId || conversationAssignedAgentProfileId || null,
      };

      const { data, error } = await insertLeadWithSourceFallback(supabase, payload);
      if (error || !data) {
        throw new Error(error?.message || 'lead_insert_failed');
      }

      lead = data;
      wasCreated = true;
      log(logger, 'LEAD_CREATED', {
        conversation_id: conversationId,
        lead_id: lead.id,
        property_id: propertyId || null,
      });
      log(logger, 'LEAD_AUTOMATION_CREATED', {
        conversation_id: conversationId,
        lead_id: lead.id,
      });
      await saveConversationEvent(supabase, conversationId, 'lead_created', {
        lead_id: lead.id,
        lead_type: leadType,
        interested_in_operation: operation,
        interested_property_id: propertyId || null,
        lead_score: leadScoring.lead_score,
        lead_temperature: leadScoring.lead_temperature,
        source: 'ai_agent',
      });

      if (intentChanged) {
        await saveConversationEvent(supabase, conversationId, 'new_lead_created_due_to_intent_change', {
          lead_id: lead.id,
          lead_type: leadType,
          interested_in_operation: operation,
          interested_property_id: propertyId || null,
          lead_score: leadScoring.lead_score,
          lead_temperature: leadScoring.lead_temperature,
          source: 'ai_agent',
        });
      }
    }

    if (!wasCreated) {
      const leadUpdatePayload = {
        lead_score: leadScoring.lead_score,
        lead_temperature: leadScoring.lead_temperature,
        notes_summary: mergeLeadNotes(lead.notes_summary, detailedNotesSummary),
      };
      if (propertyId) {
        leadUpdatePayload.interested_property_id = propertyId;
      }

      const { data: refreshedLead, error: leadUpdateError } = await supabase
        .from('leads')
        .update(leadUpdatePayload)
        .eq('id', lead.id)
        .select()
        .single();

      if (leadUpdateError) {
        console.error('LEAD_AUTOMATION_LEAD_UPDATE_ERROR', {
          lead_id: lead.id,
          error: leadUpdateError.message,
        });
        const scoredLead = await updateLeadScoring(supabase, lead.id, leadScoring);
        if (scoredLead) lead = scoredLead;
      } else if (refreshedLead) {
        lead = refreshedLead;
      }
    }

    let profileSyncWarning = null;
    try {
      await syncLeadDemandProfile(supabase, lead, aiState || {}, logger);
    } catch (profileErr) {
      profileSyncWarning = profileErr?.message || String(profileErr);
      console.error('LEAD_AUTOMATION_DEMAND_PROFILE_SYNC_FATAL', {
        lead_id: lead?.id,
        error: profileSyncWarning,
      });
      await saveConversationEvent(supabase, conversationId, 'demand_profile_sync_failed', {
        lead_id: lead?.id || null,
        error: profileSyncWarning,
        gate_enabled:
          process.env.PERSEO_QUALIFIED_APPLICANTS_PERSEO_GATE === 'true',
        source: 'ai_agent',
      });
    }

    const handoffCandidate = {
      ...lead,
      intent_type: aiState?.intent_type || aiState?.playbook_type || null,
      property_type: aiState?.property_type || lead.property_type || null,
      wants_human: !!aiState?.wants_human,
      wants_visit: !!aiState?.wants_visit,
      asks_property_details: !!aiState?.asks_property_details,
      property_interest:
        aiState?.intent_type === 'property_interest' ||
        aiState?.playbook_type === 'property_interest' ||
        !!aiState?.direct_property_reference ||
        !!propertyId,
      handoff_sent: !!aiState?.handoff_sent,
    };
    const shouldHandoff = shouldTriggerHandoff(handoffCandidate);

    let assignedAgentProfileId = null;
    let assignmentResult = null;
    let handoffTriggered = false;

    const demandContactOwnerPriority =
      isDemandLeadContext(leadType, aiState) && hasContactOwnerAssignedAgent;

    if (demandContactOwnerPriority) {
      log(logger, 'assignment_owner_contact_priority', {
        conversation_id: conversationId,
        lead_id: lead.id,
        contact_assigned_agent_profile_id: contactOwner.assignedAgentProfileId,
        property_id: propertyId || null,
      });
      if (qaForceNewLead && wasCreated) {
        log(logger, 'qa_crm_force_new_lead_owner_preserved', {
          conversation_id: conversationId,
          lead_id: lead.id,
          assigned_agent_profile_id: contactOwner.assignedAgentProfileId,
          contact_assignment_field: contactOwner.field,
        });
      }

      const ownerAssignment = await assignLeadToContactOwner({
        supabase,
        lead,
        conversationId,
        assignedAgentProfileId: contactOwner.assignedAgentProfileId,
        assignmentField: contactOwner.field,
        notesSummary: detailedNotesSummary,
        logger,
      });

      assignedAgentProfileId = ownerAssignment.assignedAgentProfileId;
      assignmentResult = ownerAssignment.assignmentResult;
      handoffTriggered = !!assignedAgentProfileId;
      if (ownerAssignment.lead) {
        lead = ownerAssignment.lead;
      }

      await saveConversationEvent(supabase, conversationId, 'lead_assignment_contact_owner_bypassed_engine', {
        lead_id: lead.id,
        assigned_agent_profile_id: assignedAgentProfileId,
        contact_assignment_field: contactOwner.field,
        reason: 'demand_contact_owner_priority',
        property_id: propertyId || null,
        source: 'ai_agent',
      });
    } else if (shouldHandoff && !aiState?.legal_sensitive) {
      const assignment = await assignLead(
        supabase,
        lead.id,
        conversationId,
        logger,
        {
          property,
          propertyId,
          contactId,
          leadType,
          aiState,
          contactWasCreated,
          intent: aiState?.intent_type || null,
          operationType: operation,
          propertyType: aiState?.property_type || null,
          budgetMin: aiState?.budget_min ?? null,
          budgetMax: aiState?.budget_max ?? null,
          campaignAgentProfileId,
          contactAssignedAgentProfileId: contactOwner.assignedAgentProfileId || null,
          conversationAssignedAgentProfileId,
          leadRow: lead,
        },
      );
      assignedAgentProfileId = assignment.assignedAgentProfileId;
      assignmentResult = assignment.assignmentResult;
      handoffTriggered = !!assignedAgentProfileId;
    } else if (shouldHandoff && aiState?.legal_sensitive) {
      assignmentResult = {
        success: false,
        reason: 'legal_sensitive_review_required',
      };

      await saveConversationEvent(supabase, conversationId, 'lead_requires_specialized_review', {
        lead_id: lead.id,
        reason: 'legal_sensitive_review_required',
        source: 'ai_agent',
      });

      await saveConversationEvent(supabase, conversationId, 'lead_handoff_deferred', {
        lead_id: lead.id,
        lead_score: lead.lead_score ?? leadScoring.lead_score,
        lead_temperature: lead.lead_temperature || leadScoring.lead_temperature,
        intent_type: handoffCandidate.intent_type,
        reason: 'legal_sensitive_review_required',
        source: 'ai_agent',
      });
    } else {
      await saveConversationEvent(supabase, conversationId, 'lead_handoff_deferred', {
        lead_id: lead.id,
        lead_score: lead.lead_score ?? leadScoring.lead_score,
        lead_temperature: lead.lead_temperature || leadScoring.lead_temperature,
        intent_type: handoffCandidate.intent_type,
        reason: 'lead_not_ready_for_handoff',
        source: 'ai_agent',
      });
    }

    let nextAiState;

    if (wasCreated) {
      nextAiState = buildResetAiStateAfterLeadCreated(aiState, lead, {
        assignedAgentProfileId,
      });
      await saveConversationEvent(supabase, conversationId, 'ai_context_reset_after_lead_created', {
        lead_id: lead.id,
        lead_type: lead.lead_type || leadType,
        interested_in_operation: lead.interested_in_operation || operation,
        interested_property_id: lead.interested_property_id || propertyId || null,
        source: 'ai_agent',
      });
    } else {
      nextAiState = {
        ...(aiState || {}),
        lead_id: lead.id,
        lead_type: lead.lead_type || leadType,
        interested_in_operation: lead.interested_in_operation || operation,
        interested_property_id: lead.interested_property_id || propertyId || null,
        crm_lead_created_at: aiState?.crm_lead_created_at || nowIso(),
      };
    }

    if (assignedAgentProfileId) {
      nextAiState.assigned_agent_profile_id = assignedAgentProfileId;
      nextAiState.handoff_ready = true;
      nextAiState.handoff_sent = true;
    }

      // Sprint 5B: enriquecer integration_contract con lead vinculado (caso reuse)
      // Para wasCreated ya se actualiza en buildResetAiStateAfterLeadCreated.
      if (!wasCreated && nextAiState.integration_contract) {
        nextAiState.integration_contract = {
          ...nextAiState.integration_contract,
          lead_id: lead.id,
          contact_id: contactId || nextAiState.integration_contract.contact_id || null,
          assigned_agent_profile_id:
            assignedAgentProfileId ||
            lead.assigned_agent_profile_id ||
            nextAiState.integration_contract.assigned_agent_profile_id ||
            null,
          linked_at: nextAiState.integration_contract.linked_at || nowIso(),
        };
      }

    const resolvedAgentId =
      assignedAgentProfileId || lead.assigned_agent_profile_id || conversation?.assigned_agent_profile_id || null;

    const conversationSync = await syncConversation(supabase, conversationId, {
      lead_id: lead.id,
      contact_id: contactId,
      assigned_agent_profile_id: resolvedAgentId,
      ai_state: nextAiState,
    });

    let conversationSyncWarning = null;
    if (!conversationSync?.ok) {
      conversationSyncWarning = conversationSync?.error || 'conversation_sync_failed';
      logWarn(logger, 'LEAD_AUTOMATION_CONVERSATION_SYNC_FAILED', {
        conversation_id: conversationId,
        lead_id: lead.id,
        contact_id: contactId || null,
        error: conversationSyncWarning,
      });
      await saveConversationEvent(supabase, conversationId, 'conversation_link_sync_failed', {
        lead_id: lead.id,
        contact_id: contactId || null,
        error: conversationSyncWarning,
        source: 'ai_agent',
      });
    } else {
      await saveConversationEvent(supabase, conversationId, 'conversation_link_synced', {
        lead_id: lead.id,
        contact_id: contactId || null,
        source: 'ai_agent',
      });
    }

    log(logger, 'CONVERSATION_LINKED', {
      conversation_id: conversationId,
      lead_id: lead.id,
      contact_id: contactId || null,
    });

    await saveConversationEvent(supabase, conversationId, 'crm_trace_snapshot', {
      lead_id: lead.id,
      contact_id: contactId || null,
      property_id: propertyId || null,
      lead_type: leadType,
      operation_type: operation,
      should_handoff: !!shouldHandoff,
      handoff_triggered: !!handoffTriggered,
      assignment_success: !!assignedAgentProfileId,
      assigned_agent_profile_id: assignedAgentProfileId || null,
      campaign_type: aiState?.campaign_context?.campaign_type || null,
      source: 'ai_agent',
    });

    if (!wasCreated) {
      log(logger, 'LEAD_REUSED', {
        conversation_id: conversationId,
        lead_id: lead.id,
        property_id: propertyId || null,
      });
    }

    if (qaForceNewLead && wasCreated) {
      log(logger, 'LEAD_AUTOMATION_QA_FORCE_NEW_LEAD_CONSUMED', {
        conversation_id: conversationId,
        lead_id: lead.id,
      });
      await saveConversationEvent(supabase, conversationId, 'qa_crm_force_new_lead_consumed', {
        lead_id: lead.id,
        source: 'qa_resetcrm',
      });
      if (nextAiState && typeof nextAiState === 'object') {
        nextAiState.qa_crm_force_new_lead = false;
      }
    }

    return {
      success: true,
      lead,
      leadId: lead.id,
      wasCreated,
      assignedAgentProfileId: assignedAgentProfileId || lead.assigned_agent_profile_id || null,
      assignmentResult,
      shouldHandoff,
      handoffTriggered,
      reason: wasCreated ? 'lead_created' : 'lead_reused',
      aiState: nextAiState,
      warnings: [
        ...(conversationSyncWarning
          ? [{ code: 'conversation_sync_failed', detail: conversationSyncWarning }]
          : []),
        ...(profileSyncWarning
          ? [{ code: 'demand_profile_sync_failed', detail: profileSyncWarning }]
          : []),
      ],
    };
  } catch (err) {
    logWarn(logger, 'LEAD_AUTOMATION_ERROR', {
      conversation_id: conversationId,
      error: err?.message || String(err),
    });
    await saveConversationEvent(supabase, conversationId, 'crm_creation_failed', {
      reason: 'lead_automation_error',
      error: err?.message || String(err),
      source: 'ai_agent',
    });

    emitCrmError(
      supabase,
      {
        conversationId,
        errorCode: 'lead_automation_error',
        errorMessage: err?.message || String(err),
      },
      (type, payload) => logWarn(logger, type, payload)
    );

    return {
      success: false,
      lead: null,
      leadId: null,
      wasCreated: false,
      assignedAgentProfileId: null,
      assignmentResult: null,
      reason: 'lead_automation_error',
      error: err?.message || String(err),
    };
  }
}

/**
 * Construye un resumen detallado de notas para un lead de pauta abandonada.
 */
function buildPautaAbandonedNotes({ aiState, conversation, referral, lastInbound }) {
  const parts = [];

  parts.push('Origen: pauta/referral de WhatsApp.');

  if (referral && typeof referral === 'object') {
    if (referral.headline) parts.push(`Anuncio: "${referral.headline}".`);
    if (referral.ad_name) parts.push(`Nombre del anuncio: ${referral.ad_name}.`);
    if (referral.campaign_name) parts.push(`Campaña: ${referral.campaign_name}.`);
    if (referral.source_url) parts.push(`URL fuente: ${referral.source_url}.`);
    if (referral.ad_id) parts.push(`Ad ID: ${referral.ad_id}.`);
    if (referral.campaign_id) parts.push(`Campaign ID: ${referral.campaign_id}.`);
    if (referral.ctwa_clid) parts.push(`CTWA CLID: ${referral.ctwa_clid}.`);
    if (referral.source_type) parts.push(`Tipo de fuente: ${referral.source_type}.`);
  }

  parts.push(`Conversación ID: ${conversation?.id || 'n/a'}.`);
  parts.push(`Teléfono: ${conversation?.phone || 'n/a'}.`);

  const intentLabel = aiState?.intent_type || aiState?.lead_flow || null;
  if (intentLabel) parts.push(`Intención detectada: ${intentLabel}.`);

  const propertyMentioned = aiState?.property_code || aiState?.direct_property_code || null;
  if (propertyMentioned) parts.push(`Propiedad mencionada: ${propertyMentioned}.`);

  if (lastInbound?.message_text) {
    parts.push(`Último mensaje recibido: "${String(lastInbound.message_text).slice(0, 200)}".`);
  }

  if (lastInbound?.created_at) {
    parts.push(`Fecha/hora del último inbound: ${lastInbound.created_at}.`);
  }

  parts.push('Motivo de asignación: pauta abandonada después de follow-ups de inactividad.');

  return parts.filter(Boolean).join(' ').slice(0, 1500);
}

/**
 * Cuarzo 0A — Lead de pauta/property abandonada: property_owner_agent vía motor oficial.
 */
async function ensurePropertyPautaAbandonedLead({
  supabase,
  conversation,
  aiState,
  messages = [],
  logger = console,
}) {
  const conversationId = conversation?.id || null;
  const { resolvePautaPropertyCrmContext } = require('../conversation/pautaDetection');
  const propertyInventoryService = require('./propertyInventoryService');
  const { ensureContactForConversationCore } = require('./contactProvisioning');

  try {
    const existingLeadId = conversation?.lead_id || aiState?.lead_id || null;
    if (existingLeadId) {
      const existingLead = await findLeadByConversation(supabase, existingLeadId);
      if (existingLead?.id) {
        await saveConversationEvent(supabase, conversationId, 'pauta_lead_skipped_already_exists', {
          lead_id: existingLead.id,
          reason: 'lead_already_exists_in_conversation',
          source: 'inactivity_followup_job',
        });
        return { created: false, reason: 'lead_already_exists', leadId: existingLead.id };
      }
    }

    const pautaCtx = resolvePautaPropertyCrmContext(aiState);
    if (!pautaCtx.bypassEligible) {
      await saveConversationEvent(supabase, conversationId, 'property_abandoned_lead_skipped', {
        reason: pautaCtx.reason || 'not_pauta_property',
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: pautaCtx.reason || 'not_pauta_property' };
    }

    const hadAiOutbound = (messages || []).some(
      (m) => m.direction === 'outbound' && ['ai_agent', 'system'].includes(String(m.sender_type || '').toLowerCase())
    );
    if (!hadAiOutbound) {
      await saveConversationEvent(supabase, conversationId, 'property_abandoned_lead_skipped', {
        reason: 'no_perseo_outbound',
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: 'no_perseo_outbound' };
    }

    let property = null;
    let propertyId = pautaCtx.propertyId || null;
    if (pautaCtx.propertyCode) {
      const resolved = await propertyInventoryService.findPropertyByInventoryReference(
        supabase,
        { code: pautaCtx.propertyCode, text: '', hintZone: null },
        logger
      );
      property = resolved.property;
      propertyId = resolved.propertyId || propertyId;
    }

    const phone = conversation?.phone || null;
    const contactResult = await ensureContactForConversationCore({
      supabase,
      conversationRow: conversation,
      state: aiState,
      phone,
      waName: null,
      source: 'whatsapp',
      rawPayload: null,
      property,
      logger,
      saveConversationEvent: (cid, type, payload) => saveConversationEvent(supabase, cid, type, payload),
      updateConversationMeta: (cid, payload) => syncConversation(supabase, cid, payload),
    });

    const contactId = contactResult?.contactId || conversation?.contact_id || null;
    if (!contactId) {
      await saveConversationEvent(supabase, conversationId, 'property_abandoned_lead_failed', {
        reason: 'missing_contact',
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: 'missing_contact' };
    }

    const enrichedState = {
      ...aiState,
      interested_property_id: propertyId || aiState.interested_property_id || null,
      property_code: pautaCtx.propertyCode || aiState.property_code || null,
      direct_property_code: pautaCtx.propertyCode || aiState.direct_property_code || null,
      property_specific_intent: true,
      direct_property_reference: true,
    };

    const leadResult = await createOrReuseLeadFromConversation({
      supabase,
      conversation,
      aiState: enrichedState,
      contactId,
      propertyId,
      property,
      contactWasCreated: !!contactResult?.wasCreated,
      logger,
    });

    if (!leadResult?.success) {
      await saveConversationEvent(supabase, conversationId, 'property_abandoned_lead_failed', {
        reason: leadResult?.reason || 'lead_creation_failed',
        error: leadResult?.error || null,
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: leadResult?.reason || 'lead_creation_failed' };
    }

    const assignmentStrategy =
      leadResult?.assignmentResult?.strategy || 'property_owner_agent';

    await saveConversationEvent(supabase, conversationId, 'property_pauta_lead_autocreated', {
      lead_id: leadResult.leadId,
      was_created: !!leadResult.wasCreated,
      interested_property_id: propertyId,
      property_code: pautaCtx.propertyCode,
      assigned_agent_profile_id: leadResult.assignedAgentProfileId,
      assignment_strategy: assignmentStrategy,
      source: 'inactivity_followup_job',
      trigger: 'property_abandoned',
    });

    log(logger, 'PROPERTY_PAUTA_ABANDONED_LEAD', {
      conversation_id: conversationId,
      lead_id: leadResult.leadId,
      property_code: pautaCtx.propertyCode,
      assignment_strategy: assignmentStrategy,
    });

    return {
      created: !!leadResult.wasCreated,
      leadId: leadResult.leadId,
      lead: leadResult.lead,
      assignmentStrategy,
      reason: leadResult.wasCreated ? 'created' : 'reused',
    };
  } catch (err) {
    logWarn(logger, 'PROPERTY_PAUTA_ABANDONED_LEAD_ERROR', {
      conversation_id: conversationId,
      error: err?.message || String(err),
    });
    await saveConversationEvent(supabase, conversationId, 'property_abandoned_lead_failed', {
      error: err?.message || String(err),
      source: 'inactivity_followup_job',
    });
    return { created: false, reason: 'error', error: err?.message };
  }
}

/**
 * @deprecated Cuarzo 0A — usar ensurePropertyPautaAbandonedLead (property_owner_agent).
 * Crea un lead en public.leads asignado al Agente Especial cuando una conversación
 * proveniente de pauta es cerrada por inactividad.
 *
 * Reglas:
 * - Si ya existe lead vinculado a la conversación: no crea duplicado, solo registra evento.
 * - Si el contacto ya tiene agente asignado: respeta ese agente, no usa Agente Especial.
 * - Si no se encontró el Agente Especial: aborta con evento de error.
 */
async function createPautaAbandonedLead({
  supabase,
  conversation,
  aiState,
  messages = [],
  specialAgentProfileId,
  logger = console,
}) {
  const conversationId = conversation?.id || null;

  try {
    // 1. Evitar duplicado: verificar si ya existe lead vinculado
    const existingLeadId = conversation?.lead_id || aiState?.lead_id || null;
    if (existingLeadId) {
      const existingLead = await findLeadByConversation(supabase, existingLeadId);
      if (existingLead?.id) {
        await saveConversationEvent(supabase, conversationId, 'pauta_lead_skipped_already_exists', {
          lead_id: existingLead.id,
          reason: 'lead_already_exists_in_conversation',
          source: 'inactivity_followup_job',
        });
        return { created: false, reason: 'lead_already_exists', leadId: existingLead.id };
      }
    }

    // 2. Respetar agente del contacto si ya tiene uno asignado
    const contactId = conversation?.contact_id || null;
    let contact = null;
    if (contactId) {
      contact = await findContactById(supabase, contactId);
    }
    const contactOwner = resolveContactAssignedAgentField(contact || {});
    if (contactOwner.assignedAgentProfileId) {
      await saveConversationEvent(supabase, conversationId, 'pauta_lead_skipped_contact_has_agent', {
        contact_id: contactId,
        assigned_agent_profile_id: contactOwner.assignedAgentProfileId,
        reason: 'contact_already_has_assigned_agent',
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: 'contact_has_assigned_agent' };
    }

    // 3. Verificar que el Agente Especial fue encontrado
    if (!specialAgentProfileId) {
      await saveConversationEvent(supabase, conversationId, 'pauta_lead_skipped_no_special_agent', {
        reason: 'special_agent_not_found',
        source: 'inactivity_followup_job',
      });
      return { created: false, reason: 'special_agent_not_found' };
    }

    // 4. Construir notas con toda la información disponible
    const referral = aiState?.whatsapp_referral || null;
    const lastInbound = [...(messages || [])].reverse().find((m) => m.direction === 'inbound') || null;
    const notes = buildPautaAbandonedNotes({ aiState, conversation, referral, lastInbound });

    // 5. Determinar tipo de lead y operación
    const leadType = resolveLeadType(aiState) || 'demand';
    const operation = resolveOperation(aiState, null);

    // 6. Obtener pipeline stage inicial
    const pipelineStageId = await getInitialPipelineStageId(supabase, leadType);

    // 7. Crear lead con Agente Especial asignado
    const normalizedPhone = normalizePhoneNumber(conversation?.phone) || conversation?.phone || null;
    const payload = {
      contact_id: contactId || null,
      lead_type: leadType,
      source: 'whatsapp',
      interested_in_operation: operation,
      notes_summary: notes,
      assigned_agent_profile_id: specialAgentProfileId,
      pipeline_stage_id: pipelineStageId,
      status: 'new',
      is_active: true,
      is_archived: false,
      phone: normalizedPhone,
      whatsapp: normalizedPhone,
      next_action: 'Seguimiento pauta abandonada',
      next_action_due_at: nowIso(),
    };

    const { data, error } = await insertLeadWithSourceFallback(supabase, payload);
    if (error || !data) {
      throw new Error(error?.message || 'pauta_lead_insert_failed');
    }

    // 8. Vincular lead a la conversación
    await syncConversation(supabase, conversationId, { lead_id: data.id });

    let profileSyncWarning = null;
    try {
      await syncLeadDemandProfile(supabase, data, aiState || {}, logger);
    } catch (profileError) {
      profileSyncWarning = profileError?.message || String(profileError);
      await saveConversationEvent(supabase, conversationId, 'demand_profile_sync_failed', {
        lead_id: data.id,
        error: profileSyncWarning,
        source: 'inactivity_followup_job',
      });
    }

    // 9. Registrar evento
    await saveConversationEvent(supabase, conversationId, 'pauta_abandoned_lead_created', {
      lead_id: data.id,
      assigned_agent_profile_id: specialAgentProfileId,
      lead_type: leadType,
      has_referral: !!referral,
      source: 'inactivity_followup_job',
    });

    log(logger, 'PAUTA_ABANDONED_LEAD_CREATED', {
      conversation_id: conversationId,
      lead_id: data.id,
      assigned_agent_profile_id: specialAgentProfileId,
      lead_type: leadType,
    });

    return {
      created: true,
      leadId: data.id,
      lead: data,
      warnings: profileSyncWarning
        ? [{ code: 'demand_profile_sync_failed', detail: profileSyncWarning }]
        : [],
    };
  } catch (err) {
    logWarn(logger, 'PAUTA_ABANDONED_LEAD_ERROR', {
      conversation_id: conversationId,
      error: err?.message || String(err),
    });
    await saveConversationEvent(supabase, conversationId, 'pauta_abandoned_lead_failed', {
      error: err?.message || String(err),
      reason: 'lead_creation_error',
      source: 'inactivity_followup_job',
    });
    return { created: false, reason: 'error', error: err?.message };
  }
}

async function ensureLeadForConversation(args) {
  return createOrReuseLeadFromConversation(args);
}

/**
 * Plan lead sin writes (ARGOS preview + parity con execute).
 */
async function _planLead({
  supabase,
  conversation,
  aiState,
  contactId,
  propertyId,
  property = null,
  contactWasCreated = false,
  logger = console,
}) {
  const baseSkip = {
    action: 'would_skip',
    would_create_lead: false,
    would_reuse_lead: false,
    lead_id: null,
    wasCreated: false,
    lead_type: null,
    operation: null,
    interested_property_id: propertyId || null,
    assigned_agent_profile_id: null,
    assignment_strategy: null,
    reuse_reason: null,
    reason: null,
  };

  if (!contactId) {
    return { ...baseSkip, reason: 'missing_contact' };
  }

  if (
    aiState?.direct_property_reference &&
    (aiState.property_code || aiState.direct_property_code) &&
    !propertyId
  ) {
    return { ...baseSkip, reason: 'missing_property' };
  }

  if (!hasClearIntent(aiState, propertyId)) {
    return { ...baseSkip, reason: 'low_confidence' };
  }

  const leadType = resolveLeadType(aiState) || (propertyId ? 'demand' : null);
  if (!leadType) {
    return { ...baseSkip, reason: 'missing_lead_type' };
  }

  const operation = resolveOperation(aiState, property);
  const normalizedConversationPhone =
    normalizePhoneNumber(conversation?.phone) || conversation?.phone || null;
  const contact = await findContactById(supabase, contactId);
  const contactOwner = resolveContactAssignedAgentField(contact || {});
  const expected = {
    contactId,
    leadType,
    operation,
    propertyId: propertyId || null,
  };

  const qaForceNewLead = aiState?.qa_crm_force_new_lead === true;

  let lead = qaForceNewLead
    ? null
    : await findLeadByConversation(supabase, conversation?.lead_id || aiState?.lead_id || null);

  if (lead && !isLeadCompatible(lead, expected)) {
    if (!canUpdateLeadPropertyInterestOnly(lead, expected)) {
      lead = null;
    }
  }

  if (!lead && !qaForceNewLead && contactId) {
    const compatibleLeads = await findCompatibleLead(supabase, {
      contactId,
      leadType,
      operation,
      propertyId: propertyId || null,
    });
    lead = chooseCanonicalCompatibleLead(compatibleLeads);
  }

  if (!lead && !qaForceNewLead) {
    const byPhone = await findCompatibleLeadByPhoneAndProperty(supabase, {
      normalizedPhone: normalizedConversationPhone,
      leadType,
      operation,
      propertyId: propertyId || null,
    });
    lead = chooseCanonicalCompatibleLead(byPhone);
  }

  if (!lead && !qaForceNewLead) {
    const byWa = await findCompatibleLeadByWhatsapp(supabase, {
      normalizedWhatsapp: normalizedConversationPhone,
      leadType,
      operation,
      propertyId: propertyId || null,
    });
    lead = chooseCanonicalCompatibleLead(byWa);
  }

  const wasCreated = !lead;
  const action = wasCreated ? 'would_create' : 'would_reuse';

  const campaignAgentProfileId =
    aiState?.campaign_context?.campaign_agent_profile_id ||
    aiState?.campaign_context?.agent_profile_id ||
    null;
  const conversationAssignedAgentProfileId = conversation?.assigned_agent_profile_id || null;

  const syntheticLead = {
    ...(lead || {}),
    id: lead?.id || 'preview-lead',
    lead_score: lead?.lead_score ?? calculateLeadScore({ aiState, intent: { leadType } }).lead_score,
    lead_type: leadType,
    interested_property_id: propertyId || null,
  };

  const assignmentDecision = await resolveAssignmentDecision(
    {
      mode: 'preview',
      lead: syntheticLead,
      leadType,
      aiState,
      contactWasCreated,
      contactOwner,
      property,
      propertyId,
      campaignAgentProfileId,
      conversationAssignedAgentProfileId,
      conversationId: conversation?.id || null,
      operationType: operation,
      propertyType: aiState?.property_type || null,
      budgetMin: aiState?.budget_min ?? null,
      budgetMax: aiState?.budget_max ?? null,
    },
    { supabase, logger },
  );

  return {
    action,
    would_create_lead: wasCreated,
    would_reuse_lead: !wasCreated,
    lead_id: lead?.id || null,
    wasCreated,
    lead_type: leadType,
    operation,
    interested_property_id: propertyId || null,
    assigned_agent_profile_id: assignmentDecision.willAssign
      ? assignmentDecision.assignedAgentProfileId
      : null,
    assignment_strategy: assignmentDecision.strategy,
    assignment_path: assignmentDecision.path,
    assignment_candidates: assignmentDecision.candidates,
    would_assign_agent: assignmentDecision.willAssign,
    would_invoke_assign_engine: assignmentDecision.wouldInvokeRpc === true,
    why_not_assigned:
      assignmentDecision.willAssign ? null : assignmentDecision.reason || assignmentDecision.path,
    reuse_reason: wasCreated ? null : 'compatible_active_lead',
    reason: null,
  };
}

async function previewLeadFromConversation(params) {
  return _planLead(params);
}

module.exports = {
  calculateLeadScore,
  chooseCanonicalCompatibleLead,
  shouldTriggerHandoff,
  isDemandLeadContext,
  buildAssignmentPriorityCandidates,
  detectLeadCreationOpportunity,
  extractCampaignReferralContext,
  buildLeadContextFromConversation,
  buildStructuredSellerCrmSummary,
  ensureLeadForConversation,
  createOrReuseLeadFromConversation,
  createPautaAbandonedLead,
  ensurePropertyPautaAbandonedLead,
  _planLead,
  previewLeadFromConversation,
  resolveAssignmentDecision,
  applyAssignmentDecision,
  assignLeadViaEngineOnly,
  __qualifiedApplicantsV2: {
    getInitialPipelineStageId,
    filterReusableDemandLeads,
    mapUrgencyToDemandCatalog,
    syncLeadDemandProfile,
  },
};
