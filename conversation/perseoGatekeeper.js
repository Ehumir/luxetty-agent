'use strict';

/**
 * Gatekeeper único PERSEO.
 * Centraliza decisión IA vs bloqueo automatizado y respeta takeover persistido.
 */

const { isSprint1QaTesterPhone } = require('./qaSprint1Commands');
const { isIcfInboundHandled } = require('../services/icfInboundInterlock');

const PERSEO_REASON_CODES = Object.freeze({
  AUTOMATION_ALLOWED: 'AUTOMATION_ALLOWED',
  LEGACY_POLICY_V2_DISABLED: 'LEGACY_POLICY_V2_DISABLED',
  CONVERSATION_HUMAN_ATTENTION: 'CONVERSATION_HUMAN_ATTENTION',
  HUMAN_ONLY_GLOBAL_ACTIVE: 'HUMAN_ONLY_GLOBAL_ACTIVE',
  AUTOMATION_DISABLED_GLOBAL: 'AUTOMATION_DISABLED_GLOBAL',
  POLICY_SETTINGS_READ_FAILED: 'POLICY_SETTINGS_READ_FAILED',
  POLICY_SETTINGS_ROW_MISSING: 'POLICY_SETTINGS_ROW_MISSING',
  POLICY_SETTINGS_PARSE_INVALID: 'POLICY_SETTINGS_PARSE_INVALID',
  POLICY_RESOLUTION_UNEXPECTED: 'POLICY_RESOLUTION_UNEXPECTED',
  QA_OUTBOUND_NOT_ALLOWLISTED: 'QA_OUTBOUND_NOT_ALLOWLISTED',
  OUTBOUND_MESSAGES_EMPTY: 'OUTBOUND_MESSAGES_EMPTY',
  ICF_FOLLOWUP_RESPONSE_HANDLED: 'ICF_FOLLOWUP_RESPONSE_HANDLED',
});

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePerseoAiControlFromRow(conversationRow) {
  const aiState = conversationRow?.ai_state;
  if (!isRecord(aiState)) {
    return { attention_mode: 'perseo', ai_paused: false, source: 'default' };
  }

  const rawControl = aiState.ai_control;
  const control = isRecord(rawControl) ? rawControl : {};
  const rawMode = control.attention_mode ?? aiState.attention_mode;
  const rawPaused = control.ai_paused ?? aiState.ai_paused;
  const hasPersistedSignal =
    rawMode === 'human' || rawMode === 'perseo' || typeof rawPaused === 'boolean';

  const isHumanControlled =
    control.ai_paused === true ||
    aiState.ai_paused === true ||
    control.attention_mode === 'human' ||
    aiState.attention_mode === 'human';

  if (isHumanControlled) {
    return { attention_mode: 'human', ai_paused: true, source: 'persisted' };
  }

  return {
    attention_mode: 'perseo',
    ai_paused: false,
    source: hasPersistedSignal ? 'persisted' : 'default',
  };
}

function isPerseoPolicyV2Enabled() {
  return process.env.PERSEO_POLICY_V2_ENABLED === 'true';
}

function maybeLogPolicyDebug(globalRow, policy) {
  if (process.env.PERSEO_POLICY_DEBUG_LOG !== 'true') return;
  console.info(
    'perseo_policy_debug',
    JSON.stringify({
      ts: new Date().toISOString(),
      perseo_policy_v2_enabled: isPerseoPolicyV2Enabled(),
      reads_ai_conversation_channel_settings: isPerseoPolicyV2Enabled(),
      human_only_global: globalRow && typeof globalRow.human_only_global === 'boolean' ? globalRow.human_only_global : null,
      automation_enabled: globalRow && typeof globalRow.automation_enabled === 'boolean' ? globalRow.automation_enabled : null,
      policyResolution: policy.policyResolution,
      allowAutomatedReply: policy.allowAutomatedReply,
      allowQaBypass: policy.allowQaBypass,
      effectiveHumanLock: policy.effectiveHumanLock,
      reason_code: policy.reason_code,
    })
  );
}

async function fetchAiConversationChannelSettingsRow(supabase) {
  try {
    if (!supabase) {
      return {
        ok: false,
        errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED,
        detail: 'supabase_client_missing',
      };
    }
    const { data, error } = await supabase
      .from('ai_conversation_channel_settings')
      .select('human_only_global, automation_enabled')
      .eq('id', true)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED,
        detail: error.message || String(error),
      };
    }
    if (!data) {
      return { ok: false, errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_ROW_MISSING, detail: null };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      errorCode: PERSEO_REASON_CODES.POLICY_RESOLUTION_UNEXPECTED,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

async function resolveAutomatedReplyPolicy({ supabase, conversationRow, from }) {
  const allowQaBypass = isSprint1QaTesterPhone(from);

  try {
    if (conversationRow?.id && isIcfInboundHandled(conversationRow.id)) {
      const out = {
        policyResolution: 'ok',
        allowAutomatedReply: false,
        allowQaBypass,
        effectiveHumanLock: true,
        reason_code: PERSEO_REASON_CODES.ICF_FOLLOWUP_RESPONSE_HANDLED,
      };
      maybeLogPolicyDebug(null, out);
      return out;
    }

    const conv = normalizePerseoAiControlFromRow(conversationRow);
    const conversationHumanLock = conv.attention_mode === 'human' || conv.ai_paused === true;

    if (!isPerseoPolicyV2Enabled()) {
      const allowAutomatedReply = !conversationHumanLock;
      const out = {
        policyResolution: 'ok',
        allowAutomatedReply,
        allowQaBypass,
        effectiveHumanLock: conversationHumanLock,
        reason_code: allowAutomatedReply
          ? PERSEO_REASON_CODES.AUTOMATION_ALLOWED
          : PERSEO_REASON_CODES.CONVERSATION_HUMAN_ATTENTION,
      };
      maybeLogPolicyDebug(null, out);
      return out;
    }

    const fetched = await fetchAiConversationChannelSettingsRow(supabase);
    if (!fetched.ok) {
      const out = {
        policyResolution: 'error',
        allowAutomatedReply: false,
        allowQaBypass,
        effectiveHumanLock: true,
        reason_code: fetched.errorCode,
      };
      maybeLogPolicyDebug(null, out);
      return out;
    }

    const row = fetched.data;
    if (typeof row.human_only_global !== 'boolean' || typeof row.automation_enabled !== 'boolean') {
      const out = {
        policyResolution: 'error',
        allowAutomatedReply: false,
        allowQaBypass,
        effectiveHumanLock: true,
        reason_code: PERSEO_REASON_CODES.POLICY_SETTINGS_PARSE_INVALID,
      };
      maybeLogPolicyDebug(row, out);
      return out;
    }

    const globalAutomationBlocked = row.human_only_global === true || row.automation_enabled === false;
    const effectiveHumanLock = globalAutomationBlocked || conversationHumanLock;
    const allowAutomatedReply = !globalAutomationBlocked && !conversationHumanLock;

    let reason_code = PERSEO_REASON_CODES.AUTOMATION_ALLOWED;
    if (!allowAutomatedReply) {
      if (conversationHumanLock) reason_code = PERSEO_REASON_CODES.CONVERSATION_HUMAN_ATTENTION;
      else if (row.human_only_global === true) reason_code = PERSEO_REASON_CODES.HUMAN_ONLY_GLOBAL_ACTIVE;
      else if (row.automation_enabled === false) reason_code = PERSEO_REASON_CODES.AUTOMATION_DISABLED_GLOBAL;
    }

    const out = {
      policyResolution: 'ok',
      allowAutomatedReply,
      allowQaBypass,
      effectiveHumanLock,
      reason_code,
    };
    maybeLogPolicyDebug(row, out);
    return out;
  } catch (_err) {
    const out = {
      policyResolution: 'error',
      allowAutomatedReply: false,
      allowQaBypass: isSprint1QaTesterPhone(from),
      effectiveHumanLock: true,
      reason_code: PERSEO_REASON_CODES.POLICY_RESOLUTION_UNEXPECTED,
    };
    maybeLogPolicyDebug(null, out);
    return out;
  }
}

module.exports = {
  PERSEO_REASON_CODES,
  resolveAutomatedReplyPolicy,
  normalizePerseoAiControlFromRow,
  fetchAiConversationChannelSettingsRow,
  isPerseoPolicyV2Enabled,
};
