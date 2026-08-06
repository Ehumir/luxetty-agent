'use strict';

/**
 * Inventory Options Engine (demanda) — busca inventario REAL publicable
 * (renta/venta) y devuelve opciones con link público. Nunca inventa: solo
 * filas active + slug (link) + precio. Recuperación híbrida:
 *   1. Filtro SQL estructurado (operación/zona/presupuesto) — base exacta.
 *   2. RAG semántico (match_property_chunks) — ranking best-effort.
 *
 * @see docs/argos/evidence/perseo-inventory-options/ (evidencia)
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { normalizeInventoryProperty } = require('./propertyInventoryService');

/** Columnas verificadas contra el esquema real de public.properties. */
const SAFE_SELECT =
  'id, listing_id, slug, title, operation_type, price, status, visible_on_website, is_public, archived_at, city, neighborhood, municipality, zone, bedrooms, bathrooms, currency_code, agent_profile_id';

const TYPE_KEYWORDS = {
  house: ['casa', 'residencia', 'quinta'],
  apartment: ['departamento', 'depa', 'depto'],
  land: ['terreno', 'lote'],
  commercial: ['local', 'bodega', 'nave', 'oficina', 'edificio'],
};

function warn(logger, event, extra = {}) {
  const w = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
  w(event, extra);
}

function sanitizeZone(zone) {
  return cleanSpaces(String(zone || ''))
    .replace(/[%,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapOperation(op) {
  const o = normalizeText(String(op || ''));
  if (o === 'rent' || o === 'renta' || o === 'rental' || o === 'rentar') return 'rent';
  if (o === 'sale' || o === 'venta' || o === 'sell' || o === 'compra' || o === 'buy' || o === 'comprar') return 'sale';
  return null;
}

function normalizeTypeKey(propertyType) {
  const t = normalizeText(String(propertyType || ''));
  if (!t) return null;
  if (/(casa|house|home|residencia|quinta)/.test(t)) return 'house';
  if (/(depa|depto|departamento|apartment|flat)/.test(t)) return 'apartment';
  if (/(terreno|lote|land)/.test(t)) return 'land';
  if (/(local|comercial|commercial|bodega|nave|oficina|edificio)/.test(t)) return 'commercial';
  return null;
}

function isPublishableOption(n) {
  if (!n) return false;
  if (!n.public_url || n.price == null) return false;
  if (String(n.status || '').toLowerCase() !== 'active') return false;
  const hasPubFlag =
    typeof n.is_public === 'boolean' || typeof n.visible_on_website === 'boolean' || n.archived_at;
  if (hasPubFlag) {
    try {
      const { isPropertyRowPublishable } = require('../conversation/v3/rag/ragPolicy');
      if (!isPropertyRowPublishable({ ...n, id: n.id || 'x' })) return false;
    } catch {
      /* policy optional */
    }
  }
  return true;
}

/**
 * Filtro estructurado determinista sobre public.properties.
 * @returns {Promise<object[]>} filas crudas
 */
async function structuredInventorySearch(db, { operation, zone, budgetMax, bedrooms, limit = 12 } = {}, logger = console) {
  if (!db || typeof db.from !== 'function') return [];
  const z = sanitizeZone(zone);
  try {
    let q = db.from('properties').select(SAFE_SELECT).eq('status', 'active');
    if (operation) q = q.eq('operation_type', operation);
    if (budgetMax != null && Number.isFinite(Number(budgetMax))) q = q.lte('price', Number(budgetMax));
    if (bedrooms != null && Number.isFinite(Number(bedrooms)) && Number(bedrooms) > 0) {
      q = q.gte('bedrooms', Number(bedrooms));
    }
    if (z) {
      const like = `%${z}%`;
      q = q.or(
        `neighborhood.ilike.${like},municipality.ilike.${like},city.ilike.${like},zone.ilike.${like}`
      );
    }
    const { data, error } = await q.order('price', { ascending: true }).limit(limit);
    if (error) {
      warn(logger, 'inventory_options_structured_failed', { message: error.message });
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    warn(logger, 'inventory_options_structured_exception', { message: String(e?.message || e) });
    return [];
  }
}

/**
 * Ranking semántico best-effort: devuelve property_ids ordenados por similitud.
 * @returns {Promise<string[]>}
 */
async function ragRankPropertyIds(db, { queryText, operation, zone } = {}, logger = console) {
  try {
    const ragService = require('./ragService');
    const { buildInventoryRetrievalQuery } = require('./ragInventoryService');
    const seed = cleanSpaces(String(queryText || `${operation || ''} ${zone || ''}`));
    const query = buildInventoryRetrievalQuery(seed, zone || '');
    const search = await ragService.semanticSearch(db, {
      query,
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
    if (!search || search.fallback || !Array.isArray(search.chunks)) return [];
    const ids = [];
    for (const c of search.chunks) {
      const pid = c?.metadata?.property_id || c?.metadata?.source_property_id;
      if (pid && !ids.includes(String(pid))) ids.push(String(pid));
    }
    return ids;
  } catch (e) {
    warn(logger, 'inventory_options_rag_rank_failed', { message: String(e?.message || e) });
    return [];
  }
}

/**
 * Punto de entrada: busca opciones reales publicables por criterios de demanda.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{operation?:string, zone?:string, budgetMax?:number, propertyType?:string, queryText?:string, limit?:number}} criteria
 * @returns {Promise<{options:object[], operation:string|null, zone:string|null, budgetMax:number|null, relaxedZone:boolean, source:string}>}
 */
async function searchInventoryOptions(db, criteria = {}, logger = console) {
  const operation = mapOperation(criteria.operation);
  const zone = criteria.zone ? cleanSpaces(String(criteria.zone)) : null;
  const budgetMax =
    criteria.budgetMax != null && Number.isFinite(Number(criteria.budgetMax)) ? Number(criteria.budgetMax) : null;
  const propertyType = criteria.propertyType || null;
  const limit = Number.isFinite(Number(criteria.limit)) ? Number(criteria.limit) : 3;

  let rows = await structuredInventorySearch(
    db,
    { operation, zone, budgetMax, bedrooms: criteria.bedrooms, limit: 12 },
    logger
  );

  // La zona sólo puede ampliarse después de una aceptación explícita del cliente.
  let relaxedZone = false;
  if (!rows.length && zone && criteria.allowZoneExpansion === true) {
    rows = await structuredInventorySearch(
      db,
      { operation, budgetMax, bedrooms: criteria.bedrooms, limit: 12 },
      logger
    );
    relaxedZone = rows.length > 0;
  }

  const byId = new Map();
  for (const row of rows) {
    const n = normalizeInventoryProperty(row);
    if (!n) continue;
    if (row.is_public != null) n.is_public = row.is_public;
    if (row.visible_on_website != null) n.visible_on_website = row.visible_on_website;
    if (row.archived_at != null) n.archived_at = row.archived_at;
    if (isPublishableOption(n) && !byId.has(n.id)) byId.set(n.id, n);
  }
  let normalized = [...byId.values()];

  if (!normalized.length) {
    return { options: [], operation, zone, budgetMax, relaxedZone, source: 'none' };
  }

  const typeKw = propertyType ? TYPE_KEYWORDS[normalizeTypeKey(propertyType)] || [] : [];
  let source = 'structured';
  let ragIds = [];
  if (normalized.length > limit) {
    ragIds = await ragRankPropertyIds(db, { queryText: criteria.queryText, operation, zone }, logger);
    if (ragIds.length) source = 'structured+rag';
  }

  const ragRank = (id) => {
    const i = ragIds.indexOf(String(id));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const typeScore = (n) => {
    if (!typeKw.length) return 0;
    const hay = normalizeText(`${n.slug || ''} ${n.title || ''}`);
    return typeKw.some((k) => hay.includes(k)) ? 0 : 1;
  };

  normalized.sort((a, b) => {
    const ts = typeScore(a) - typeScore(b);
    if (ts !== 0) return ts;
    const rr = ragRank(a.id) - ragRank(b.id);
    if (rr !== 0) return rr;
    return (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY);
  });

  return { options: normalized.slice(0, limit), operation, zone, budgetMax, relaxedZone, source };
}

module.exports = {
  searchInventoryOptions,
  structuredInventorySearch,
  ragRankPropertyIds,
  mapOperation,
  normalizeTypeKey,
  isPublishableOption,
  sanitizeZone,
  SAFE_SELECT,
};
