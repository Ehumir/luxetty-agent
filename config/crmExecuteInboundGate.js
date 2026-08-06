'use strict';

const { getPerseoV3Config, evaluateV3PrimaryGate } = require('./perseoV3Flags');
const {
  resolvePautaPropertyCrmContext,
  isPautaPropertyBypassEnabled,
} = require('../conversation/pautaDetection');
const {
  resolveOrganicOfferCrmContext,
  isOrganicOfferBypassEnabled,
} = require('../conversation/organicOfferCrm');

const V3_PIPELINES = new Set(['v3', 'v3_primary']);

/**
 * Gate de seguridad V1: mutaciones CRM reales con EXECUTE ON + (allowlist V3 pipeline | bypass pauta/property controlado).
 *
 * @param {{
 *   phone: string,
 *   rawPhone?: string|null,
 *   conversationId?: string|null,
 *   v3PrimaryAllowed?: boolean,
 *   selectedPipeline?: string|null,
 *   argosMode?: boolean,
 *   aiState?: object|null,
 *   propertyId?: string|null,
 * }} input
 */
function shouldAllowCrmExecuteForInbound(input) {
  const cfg = getPerseoV3Config();
  const gate = evaluateV3PrimaryGate({
    phone: input?.phone || '',
    rawPhone: input?.rawPhone ?? null,
    argosMode: input?.argosMode === true,
  });

  const selectedPipeline = String(input?.selectedPipeline || 'legacy').trim().toLowerCase() || 'legacy';
  const v3PrimaryAllowed =
    input?.v3PrimaryAllowed === true || (input?.v3PrimaryAllowed !== false && gate.v3_primary_allowed);

  const pautaCtx = resolvePautaPropertyCrmContext(input?.aiState || {}, {
    propertyId: input?.propertyId ?? null,
  });
  const pautaBypass =
    isPautaPropertyBypassEnabled() &&
    pautaCtx.bypassEligible &&
    !(input?.argosMode === true && process.env.PERSEO_ARGOS_ENABLED === 'true');

  const organicCtx = resolveOrganicOfferCrmContext(input?.aiState || {});
  const organicBypass =
    isOrganicOfferBypassEnabled() &&
    organicCtx.bypassEligible &&
    !(input?.argosMode === true && process.env.PERSEO_ARGOS_ENABLED === 'true');
  const p0Operation = String(input?.aiState?.operation_type || '').toLowerCase();
  const p0CommercialFlow =
    input?.aiState?.meta_lead_form_flow === true ||
    input?.aiState?.lead_flow === 'demand' ||
    input?.aiState?.lead_flow === 'offer' ||
    input?.aiState?.lead_type === 'supply' ||
    input?.aiState?.property_specific_intent === true;
  const p0RecoveryBypass =
    process.env.PERSEO_P0_CRM_RECOVERY_ENABLED === 'true' &&
    ['sale', 'rent'].includes(p0Operation) &&
    p0CommercialFlow &&
    !(input?.argosMode === true && process.env.PERSEO_ARGOS_ENABLED === 'true');

  const base = {
    phone: input?.phone || null,
    conversation_id: input?.conversationId || null,
    allowlist_count: cfg.qaAllowlist.length,
    is_qa_allowed: gate.allowlist_match,
    selected_pipeline: selectedPipeline,
    crm_execute_env: cfg.crmExecute,
    v3_enabled: cfg.enabled,
    v3_primary_allowed: v3PrimaryAllowed,
    allowlist_block_reason: gate.v3_primary_block_reason || null,
    pauta_property_bypass: pautaBypass,
    pauta_property_code: pautaCtx.propertyCode || null,
    pauta_bypass_reason: pautaBypass ? 'pauta_property' : pautaCtx.reason,
    organic_offer_bypass: organicBypass,
    organic_offer_bypass_reason: organicBypass ? 'organic_offer' : organicCtx.reason,
    p0_recovery_bypass: p0RecoveryBypass,
  };

  if (!cfg.crmExecute) {
    return {
      ...base,
      crm_execute_allowed: false,
      block_reason: 'crm_execute_disabled',
      crm_execute_bypass_reason: null,
    };
  }

  if (!cfg.enabled) {
    return {
      ...base,
      crm_execute_allowed: false,
      block_reason: 'v3_disabled',
      crm_execute_bypass_reason: null,
    };
  }

  if (p0RecoveryBypass) {
    return {
      ...base,
      crm_execute_allowed: true,
      block_reason: null,
      crm_execute_bypass_reason: 'p0_commercial_intent',
    };
  }

  if (pautaBypass) {
    return {
      ...base,
      crm_execute_allowed: true,
      block_reason: null,
      crm_execute_bypass_reason: 'pauta_property',
    };
  }

  if (organicBypass) {
    return {
      ...base,
      crm_execute_allowed: true,
      block_reason: null,
      crm_execute_bypass_reason: 'organic_offer',
    };
  }

  if (!gate.allowlist_match && !(input?.argosMode === true && process.env.PERSEO_ARGOS_ENABLED === 'true')) {
    return {
      ...base,
      crm_execute_allowed: false,
      block_reason: 'allowlist_no_match',
      crm_execute_bypass_reason: null,
    };
  }

  if (!v3PrimaryAllowed) {
    return {
      ...base,
      crm_execute_allowed: false,
      block_reason: 'v3_primary_not_allowed',
      crm_execute_bypass_reason: null,
    };
  }

  if (!V3_PIPELINES.has(selectedPipeline)) {
    return {
      ...base,
      crm_execute_allowed: false,
      block_reason: 'pipeline_not_v3',
      crm_execute_bypass_reason: null,
    };
  }

  return {
    ...base,
    crm_execute_allowed: true,
    block_reason: null,
    crm_execute_bypass_reason: null,
  };
}

/**
 * @param {Function|null|undefined} logEvent
 * @param {ReturnType<typeof shouldAllowCrmExecuteForInbound>} gateResult
 */
function buildCrmExecuteGatePayload(gateResult) {
  return {
    event: 'crm_execute_gate',
    phone: gateResult.phone,
    conversation_id: gateResult.conversation_id,
    allowlist_count: gateResult.allowlist_count,
    is_qa_allowed: gateResult.is_qa_allowed,
    selected_pipeline: gateResult.selected_pipeline,
    crm_execute_env: gateResult.crm_execute_env,
    crm_execute_allowed: gateResult.crm_execute_allowed,
    block_reason: gateResult.block_reason,
    v3_primary_allowed: gateResult.v3_primary_allowed,
    v3_enabled: gateResult.v3_enabled,
    allowlist_block_reason: gateResult.allowlist_block_reason ?? null,
    pauta_property_bypass: gateResult.pauta_property_bypass === true,
    pauta_property_code: gateResult.pauta_property_code ?? null,
    crm_execute_bypass_reason: gateResult.crm_execute_bypass_reason ?? null,
    pauta_bypass_reason: gateResult.pauta_bypass_reason ?? null,
    organic_offer_bypass: gateResult.organic_offer_bypass === true,
    organic_offer_bypass_reason: gateResult.organic_offer_bypass_reason ?? null,
    p0_recovery_bypass: gateResult.p0_recovery_bypass === true,
  };
}

function logCrmExecuteGate(logEvent, gateResult) {
  const payload = buildCrmExecuteGatePayload(gateResult);
  if (typeof logEvent === 'function') {
    logEvent('crm_execute_gate', payload);
  }
}

/**
 * @param {(id: string, type: string, payload: object) => Promise<void>|void} saveConversationEvent
 * @param {string|null|undefined} conversationId
 * @param {ReturnType<typeof shouldAllowCrmExecuteForInbound>} gateResult
 */
async function persistCrmExecuteGateEvent(saveConversationEvent, conversationId, gateResult) {
  const id = String(conversationId || '').trim();
  if (!id || typeof saveConversationEvent !== 'function') return;
  try {
    await saveConversationEvent(id, 'crm_execute_gate', buildCrmExecuteGatePayload(gateResult));
  } catch (err) {
    console.error('crm_execute_gate_persist_fatal', err);
  }
}

module.exports = {
  shouldAllowCrmExecuteForInbound,
  logCrmExecuteGate,
  persistCrmExecuteGateEvent,
  buildCrmExecuteGatePayload,
  V3_PIPELINES,
};
