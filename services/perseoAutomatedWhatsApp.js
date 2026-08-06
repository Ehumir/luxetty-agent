'use strict';

/**
 * Sprint 2 — Wrapper outbound obligatorio (WhatsApp Graph /messages).
 *
 * Toda respuesta automatizada del webhook PERSEO debe salir por `sendPerseoAutomatedWhatsApp`.
 * No añadir `axios.post(.../messages)` en otros módulos de runtime; validar con:
 *   npm run validate:graph-outbound
 *
 * Webhook, QA y jobs de inactividad deben reevaluar la misma política aquí justo antes
 * de persistir y enviar.
 */

const axios = require('axios');
const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, GRAPH_API_VERSION } = require('../config/env');
const { normalizeOutboundMessages } = require('../utils/helpers');
const { PERSEO_REASON_CODES, resolveAutomationPolicy } = require('../conversation/perseoGatekeeper');

const EVENT_AUTOMATION_BLOCKED = 'ai_auto_response_skipped_human_attention';

function graphApiVersionPath() {
  const v = GRAPH_API_VERSION || 'v19.0';
  return v.startsWith('v') ? v : `v${v}`;
}

/** Único axios.post hacia Graph messages en el path webhook PERSEO. */
async function graphPostWhatsAppText(to, body) {
  const version = graphApiVersionPath();
  return axios.post(
    `https://graph.facebook.com/${version}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * @param {object} args
 * @param {'ia'|'qa'} args.channel
 * @param {string} args.to
 * @param {string|string[]|null|undefined} args.messages
 * @param {string|null} args.conversationId
 * @param {object} [args.rawPayload]
 * @param {import('../conversation/perseoGatekeeper').AutomatedReplyPolicy} args.policy
 * @param {function} args.saveOutboundMessages — misma firma que en index.js
 * @param {function} [args.saveConversationEvent]
 * @param {function} [args.logEvent]
 */
async function sendPerseoAutomatedWhatsApp({
  channel,
  to,
  messages,
  conversationId,
  messageId,
  conversationRow = null,
  route,
  requestKind = 'direct',
  qaSession = null,
  supabase = null,
  rawPayload = {},
  saveOutboundMessages,
  saveConversationEvent,
  logEvent,
  argosMode = false,
  env = process.env,
  globalPolicyRow = null,
  recordDecision = null,
  checkMessageProcessed = null,
  resolvePolicy = resolveAutomationPolicy,
  sendTransport = graphPostWhatsAppText,
}) {
  if (argosMode === true || rawPayload?.argosMode === true) {
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

  const outbound = normalizeOutboundMessages(messages);
  if (!outbound.length) {
    return { sent: false, reason_code: PERSEO_REASON_CODES.OUTBOUND_MESSAGES_EMPTY };
  }

  let alreadyProcessed = false;
  if (typeof checkMessageProcessed === 'function') {
    alreadyProcessed = await checkMessageProcessed({ conversationId, messageId, requestKind });
  } else if (supabase && conversationId && messageId) {
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .contains('raw_payload', { perseo_automation: { message_id: messageId } })
      .limit(1);
    alreadyProcessed = !error && Array.isArray(data) && data.length > 0;
    if (error) alreadyProcessed = true;
  }

  const policy = await resolvePolicy({
    supabase,
    conversationRow,
    conversationId,
    messageId,
    from: to,
    channel,
    route,
    requestKind,
    qaSession,
    messageAlreadyProcessed: alreadyProcessed,
    env,
    globalPolicyRow,
    recordDecision,
  });

  if (!policy.allowAutomatedReply) {
    if (typeof logEvent === 'function') {
      logEvent('perseo_automation_blocked', {
        conversation_id: conversationId,
        reason_code: policy.reason_code,
        policy_resolution: policy.policyResolution,
        channel,
        route,
      });
    }
    if (typeof saveConversationEvent === 'function') {
      await saveConversationEvent(conversationId, EVENT_AUTOMATION_BLOCKED, {
        reason_code: policy.reason_code,
        policy_resolution: policy.policyResolution,
        channel,
        route,
        via: 'outbound_wrapper',
      });
    }
    return { sent: false, reason_code: policy.reason_code };
  }

  const persisted = await saveOutboundMessages({
    conversationId,
    messages: outbound,
    rawPayload: {
      ...rawPayload,
      perseo_automation: {
        ...(rawPayload?.perseo_automation || {}),
        message_id: messageId,
        route,
        request_kind: requestKind,
        decision: policy.decision,
        reason_code: policy.reason_code,
      },
    },
  });

  if (persisted?.duplicate === true) {
    const duplicatePolicy = await resolvePolicy({
      supabase,
      conversationRow,
      conversationId,
      messageId,
      from: to,
      channel,
      route,
      requestKind,
      qaSession,
      messageAlreadyProcessed: true,
      env,
      globalPolicyRow,
      recordDecision,
    });
    if (typeof logEvent === 'function') {
      logEvent('perseo_outbound_duplicate_blocked', {
        conversation_id: conversationId,
        message_id: messageId,
        route,
      });
    }
    return { sent: false, reason_code: duplicatePolicy.reason_code, duplicate: true };
  }

  if (typeof logEvent === 'function') {
    logEvent('perseo_outbound_wrapper_persisted', {
      conversation_id: conversationId,
      channel,
      fragments: outbound.length,
    });
  }

  for (const body of outbound) {
    await sendTransport(to, body);
  }

  if (typeof logEvent === 'function') {
    logEvent('perseo_wrapper_outbound_sent', {
      conversation_id: conversationId,
      channel,
      fragments: outbound.length,
    });
  }

  return {
    sent: true,
    outbound: persisted?.outbound ?? outbound,
    rows: persisted?.rows ?? [],
  };
}

module.exports = {
  sendPerseoAutomatedWhatsApp,
  graphPostWhatsAppText,
};
