'use strict';

/**
 * Wrapper outbound único de PERSEO hacia WhatsApp Graph /messages.
 *
 * Toda respuesta automatizada (texto o template) debe pasar por este módulo para:
 * - revalidar takeover humano inmediatamente antes de Graph;
 * - mantener fail-closed ante errores de policy;
 * - persistir el outbound en el hilo ATENA;
 * - exigir wamid real antes de considerar un envío exitoso.
 */

const axios = require('axios');
const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, GRAPH_API_VERSION } = require('../config/env');
const { normalizeOutboundMessages } = require('../utils/helpers');
const {
  PERSEO_REASON_CODES,
  resolveAutomatedReplyPolicy,
} = require('../conversation/perseoGatekeeper');

const EVENT_AUTOMATION_BLOCKED = 'ai_auto_response_skipped_human_attention';

function graphApiVersionPath() {
  const v = GRAPH_API_VERSION || 'v19.0';
  return v.startsWith('v') ? v : `v${v}`;
}

function getDefaultPolicyClient() {
  try {
    return require('./supabaseService').supabase;
  } catch (_err) {
    return null;
  }
}

/** Único axios.post hacia Graph messages en runtime PERSEO. */
async function graphPostWhatsAppPayload(to, payload) {
  const version = graphApiVersionPath();
  return axios.post(
    `https://graph.facebook.com/${version}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, ...payload },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function graphPostWhatsAppText(to, body) {
  return graphPostWhatsAppPayload(to, { type: 'text', text: { body } });
}

async function graphPostWhatsAppTemplate(to, { name, language = 'es_MX', components = [] } = {}) {
  if (!name || !String(name).trim()) {
    const err = new Error('WHATSAPP_TEMPLATE_NAME_REQUIRED');
    err.code = 'WHATSAPP_TEMPLATE_NAME_REQUIRED';
    throw err;
  }
  return graphPostWhatsAppPayload(to, {
    type: 'template',
    template: {
      name: String(name).trim(),
      language: { code: String(language || 'es_MX').trim() || 'es_MX' },
      ...(Array.isArray(components) && components.length ? { components } : {}),
    },
  });
}

function extractGraphWamids(response) {
  const messages = response?.data?.messages;
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => (m?.id == null ? '' : String(m.id).trim()))
    .filter(Boolean);
}

function requireGraphWamid(response) {
  const wamids = extractGraphWamids(response);
  if (!wamids.length) {
    const err = new Error('WHATSAPP_GRAPH_MISSING_WAMID');
    err.code = 'WHATSAPP_GRAPH_MISSING_WAMID';
    err.graph_response = response?.data ?? null;
    throw err;
  }
  return wamids;
}

function enrichGraphAttemptError(error, persisted, deliveryKind) {
  const err = error instanceof Error ? error : new Error(String(error || 'WHATSAPP_GRAPH_FAILURE'));
  err.graphAttempted = true;
  err.persistedRows = Array.isArray(persisted?.rows) ? persisted.rows : [];
  err.persistedOutbound = Array.isArray(persisted?.outbound) ? persisted.outbound : [];
  err.deliveryKind = deliveryKind;
  return err;
}

async function revalidateAutomatedReplyPolicy({ conversationId, to, initialPolicy, client }) {
  const effectiveClient = client || getDefaultPolicyClient();
  if (!conversationId || !effectiveClient) {
    return {
      policyResolution: 'error',
      allowAutomatedReply: false,
      allowQaBypass: Boolean(initialPolicy?.allowQaBypass),
      effectiveHumanLock: true,
      reason_code: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED,
    };
  }

  try {
    const { data: conversationRow, error } = await effectiveClient
      .from('conversations')
      .select('id, ai_state')
      .eq('id', conversationId)
      .maybeSingle();

    if (error || !conversationRow) {
      return {
        policyResolution: 'error',
        allowAutomatedReply: false,
        allowQaBypass: Boolean(initialPolicy?.allowQaBypass),
        effectiveHumanLock: true,
        reason_code: PERSEO_REASON_CODES.POLICY_SETTINGS_READ_FAILED,
      };
    }

    return resolveAutomatedReplyPolicy({
      supabase: effectiveClient,
      conversationRow,
      from: to,
    });
  } catch (_err) {
    return {
      policyResolution: 'error',
      allowAutomatedReply: false,
      allowQaBypass: Boolean(initialPolicy?.allowQaBypass),
      effectiveHumanLock: true,
      reason_code: PERSEO_REASON_CODES.POLICY_RESOLUTION_UNEXPECTED,
    };
  }
}

async function resolveOutboundPolicy({
  channel,
  to,
  conversationId,
  policy,
  policyClient,
  saveConversationEvent,
  logEvent,
}) {
  let effectivePolicy = policy;
  if (channel === 'ia') {
    effectivePolicy = await revalidateAutomatedReplyPolicy({
      conversationId,
      to,
      initialPolicy: policy,
      client: policyClient,
    });
  }

  if (channel === 'ia' && !effectivePolicy.allowAutomatedReply) {
    if (typeof logEvent === 'function') {
      logEvent('perseo_automation_blocked', {
        conversation_id: conversationId,
        reason_code: effectivePolicy.reason_code,
        policy_resolution: effectivePolicy.policyResolution,
        channel: 'ia',
        revalidated_before_graph: true,
      });
    }
    if (typeof saveConversationEvent === 'function') {
      await saveConversationEvent(conversationId, EVENT_AUTOMATION_BLOCKED, {
        reason_code: effectivePolicy.reason_code,
        policy_resolution: effectivePolicy.policyResolution,
        channel: 'ia',
        via: 'outbound_wrapper_revalidation',
      });
    }
    return { allowed: false, policy: effectivePolicy };
  }

  if (channel === 'qa' && !policy?.allowQaBypass) {
    if (typeof logEvent === 'function') {
      logEvent('perseo_qa_outbound_denied', {
        conversation_id: conversationId,
        reason_code: PERSEO_REASON_CODES.QA_OUTBOUND_NOT_ALLOWLISTED,
      });
    }
    if (typeof saveConversationEvent === 'function') {
      await saveConversationEvent(conversationId, 'qa_outbound_denied_not_allowlist', {
        conversation_id: conversationId,
      });
    }
    return {
      allowed: false,
      policy: { reason_code: PERSEO_REASON_CODES.QA_OUTBOUND_NOT_ALLOWLISTED },
    };
  }

  return { allowed: true, policy: effectivePolicy };
}

function assertNotArgos({ argosMode, rawPayload, policy, conversationId, channel, logEvent }) {
  if (argosMode === true || rawPayload?.argosMode === true || policy?.argosMode === true) {
    const err = new Error('ARGOS_WHATSAPP_BLOCKED');
    err.code = 'ARGOS_WHATSAPP_BLOCKED';
    if (typeof logEvent === 'function') {
      logEvent('argos_whatsapp_blocked', {
        conversation_id: conversationId,
        channel,
        reason: 'argos_mode',
      });
    }
    throw err;
  }
}

async function sendPerseoAutomatedWhatsApp({
  channel,
  to,
  messages,
  conversationId,
  rawPayload = {},
  policy,
  saveOutboundMessages,
  saveConversationEvent,
  logEvent,
  argosMode = false,
  policyClient,
}) {
  assertNotArgos({ argosMode, rawPayload, policy, conversationId, channel, logEvent });

  const outbound = normalizeOutboundMessages(messages);
  if (!outbound.length) {
    return { sent: false, reason_code: PERSEO_REASON_CODES.OUTBOUND_MESSAGES_EMPTY };
  }

  const gate = await resolveOutboundPolicy({
    channel,
    to,
    conversationId,
    policy,
    policyClient,
    saveConversationEvent,
    logEvent,
  });
  if (!gate.allowed) {
    return { sent: false, reason_code: gate.policy?.reason_code };
  }

  const persisted = await saveOutboundMessages({
    conversationId,
    messages: outbound,
    rawPayload,
  });

  if (typeof logEvent === 'function') {
    logEvent('perseo_outbound_wrapper_persisted', {
      conversation_id: conversationId,
      channel,
      fragments: outbound.length,
      policy_revalidated_before_graph: channel === 'ia',
    });
  }

  const wamids = [];
  try {
    for (const body of outbound) {
      const response = await graphPostWhatsAppText(to, body);
      wamids.push(...requireGraphWamid(response));
    }
  } catch (err) {
    throw enrichGraphAttemptError(err, persisted, 'text');
  }

  if (typeof logEvent === 'function') {
    logEvent('perseo_wrapper_outbound_sent', {
      conversation_id: conversationId,
      channel,
      fragments: outbound.length,
      wamids_count: wamids.length,
      policy_revalidated_before_graph: channel === 'ia',
    });
  }

  return {
    sent: true,
    wamid: wamids[0] || null,
    wamids,
    outbound: persisted?.outbound ?? outbound,
    rows: persisted?.rows ?? [],
  };
}

async function sendPerseoAutomatedWhatsAppTemplate({
  channel = 'ia',
  to,
  conversationId,
  templateName,
  templateLanguage = 'es_MX',
  templateComponents = [],
  displayText,
  rawPayload = {},
  policy,
  saveOutboundMessages,
  saveConversationEvent,
  logEvent,
  argosMode = false,
  policyClient,
}) {
  assertNotArgos({ argosMode, rawPayload, policy, conversationId, channel, logEvent });

  if (!templateName || !String(templateName).trim()) {
    return { sent: false, reason_code: 'whatsapp_template_not_configured' };
  }
  const persistedText = String(displayText || '').trim() || `[Plantilla WhatsApp: ${String(templateName).trim()}]`;

  const gate = await resolveOutboundPolicy({
    channel,
    to,
    conversationId,
    policy,
    policyClient,
    saveConversationEvent,
    logEvent,
  });
  if (!gate.allowed) {
    return { sent: false, reason_code: gate.policy?.reason_code };
  }

  const persisted = await saveOutboundMessages({
    conversationId,
    messages: [persistedText],
    rawPayload: {
      ...rawPayload,
      whatsapp_message_type: 'template',
      whatsapp_template_name: String(templateName).trim(),
      whatsapp_template_language: templateLanguage,
    },
  });

  let wamids;
  try {
    const response = await graphPostWhatsAppTemplate(to, {
      name: templateName,
      language: templateLanguage,
      components: templateComponents,
    });
    wamids = requireGraphWamid(response);
  } catch (err) {
    throw enrichGraphAttemptError(err, persisted, 'template');
  }

  if (typeof logEvent === 'function') {
    logEvent('perseo_template_outbound_sent', {
      conversation_id: conversationId,
      channel,
      template_name: String(templateName).trim(),
      wamids_count: wamids.length,
      policy_revalidated_before_graph: channel === 'ia',
    });
  }

  return {
    sent: true,
    wamid: wamids[0] || null,
    wamids,
    outbound: persisted?.outbound ?? [persistedText],
    rows: persisted?.rows ?? [],
  };
}

module.exports = {
  sendPerseoAutomatedWhatsApp,
  sendPerseoAutomatedWhatsAppTemplate,
  graphPostWhatsAppText,
  graphPostWhatsAppTemplate,
  graphPostWhatsAppPayload,
  extractGraphWamids,
  requireGraphWamid,
  enrichGraphAttemptError,
  revalidateAutomatedReplyPolicy,
  getDefaultPolicyClient,
};
