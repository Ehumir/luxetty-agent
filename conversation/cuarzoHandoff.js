'use strict';

/**
 * Cuarzo V1 — handoff operativo con resumen para agente humano (ATENA solo lectura).
 */

const { cleanSpaces, normalizeText } = require('../utils/text');
const { buildFinalHandoffReply } = require('./responseBuilder');
const { detectConversationalFrustration } = require('./antiLoopGuardrails');
const { isPositiveHandoffAck, isShortPostCloseAck } = require('./v3/interpreter/objectionClassifier');

function isBotRejectionTextLocal(text = '') {
  const t = normalizeText(String(text || ''));
  return (
    t.includes('no maquina') ||
    t.includes('no máquina') ||
    t.includes('no bot') ||
    t.includes('no robot') ||
    t.includes('nada de bot') ||
    t.includes('nada de maquina') ||
    t.includes('nada de máquina')
  );
}

const HANDOFF_REASON_LABELS = {
  frustration: 'Frustración o repetición detectada',
  explicit_human_request: 'Solicitud explícita de asesor humano',
  legal_sensitive: 'Caso legal delicado',
  multimedia_unprocessed: 'Multimedia no procesable en Cuarzo',
  out_of_scope: 'Contenido fuera de alcance Cuarzo',
  ambiguous_intent: 'Cambio de intención ambiguo',
};

function formatIntentLabel(aiState = {}) {
  const flow = aiState.lead_flow;
  const op = aiState.operation_type;
  if (flow === 'offer') return 'Venta / captación';
  if (flow === 'demand' && op === 'rent') return 'Demanda — renta';
  if (flow === 'demand') return 'Demanda — compra';
  return flow ? String(flow) : 'No confirmada';
}

function buildBriefSummary(aiState = {}) {
  const parts = [];
  if (aiState.lead_flow === 'offer') parts.push('Interesado en vender propiedad');
  else if (aiState.lead_flow === 'demand') parts.push('Busca propiedad');
  if (aiState.location_text) parts.push(`Zona: ${aiState.location_text}`);
  if (aiState.property_type) parts.push(`Tipo: ${aiState.property_type}`);
  if (aiState.occupancy_status) parts.push(`Ocupación: ${aiState.occupancy_status}`);
  return parts.join('. ') || 'Conversación con asistente IA de Luxetty.';
}

function buildOperationalHandoffSummary(aiState = {}, context = {}) {
  const st = aiState && typeof aiState === 'object' ? aiState : {};
  const reason = context.reason || 'explicit_human_request';
  const captured = {};
  if (st.full_name) captured.full_name = st.full_name;
  if (st.location_text) captured.location_text = st.location_text;
  if (st.property_type) captured.property_type = st.property_type;
  if (st.occupancy_status) captured.occupancy_status = st.occupancy_status;
  if (st.budget_max != null && Number.isFinite(Number(st.budget_max))) {
    captured.budget_max = st.budget_max;
  }
  if (st.property_code) captured.property_code = st.property_code;

  const campaign = st.campaign_context || st.campaign || null;
  const propertyCode =
    st.property_code ||
    st.direct_property_code ||
    (campaign && (campaign.property_code || campaign.propertyCode)) ||
    null;

  return {
    version: 'cuarzo_v1',
    escalated_at: new Date().toISOString(),
    reason_code: reason,
    reason_label: HANDOFF_REASON_LABELS[reason] || reason,
    user_snippet: context.userSnippet ? String(context.userSnippet).slice(0, 240) : null,
    intent_label: formatIntentLabel(st),
    lead_flow: st.lead_flow || null,
    operation_type: st.operation_type || null,
    captured_fields: captured,
    property_code: propertyCode,
    campaign_name:
      campaign && (campaign.name || campaign.headline || campaign.ad_name)
        ? String(campaign.name || campaign.headline || campaign.ad_name)
        : null,
    linked_lead_id: context.leadId || st.linked_lead_id || null,
    linked_contact_id: context.contactId || st.linked_contact_id || null,
    conversation_summary: context.conversationSummary || buildBriefSummary(st),
    pending_version: context.pendingVersion || null,
  };
}

function buildStandardHandoffStatePatch(summary, extra = {}) {
  return {
    wants_human: true,
    handoff_ready: true,
    handoff_sent: true,
    handoff_waiting_final_confirmation: true,
    awaiting_field: null,
    pending_name_capture: false,
    handoff_summary: summary,
    ...extra,
  };
}

/**
 * Tras handoff: ACK corto una vez, hold una vez, luego silencio (modo HUMAN).
 */
function resolvePostHandoffTurn({ previousAiState = {}, nextAiState = {}, text = '' } = {}) {
  const merged = { ...previousAiState, ...nextAiState };
  if (!merged.handoff_sent) return { handled: false };

  const conversationMode = require('./conversationMode');

  const { shouldExplicitlyReopenConversation } = require('./conversationReopenPolicy');
  if (shouldExplicitlyReopenConversation(text, merged)) {
    return { handled: false };
  }

  // El gate superior de conversation_mode bloquea este camino en tráfico real
  // HUMAN_WAITING/HUMAN. En el harness legacy, reiterar “asesor” no consume el
  // único ACK terminal que sigue al consentimiento.
  if (/\b(?:mejor|quiero|necesito|atienda|atender)\b.*\basesor(?:a)?\b/i.test(normalizeText(text))) {
    return {
      handled: true,
      reply: 'Ya quedó canalizado con un asesor de Luxetty.',
      statePatch: { awaiting_field: null },
      responseSource: 'cuarzo_handoff_request_reaffirmed',
    };
  }

  // Rechazo a bot / insistencia en humano: silencio total
  if (isBotRejectionTextLocal(text)) {
    return {
      handled: true,
      reply: null,
      skipSend: true,
      reason: 'bot_rejection_silence',
      statePatch: {
        ...conversationMode.patchForHumanHandoffSent({
          post_handoff_hold_sent: true,
          terminal_ack_close: true,
          awaiting_field: null,
        }),
      },
      responseSource: 'human_mode_silence',
    };
  }

  if (isPositiveHandoffAck(text) || isShortPostCloseAck(text)) {
    if (merged.terminal_ack_close || merged.post_handoff_hold_sent) {
      return {
        handled: true,
        reply: null,
        skipSend: true,
        reason: 'post_handoff_silence',
        statePatch: conversationMode.patchForHumanHandoffSent({ awaiting_field: null }),
        responseSource: 'human_mode_silence',
      };
    }
    const fn = merged.full_name ? String(merged.full_name).split(/\s+/)[0] : null;
    const head = fn ? `Perfecto, ${fn}.` : 'Perfecto.';
    return {
      handled: true,
      reply: `${head} Un asesor de Luxetty continuará contigo por aquí.`,
      statePatch: {
        ...conversationMode.patchForHumanHandoffSent({
          terminal_ack_close: true,
          post_handoff_hold_sent: true,
          awaiting_field: null,
        }),
      },
      responseSource: 'cuarzo_post_handoff_ack',
    };
  }

  // Hold genérico como máximo una vez
  if (merged.post_handoff_hold_sent || merged.terminal_ack_close) {
    return {
      handled: true,
      reply: null,
      skipSend: true,
      reason: 'post_handoff_silence',
      statePatch: conversationMode.patchForHumanHandoffSent({ awaiting_field: null }),
      responseSource: 'human_mode_silence',
    };
  }

  return {
    handled: true,
    reply: 'Quedó canalizado con un asesor de Luxetty. En breve te contactan por aquí.',
    statePatch: {
      ...conversationMode.patchForHumanHandoffSent({
        post_handoff_hold_sent: true,
        awaiting_field: null,
      }),
    },
    responseSource: 'cuarzo_post_handoff_hold',
  };
}

/**
 * Frustración / repetición → handoff terminal (Cuarzo P0-A).
 */
function resolveFrustrationTerminalHandoff({
  previousAiState = {},
  nextAiState = {},
  text = '',
  inboundFrustration = null,
} = {}) {
  if (previousAiState.handoff_sent || nextAiState.handoff_sent) {
    return { handled: false };
  }

  const fr = inboundFrustration || detectConversationalFrustration(text);
  if (!fr || !fr.frustrated) return { handled: false };

  const merged = { ...previousAiState, ...nextAiState, wants_human: true };
  const summary = buildOperationalHandoffSummary(merged, {
    reason: 'frustration',
    userSnippet: cleanSpaces(String(text || '')),
  });

  const lead = buildFinalHandoffReply(merged);
  const prefix = 'Tienes razón, pido una disculpa por la repetición. ';

  return {
    handled: true,
    reply: `${prefix}${lead}`,
    statePatch: buildStandardHandoffStatePatch(summary, {
      last_change_type: 'cuarzo_frustration_handoff',
    }),
    responseSource: 'cuarzo_frustration_handoff',
  };
}

module.exports = {
  HANDOFF_REASON_LABELS,
  buildOperationalHandoffSummary,
  buildStandardHandoffStatePatch,
  resolvePostHandoffTurn,
  resolveFrustrationTerminalHandoff,
};
