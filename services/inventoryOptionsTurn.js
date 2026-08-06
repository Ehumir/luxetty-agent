'use strict';

/**
 * Resuelve opciones de inventario para un turno demanda (pre-V3).
 * Solo lectura SoT + RAG rerank; nunca inventa.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const {
  isInventoryOptionsEffectiveForUser,
} = require('../config/accP0Flags');
const {
  mentionsRentDemand,
  mentionsBuyDemand,
  isDemandSearchInbound,
  extractLooseLocationPhrase,
} = require('../conversation/v3/interpreter/campaignIntake');
const { normalizeLocationFromUserText } = require('../conversation/v3/interpreter/locationNormalizer');
const { parseMoneyAmount } = require('../conversation/v3/interpreter/moneyParser');
const inventoryOptionsService = require('./inventoryOptionsService');
const {
  readDemandSlots,
  mergeDemandSlots,
  buildInventorySearchMeta,
} = require('../conversation/v3/rag/demandSearchSlots');

function resolveDemandOperation(text, previousAiState = {}) {
  const t = normalizeText(String(text || ''));
  const prev = readDemandSlots(previousAiState);
  if (mentionsRentDemand(t)) return 'rent';
  if (mentionsBuyDemand(t)) return 'sale';
  if (prev.operationType === 'rent' || prev.conversationGoal === 'RENT_PROPERTY') return 'rent';
  if (prev.operationType === 'sale' || prev.conversationGoal === 'BUY_PROPERTY') return 'sale';
  if (/\brenta\b/.test(t)) return 'rent';
  if (/\bventa\b|\bcomprar\b/.test(t)) return 'sale';
  return null;
}

function shouldAttemptInventorySearch({ text, previousAiState = {}, phone } = {}) {
  if (!isInventoryOptionsEffectiveForUser(phone)) return false;
  const t = String(text || '');
  const prev = readDemandSlots(previousAiState);
  const demand =
    isDemandSearchInbound(t) ||
    mentionsRentDemand(normalizeText(t)) ||
    mentionsBuyDemand(normalizeText(t)) ||
    prev.leadFlow === 'demand' ||
    ['BUY_PROPERTY', 'RENT_PROPERTY'].includes(String(prev.conversationGoal || ''));
  if (!demand) return false;
  if (prev.leadFlow === 'offer') return false;
  return true;
}

/**
 * @returns {Promise<{matchedOptions: object[], inventorySearchMeta: object, demandSlots: object}|null>}
 */
async function resolveInventoryOptionsForTurn({
  db,
  text,
  phone,
  previousAiState = {},
  logger = console,
} = {}) {
  if (!shouldAttemptInventorySearch({ text, previousAiState, phone })) {
    return null;
  }

  const operation = resolveDemandOperation(text, previousAiState);
  if (!operation) return null;

  const prevSlots = readDemandSlots(previousAiState);
  const inboundZone =
    normalizeLocationFromUserText(text) || extractLooseLocationPhrase(text) || null;
  const inboundBudget = parseMoneyAmount(text);

  const slots = mergeDemandSlots(prevSlots, {
    operationType: operation,
    locationText: inboundZone || undefined,
    budgetMax: inboundBudget != null ? inboundBudget : undefined,
    leadFlow: 'demand',
  });

  const zone = slots.locationText;
  const budgetMax = slots.budgetMax;
  const bedrooms = slots.bedrooms;
  const propertyType =
    previousAiState.property_type ||
    previousAiState.propertyType ||
    previousAiState.collectedFields?.propertyType ||
    previousAiState.collected_fields?.property_type ||
    null;

  // No hacer ni siquiera lecturas auxiliares de inventario antes de completar
  // los criterios mínimos de demanda.
  if (!zone || budgetMax == null || !propertyType) return null;

  let resolvedZone = zone;
  // LI light KG: expandir zona canónica antes del SQL (anti-inventar).
  if (zone && db) {
    try {
      const { resolveZoneContext } = require('./zoneContextService');
      const zc = await resolveZoneContext(db, zone, logger);
      if (zc.resolved && zc.canonical) {
        resolvedZone = zc.canonical;
      }
    } catch {
      /* zone KG optional */
    }
  }
  const res = await inventoryOptionsService.searchInventoryOptions(
    db,
    {
      operation,
      zone: resolvedZone,
      budgetMax,
      bedrooms,
      propertyType,
      queryText: text,
      limit: 3,
    },
    logger
  );

  const options = Array.isArray(res.options) ? res.options : [];
  return {
    matchedOptions: options,
    demandSlots: slots,
    inventorySearchMeta: buildInventorySearchMeta({
      attempted: true,
      source: res.source || 'none',
      operation: res.operation || operation,
      zone: res.zone ?? resolvedZone,
      budgetMax: res.budgetMax ?? budgetMax,
      bedrooms,
      relaxedZone: !!res.relaxedZone,
      emptyAfterSearch: options.length === 0,
    }),
  };
}

module.exports = {
  shouldAttemptInventorySearch,
  resolveDemandOperation,
  resolveInventoryOptionsForTurn,
  readDemandSlots,
};
