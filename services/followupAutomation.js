const { getDefaultAiState, normalizeAiState } = require('../conversation/aiState');
const { nowIso } = require('../utils/helpers');
const { ensurePropertyPautaAbandonedLead } = require('./leadAutomation');
const { resolvePautaPropertyCrmContext } = require('../conversation/pautaDetection');
const { isPautaConversation } = require('../conversation/pautaDetection');

const FOLLOWUP_STEPS = [
  {
    key: '1h',
    eventType: 'followup_1h_sent',
    minAgeMs: 60 * 60 * 1000,
    message: '¿Deseas continuar con tu búsqueda o puedo orientarte con algo más?',
  },
  {
    key: '6h',
    eventType: 'followup_6h_sent',
    minAgeMs: 6 * 60 * 60 * 1000,
    message: 'Puedo canalizar tu caso con un asesor de Luxetty cuando gustes para darle seguimiento.',
  },
  {
    key: '20h',
    eventType: 'followup_20h_sent',
    minAgeMs: 20 * 60 * 60 * 1000,
    message: '¿Deseas retomar tu búsqueda o prefieres dejarlo para más adelante?',
  },
];

const CLOSE_STEP = {
  key: '24h',
  eventType: 'conversation_closed_by_inactivity',
  minAgeMs: 24 * 60 * 60 * 1000,
  message:
    'Fue un gusto atenderte. Cierro esta conversación por ahora, pero cuando quieras retomarla solo escríbeme y con gusto te ayudo.',
};

  const WHATSAPP_FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT = 'followup_blocked_outside_24h_window';

function isClosedStatus(status) {
  return ['closed', 'inactive', 'resolved', 'archived'].includes(String(status || '').toLowerCase());
}

function isHumanOutbound(message) {
  if (!message || message.direction !== 'outbound') return false;
  return !['ai_agent', 'system'].includes(String(message.sender_type || '').toLowerCase());
}

function resetAiStateForClosedConversation(rawState) {
  const previous = normalizeAiState(rawState);
  return {
    ...getDefaultAiState(),
    lead_id: previous.lead_id || null,
    assigned_agent_profile_id: previous.assigned_agent_profile_id || null,
    last_completed_lead: previous.last_completed_lead || null,
    closed_by_inactivity_at: nowIso(),
    last_change_type: 'conversation_closed_by_inactivity',
    intent_version: (previous.intent_version || 1) + 1,
  };
}

async function saveConversationEvent(supabase, conversationId, type, payload = {}) {
  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: conversationId,
    type,
    payload,
  });

  if (error) {
    console.error('FOLLOWUP_EVENT_ERROR', { conversation_id: conversationId, type, error: error.message });
  }
}

async function loadConversationMessages(supabase, conversationId) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('id, direction, sender_type, message_type, message_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('FOLLOWUP_MESSAGES_ERROR', { conversation_id: conversationId, error: error.message });
    return [];
  }

  return data || [];
}

async function loadConversationEvents(supabase, conversationId) {
  const eventTypes = [
    ...FOLLOWUP_STEPS.map((step) => step.eventType),
    CLOSE_STEP.eventType,
    FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT,
  ];

  const { data, error } = await supabase
    .from('conversation_events')
    .select('type, created_at, payload')
    .eq('conversation_id', conversationId)
    .in('type', eventTypes);

  if (error) {
    console.error('FOLLOWUP_EVENTS_ERROR', { conversation_id: conversationId, error: error.message });
    return {
      sentEventTypes: new Set(),
      blockedSteps: new Set(),
    };
  }

  const sentEventTypes = new Set();
  const blockedSteps = new Set();

  for (const event of data || []) {
    if (event?.type === FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT) {
      const step = event?.payload?.step || null;
      if (step) blockedSteps.add(step);
      continue;
    }
    sentEventTypes.add(event.type);
  }

  return {
    sentEventTypes,
    blockedSteps,
  };
}

function normalizeEventState(eventState) {
  if (eventState instanceof Set) {
    return {
      sentEventTypes: eventState,
      blockedSteps: new Set(),
    };
  }

  if (!eventState || typeof eventState !== 'object') {
    return {
      sentEventTypes: new Set(),
      blockedSteps: new Set(),
    };
  }

  return {
    sentEventTypes:
      eventState.sentEventTypes instanceof Set ? eventState.sentEventTypes : new Set(),
    blockedSteps:
      eventState.blockedSteps instanceof Set ? eventState.blockedSteps : new Set(),
  };
}

function isInsideWhatsAppFreeTextWindow(ageMs) {
  return Number.isFinite(ageMs) && ageMs < WHATSAPP_FREE_TEXT_WINDOW_MS;
}

async function saveOutboundFollowupMessage(supabase, conversationId, messageText, stepKey) {
  const { error: messageError } = await supabase.from('conversation_messages').insert({
    conversation_id: conversationId,
    direction: 'outbound',
    sender_type: 'ai_agent',
    message_type: 'text',
    message_text: messageText,
    raw_payload: { automation: 'inactivity_followup', step: stepKey },
  });

  if (messageError) {
    console.error('FOLLOWUP_MESSAGE_SAVE_ERROR', {
      conversation_id: conversationId,
      step: stepKey,
      error: messageError.message,
    });
  }

  await supabase
    .from('conversations')
    .update({ last_message_at: nowIso(), updated_at: nowIso() })
    .eq('id', conversationId);
}

function getNextDueAction({ messages, sentEvents, now }) {
  if (!messages.length) return null;

  const eventState = normalizeEventState(sentEvents);
  const sentEventTypes = eventState.sentEventTypes;
  const blockedSteps = eventState.blockedSteps;

  const lastMessage = messages[messages.length - 1];
  const lastInbound = [...messages].reverse().find((message) => message.direction === 'inbound');
  const lastOutbound = [...messages].reverse().find((message) => message.direction === 'outbound');

  if (!lastInbound || !lastOutbound) return null;
  if (lastMessage.direction === 'inbound') return null;
  if (isHumanOutbound(lastOutbound)) return null;

  const lastInboundAt = new Date(lastInbound.created_at).getTime();
  if (!Number.isFinite(lastInboundAt)) return null;

  const ageMs = now.getTime() - lastInboundAt;
  if (ageMs < FOLLOWUP_STEPS[0].minAgeMs) return null;

  if (
    ageMs >= CLOSE_STEP.minAgeMs &&
    !sentEventTypes.has(CLOSE_STEP.eventType) &&
    !blockedSteps.has(CLOSE_STEP.key)
  ) {
    return { kind: 'close', step: CLOSE_STEP, ageMs };
  }

  for (const step of FOLLOWUP_STEPS) {
    if (
      ageMs >= step.minAgeMs &&
      !sentEventTypes.has(step.eventType) &&
      !blockedSteps.has(step.key)
    ) {
      return { kind: 'followup', step, ageMs };
    }
  }

  return null;
}

async function sendFollowup({ supabase, sendWhatsAppText, conversation, action, eventState = null }) {
  const phone = conversation.phone;
  const { step } = action;
  const normalizedEventState = normalizeEventState(eventState);

  if (normalizedEventState.blockedSteps.has(step.key)) {
    return { sent: false, reason: 'already_blocked_outside_24h_window', blockedOutside24h: true };
  }

  if (!isInsideWhatsAppFreeTextWindow(action.ageMs)) {
    await saveConversationEvent(supabase, conversation.id, FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT, {
      reason: 'outside_24h_window',
      step: step.key,
      age_ms: action.ageMs,
      source: 'inactivity_followup_job',
    });

    return {
      sent: false,
      reason: 'followup_blocked_outside_24h_window',
      blockedOutside24h: true,
    };
  }

  if (!phone) {
    await saveConversationEvent(supabase, conversation.id, `${step.eventType}_skipped`, {
      reason: 'missing_phone',
      step: step.key,
    });
    return { sent: false, reason: 'missing_phone' };
  }

  const sendResult = await sendWhatsAppText(phone, step.message, conversation, action);
  if (sendResult?.sent === false) {
    await saveConversationEvent(supabase, conversation.id, `${step.eventType}_skipped`, {
      reason: sendResult.reason_code || sendResult.reason || 'automation_policy_blocked',
      step: step.key,
      source: 'inactivity_followup_job',
    });
    return {
      sent: false,
      reason: sendResult.reason_code || sendResult.reason || 'automation_policy_blocked',
    };
  }
  if (!sendResult?.persistedOutbound) {
    await saveOutboundFollowupMessage(supabase, conversation.id, step.message, step.key);
  }
  await saveConversationEvent(supabase, conversation.id, step.eventType, {
    step: step.key,
    age_ms: action.ageMs,
    source: 'inactivity_followup_job',
  });

  return { sent: true, reason: step.eventType };
}

async function closeConversation({ supabase, sendWhatsAppText, conversation, action, eventState = null }) {
  const sendResult = await sendFollowup({
    supabase,
    sendWhatsAppText,
    conversation,
    action,
    eventState,
  });

  if (!sendResult.sent && !sendResult.blockedOutside24h) return sendResult;

  if (!sendResult.sent && sendResult.blockedOutside24h) {
    await saveConversationEvent(supabase, conversation.id, CLOSE_STEP.eventType, {
      step: CLOSE_STEP.key,
      age_ms: action.ageMs,
      source: 'inactivity_followup_job',
      free_text_message_sent: false,
      reason: 'outside_24h_window',
    });
  }

  const nextAiState = resetAiStateForClosedConversation(conversation.ai_state);
  const { error } = await supabase
    .from('conversations')
    .update({
      status: 'closed',
      follow_up_status: 'closed',
      next_action: null,
      next_action_due_at: null,
      ai_state: nextAiState,
      updated_at: nowIso(),
    })
    .eq('id', conversation.id);

  if (error) {
    console.error('FOLLOWUP_CLOSE_CONVERSATION_ERROR', {
      conversation_id: conversation.id,
      error: error.message,
    });
    return { sent: !!sendResult.sent, closed: false, reason: 'conversation_close_failed' };
  }

  return {
    sent: !!sendResult.sent,
    closed: true,
    reason: sendResult.sent ? CLOSE_STEP.eventType : 'closed_without_free_text_outside_24h_window',
    blockedOutside24h: !!sendResult.blockedOutside24h,
  };
}

async function runInactivityFollowups({
  supabase,
  sendWhatsAppText,
  authorizeAutomation = null,
  now = new Date(),
  limit = 50,
  logger = console,
}) {
  if (!supabase || !sendWhatsAppText) {
    throw new Error('supabase_and_sendWhatsAppText_required');
  }

  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('id, phone, status, channel, ai_state, assigned_agent_profile_id, contact_id, lead_id, last_message_at, updated_at')
    .eq('channel', 'whatsapp')
    .in('status', ['open', 'pending', 'escalated'])
    .order('last_message_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`followup_conversation_query_failed:${error.message}`);
  }

  const summary = {
    checked: 0,
    sent: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
  };

  for (const conversation of conversations || []) {
    summary.checked += 1;

    try {
      if (isClosedStatus(conversation.status)) {
        summary.skipped += 1;
        continue;
      }

      const messages = await loadConversationMessages(supabase, conversation.id);
      const eventState = await loadConversationEvents(supabase, conversation.id);
      const action = getNextDueAction({ messages, sentEvents: eventState, now });

      if (!action) {
        summary.skipped += 1;
        logger.info?.('FOLLOWUP_AUTOMATION_SKIPPED', {
          conversation_id: conversation.id,
          reason: 'no_due_action',
        });
        continue;
      }

      if (typeof authorizeAutomation !== 'function') {
        summary.skipped += 1;
        logger.info?.('FOLLOWUP_AUTOMATION_SKIPPED', {
          conversation_id: conversation.id,
          reason: 'automation_policy_missing',
        });
        continue;
      }

      const policy = await authorizeAutomation({ conversation, action });
      if (!policy?.allowAutomatedReply) {
        summary.skipped += 1;
        logger.info?.('FOLLOWUP_AUTOMATION_SKIPPED', {
          conversation_id: conversation.id,
          reason: policy?.reason_code || 'automation_policy_blocked',
        });
        continue;
      }

      // Conservar el contexto previo: algunos adaptadores de prueba mutan la fila al cerrar.
      const aiStateBeforeAction = normalizeAiState(conversation.ai_state);

      const result =
        action.kind === 'close'
          ? await closeConversation({ supabase, sendWhatsAppText, conversation, action, eventState })
          : await sendFollowup({ supabase, sendWhatsAppText, conversation, action, eventState });

      if (result.closed) {
        summary.closed += 1;

        const aiState = aiStateBeforeAction;
        const pautaProperty =
          isPautaConversation(aiState) || resolvePautaPropertyCrmContext(aiState).bypassEligible;

        if (pautaProperty) {
          await saveConversationEvent(supabase, conversation.id, 'property_pauta_abandoned', {
            step: CLOSE_STEP.key,
            age_ms: action.ageMs,
            source: 'inactivity_followup_job',
          });
          try {
            const abandonResult = await ensurePropertyPautaAbandonedLead({
              supabase,
              conversation,
              aiState,
              messages,
              logger,
            });
            if (abandonResult?.created) {
              await saveConversationEvent(supabase, conversation.id, 'followup_lead_recovered', {
                lead_id: abandonResult.leadId,
                assignment_strategy: abandonResult.assignmentStrategy || 'property_owner_agent',
                source: 'inactivity_followup_job',
              });
            }
          } catch (pautaErr) {
            logger.warn?.('PAUTA_PROPERTY_LEAD_CREATION_FAILED', {
              conversation_id: conversation.id,
              error: pautaErr?.message || String(pautaErr),
            });
          }
        }
      }
      if (result.sent) summary.sent += 1;
      if (!result.sent) summary.skipped += 1;

      logger.info?.('FOLLOWUP_AUTOMATION_RESULT', {
        conversation_id: conversation.id,
        action_kind: action.kind,
        step: action.step?.key,
        sent: !!result.sent,
        closed: !!result.closed,
        blocked_outside_24h_window: !!result.blockedOutside24h,
        reason: result.reason,
      });
    } catch (err) {
      summary.errors += 1;
      logger.warn('FOLLOWUP_AUTOMATION_ERROR', {
        conversation_id: conversation.id,
        error: err?.message || String(err),
      });
    }
  }

  return summary;
}

module.exports = {
  FOLLOWUP_STEPS,
  CLOSE_STEP,
  WHATSAPP_FREE_TEXT_WINDOW_MS,
  FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT,
  isInsideWhatsAppFreeTextWindow,
  isPautaConversation,
  getNextDueAction,
  resetAiStateForClosedConversation,
  runInactivityFollowups,
};
