'use strict';

const ragService = require('../../../services/ragService');
const ragRulesService = require('../../../services/ragRulesService');
const ragInventoryService = require('../../../services/ragInventoryService');
const { DEFAULT_MIN_SCORE } = require('./ragPolicy');
const { getMinScoreForDomain } = require('./ragDomainThresholdLoader');
const {
  classifyDomainIntent,
  CONFIDENCE_MED,
  SECONDARY_BY_DOMAIN,
  stripHarnessNoise,
  SECONDARY_CHAIN_BY_DOMAIN,
} = require('./domainIntentClassifier');
const { isRagRc11ZoneEntityValidationEnabled, isRagRc12CampaignEntityValidationEnabled } = require('../../../config/accP0Flags');
const { validateZoneEntityMatch, extractZoneEntityTokens } = require('./zoneEntityValidation');
const { validateCampaignEntityMatch, extractCampaignEntityTokens } = require('./campaignEntityValidation');

/**
 * Filtra chunks a dominio(s) permitidos — evita competencia cross-domain.
 * @param {object[]} chunks
 * @param {string|string[]} allowed
 */
function filterChunksByDomain(chunks, allowed) {
  const list = Array.isArray(chunks) ? chunks : [];
  const set = new Set(Array.isArray(allowed) ? allowed : [allowed]);
  return list.filter((c) => set.has(c.registry_domain_code));
}

/**
 * Retrieval especializado por dominio (sin búsqueda global).
 */
/** RQ-4.7 — top_k por dominio (evidencia-driven, reversible vía env). */
const DOMAIN_TOP_K = {
  properties: 8,
  commercial_objections: 8,
  assignment_rules: 8,
  rules_atena: 8,
  rules_perseo: 8,
  zones: 8,
  campaigns: 8,
  scripts: 8,
};

function topKForDomain(domain) {
  return DOMAIN_TOP_K[domain] || 5;
}

/** RQ-4.7 — recall RPC por dominio (no altera threshold adaptativo de app). */
function rpcMinScoreForDomain(domain) {
  const recall = { campaigns: 0.45, zones: 0.45 };
  const v = recall[domain];
  if (typeof v === 'number') return v;
  return ragService.getRagRpcMinScore();
}

async function retrieveForDomain(db, domain, query, { logger = console } = {}) {
  const cleanQuery = stripHarnessNoise(query);
  if (domain === 'properties') {
    const retrievalQuery = ragInventoryService.buildInventoryRetrievalQuery(cleanQuery);
    const search = await ragService.semanticSearch(db, {
      query: retrievalQuery,
      rpcName: 'match_property_chunks',
      rpcParams: {
        match_count: 10,
        min_score: ragService.getRagRpcMinScore(),
        filter_visibility_scope: null,
        filter_is_active: true,
        filter_property_id: null,
      },
      logger,
    });

    if (search.fallback || !search.chunks?.length) {
      return {
        chunks: [],
        candidates: [],
        thresholded: [],
        fallback: true,
        domain,
        rpcName: 'match_property_chunks',
        search,
      };
    }

    const candidates = ragService.selectCandidates(search.chunks, { topK: topKForDomain(domain) });
    const minScore = getMinScoreForDomain(domain);
    const thresholded = ragService.applyThresholds(candidates, { minScore });
    return {
      chunks: search.chunks,
      candidates,
      thresholded,
      fallback: !thresholded.length,
      domain,
      rpcName: 'match_property_chunks',
      search,
    };
  }

  const retrievalQuery = ragRulesService.buildRulesRetrievalQuery(cleanQuery, domain);
  const rpcParams = {
    ...ragRulesService.buildKnowledgeChunksRpcParams({ matchCount: 10, domain }),
    min_score: rpcMinScoreForDomain(domain),
  };
  const search = await ragService.semanticSearch(db, {
    query: retrievalQuery,
    rpcName: 'match_knowledge_chunks',
    rpcParams,
    logger,
  });

  if (search.fallback) {
    return {
      chunks: [],
      candidates: [],
      thresholded: [],
      fallback: true,
      domain,
      rpcName: 'match_knowledge_chunks',
      search,
    };
  }

  const domainChunks = filterChunksByDomain(search.chunks, domain);
  const candidates = ragService.selectCandidates(domainChunks, { topK: topKForDomain(domain) });
  let zoneEntityValidation = null;
  let campaignEntityValidation = null;

  if (domain === 'zones' && isRagRc11ZoneEntityValidationEnabled()) {
    const entityTokens = extractZoneEntityTokens(cleanQuery);
    if (entityTokens.length) {
      zoneEntityValidation = validateZoneEntityMatch(cleanQuery, candidates.length ? candidates : domainChunks);
      if (!zoneEntityValidation.valid) {
        return {
          chunks: domainChunks,
          candidates: [],
          thresholded: [],
          fallback: true,
          domain,
          rpcName: 'match_knowledge_chunks',
          search,
          cross_domain_discarded: (search.chunks?.length || 0) - domainChunks.length,
          zone_entity_validation: zoneEntityValidation,
          campaign_entity_validation: null,
        };
      }
    }
  }

  if (domain === 'campaigns' && isRagRc12CampaignEntityValidationEnabled()) {
    const entityTokens = extractCampaignEntityTokens(cleanQuery);
    if (entityTokens.length) {
      campaignEntityValidation = validateCampaignEntityMatch(cleanQuery, candidates.length ? candidates : domainChunks);
      if (!campaignEntityValidation.valid) {
        return {
          chunks: domainChunks,
          candidates: [],
          thresholded: [],
          fallback: true,
          domain,
          rpcName: 'match_knowledge_chunks',
          search,
          cross_domain_discarded: (search.chunks?.length || 0) - domainChunks.length,
          zone_entity_validation: zoneEntityValidation,
          campaign_entity_validation: campaignEntityValidation,
        };
      }
    }
  }

  const minScore = getMinScoreForDomain(domain);
  let thresholded = ragService.applyThresholds(candidates, { minScore });

  return {
    chunks: domainChunks,
    candidates,
    thresholded,
    fallback: !thresholded.length,
    domain,
    rpcName: 'match_knowledge_chunks',
    search,
    cross_domain_discarded: (search.chunks?.length || 0) - domainChunks.length,
    zone_entity_validation: zoneEntityValidation,
    campaign_entity_validation: campaignEntityValidation,
  };
}

/**
 * Domain-Aware Retrieval Orchestrator (RQ-3).
 * @returns {Promise<object>}
 */
async function retrieveWithDomainRouting(db, { query, domain: domainOverride = null, logger = console } = {}) {
  const routingStart = Date.now();
  const cleanQuery = stripHarnessNoise(query);
  const intent = domainOverride
    ? { domain: domainOverride, confidence: 1, reason: 'override', secondary_domain: SECONDARY_BY_DOMAIN[domainOverride] }
    : classifyDomainIntent(cleanQuery);

  const primaryDomain = intent.domain;
  const strategy =
    intent.confidence >= CONFIDENCE_MED ? 'primary_only' : intent.secondary_domain ? 'primary_secondary' : 'primary_only';

  const domainsAttempted = [];
  let primaryResult = await retrieveForDomain(db, primaryDomain, cleanQuery, { logger });
  domainsAttempted.push(primaryDomain);

  let selectedDomain = primaryDomain;
  let secondaryDomain = null;
  let routingStrategy = strategy;
  let finalResult = primaryResult;
  let secondaryDomainDiscarded = 0;
  let secondaryDomainUsed = false;

  const secondaryChain = SECONDARY_CHAIN_BY_DOMAIN[primaryDomain] || (intent.secondary_domain ? [intent.secondary_domain] : []);

  const zoneEntityMismatch =
    primaryResult.zone_entity_validation && primaryResult.zone_entity_validation.valid === false;
  const campaignEntityMismatch =
    primaryResult.campaign_entity_validation && primaryResult.campaign_entity_validation.valid === false;

  // RC-1.1 — zona inexistente: no escalar a secondary (evita grounded incorrecto).
  if (primaryResult.fallback && zoneEntityMismatch) {
    finalResult = primaryResult;
    routingStrategy = 'zone_entity_mismatch';
  } else if (primaryResult.fallback && campaignEntityMismatch) {
    // RC-1.2 — campaña inexistente: no escalar a secondary.
    finalResult = primaryResult;
    routingStrategy = 'campaign_entity_mismatch';
  } else if (primaryResult.fallback && secondaryChain.length) {
    for (const candidate of secondaryChain) {
      if (!primaryResult.fallback) break;
      secondaryDomain = candidate;
      const secondaryResult = await retrieveForDomain(db, candidate, cleanQuery, { logger });
      domainsAttempted.push(candidate);
      secondaryDomainDiscarded += secondaryResult.cross_domain_discarded ?? 0;
      if (!secondaryResult.fallback && secondaryResult.thresholded.length) {
        finalResult = secondaryResult;
        selectedDomain = candidate;
        routingStrategy = 'secondary_fallback';
        secondaryDomainUsed = true;
        break;
      }
    }
  }

  if (finalResult.fallback && !zoneEntityMismatch && !campaignEntityMismatch) {
    routingStrategy = 'legacy_fallback';
  }

  const zoneValidation = finalResult.zone_entity_validation;
  const campaignValidation = finalResult.campaign_entity_validation;
  const fallbackReason = finalResult.fallback
    ? zoneValidation && !zoneValidation.valid
      ? 'zone_entity_mismatch'
      : campaignValidation && !campaignValidation.valid
        ? 'campaign_entity_mismatch'
        : 'low_confidence_or_empty'
    : null;

  const ctx = finalResult.fallback ? { chunks: [], dropped: [], context_tokens_estimated: 0, chunks_selected: 0, chunks_dropped: 0 } : ragService.buildContext(finalResult.thresholded);

  const searchTiming = finalResult.search || {};
  const routingMeta = {
    domain_detected: primaryDomain,
    domain_confidence: intent.confidence,
    domain_selected: selectedDomain,
    secondary_domain: secondaryDomain,
    routing_strategy: routingStrategy,
    routing_reason: intent.reason,
    domains_attempted: domainsAttempted,
    chunks_considered: finalResult.chunks?.length ?? 0,
    chunks_selected: ctx.chunks_selected ?? 0,
    cross_domain_discarded: primaryResult.cross_domain_discarded ?? 0,
    secondary_domain_discarded: secondaryDomainDiscarded,
    secondary_domain_used: secondaryDomainUsed,
    wrong_domain_retrieval: false,
    routing_latency_ms: Date.now() - routingStart,
    fallback_reason: fallbackReason,
    zone_entity_validation: zoneValidation || null,
    campaign_entity_validation: campaignValidation || null,
    embedding_ms: searchTiming.embedding_ms ?? null,
    rpc_ms: searchTiming.rpc_ms ?? null,
    serialization_ms: searchTiming.serialization_ms ?? null,
    candidate_count: finalResult.candidates?.length ?? 0,
    discarded_count: (finalResult.chunks?.length ?? 0) - (finalResult.thresholded?.length ?? 0),
  };

  return {
    intent,
    routing: routingMeta,
    thresholded: finalResult.thresholded,
    context: ctx,
    fallback: finalResult.fallback,
    top1: finalResult.candidates?.[0] || null,
    top1_score: finalResult.candidates?.[0]
      ? Number(finalResult.candidates[0].similarity ?? finalResult.candidates[0].score ?? 0)
      : 0,
    search: finalResult.search,
  };
}

/**
 * Context pack de reglas con routing domain-aware (prod path RQ-3).
 */
async function fetchDomainAwareRulesContextPack(db, { query, domain = null, logger = console } = {}) {
  const routed = await retrieveWithDomainRouting(db, { query, domain, logger });

  if (routed.fallback || !routed.context?.chunks?.length) {
    const minScore = getMinScoreForDomain(routed.routing.domain_selected || domain);
    return {
      contextPack: ragService.createContextPack({
        fallback_used: true,
        minScore,
        latency_ms: routed.routing.routing_latency_ms,
      }),
      fallback: true,
      routing: routed.routing,
      intent: routed.intent,
    };
  }

  const { evaluateRetrieval } = require('./ragPolicy');
  const minScore = getMinScoreForDomain(routed.routing.domain_selected);
  const evalResult = evaluateRetrieval(routed.thresholded, { minScore });
  const citations = ragService.buildCitationsFromChunks(routed.context.chunks);
  const logId = await ragService.persistRagQueryLog(db, {
    queryHash: routed.search?.query_hash,
    filters: {
      routing_strategy: routed.routing.routing_strategy,
      domain_selected: routed.routing.domain_selected,
      domain_detected: routed.routing.domain_detected,
      min_score_threshold: minScore,
    },
    resultsCount: routed.context.chunks.length,
    latencyMs: (routed.search?.latency_ms || 0) + routed.routing.routing_latency_ms,
    fallbackUsed: false,
    citations,
  });

  const contextPack = ragService.createContextPack({
    chunks: routed.context.chunks,
    confidence: evalResult.confidence,
    minScore,
    fallback_used: false,
    rag_query_log_id: logId,
    latency_ms: routed.routing.routing_latency_ms,
    budgetMeta: routed.context,
  });

  return {
    contextPack,
    fallback: false,
    routing: routed.routing,
    intent: routed.intent,
    evalResult,
  };
}

module.exports = {
  filterChunksByDomain,
  retrieveForDomain,
  retrieveWithDomainRouting,
  fetchDomainAwareRulesContextPack,
};
