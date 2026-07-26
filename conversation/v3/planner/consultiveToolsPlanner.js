'use strict';

/**
 * Planner consultivo con tool-calling (solo lectura).
 * Flag: PERSEO_CONSULTIVE_TOOLS_ENABLED (default OFF).
 * Prohibido: create lead, assignment, CRM write.
 */

const { envTrue } = (() => {
  try {
    const f = require('../config/accP0Flags');
    return { envTrue: (n) => process.env[n] === 'true', isInventory: f.isInventoryOptionsEffectiveForUser };
  } catch {
    return { envTrue: (n) => process.env[n] === 'true', isInventory: () => false };
  }
})();

function isConsultiveToolsEnabled() {
  return envTrue('PERSEO_CONSULTIVE_TOOLS_ENABLED');
}

function isConsultiveToolsEffectiveForUser(phone) {
  if (!isConsultiveToolsEnabled()) return false;
  if (envTrue('PERSEO_CONSULTIVE_TOOLS_GLOBAL')) return true;
  const list = String(process.env.PERSEO_CONSULTIVE_TOOLS_ALLOWLIST || '')
    .split(/[,;]+/)
    .map((x) => x.trim().replace(/\D/g, ''))
    .filter(Boolean);
  if (!list.length) return false;
  const n = String(phone || '').replace(/\D/g, '');
  if (!n) return false;
  return list.some((e) => n === e || n.endsWith(e) || e.endsWith(n));
}

const TOOL_CAPS = Object.freeze({
  maxToolsPerTurn: 2,
  timeoutMs: 4000,
});

/**
 * Clasifica qué tools hacen falta (0–2) según texto + estado.
 * @returns {string[]}
 */
function planConsultiveTools({ text, state = {} } = {}) {
  const t = String(text || '').toLowerCase();
  /** @type {string[]} */
  const tools = [];
  const hasAp = !!(state.activeProperty && state.activeProperty.id);

  if (hasAp && /\b(precio|cuesta|cu[aá]nto|zona|ubicaci|info|h[aá]blame|disponible|link|enlace|foto)\b/i.test(t)) {
    tools.push('get_property_facts');
  }
  if (/\b(compar|similar|parecid|otras?\s+opciones?|alternativ)\b/i.test(t) && hasAp) {
    tools.push('get_comparables');
  }
  if (
    /\b(busco|comprar|renta|opciones?|tienes|hay|alberca|millones|presupuesto)\b/i.test(t) &&
    !tools.includes('get_comparables')
  ) {
    tools.push('search_inventory_options');
  }
  if (/\b(zona|colonia|cumbres|san\s+pedro|montemorelos|carretera)\b/i.test(t)) {
    tools.push('get_zone_context');
  }
  if (/\b(comisi[oó]n|exclusiva|regla|objeci[oó]n|pol[ií]tica)\b/i.test(t)) {
    tools.push('get_rules_context');
  }

  return [...new Set(tools)].slice(0, TOOL_CAPS.maxToolsPerTurn);
}

/**
 * Ejecuta tools de solo lectura. Nunca escribe CRM.
 * @returns {Promise<{toolsCalled:string[], results:Record<string, unknown>, mustNot:string[]}>}
 */
async function runConsultiveTools({
  db,
  text,
  phone,
  state = {},
  logger = console,
} = {}) {
  if (!isConsultiveToolsEffectiveForUser(phone)) {
    return { toolsCalled: [], results: {}, mustNot: ['crm_write', 'create_lead', 'assignment'] };
  }

  const planned = planConsultiveTools({ text, state });
  const results = {};
  const toolsCalled = [];
  const mustNot = ['crm_write', 'create_lead', 'assignment', 'invent_price', 'invent_url'];

  const started = Date.now();

  for (const tool of planned) {
    if (Date.now() - started > TOOL_CAPS.timeoutMs) break;
    try {
      if (tool === 'get_property_facts') {
        const ap = state.activeProperty || null;
        results.get_property_facts = ap
          ? {
              id: ap.id,
              code: ap.code || ap.listing_id || null,
              price_label: ap.price_label || null,
              price: ap.price ?? null,
              location_label: ap.location_label || ap.zone || null,
              public_url: ap.public_url || null,
              cover_image_url: ap.cover_image_url || null,
            }
          : null;
        toolsCalled.push(tool);
      } else if (tool === 'search_inventory_options') {
        const inventoryOptionsTurn = require('../services/inventoryOptionsTurn');
        const inv = await inventoryOptionsTurn.resolveInventoryOptionsForTurn({
          db,
          text,
          phone,
          previousAiState: state,
          logger,
        });
        results.search_inventory_options = inv
          ? {
              matchedOptions: inv.matchedOptions || [],
              inventorySearchMeta: inv.inventorySearchMeta || null,
            }
          : null;
        toolsCalled.push(tool);
      } else if (tool === 'get_comparables') {
        const comparablesService = require('../services/comparablesService');
        const cmp = await comparablesService.findComparables(
          db,
          { activeProperty: state.activeProperty, limit: 3 },
          logger
        );
        results.get_comparables = cmp;
        toolsCalled.push(tool);
      } else if (tool === 'get_zone_context') {
        const zoneContextService = require('../services/zoneContextService');
        const zone =
          state.locationText ||
          state.activeProperty?.neighborhood ||
          state.activeProperty?.zone ||
          null;
        results.get_zone_context = await zoneContextService.resolveZoneContext(db, zone, logger);
        toolsCalled.push(tool);
      } else if (tool === 'get_rules_context') {
        results.get_rules_context = state.ragContextPack || null;
        toolsCalled.push(tool);
      }
    } catch (e) {
      const w = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
      w('consultive_tool_failed', { tool, message: String(e?.message || e) });
    }
  }

  return { toolsCalled, results, mustNot };
}

module.exports = {
  isConsultiveToolsEnabled,
  isConsultiveToolsEffectiveForUser,
  planConsultiveTools,
  runConsultiveTools,
  TOOL_CAPS,
};
