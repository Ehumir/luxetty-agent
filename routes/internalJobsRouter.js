'use strict';

const express = require('express');
const { supabase } = require('../services/supabaseService');
const { sendPerseoAutomatedWhatsApp } = require('../services/perseoAutomatedWhatsApp');
const { saveOutboundMessages } = require('../services/saveOutboundMessages');
const { runInactivityFollowups } = require('../services/followupAutomation');
const { resolveAutomationPolicy } = require('../conversation/perseoGatekeeper');
const router = express.Router();

function isFollowupsJobEnabled() {
  return process.env.PERSEO_FOLLOWUPS_ENABLED === 'true';
}

async function saveConversationEventForJob(conversationId, type, payload = {}) {
  if (!conversationId) return;
  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: conversationId,
    type,
    payload,
  });
  if (error) {
    console.error('FOLLOWUP_JOB_CONVERSATION_EVENT_ERROR', {
      conversation_id: conversationId,
      type,
      error: error.message,
    });
  }
}

async function sendWhatsAppTextForFollowup(phone, messageText, conversation = null, action = null) {
  const conversationId = conversation?.id || null;
  const stepKey = action?.step?.eventType || action?.step?.key || 'unknown';
  const rawPayload = {
    perseo_metadata: { response_source: 'inactivity_followup_job' },
    automation: 'inactivity_followup',
  };

  const result = await sendPerseoAutomatedWhatsApp({
    channel: 'ia',
    to: phone,
    messages: [messageText],
    conversationId,
    messageId: `followup:${conversationId}:${stepKey}`,
    conversationRow: conversation,
    route: 'followup',
    requestKind: 'followup',
    supabase,
    rawPayload,
    saveOutboundMessages: (args) => saveOutboundMessages(supabase, args),
    saveConversationEvent: saveConversationEventForJob,
    logEvent: (event, payload) => {
      console.info('FOLLOWUP_JOB_OUTBOUND', { event, ...payload });
    },
  });

  return { ...result, persistedOutbound: result.sent === true };
}

router.post('/inactivity-followups', async (req, res) => {
  const startedAt = Date.now();

  if (!isFollowupsJobEnabled()) {
    return res.json({
      ok: true,
      skipped: true,
      reason: 'PERSEO_FOLLOWUPS_ENABLED!=true',
    });
  }

  try {
    const limit = Number(process.env.PERSEO_FOLLOWUP_BATCH_LIMIT || req.body?.limit || 100);
    const summary = await runInactivityFollowups({
      supabase,
      sendWhatsAppText: sendWhatsAppTextForFollowup,
      authorizeAutomation: ({ conversation, action }) =>
        resolveAutomationPolicy({
          supabase,
          conversationRow: conversation,
          conversationId: conversation.id,
          messageId: `followup:${conversation.id}:${action?.step?.eventType || action?.step?.key || 'unknown'}`,
          channel: 'ia',
          route: 'followup',
          requestKind: 'followup',
        }),
      limit: Number.isFinite(limit) ? limit : 100,
      logger: console,
    });

    const payload = {
      ...summary,
      duration_ms: Date.now() - startedAt,
      source: 'inactivity_followup_job',
    };

    console.info('FOLLOWUP_JOB_SUMMARY', payload);

    return res.json({ ok: true, summary: payload });
  } catch (err) {
    console.error('FOLLOWUP_JOB_FATAL', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

module.exports = router;
