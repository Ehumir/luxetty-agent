'use strict';

const {
  getAccRagP0FlagSnapshot,
  isRagRulesEffectiveForUser,
  isRagDomainRoutingEnabled,
  isRagRc11TelemetryEnabled,
} = require('../../../config/accP0Flags');
const ragRulesService = require('../../../services/ragRulesService');
const { canAssertClaim, DEFAULT_MIN_SCORE } = require('./ragPolicy');
const { getMinScoreForDomain } = require('./ragDomainThresholdLoader');
const { buildRagRetrievalKpi } = require('./ragKpi');
const {
  classifyDomainIntent,
  detectRulesDomain,
  CONFIDENCE_LOW,
} = require('./domainIntentClassifier');
const { fetchDomainAwareRulesContextPack } = require('./domainRetrievalOrchestrator');

/** @deprecated use classifyDomainIntent — kept for tests / legacy parity */
const RULES_INTENT_PATTERNS = [
  { domain: 'commercial_objections', re: /\bcomisi[oó]n\b|\bexclusiv|\bvaluaci[oó]n\b|\bcu[aá]nto\s+cobran\b/i },
  { domain: 'rules_perseo', re: /\bpol[ií]tica\b|\bregla\b|\bno\s+invent/i },
  { domain: 'rules_atena', re: /\bsolicitud\b|\blead\b|\bcontacto\b/i },
  { domain: 'assignment_rules', re: /\basignaci[oó]n\b|\bownership\b|\bdue[nñ]o\b/i },
  { domain: 'campaigns', re: /\bcampa[nñ]a\b|\bpauta\b|\bmeta\b/i },
  { domain: 'zones', re: /\bcolonia\b|\bzona\b|\bubicaci[oó]n\b/i },
];

function pickGroundedExcerpt(contextPack, { minConfidence, domain = null } = {}) {
  const threshold = minConfidence ?? getMinScoreForDomain(domain) ?? DEFAULT_MIN_SCORE;
  if (!contextPack || contextPack.fallback_used) return null;
  if (!canAssertClaim({ confidence: contextPack.confidence, citations: contextPack.citations, minConfidence: threshold })) {
    return null;
  }
  const top = contextPack.citations?.[0];
  if (!top?.excerpt) return null;
  return String(top.excerpt).slice(0, 180).trim();
}

function buildTimingExtras(routing = {}, contextPack = null) {
  return {
    embedding_ms: routing.embedding_ms ?? contextPack?.embedding_ms ?? null,
    rpc_ms: routing.rpc_ms ?? contextPack?.rpc_ms ?? null,
    serialization_ms: routing.serialization_ms ?? null,
    retrieval_ms: routing.routing_latency_ms ?? contextPack?.latency_ms ?? null,
    candidate_count: routing.candidate_count ?? null,
    discarded_count: routing.discarded_count ?? null,
  };
}

async function emitSkippedRagTelemetry({ saveConversationEvent, conversationId, messageId, flags, extras }) {
  if (!saveConversationEvent || !conversationId) return;
  // F1A: always emit skip classification (RC11 flag only adds extended fields).
  const kpiPayload = buildRagRetrievalKpi(null, {
    message_id: messageId || null,
    conversation_id: conversationId,
    request_id: messageId || null,
    fallback_used: true,
    skipped: true,
    flags,
    allowlist_eligible: true,
    pipeline: extras.pipeline || 'rq3_domain_routing',
    telemetry_rc11: isRagRc11TelemetryEnabled(),
    classification: extras.classification || extras.skipped_reason || 'retrieval_skipped',
    ...extras,
  });
  await saveConversationEvent(conversationId, 'rag_retrieval', kpiPayload);
}

/** Sprint 5 legacy path — idéntico a 7766a7b cuando RAG_DOMAIN_ROUTING_ENABLED=false */
async function enrichTurnWithRagContextLegacy(db, { text, phone, conversationId, messageId, saveConversationEvent, flags }) {
  const domain = detectRulesDomain(text);
  if (!domain) {
    return {
      contextPack: null,
      meta: { skipped: true, reason: 'no_rules_intent', flags, allowlist_eligible: true, pipeline: 'legacy_sprint5' },
    };
  }

  const start = Date.now();
  try {
    const rulesResult = await ragRulesService.fetchRulesContextPack(db, {
      query: text,
      domain,
      domainAware: false,
    });
    const contextPack = rulesResult?.contextPack || null;
    const latencyMs = Date.now() - start;
    const meta = {
      skipped: false,
      domain,
      pipeline: 'legacy_sprint5',
      flags,
      allowlist_eligible: true,
      confidence: contextPack?.confidence ?? 0,
      chunks_selected: contextPack?.chunks_selected ?? 0,
      chunks_dropped: contextPack?.chunks_dropped ?? 0,
      citations_count: contextPack?.citations?.length ?? 0,
      fallback_used: contextPack?.fallback_used ?? rulesResult?.fallback ?? true,
      latency_ms: latencyMs,
      rag_query_log_id: contextPack?.rag_query_log_id || null,
    };

    if (typeof saveConversationEvent === 'function' && conversationId) {
      const kpiPayload = buildRagRetrievalKpi(contextPack, {
        domain,
        message_id: messageId || null,
        retrieval_latency_ms: latencyMs,
        flags,
        allowlist_eligible: true,
        pipeline: 'legacy_sprint5',
        fallback_reason: meta.fallback_used ? 'low_confidence_or_empty' : null,
      });
      await saveConversationEvent(conversationId, 'rag_retrieval', kpiPayload);
    }

    return { contextPack, meta };
  } catch (err) {
    return {
      contextPack: null,
      meta: {
        skipped: false,
        domain,
        pipeline: 'legacy_sprint5',
        flags,
        allowlist_eligible: true,
        fallback_used: true,
        fallback_reason: 'exception',
        latency_ms: Date.now() - start,
      },
    };
  }
}

/** RQ-3 certified path — domain routing + RQ-4 adaptive threshold via orchestrator */
async function enrichTurnWithRagContextRq3(db, { text, phone, conversationId, messageId, saveConversationEvent, flags, logger }) {
  const intent = classifyDomainIntent(text);

  if (intent.domain === 'properties') {
    await emitSkippedRagTelemetry({
      saveConversationEvent,
      conversationId,
      messageId,
      flags,
      extras: {
        skipped_reason: 'properties_domain_deferred_to_inventory',
        domain_selected: 'properties',
        domain_detected: intent.domain,
        domain_confidence: intent.confidence,
        inventory_path: 'properties_domain_deferred',
        routing_reason: intent.reason,
      },
    });
    return {
      contextPack: null,
      meta: {
        skipped: true,
        reason: 'properties_domain_deferred_to_inventory',
        flags,
        allowlist_eligible: true,
        domain_intent: intent,
        pipeline: 'rq3_domain_routing',
      },
    };
  }

  if (intent.confidence < CONFIDENCE_LOW && !detectRulesDomain(text)) {
    return {
      contextPack: null,
      meta: {
        skipped: true,
        reason: 'no_rules_intent',
        flags,
        allowlist_eligible: true,
        domain_intent: intent,
        pipeline: 'rq3_domain_routing',
      },
    };
  }

  const domain =
    intent.domain === 'scripts'
      ? detectRulesDomain(text) || intent.secondary_domain
      : intent.domain;

  if (!domain || (domain === 'scripts' && !detectRulesDomain(text))) {
    return {
      contextPack: null,
      meta: {
        skipped: true,
        reason: 'no_rules_intent',
        flags,
        allowlist_eligible: true,
        domain_intent: intent,
        pipeline: 'rq3_domain_routing',
      },
    };
  }

  const start = Date.now();
  const minScoreApplied = getMinScoreForDomain(domain);
  try {
    const rulesResult = await fetchDomainAwareRulesContextPack(db, { query: text, domain, logger });
    const contextPack = rulesResult?.contextPack || null;
    const latencyMs = Date.now() - start;
    const routing = rulesResult?.routing || {};
    const meta = {
      skipped: false,
      domain,
      pipeline: 'rq3_domain_routing',
      domain_intent: rulesResult?.intent || intent,
      routing,
      flags,
      allowlist_eligible: true,
      confidence: contextPack?.confidence ?? 0,
      chunks_selected: contextPack?.chunks_selected ?? 0,
      chunks_dropped: contextPack?.chunks_dropped ?? 0,
      citations_count: contextPack?.citations?.length ?? 0,
      fallback_used: contextPack?.fallback_used ?? rulesResult?.fallback ?? true,
      latency_ms: latencyMs,
      rag_query_log_id: contextPack?.rag_query_log_id || null,
    };

    if (typeof saveConversationEvent === 'function' && conversationId) {
      const kpiPayload = buildRagRetrievalKpi(contextPack, {
        domain,
        message_id: messageId || null,
        retrieval_latency_ms: latencyMs,
        flags,
        allowlist_eligible: true,
        pipeline: 'rq3_domain_routing',
        fallback_reason: meta.fallback_used ? routing.fallback_reason || 'low_confidence_or_empty' : null,
        domain_detected: routing.domain_detected,
        domain_confidence: routing.domain_confidence,
        domain_selected: routing.domain_selected,
        secondary_domain: routing.secondary_domain,
        routing_strategy: routing.routing_strategy,
        routing_reason: routing.routing_reason,
        chunks_considered: routing.chunks_considered,
        routing_latency_ms: routing.routing_latency_ms,
        cross_domain_discarded: routing.cross_domain_discarded,
        secondary_domain_discarded: routing.secondary_domain_discarded,
        secondary_domain_used: routing.secondary_domain_used,
        wrong_domain_retrieval: routing.wrong_domain_retrieval === true,
        min_score_threshold: minScoreApplied,
        zone_entity_validation: routing.zone_entity_validation || null,
        campaign_entity_validation: routing.campaign_entity_validation || null,
        hallucination_blocked:
          routing.fallback_reason === 'zone_entity_mismatch' ||
          routing.fallback_reason === 'campaign_entity_mismatch',
        ...buildTimingExtras(routing, contextPack),
      });
      await saveConversationEvent(conversationId, 'rag_retrieval', kpiPayload);
    }

    return { contextPack, meta };
  } catch (err) {
    logger?.warn?.('rag_turn_orchestrator_failed', { error: String(err?.message || err) });
    const meta = {
      skipped: false,
      domain,
      pipeline: 'rq3_domain_routing',
      flags,
      allowlist_eligible: true,
      fallback_used: true,
      fallback_reason: 'exception',
      latency_ms: Date.now() - start,
    };
    if (typeof saveConversationEvent === 'function' && conversationId) {
      const kpiPayload = buildRagRetrievalKpi(null, {
        domain,
        message_id: messageId || null,
        fallback_used: true,
        fallback_reason: 'exception',
        flags,
        allowlist_eligible: true,
        pipeline: 'rq3_domain_routing',
        retrieval_latency_ms: meta.latency_ms,
        min_score_threshold: minScoreApplied,
      });
      await saveConversationEvent(conversationId, 'rag_retrieval', kpiPayload);
    }
    return { contextPack: null, meta };
  }
}

async function enrichTurnWithRagContext(
  db,
  {
    text,
    phone,
    conversationId = null,
    messageId = null,
    saveConversationEvent = null,
    logger = console,
  } = {}
) {
  const flags = getAccRagP0FlagSnapshot();
  const allowlistEligible = isRagRulesEffectiveForUser(phone);

  if (!allowlistEligible) {
    const meta = {
      skipped: true,
      reason: 'not_eligible',
      flags,
      allowlist_eligible: false,
      classification: 'retrieval_skipped_by_policy',
    };
    // F1A: no fingir rag_query_logs; sí auditar skip por política.
    await emitSkippedRagTelemetry({
      saveConversationEvent,
      conversationId,
      messageId,
      flags,
      extras: {
        skipped_reason: 'not_eligible',
        classification: 'retrieval_skipped_by_policy',
        allowlist_eligible: false,
        pipeline: 'eligibility_gate',
      },
    });
    return { contextPack: null, meta };
  }

  const ctx = { text, phone, conversationId, messageId, saveConversationEvent, flags, logger };
  if (isRagDomainRoutingEnabled()) {
    return enrichTurnWithRagContextRq3(db, ctx);
  }
  return enrichTurnWithRagContextLegacy(db, ctx);
}

module.exports = {
  RULES_INTENT_PATTERNS,
  detectRulesDomain,
  pickGroundedExcerpt,
  enrichTurnWithRagContext,
  enrichTurnWithRagContextLegacy,
  enrichTurnWithRagContextRq3,
};
