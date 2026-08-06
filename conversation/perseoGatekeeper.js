'use strict';

const { isSprint1QaTesterPhone } = require('./qaSprint1Commands');

const AUTOMATION_MODES = Object.freeze({
  GLOBAL_PAUSED: 'GLOBAL_PAUSED',
  CANARY_ALLOWLIST: 'CANARY_ALLOWLIST',
  GLOBAL_ENABLED: 'GLOBAL_ENABLED',
});

const PERSEO_REASON_CODES = Object.freeze({
  AUTOMATION_ALLOWED: 'AUTOMATION_ALLOWED',
  CANARY_CONVERSATION_ALLOWED: 'CANARY_CONVERSATION_ALLOWED',
  QA_AUTOMATION_ALLOWED: 'QA_AUTOMATION_ALLOWED',
  KILL_SWITCH_ACTIVE: 'KILL_SWITCH_ACTIVE',
  CONFIG_MISSING_OR_INVALID: 'CONFIG_MISSING_OR_INVALID',
  GLOBAL_ENABLED_NOT_AUTHORIZED: 'GLOBAL_ENABLED_NOT_AUTHORIZED',
  GLOBAL_PAUSE_NOT_ACTIVE: 'GLOBAL_PAUSE_NOT_ACTIVE',
  GLOBAL_PAUSED: 'GLOBAL_PAUSED',
  CANARY_DISABLED: 'CANARY_DISABLED',
  CANARY_ALLOWLIST_EMPTY: 'CANARY_ALLOWLIST_EMPTY',
  CANARY_ID_INVALID: 'CANARY_ID_INVALID',
  CANARY_CONVERSATION_NOT_ALLOWED: 'CANARY_CONVERSATION_NOT_ALLOWED',
  CONVERSATION_ID_MISSING: 'CONVERSATION_ID_MISSING',
  MESSAGE_ID_MISSING: 'MESSAGE_ID_MISSING',
  CONVERSATION_HUMAN_ATTENTION: 'CONVERSATION_HUMAN_ATTENTION',
  HUMAN_WAITING_ACTIVE: 'HUMAN_WAITING_ACTIVE',
  FOLLOWUPS_DISABLED: 'FOLLOWUPS_DISABLED',
  ROUTE_NOT_AUTHORIZED: 'ROUTE_NOT_AUTHORIZED',
  QA_SESSION_NOT_AUTHORIZED: 'QA_SESSION_NOT_AUTHORIZED',
  QA_IDENTITY_NOT_AUTHORIZED: 'QA_IDENTITY_NOT_AUTHORIZED',
  QA_ENVIRONMENT_NOT_AUTHORIZED: 'QA_ENVIRONMENT_NOT_AUTHORIZED',
  MESSAGE_ALREADY_PROCESSED: 'MESSAGE_ALREADY_PROCESSED',
  POLICY_SETTINGS_READ_FAILED: 'POLICY_SETTINGS_READ_FAILED',
  POLICY_SETTINGS_ROW_MISSING: 'POLICY_SETTINGS_ROW_MISSING',
  POLICY_SETTINGS_PARSE_INVALID: 'POLICY_SETTINGS_PARSE_INVALID',
  POLICY_RESOLUTION_UNEXPECTED: 'POLICY_RESOLUTION_UNEXPECTED',
  TELEMETRY_WRITE_FAILED: 'TELEMETRY_WRITE_FAILED',
  QA_OUTBOUND_NOT_ALLOWLISTED: 'QA_OUTBOUND_NOT_ALLOWLISTED',
  OUTBOUND_MESSAGES_EMPTY: 'OUTBOUND_MESSAGES_EMPTY',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORIZED_ROUTES = new Set([
  'legacy',
  'v2',
  'v3',
  'deterministic',
  'rag',
  'followup',
  'cron',
  'worker',
  'retry',
  'deferred',
  'qa',
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strictBoolean(value) {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return null;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRoute(value) {
  const route = String(value || '').trim().toLowerCase();
  if (AUTHORIZED_ROUTES.has(route)) return route;
  if (route.startsWith('legacy')) return 'legacy';
  if (route.startsWith('v2')) return 'v2';
  if (route.startsWith('v3')) return 'v3';
  if (route.includes('rag')) return 'rag';
  if (route.includes('followup')) return 'followup';
  return null;
}

function resolveEffectiveConfig(env = process.env) {
  const mode = String(env.PERSEO_AUTOMATION_MODE || '').trim().toUpperCase();
  const automatedResponsesEnabled = strictBoolean(env.PERSEO_AUTOMATED_RESPONSES_ENABLED);
  const canaryEnabled = strictBoolean(env.PERSEO_CANARY_ENABLED);
  const followupsEnabled = strictBoolean(env.PERSEO_FOLLOWUPS_ENABLED);
  const killSwitch = strictBoolean(env.PERSEO_KILL_SWITCH);
  const qaEnabled = strictBoolean(env.PERSEO_QA_AUTOMATION_ENABLED);
  const canaryIds = splitCsv(env.PERSEO_CANARY_CONVERSATION_IDS);
  const invalidCanaryIds = canaryIds.filter((id) => !UUID_RE.test(id));
  const qaAllowedEnvironments = splitCsv(env.PERSEO_QA_ALLOWED_ENVIRONMENTS).map((entry) => entry.toLowerCase());
  const environment = String(
    env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.NODE_ENV || ''
  ).trim().toLowerCase();

  const booleansValid = [automatedResponsesEnabled, canaryEnabled, followupsEnabled, killSwitch].every(
    (value) => typeof value === 'boolean'
  );
  const modeValid = Object.values(AUTOMATION_MODES).includes(mode);

  return {
    valid: booleansValid && modeValid,
    mode,
    automatedResponsesEnabled,
    canaryEnabled,
    followupsEnabled,
    killSwitch,
    qaEnabled,
    canaryIds,
    invalidCanaryIds,
    qaAllowedEnvironments,
    environment,
  };
}

function normalizePerseoAiControlFromRow(conversationRow) {
  const aiState = isRecord(conversationRow?.ai_state) ? conversationRow.ai_state : {};
  const control = isRecord(aiState.ai_control) ? aiState.ai_control : {};
  const mode = String(
    aiState.conversation_mode || aiState.control_mode || conversationRow?.conversation_mode || ''
  ).toUpperCase();
  const handoffState = String(aiState.handoff_state || conversationRow?.handoff_state || '').toUpperCase();
  const aiPaused =
    control.ai_paused === true ||
    aiState.ai_paused === true ||
    control.attention_mode === 'human' ||
    aiState.attention_mode === 'human';
  const humanWaiting = mode === 'HUMAN_WAITING' || handoffState === 'HUMAN_WAITING';

  return {
    attention_mode: aiPaused ? 'human' : 'perseo',
    ai_paused: aiPaused,
    human_waiting: humanWaiting,
    conversation_mode: mode || null,
    handoff_state: handoffState || null,
    source: Object.keys(aiState).length ? 'persisted' : 'default',
  };
}

async function fetchAiConversationChannelSettingsRow(supabase) {
  try {
    if (!supabase) {
      return { ok: false, errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED };
    }
    const { data, error } = await supabase
      .from('ai_conversation_channel_settings')
      .select('human_only_global, automation_enabled')
      .eq('id', true)
      .maybeSingle();
    if (error) return { ok: false, errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED };
    if (!data) return { ok: false, errorCode: PERSEO_REASON_CODES.POLICY_SETTINGS_ROW_MISSING };
    return { ok: true, data };
  } catch (_error) {
    return { ok: false, errorCode: PERSEO_REASON_CODES.POLICY_RESOLUTION_UNEXPECTED };
  }
}

function buildDecision(base, allow, reasonCode, extra = {}) {
  return {
    ...base,
    ...extra,
    policyResolution: extra.policyResolution || 'ok',
    allowAutomatedReply: allow,
    decision: allow ? 'ALLOW' : 'BLOCK',
    reason_code: reasonCode,
    effectiveHumanLock: !allow,
    allowQaBypass: allow && base.channel === 'qa',
  };
}

async function recordAutomationDecision({ supabase, recordDecision, decision }) {
  if (typeof recordDecision === 'function') {
    await recordDecision(decision);
    return { ok: true };
  }
  if (!supabase || !decision.conversation_id) return { ok: false };
  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: decision.conversation_id,
    type: 'perseo_automation_policy_decision',
    payload: decision,
  });
  return { ok: !error };
}

function maybeLogPolicyDebug(decision) {
  if (process.env.PERSEO_POLICY_DEBUG_LOG !== 'true') return;
  console.info('perseo_automation_policy_decision', JSON.stringify(decision));
}

/**
 * Única política autoritativa para cualquier salida automática de PERSEO.
 * Toda configuración ausente o ambigua bloquea. Un ALLOW exige telemetría persistida.
 */
async function resolveAutomationPolicy({
  supabase = null,
  conversationRow = null,
  conversationId = null,
  messageId = null,
  from = null,
  channel = 'ia',
  route = null,
  requestKind = 'direct',
  qaSession = null,
  messageAlreadyProcessed = false,
  env = process.env,
  globalPolicyRow = null,
  recordDecision = null,
  deployedSha = null,
} = {}) {
  const timestamp = new Date().toISOString();
  const config = resolveEffectiveConfig(env);
  const conv = normalizePerseoAiControlFromRow(conversationRow);
  const normalizedRoute = normalizeRoute(route);
  const resolvedConversationId = String(conversationId || conversationRow?.id || '').trim() || null;
  const inCanary = !!resolvedConversationId && config.canaryIds.includes(resolvedConversationId);
  const base = {
    conversation_id: resolvedConversationId,
    message_id: messageId || null,
    mode: config.mode || null,
    kill_switch: config.killSwitch,
    automated_responses_enabled: config.automatedResponsesEnabled,
    canary_enabled: config.canaryEnabled,
    canary_member: inCanary,
    cohort: inCanary ? 'canary' : channel === 'qa' ? 'qa' : 'none',
    global_paused: null,
    individual_paused: conv.ai_paused,
    human_waiting: conv.human_waiting,
    channel,
    route: normalizedRoute || String(route || '') || null,
    request_kind: requestKind,
    followup: requestKind === 'followup' || normalizedRoute === 'followup',
    timestamp,
    deployed_sha:
      deployedSha || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || env.SOURCE_VERSION || 'unknown',
  };

  let decision;
  try {
    if (!config.valid) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.CONFIG_MISSING_OR_INVALID);
    } else if (config.killSwitch) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.KILL_SWITCH_ACTIVE);
    } else if (!resolvedConversationId) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.CONVERSATION_ID_MISSING);
    } else if (!UUID_RE.test(resolvedConversationId)) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.CANARY_ID_INVALID);
    } else if (!messageId || !String(messageId).trim()) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.MESSAGE_ID_MISSING);
    } else if (!normalizedRoute) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.ROUTE_NOT_AUTHORIZED);
    } else if (messageAlreadyProcessed) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.MESSAGE_ALREADY_PROCESSED);
    } else if (conv.human_waiting) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.HUMAN_WAITING_ACTIVE);
    } else if (conv.ai_paused) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.CONVERSATION_HUMAN_ATTENTION);
    } else if (config.invalidCanaryIds.length) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.CANARY_ID_INVALID);
    } else if (config.mode === AUTOMATION_MODES.GLOBAL_ENABLED) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.GLOBAL_ENABLED_NOT_AUTHORIZED);
    } else {
      let row = globalPolicyRow;
      if (!row) {
        const fetched = await fetchAiConversationChannelSettingsRow(supabase);
        if (!fetched.ok) {
          decision = buildDecision(base, false, fetched.errorCode, { policyResolution: 'error' });
        } else {
          row = fetched.data;
        }
      }

      if (!decision) {
        if (typeof row?.human_only_global !== 'boolean' || typeof row?.automation_enabled !== 'boolean') {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.POLICY_SETTINGS_PARSE_INVALID, {
            policyResolution: 'error',
          });
        } else {
          base.global_paused = row.human_only_global === true || row.automation_enabled === false;
          if (!base.global_paused) {
            decision = buildDecision(base, false, PERSEO_REASON_CODES.GLOBAL_PAUSE_NOT_ACTIVE);
          }
        }
      }

      if (!decision && channel === 'qa') {
        const qaEnvironmentAllowed = config.qaAllowedEnvironments.includes(config.environment);
        if (config.qaEnabled !== true || qaSession?.authorized !== true || qaSession?.isQa !== true) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.QA_SESSION_NOT_AUTHORIZED);
        } else if (!isSprint1QaTesterPhone(from)) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.QA_IDENTITY_NOT_AUTHORIZED);
        } else if (!qaEnvironmentAllowed) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.QA_ENVIRONMENT_NOT_AUTHORIZED);
        } else {
          decision = buildDecision(base, true, PERSEO_REASON_CODES.QA_AUTOMATION_ALLOWED);
        }
      }

      if (!decision && config.mode === AUTOMATION_MODES.GLOBAL_PAUSED) {
        decision = buildDecision(base, false, PERSEO_REASON_CODES.GLOBAL_PAUSED);
      }

      if (!decision && config.mode === AUTOMATION_MODES.CANARY_ALLOWLIST) {
        if (config.automatedResponsesEnabled !== true || config.canaryEnabled !== true) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.CANARY_DISABLED);
        } else if (!config.canaryIds.length) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.CANARY_ALLOWLIST_EMPTY);
        } else if (!inCanary) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.CANARY_CONVERSATION_NOT_ALLOWED);
        } else if (base.followup && config.followupsEnabled !== true) {
          decision = buildDecision(base, false, PERSEO_REASON_CODES.FOLLOWUPS_DISABLED);
        } else {
          decision = buildDecision(base, true, PERSEO_REASON_CODES.CANARY_CONVERSATION_ALLOWED);
        }
      }
    }
  } catch (_error) {
    decision = buildDecision(base, false, PERSEO_REASON_CODES.POLICY_RESOLUTION_UNEXPECTED, {
      policyResolution: 'error',
    });
  }

  maybeLogPolicyDebug(decision);
  try {
    const telemetry = await recordAutomationDecision({ supabase, recordDecision, decision });
    if (!telemetry.ok && decision.allowAutomatedReply) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.TELEMETRY_WRITE_FAILED, {
        policyResolution: 'error',
      });
    }
  } catch (_error) {
    if (decision.allowAutomatedReply) {
      decision = buildDecision(base, false, PERSEO_REASON_CODES.TELEMETRY_WRITE_FAILED, {
        policyResolution: 'error',
      });
    }
  }
  return decision;
}

// Alias compatible: ya no conserva semántica permisiva legacy.
const resolveAutomatedReplyPolicy = resolveAutomationPolicy;

function isPerseoPolicyV2Enabled() {
  return true;
}

module.exports = {
  AUTOMATION_MODES,
  PERSEO_REASON_CODES,
  resolveAutomationPolicy,
  resolveAutomatedReplyPolicy,
  resolveEffectiveConfig,
  normalizePerseoAiControlFromRow,
  fetchAiConversationChannelSettingsRow,
  recordAutomationDecision,
  isPerseoPolicyV2Enabled,
};
