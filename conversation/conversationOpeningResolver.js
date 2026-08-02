'use strict';

/**
 * Conversation Opening Resolver — decide el primer mensaje antes del engine/fallback.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { resolvePriorityIntent } = require('./conversationPriorityResolver');
const { enforceOpeningContract, SAFE_OPENING_REPLIES } = require('./contracts/conversationOpeningContract');
const { isExplicitHumanAdvisorRequest } = require('./humanEscalation');
const conversationMode = require('./conversationMode');
const r0 = require('./r0ContextContinuity');
const { extractPropertyCode } = require('./propertyIntentResolver');

function countInbound(recentMessages = []) {
  return (Array.isArray(recentMessages) ? recentMessages : []).filter(
    (m) => m && m.direction === 'inbound',
  ).length;
}

function isColdThread(aiState = {}, recentMessages = []) {
  const st = aiState && typeof aiState === 'object' ? aiState : {};
  if (st.lead_flow || st.handoff_sent || st.property_code || st.direct_property_code) return false;
  // El segundo mensaje ya es continuidad, aunque el primero sólo haya
  // producido el saludo. Tratarlo como apertura fría reinicia la intención.
  return countInbound(recentMessages) <= 1;
}

function buildGreetingReply() {
  return SAFE_OPENING_REPLIES.greeting;
}

function buildMetaGeneralReply() {
  return SAFE_OPENING_REPLIES.meta_general;
}

function buildSocialReply() {
  return SAFE_OPENING_REPLIES.social_reference;
}

function buildSellerOpeningReply(text = '', aiState = {}) {
  const loc = cleanSpaces(String(aiState.location_text || ''));
  const t = normalizeText(text);
  if (r0.isSaleProcessQuestion(text)) {
    return r0.buildSaleCaptiveContinuityReply({
      text,
      aiState: { ...aiState, lead_flow: 'offer' },
      loc,
      hasValidHumanName: !!cleanSpaces(String(aiState.full_name || '')),
    });
  }
  if (loc || t.includes('garcia') || t.includes('garcía') || t.includes('cumbres')) {
    return loc
      ? `Claro, te puedo orientar con la venta en ${loc}. ¿El inmueble es casa, departamento o terreno?`
      : SAFE_OPENING_REPLIES.seller_capture;
  }
  return SAFE_OPENING_REPLIES.seller_capture;
}

/**
 * @returns {{
 *   handled: boolean,
 *   reply?: string|null,
 *   statePatch?: object,
 *   opening_type?: string,
 *   entry_type?: string|null,
 *   opening_source?: string,
 *   skipSend?: boolean,
 *   metrics?: object,
 * }}
 */
function resolveConversationOpening(context = {}) {
  const started = Date.now();
  const {
    text = '',
    previousAiState = {},
    nextAiState = {},
    parsedSignals = {},
    recentMessages = [],
  } = context;

  const prev = previousAiState && typeof previousAiState === 'object' ? previousAiState : {};
  const next = nextAiState && typeof nextAiState === 'object' ? nextAiState : {};
  const merged = { ...prev, ...next };

  const priority = resolvePriorityIntent(text, merged, parsedSignals);
  const metricsBase = {
    opening_type: priority.opening_type,
    entry_type: priority.entry_type,
    opening_source: 'conversation_opening_resolver',
    opening_latency_ms: 0,
  };

  // Humano: no apertura comercial; lo maneja humanEscalation / mode gate
  if (priority.key === 'human' || isExplicitHumanAdvisorRequest(text, parsedSignals)) {
    return {
      handled: false,
      opening_type: 'human_request',
      entry_type: 'human_request',
      opening_source: 'conversation_opening_resolver',
      statePatch: conversationMode.patchForHumanRequest({
        opening_type: 'human_request',
        entry_point_last: { entry_type: 'human_request', lead_flow: merged.lead_flow || null },
      }),
      metrics: { ...metricsBase, opening_type: 'human_request', opening_latency_ms: Date.now() - started },
    };
  }

  // Hilo ya caliente con offer sticky: no reabrir menú; dejar continuidad R0 / engine
  if (r0.isR0StickySaleCaptureThread(merged) && !isColdThread(merged, recentMessages)) {
    if (r0.isSaleProcessQuestion(text) || text.trim() === '?' || normalizeText(text) === '?') {
      const reply = r0.buildSaleCaptiveContinuityReply({
        text: r0.isSaleProcessQuestion(text) ? text : 'continuar',
        aiState: merged,
        loc: cleanSpaces(String(merged.location_text || '')),
        hasValidHumanName: !!cleanSpaces(String(merged.full_name || '')),
      });
      const enforced = enforceOpeningContract(reply, {
        aiState: { ...merged, lead_flow: 'offer' },
        opening_type: 'seller_capture',
      });
      return {
        handled: true,
        reply: enforced.reply,
        opening_type: 'seller_capture',
        entry_type: 'seller_capture_ad',
        opening_source: 'conversation_opening_resolver',
        statePatch: {
          lead_flow: 'offer',
          operation_type: merged.operation_type || 'sale',
          opening_type: 'seller_capture',
          entry_point_last: {
            entry_type: 'seller_capture_ad',
            lead_flow: 'offer',
            location_text: merged.location_text || null,
          },
        },
        metrics: {
          ...metricsBase,
          opening_type: 'seller_capture',
          opening_latency_ms: Date.now() - started,
          contract_enforced: enforced.enforced,
        },
      };
    }
    return {
      handled: false,
      opening_type: 'seller_capture',
      entry_type: 'seller_capture_ad',
      opening_source: 'conversation_opening_resolver',
      statePatch: { lead_flow: 'offer', opening_type: 'seller_capture' },
      metrics: { ...metricsBase, opening_latency_ms: Date.now() - started },
    };
  }

  const cold = isColdThread(merged, recentMessages);
  const shouldOpen =
    cold ||
    priority.key === 'greeting' ||
    priority.key === 'meta_general' ||
    priority.key === 'social' ||
    (priority.key === 'seller_capture' && !merged.lead_flow);

  if (!shouldOpen && priority.key === 'unknown') {
    return {
      handled: false,
      opening_type: 'unknown',
      entry_type: null,
      opening_source: 'conversation_opening_resolver',
      statePatch: {},
      metrics: { ...metricsBase, opening_latency_ms: Date.now() - started },
    };
  }

  let reply = null;
  let statePatch = {
    opening_type: priority.opening_type,
    entry_point_last: {
      entry_type: priority.entry_type,
      lead_flow: priority.lead_flow,
      property_code: extractPropertyCode(text) || null,
      location_text: merged.location_text || parsedSignals.location_text || null,
    },
  };

  if (priority.key === 'greeting') {
    reply = buildGreetingReply();
  } else if (priority.key === 'meta_general') {
    reply = buildMetaGeneralReply();
    statePatch.entry_point_last.entry_type = 'meta_general_entry';
  } else if (priority.key === 'social') {
    reply = buildSocialReply();
  } else if (priority.key === 'seller_capture') {
    reply = buildSellerOpeningReply(text, { ...merged, ...parsedSignals, lead_flow: 'offer' });
    statePatch.lead_flow = 'offer';
    statePatch.operation_type = merged.operation_type || parsedSignals.operation_type || 'sale';
    statePatch.intent_lock_sale_owner = true;
    if (parsedSignals.location_text) statePatch.location_text = parsedSignals.location_text;
  } else if (priority.key === 'property_specific') {
    // Dejar name-first / property flow (ya tienen copy propio)
    return {
      handled: false,
      opening_type: 'property_specific',
      entry_type: 'property_ad',
      opening_source: 'conversation_opening_resolver',
      statePatch: {
        opening_type: 'property_specific',
        entry_point_last: { entry_type: 'property_ad', lead_flow: 'demand' },
      },
      metrics: { ...metricsBase, opening_latency_ms: Date.now() - started },
    };
  } else if (priority.key === 'buyer_search' || priority.key === 'rent_search') {
    return {
      handled: false,
      opening_type: priority.opening_type,
      entry_type: priority.entry_type,
      opening_source: 'conversation_opening_resolver',
      statePatch: {
        opening_type: priority.opening_type,
        lead_flow: 'demand',
        entry_point_last: { entry_type: priority.entry_type, lead_flow: 'demand' },
      },
      metrics: { ...metricsBase, opening_latency_ms: Date.now() - started },
    };
  } else if (cold && priority.key === 'unknown') {
    // Hilo frío sin clasificación: apertura natural, no genérico robot
    reply = SAFE_OPENING_REPLIES.default;
    statePatch.opening_type = 'greeting';
  }

  if (!reply) {
    return {
      handled: false,
      opening_type: priority.opening_type,
      entry_type: priority.entry_type,
      opening_source: 'conversation_opening_resolver',
      statePatch,
      metrics: { ...metricsBase, opening_latency_ms: Date.now() - started },
    };
  }

  const enforced = enforceOpeningContract(reply, {
    aiState: { ...merged, ...statePatch },
    opening_type: statePatch.opening_type || priority.opening_type,
  });

  return {
    handled: true,
    reply: enforced.reply,
    opening_type: statePatch.opening_type || priority.opening_type,
    entry_type: priority.entry_type,
    opening_source: 'conversation_opening_resolver',
    statePatch,
    metrics: {
      ...metricsBase,
      opening_type: statePatch.opening_type || priority.opening_type,
      opening_latency_ms: Date.now() - started,
      contract_enforced: enforced.enforced,
      contract_reason: enforced.reason,
    },
  };
}

module.exports = {
  resolveConversationOpening,
  isColdThread,
  buildGreetingReply,
  buildMetaGeneralReply,
  buildSellerOpeningReply,
};
