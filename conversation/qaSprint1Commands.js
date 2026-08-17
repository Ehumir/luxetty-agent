'use strict';

/**
 * Sprint 1 — Comandos QA seguros (!reset, !resetcrm, !state, !close, !leadcheck)
 * y respuestas a plantillas QA del Centro de Activación.
 * Sin OpenAI, sin CRM, sin búsqueda de propiedades en estos turnos.
 */

function normalizeQaInput(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .trim();
}

function normalizePhoneForAllowlist(phone) {
  return String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
}

function maskPhoneForLog(phone) {
  const value = normalizePhoneForAllowlist(phone);
  if (!value) return null;
  if (value.length <= 4) return `***${value}`;
  return `***${value.slice(-4)}`;
}

function sameQaPhone(left, right) {
  const a = normalizePhoneForAllowlist(left);
  const b = normalizePhoneForAllowlist(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Meta puede entregar MX como 521XXXXXXXXXX y la allowlist como 52XXXXXXXXXX.
  // Para QA autorizado, el número nacional de 10 dígitos debe coincidir exactamente.
  return a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10);
}

function extractQaTemplateReplyContext(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const message = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || typeof message !== 'object') return null;
  const contextWamid = message?.context?.id != null ? String(message.context.id).trim() : '';
  if (!contextWamid) return null;

  const type = String(message.type || '').trim();
  let replyText = '';
  let replyPayload = '';
  let interactionType = 'text_reply';

  if (type === 'button') {
    replyText = String(message?.button?.text || '').trim();
    replyPayload = String(message?.button?.payload || '').trim();
    interactionType = 'button_reply';
  } else if (type === 'interactive') {
    const button = message?.interactive?.button_reply;
    const list = message?.interactive?.list_reply;
    replyText = String(button?.title || list?.title || button?.id || list?.id || '').trim();
    replyPayload = String(button?.id || list?.id || '').trim();
    interactionType = 'interactive_reply';
  } else {
    replyText = String(message?.text?.body || '').trim();
    interactionType = 'text_reply';
  }

  return { contextWamid, replyText, replyPayload, interactionType };
}

function classifyQaTemplateReply(text, payload = '') {
  const value = normalizeQaInput(text || payload).toLowerCase();
  if (value === 'continuar solicitud' || value === 'continuar' || value === 'sí' || value === 'si') {
    return { recognized: true, action: 'continue' };
  }
  if (value === 'cerrar solicitud' || value === 'cerrar' || value === 'no') {
    return { recognized: true, action: 'close' };
  }
  return { recognized: Boolean(value), action: 'other' };
}

async function maybeHandleFollowupTemplateQaReply({
  supabase,
  metaMessageId,
  from,
  conversationId,
  text,
  nowIso,
  saveEventFn,
  logEvent,
}) {
  if (!supabase || !metaMessageId) return null;

  try {
    const { data: inboundRow, error: inboundError } = await supabase
      .from('conversation_messages')
      .select('id, raw_payload')
      .eq('direction', 'inbound')
      .eq('meta_message_id', metaMessageId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (inboundError || !inboundRow) return null;
    const context = extractQaTemplateReplyContext(inboundRow.raw_payload);
    if (!context?.contextWamid) return null;

    const { data: attempt, error: attemptError } = await supabase
      .from('followup_template_test_attempts')
      .select('id, template_name, test_number_id, provider_message_id, status')
      .eq('provider_message_id', context.contextWamid)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // No es una respuesta a un envío QA del Centro de Activación.
    if (attemptError || !attempt) return null;

    const { data: qaNumber, error: numberError } = await supabase
      .from('followup_test_numbers')
      .select('id, phone_normalized, is_active')
      .eq('id', attempt.test_number_id)
      .maybeSingle();

    const phoneMatches = !numberError && qaNumber?.is_active === true && sameQaPhone(from, qaNumber.phone_normalized);
    const classification = classifyQaTemplateReply(context.replyText || text, context.replyPayload);

    // Si el WAMID sí pertenece a una prueba, el turno se aísla SIEMPRE del CRM.
    // Un mismatch de teléfono se considera sospechoso y falla cerrado.
    const interaction = {
      attempt_id: attempt.id,
      template_name: attempt.template_name,
      test_number_id: attempt.test_number_id,
      conversation_id: conversationId || null,
      inbound_message_id: inboundRow.id || null,
      meta_message_id: metaMessageId,
      context_wamid: context.contextWamid,
      interaction_type: context.interactionType,
      reply_text: context.replyText || text || null,
      reply_payload: context.replyPayload || null,
      recognized: phoneMatches && classification.recognized,
      recognized_action: phoneMatches ? classification.action : 'other',
      created_at: nowIso(),
    };

    const { error: interactionError } = await supabase
      .from('followup_template_test_interactions')
      .upsert(interaction, { onConflict: 'meta_message_id', ignoreDuplicates: true });

    if (interactionError) {
      console.warn('followup_template_qa_interaction_persist_failed', {
        conversation_id: conversationId || null,
        template_name: attempt.template_name,
        error: interactionError.message,
      });
    }

    const audit = {
      template_name: attempt.template_name,
      attempt_id: attempt.id,
      conversation_id: conversationId || null,
      inbound_message_id: inboundRow.id || null,
      meta_message_id: metaMessageId,
      context_wamid: context.contextWamid,
      from_masked: maskPhoneForLog(from),
      phone_match: phoneMatches,
      recognized_action: phoneMatches ? classification.action : 'blocked_phone_mismatch',
      source: 'followup_activation_center_qa',
    };

    if (typeof saveEventFn === 'function' && conversationId) {
      await saveEventFn(
        conversationId,
        phoneMatches ? 'followup_template_qa_reply_isolated' : 'followup_template_qa_reply_phone_mismatch',
        audit,
      );
    }
    if (typeof logEvent === 'function') {
      logEvent('followup_template_qa_reply_isolated', audit);
    }

    return {
      handled: true,
      messages: [],
      qaTemplateReply: true,
      qaTemplateReplyAudit: audit,
    };
  } catch (err) {
    // Si todavía no podemos demostrar que el context WAMID es QA, no secuestramos
    // mensajes productivos. El error se registra para diagnóstico.
    console.warn('followup_template_qa_reply_detection_failed', {
      conversation_id: conversationId || null,
      meta_message_id: metaMessageId || null,
      error: String(err?.message || err),
    });
    return null;
  }
}

const { RESET_CONVERSATION_REPLY: REPLY_RESET } = require('./v3/composer/humanCopyV1');
const REPLY_CLOSE = 'Listo, cerré esta conversación de prueba.';

/**
 * Allowlist QA Sprint 1 — misma regla que comandos QA legacy (`qaCommands.isQaCommandAllowed`):
 * números internos MX + `QA_ALLOWED_WHATSAPP_NUMBERS`. Carga perezosa para evitar dependencia circular.
 * @param {string} from
 * @returns {boolean}
 */
function isSprint1QaTesterPhone(from) {
  const { isQaCommandAllowed } = require('./qaCommands');
  return isQaCommandAllowed(from);
}

/**
 * Comandos exactos (tras normalizeQaInput), case-insensitive en el comando.
 * @returns {'reset'|'resetcrm'|'state'|'close'|'leadcheck'|null}
 */
function parseSprint1StrictCommand(text) {
  const raw = normalizeQaInput(text);
  if (raw.length > 32) return null;
  const t = raw.toLowerCase();
  if (t === '!reset') return 'reset';
  if (t === '!resetcrm') return 'resetcrm';
  if (t === '!state') return 'state';
  if (t === '!close') return 'close';
  if (t === '!leadcheck') return 'leadcheck';
  return null;
}

function formatStateSummary(conversationRow, aiState) {
  const safe = (v) => (v == null || v === '' ? '(vacío)' : String(v));
  const boolSafe = (v) => (v === true ? 'true' : v === false ? 'false' : safe(v));
  const lines = [
    `lead_flow: ${safe(aiState?.lead_flow)}`,
    `operation_type: ${safe(aiState?.operation_type)}`,
    `full_name: ${safe(aiState?.full_name)}`,
    `awaiting_field: ${safe(aiState?.awaiting_field)}`,
    `location_text: ${safe(aiState?.location_text)}`,
    `property_type: ${safe(aiState?.property_type)}`,
    `occupancy_status: ${safe(aiState?.occupancy_status)}`,
    `expected_price: ${safe(aiState?.expected_price)}`,
    `conversation_stage: ${safe(aiState?.conversation_stage)}`,
    `identity_state: ${safe(aiState?.identity_state)}`,
    `conversation_goal: ${safe(aiState?.conversation_goal)}`,
    `goal_locked: ${boolSafe(aiState?.conversation_goal_locked)}`,
    `last_question: ${safe(aiState?.last_question)}`,
    `budget_max: ${safe(aiState?.budget_max)}`,
    `bedrooms: ${safe(aiState?.bedrooms)}`,
    `qualification_complete: ${boolSafe(aiState?.qualification_complete)}`,
    `advisor_contact_consent: ${safe(aiState?.advisor_contact_consent)}`,
    `handoff_stage: ${safe(aiState?.handoff_stage)}`,
    `crm_payload_ready: ${boolSafe(aiState?.crm_payload_ready)}`,
    `qualification_missing_slots: ${safe(Array.isArray(aiState?.qualification_missing_slots) ? aiState.qualification_missing_slots.join(',') : aiState?.qualification_missing_slots)}`,
    `must_have_features: ${safe(Array.isArray(aiState?.must_have_features) ? aiState.must_have_features.join(',') : aiState?.must_have_features)}`,
    `property_code: ${safe(aiState?.property_code)}`,
    `property_specific_intent: ${safe(aiState?.property_specific_intent)}`,
    `interested_property_id: ${safe(aiState?.interested_property_id)}`,
    `contact_id: ${safe(conversationRow?.contact_id)}`,
    `lead_id: ${safe(conversationRow?.lead_id)}`,
  ];
  return `Estado (QA):\n${lines.join('\n')}`;
}

async function fetchLeadSafeSummary(supabase, leadId) {
  if (!supabase || !leadId) return null;
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('lead_type, assigned_agent_profile_id')
      .eq('id', leadId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function formatLeadcheckReply(conversationRow, leadSummary) {
  const hasContact = !!conversationRow?.contact_id;
  const hasLead = !!conversationRow?.lead_id;
  const parts = [
    `contacto vinculado: ${hasContact ? 'sí' : 'no'}`,
    `lead vinculado: ${hasLead ? 'sí' : 'no'}`,
  ];
  if (leadSummary?.lead_type != null) parts.push(`lead_type: ${leadSummary.lead_type}`);
  if (leadSummary?.assigned_agent_profile_id != null) {
    parts.push(`assigned_agent_profile_id: ${leadSummary.assigned_agent_profile_id}`);
  }
  return `Lead check (QA):\n${parts.join('\n')}`;
}

/**
 * @param {object} deps
 * @returns {Promise<null | { unauthorized: true, payload: object } | { handled: true, messages: string[], nextAiState?: object, conversationUpdate?: object }>}
 */
async function processSprint1QaInbound(deps) {
  const {
    text,
    from,
    conversationId,
    conversationRow,
    metaMessageId,
    supabase,
    getDefaultAiState,
    normalizeAiState,
    nowIso,
    saveEventFn,
    saveStateFn,
    updateConversationFn,
    conversations,
    isQaExecutionAllowed,
    getV3Session,
    setV3Session,
    logEvent,
  } = deps;

  // Antes de interpretar intención o ejecutar CRM, aislar respuestas que referencian
  // el WAMID de una prueba enviada desde Seguimiento → Centro de Activación.
  const templateQa = await maybeHandleFollowupTemplateQaReply({
    supabase,
    metaMessageId,
    from,
    conversationId,
    text,
    nowIso,
    saveEventFn,
    logEvent,
  });
  if (templateQa?.handled) return templateQa;

  const cmd = parseSprint1StrictCommand(text);
  if (!cmd) return null;

  const auditPhone = maskPhoneForLog(from);

  const allowed =
    typeof isQaExecutionAllowed === 'function' ? isQaExecutionAllowed(from) : isSprint1QaTesterPhone(from);
  if (!allowed) {
    return {
      unauthorized: true,
      payload: {
        command: cmd,
        from_masked: auditPhone,
        meta_message_id: metaMessageId || null,
        conversation_id: conversationId || null,
      },
    };
  }

  if (!conversationId) {
    return { handled: true, messages: ['No hay conversación activa para este comando QA.'] };
  }

  const baseAudit = {
    command: cmd,
    from_masked: auditPhone,
    meta_message_id: metaMessageId || null,
    conversation_id: conversationId,
    ts: nowIso(),
  };

  if (cmd === 'resetcrm') {
    const { executeQaCrmReset } = require('./v3/qa/qaCrmReset');
    const crmReset = await executeQaCrmReset({
      phone: from,
      conversationId,
      conversationRow,
      qaCommandsAllowed: allowed,
      saveStateFn,
      updateConversationFn,
      supabase,
      normalizeAiState,
      getV3Session,
      setV3Session,
      saveEventFn,
      nowIso,
      logEvent,
    });
    return {
      handled: true,
      messages: [crmReset.message],
      nextAiState: crmReset.nextAiState,
      conversationUpdate: crmReset.conversationUpdate,
    };
  }

  if (cmd === 'reset') {
    const fresh = getDefaultAiState();
    if (conversations && typeof conversations.set === 'function') {
      conversations.set(from, []);
    }
    await saveStateFn(conversationId, fresh);
    await saveEventFn(conversationId, 'qa_reset_executed', {
      ...baseAudit,
      action: 'ai_state_reset_to_default',
    });
    return { handled: true, messages: [REPLY_RESET], nextAiState: fresh };
  }

  if (cmd === 'state') {
    let aiState = normalizeAiState(conversationRow?.ai_state);
    if (typeof getV3Session === 'function') {
      try {
        const { mergeLegacyAiStateWithV3 } = require('./v3/state/v3ToLegacyAiState');
        const v3Session = getV3Session(conversationId);
        if (v3Session) {
          aiState = normalizeAiState(mergeLegacyAiStateWithV3(aiState, v3Session));
        }
      } catch {
        // QA state sigue con legacy si el bridge V3 no está disponible
      }
    }
    const msg = formatStateSummary(conversationRow, aiState);
    await saveEventFn(conversationId, 'qa_state_viewed', { ...baseAudit });
    return { handled: true, messages: [msg] };
  }

  if (cmd === 'close') {
    const fresh = getDefaultAiState();
    await saveStateFn(conversationId, fresh);
    if (updateConversationFn && supabase) {
      await updateConversationFn(supabase, conversationId, {
        status: 'closed',
        ai_state: fresh,
        updated_at: nowIso(),
      });
    }
    await saveEventFn(conversationId, 'qa_conversation_closed', { ...baseAudit });
    return { handled: true, messages: [REPLY_CLOSE], nextAiState: fresh, conversationUpdate: { status: 'closed' } };
  }

  if (cmd === 'leadcheck') {
    const leadSummary = await fetchLeadSafeSummary(supabase, conversationRow?.lead_id);
    const msg = formatLeadcheckReply(conversationRow, leadSummary);
    await saveEventFn(conversationId, 'qa_leadcheck_viewed', { ...baseAudit });
    return { handled: true, messages: [msg] };
  }

  return null;
}

module.exports = {
  parseSprint1StrictCommand,
  isSprint1QaTesterPhone,
  processSprint1QaInbound,
  formatStateSummary,
  maybeHandleFollowupTemplateQaReply,
  extractQaTemplateReplyContext,
  classifyQaTemplateReply,
  sameQaPhone,
  REPLY_RESET,
  REPLY_CLOSE,
};
