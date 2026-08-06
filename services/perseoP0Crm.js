'use strict';

const crypto = require('node:crypto');
const { normalizeText, cleanSpaces } = require('../utils/text');

const FAIL_CLOSED_REPLY =
  'Gracias, ya recibí tus datos. Primero validaremos el anuncio de origen para no proporcionarte información de otra propiedad. Un asesor te contactará para continuar.';

function isEnabled() {
  return process.env.PERSEO_P0_CRM_RECOVERY_ENABLED === 'true';
}

function normalizeOperation(value) {
  const operation = normalizeText(String(value || ''));
  if (operation === 'rent' || operation === 'renta' || operation === 'rentar') return 'rent';
  if (operation === 'purchase' || operation === 'buy' || operation === 'compra' || operation === 'sale' || operation === 'venta') {
    return 'sale';
  }
  return null;
}

function classifyOrigin(aiState = {}) {
  const campaign = aiState.campaign_context && typeof aiState.campaign_context === 'object'
    ? aiState.campaign_context
    : {};
  if (aiState.meta_lead_form_flow === true && (aiState.lead_flow === 'offer' || aiState.lead_type === 'supply')) {
    return 'seller_capture';
  }
  if (campaign.campaign_type === 'seller_capture' || campaign.campaign_type === 'valuation') return 'seller_capture';
  if (campaign.campaign_type === 'property_listing' || aiState.property_specific_intent === true) return 'property_listing';
  if (aiState.lead_flow === 'demand' && normalizeOperation(aiState.operation_type) === 'rent') return 'tenant_demand';
  if (aiState.lead_flow === 'demand') return 'buyer_demand';
  return 'natural';
}

function extractInboundId(rawPayload = {}) {
  return cleanSpaces(String(
    rawPayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id ||
    rawPayload?.message_id ||
    rawPayload?.id ||
    '',
  ));
}

function buildIdempotencyKey({ conversationId, rawPayload, text }) {
  const inboundId = extractInboundId(rawPayload);
  const material = inboundId
    ? `meta:${inboundId}`
    : `fallback:${conversationId}:${normalizeText(String(text || ''))}`;
  return `perseo-p0:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function propertyIsVerified(property) {
  if (!property?.id) return false;
  const row = property.raw && typeof property.raw === 'object' ? property.raw : property;
  return row.status === 'active' && row.is_public !== false && row.visible_on_website !== false;
}

function buildP0CrmPayload({
  conversationId,
  conversationRow = {},
  aiState = {},
  parsedSignals = {},
  property = null,
  propertyId = null,
  phone,
  waProfileName,
  rawPayload = {},
  text = '',
}) {
  const origin = classifyOrigin(aiState);
  const supply = origin === 'seller_capture' || aiState.lead_flow === 'offer' || aiState.lead_type === 'supply';
  const operation = normalizeOperation(aiState.operation_type || parsedSignals.operation_type);
  const campaign = aiState.campaign_context && typeof aiState.campaign_context === 'object'
    ? aiState.campaign_context
    : {};
  const resolvedPropertyId = propertyId || property?.id || aiState.interested_property_id || null;
  const assignedAgentId =
    conversationRow.assigned_agent_profile_id ||
    aiState.assigned_agent_profile_id ||
    (!supply ? property?.agent_profile_id || property?.raw?.agent_profile_id : null) ||
    campaign.campaign_agent_profile_id ||
    null;

  if (!operation) return { ok: false, reason: 'operation_missing' };
  if (!assignedAgentId) return { ok: false, reason: 'assigned_agent_missing' };
  if (!supply && origin === 'property_listing' && !propertyIsVerified(property)) {
    return { ok: false, reason: 'campaign_property_not_verified' };
  }
  if (!supply && resolvedPropertyId && !propertyIsVerified(property)) {
    return { ok: false, reason: 'property_not_publishable' };
  }
  if (!supply && resolvedPropertyId) {
    const propertyOperation = normalizeOperation(property?.operation_type || property?.raw?.operation_type);
    if (propertyOperation && propertyOperation !== operation && (property?.operation_type || property?.raw?.operation_type) !== 'sale_rent') {
      return { ok: false, reason: 'property_operation_conflict' };
    }
  }

  return {
    ok: true,
    strippedCampaignProperty: supply && !!resolvedPropertyId,
    payload: {
      idempotency_key: buildIdempotencyKey({ conversationId, rawPayload, text }),
      conversation_id: conversationId,
      contact_id: conversationRow.contact_id || null,
      lead_id: conversationRow.lead_id || aiState.lead_id || null,
      phone,
      full_name: aiState.full_name || waProfileName || null,
      lead_type: supply ? 'supply' : 'demand',
      operation,
      property_id: supply ? null : resolvedPropertyId,
      assigned_agent_profile_id: assignedAgentId,
      campaign_key: campaign.campaign_id || campaign.ad_id || campaign.ctwa_clid || null,
      campaign_kind: origin,
      location_text: aiState.location_text || parsedSignals.location_text || null,
      budget_min: aiState.budget_min ?? null,
      budget_max: aiState.budget_max ?? null,
      wants_visit: aiState.wants_visit === true,
      notes_summary: aiState.crm_structured_summary
        ? JSON.stringify(aiState.crm_structured_summary).slice(0, 1500)
        : null,
      discovery_notes: `PERSEO P0 | origen=${origin}`,
    },
  };
}

async function commitP0CrmIntake(input) {
  if (!isEnabled()) return { handled: false, reason: 'p0_crm_disabled' };
  const operation = normalizeOperation(input.aiState?.operation_type || input.parsedSignals?.operation_type);
  const commercialFlow =
    input.aiState?.meta_lead_form_flow === true ||
    input.aiState?.lead_flow === 'demand' ||
    input.aiState?.lead_flow === 'offer' ||
    input.aiState?.lead_type === 'supply' ||
    input.aiState?.property_specific_intent === true;
  const eligible = !!input.conversationId && !!input.phone && !!operation && commercialFlow;
  if (!eligible) return { handled: false, reason: 'commercial_intent_incomplete' };

  let effectiveInput = input;
  const hasAssignedAgent = !!(
    input.conversationRow?.assigned_agent_profile_id ||
    input.aiState?.assigned_agent_profile_id ||
    input.property?.agent_profile_id ||
    input.property?.raw?.agent_profile_id ||
    input.aiState?.campaign_context?.campaign_agent_profile_id
  );
  if (!hasAssignedAgent) {
    const { resolveEngineAssignmentReadOnly } = require('./assignmentDecision');
    const assignment = await resolveEngineAssignmentReadOnly(
      input.supabase,
      {
        operationType: operation,
        propertyType: input.aiState?.property_type || null,
        budgetMin: input.aiState?.budget_min ?? null,
        budgetMax: input.aiState?.budget_max ?? null,
      },
      { previewMode: true, logger: input.logger || console },
    );
    if (!assignment.assignedAgentProfileId) {
      return { handled: true, success: false, failClosed: true, reason: 'assignment_queue_unavailable' };
    }
    effectiveInput = {
      ...input,
      aiState: { ...input.aiState, assigned_agent_profile_id: assignment.assignedAgentProfileId },
    };
  }

  const contract = buildP0CrmPayload(effectiveInput);
  if (!contract.ok) {
    return { handled: true, success: false, failClosed: true, reason: contract.reason };
  }

  const { data, error } = await input.supabase.rpc('perseo_p0_commit_crm_intake', {
    p_payload: contract.payload,
  });
  if (error || !data) {
    return {
      handled: true,
      success: false,
      failClosed: true,
      reason: error?.message || 'p0_crm_rpc_failed',
      code: error?.code || null,
    };
  }
  return {
    handled: true,
    success: true,
    result: data,
    strippedCampaignProperty: contract.strippedCampaignProperty,
    idempotencyKey: contract.payload.idempotency_key,
  };
}

module.exports = {
  FAIL_CLOSED_REPLY,
  isEnabled,
  normalizeOperation,
  classifyOrigin,
  buildIdempotencyKey,
  buildP0CrmPayload,
  commitP0CrmIntake,
};
