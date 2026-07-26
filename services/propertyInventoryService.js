'use strict';

const { normalizeText, cleanSpaces } = require('../utils/text');
const { formatMoney } = require('../utils/formatting');
const { extractPropertyCode, pickNumericPrice } = require('../conversation/propertyIntentResolver');

const LUXETTY_PUBLIC_ORIGIN = 'https://luxetty.com';

/** Select tiers: widest first; on PostgREST column errors, fall back (read-only). */
const SELECT_TIERS = [
  'id, listing_id, public_code, code, folio, slug, title, operation_type, price, sale_price, selling_price, rent_price, rent_amount, currency_code, currency, status, is_active, published, visible_on_website, city, neighborhood, municipality, zone, bedrooms, bathrooms, construction_m2, terrain_m2, property_type, property_category, highlights, public_highlights, amenities, cover_image_url, agent_profile_id, responsible_agent_profile_id',
  'id, listing_id, slug, title, operation_type, price, sale_price, selling_price, rent_price, rent_amount, status, bedrooms, bathrooms, city, neighborhood, municipality, zone, property_type, property_category, terrain_m2, construction_m2, highlights, amenities, agent_profile_id',
  'id, listing_id, slug, title, operation_type, price, sale_price, selling_price, rent_price, rent_amount, status, bedrooms, bathrooms, city, neighborhood, municipality, property_type, terrain_m2, construction_m2, agent_profile_id',
  'id, listing_id, operation_type, agent_profile_id, price, sale_price, selling_price, rent_price, rent_amount, status, bedrooms, bathrooms, city, neighborhood, title, slug, property_type, terrain_m2, construction_m2',
  'id, listing_id, operation_type, agent_profile_id, price, sale_price, slug, title, neighborhood, city',
  'id, listing_id, slug, title, operation_type, price, status, neighborhood, city',
];

function logInventoryFallback(logger, reason, extra = {}) {
  const w = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
  w('property_inventory_select_fallback', { reason, ...extra });
}

function normalizeInventoryCode(raw) {
  if (raw == null) return null;
  const c = String(raw).trim().toUpperCase();
  if (!c) return null;
  if (c.startsWith('LUX-')) return c;
  const m = c.match(/^([A-Z])(\d{4})$/);
  if (m) return `LUX-${m[1]}${m[2]}`;
  return c;
}

function isUuidLike(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function stripSupabaseNoiseFromSlug(slug) {
  if (slug == null || typeof slug !== 'string') return '';
  const s = slug.trim();
  if (!s) return '';
  if (/supabase\.co|storage\.googleapis\.com|amazonaws\.com/i.test(s)) return '';
  return s;
}

/**
 * URL pública obligatoria: solo luxetty.com/propiedad/{slug}
 * @param {object} property — fila o normalizado con slug
 * @returns {string|null}
 */
function buildPublicPropertyUrl(property = {}) {
  const rawSlug = stripSupabaseNoiseFromSlug(property.slug);
  if (!rawSlug || /\s/.test(rawSlug)) return null;
  const cleanSlug = rawSlug
    .replace(/^https?:\/\/(?:www\.)?luxetty\.com\/propiedad\//i, '')
    .replace(/^\/?propiedad\//i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!cleanSlug || /\s/.test(cleanSlug)) return null;
  if (/^https?:\/\//i.test(cleanSlug)) return null;
  return `${LUXETTY_PUBLIC_ORIGIN}/propiedad/${cleanSlug}`;
}

function propertyHasPublicLink(property = {}) {
  return !!buildPublicPropertyUrl(property);
}

function propertyHasPrice(property = {}) {
  return pickNumericPrice(property) != null;
}

function propertyOperationLabel(property = {}) {
  const op = String(property.operation_type || property.operation || '').toLowerCase();
  if (op === 'rent' || op === 'rental') return 'en renta';
  if (op === 'sale' || op === 'sell' || op === 'venta') return 'en venta';
  if (op === 'sale_rent' || op === 'both') return 'en venta y en renta';
  return 'operación no confirmada en inventario';
}

function getPropertyPublicFacts(property = {}) {
  const p = property && typeof property === 'object' ? property : {};
  return {
    code: cleanSpaces(String(p.listing_id || p.code || '')) || null,
    slug: stripSupabaseNoiseFromSlug(p.slug) || null,
    title: p.title || null,
    operation_type: p.operation_type || null,
    operation_label: propertyOperationLabel(p),
    price: pickNumericPrice(p),
    public_url: buildPublicPropertyUrl(p),
    location_label:
      cleanSpaces(
        String(p.neighborhood || p.zone || p.municipality || p.city || p.location_label || '')
      ) || null,
    bedrooms: p.bedrooms != null && Number.isFinite(Number(p.bedrooms)) ? Number(p.bedrooms) : null,
    bathrooms: p.bathrooms != null && Number.isFinite(Number(p.bathrooms)) ? Number(p.bathrooms) : null,
    construction_m2:
      p.construction_m2 != null && Number.isFinite(Number(p.construction_m2)) ? Number(p.construction_m2) : null,
    terrain_m2: p.terrain_m2 != null && Number.isFinite(Number(p.terrain_m2)) ? Number(p.terrain_m2) : null,
    status: p.status || null,
  };
}

/**
 * Estructura estable para UI / ai_state (incluye raw).
 * @param {object|null} row
 * @returns {object|null}
 */
function normalizeInventoryProperty(row) {
  if (!row || !row.id) return null;
  const slug = stripSupabaseNoiseFromSlug(row.slug);
  const priceNum = pickNumericPrice(row);
  const currency = row.currency_code || row.currency || 'MXN';
  const public_url = buildPublicPropertyUrl({ ...row, slug });
  const opLabel = propertyOperationLabel(row);
  const location_label =
    cleanSpaces(String(row.neighborhood || row.zone || row.municipality || row.city || '')) || null;

  let price_label = null;
  if (priceNum != null) {
    try {
      price_label = formatMoney(priceNum, currency);
    } catch {
      price_label = String(priceNum);
    }
  }

  return {
    id: String(row.id),
    code: cleanSpaces(String(row.listing_id || row.public_code || row.code || '')) || null,
    slug: slug || null,
    title: row.title || null,
    operation_type: row.operation_type || row.operation || null,
    operation_label: opLabel,
    price: priceNum,
    price_label,
    currency,
    status: row.status || null,
    is_active: row.is_active != null ? !!row.is_active : null,
    is_published: row.published != null ? !!row.published : row.is_published != null ? !!row.is_published : null,
    visible_on_website: row.visible_on_website != null ? !!row.visible_on_website : null,
    zone: row.zone || null,
    neighborhood: row.neighborhood || null,
    municipality: row.municipality || null,
    city: row.city || null,
    location_label,
    property_type: row.property_type || null,
    property_category: row.property_category || null,
    bedrooms: row.bedrooms != null && Number.isFinite(Number(row.bedrooms)) ? Number(row.bedrooms) : null,
    bathrooms: row.bathrooms != null && Number.isFinite(Number(row.bathrooms)) ? Number(row.bathrooms) : null,
    construction_m2:
      row.construction_m2 != null && Number.isFinite(Number(row.construction_m2))
        ? Number(row.construction_m2)
        : null,
    terrain_m2: row.terrain_m2 != null && Number.isFinite(Number(row.terrain_m2)) ? Number(row.terrain_m2) : null,
    highlights: row.public_highlights ?? row.highlights ?? null,
    amenities: row.amenities ?? null,
    public_url,
    cover_image_url: row.cover_image_url || null,
    responsible_agent_profile_id: row.responsible_agent_profile_id || row.agent_profile_id || null,
    raw: row,
  };
}

async function selectPropertyRow(db, columns, applyFilter, logger) {
  if (!db || typeof db.from !== 'function') return { data: null, error: new Error('no_db') };
  try {
    let q = db.from('properties').select(columns);
    q = applyFilter(q);
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

function columnMissingError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return m.includes('column') || m.includes('schema') || m.includes('does not exist');
}

function errorMessageReferencesColumn(message, column) {
  const msg = String(message || '').toLowerCase();
  const c = String(column || '').toLowerCase();
  if (!msg || !c) return false;
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(properties\\.)?${escaped}\\b`).test(msg);
}

/**
 * Busca por columna opcional; si la columna no existe en la tabla, retorna null sin romper el flujo.
 */
async function findPropertyRowByEqColumn(db, column, value, logger) {
  if (!column || value == null || String(value).trim() === '') return null;
  const v = String(value).trim();
  let filterColumnMissing = false;
  for (let i = 0; i < SELECT_TIERS.length; i++) {
    const columns = SELECT_TIERS[i];
    const { data, error } = await selectPropertyRow(db, columns, (q) => q.eq(column, v), logger);
    if (!error && data?.id) return data;
    if (error && columnMissingError(error)) {
      if (errorMessageReferencesColumn(error.message, column)) {
        filterColumnMissing = true;
        logInventoryFallback(logger, 'column_or_schema_mismatch', { tier: i, column, message: error.message });
        break;
      }
      logInventoryFallback(logger, 'column_or_schema_mismatch', { tier: i, column, message: error.message });
      continue;
    }
    if (error && i < SELECT_TIERS.length - 1) {
      logInventoryFallback(logger, 'select_failed_retry', { tier: i, column, message: error.message });
    }
  }
  if (filterColumnMissing) return null;
  return null;
}

async function findPropertyRowWithTieredSelect(db, applyFilter, logger) {
  let lastErr = null;
  for (let i = 0; i < SELECT_TIERS.length; i++) {
    const columns = SELECT_TIERS[i];
    const { data, error } = await selectPropertyRow(db, columns, applyFilter, logger);
    if (!error && data?.id) return data;
    if (error) {
      lastErr = error;
      if (i < SELECT_TIERS.length - 1 && columnMissingError(error)) {
        logInventoryFallback(logger, 'column_or_schema_mismatch', { tier: i, message: error.message });
        continue;
      }
      if (i < SELECT_TIERS.length - 1) {
        logInventoryFallback(logger, 'select_failed_retry', { tier: i, message: error.message });
        continue;
      }
    }
  }
  return null;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} code — LUX-A0470 o variante
 */
async function findPropertyByCode(db, code, logger = console) {
  const normalized = normalizeInventoryCode(code) || cleanSpaces(String(code || ''));
  if (!normalized) return { property: null, propertyId: null, normalized: null };

  let row = await findPropertyRowWithTieredSelect(db, (q) => q.eq('listing_id', normalized), logger);
  if (!row && normalized.startsWith('LUX-')) {
    const alt = normalized.replace(/^LUX-/, '');
    row = await findPropertyRowWithTieredSelect(db, (q) => q.eq('listing_id', alt), logger);
  }
  if (!row && isUuidLike(normalized)) {
    row = await findPropertyRowWithTieredSelect(db, (q) => q.eq('id', normalized), logger);
  }

  if (!row) {
    row = await findPropertyRowByEqColumn(db, 'public_code', normalized, logger);
  }
  if (!row && normalized.startsWith('LUX-')) {
    row = await findPropertyRowByEqColumn(db, 'code', normalized, logger);
  }

  if (!row) return { property: null, propertyId: null, normalized: null };
  const normalizedShape = normalizeInventoryProperty(row);
  return { property: { ...row, ...normalizedShape, raw: row }, propertyId: row.id, normalized: normalizedShape };
}

async function findPropertyBySlug(db, slug, logger = console) {
  const s = stripSupabaseNoiseFromSlug(slug);
  if (!s) return { property: null, propertyId: null, normalized: null };
  const row = await findPropertyRowWithTieredSelect(db, (q) => q.eq('slug', s), logger);
  if (!row?.id) return { property: null, propertyId: null, normalized: null };
  const normalizedShape = normalizeInventoryProperty(row);
  return { property: { ...row, ...normalizedShape, raw: row }, propertyId: row.id, normalized: normalizedShape };
}

/**
 * Referencia flexible: código en texto, URL luxetty, slug; fallback título+zona acotado.
 */
async function findPropertyByLooseReference(db, text, opts = {}) {
  const logger = opts.logger || console;
  const hintZone = cleanSpaces(String(opts.hintZone || ''));

  const code = extractPropertyCode(text);
  if (code) {
    const r = await findPropertyByCode(db, code, logger);
    if (r.property) return r;
  }

  const t = String(text || '');
  const urlSlug = t.match(/luxetty\.com\/propiedad\/([a-z0-9-]+)/i);
  if (urlSlug?.[1]) {
    const r = await findPropertyBySlug(db, urlSlug[1], logger);
    if (r.property) return r;
  }

  const slugish = t.match(/\b([a-z]{3,}-en-[a-z0-9-]+(?:-en-venta|-en-renta)?)\b/i);
  if (slugish?.[1]) {
    const r = await findPropertyBySlug(db, slugish[1], logger);
    if (r.property) return r;
  }

  if (hintZone && /propiedad|casa|depa|depto|interesa/i.test(t)) {
    const row = await findPropertyRowWithTieredSelect(
      db,
      (q) => q.ilike('neighborhood', `%${hintZone}%`),
      logger
    );
    if (row?.id) {
      const z = normalizeText(String(row.neighborhood || row.city || row.municipality || row.zone || ''));
      const zn = normalizeText(hintZone);
      if (z && zn && (z.includes(zn) || zn.includes(z))) {
        const normalizedShape = normalizeInventoryProperty(row);
        return { property: { ...row, ...normalizedShape, raw: row }, propertyId: row.id, normalized: normalizedShape };
      }
    }
  }

  const titleHint = extractPropertyTitleHint(t);
  if (titleHint) {
    const scored = await findPublishedPropertiesByTitleHint(db, titleHint, logger);
    if (scored.length === 1) {
      const row = scored[0].row;
      const normalizedShape = scored[0].normalizedShape;
      return { property: { ...row, ...normalizedShape, raw: row }, propertyId: row.id, normalized: normalizedShape };
    }
  }

  return { property: null, propertyId: null, normalized: null };
}

function extractZoneFromPropertyPhrase(text) {
  const m = String(text || '').match(/\bde\s+([^.?!\n]+?)(?:\s*$|\s*[.?!])/im);
  return m ? cleanSpaces(m[1]) : '';
}

const LANDING_REFERENCE_PATTERNS = [
  /\binformaci[oó]n comparativa sobre/i,
  /\binformaci[oó]n sobre .+ y opciones relacionadas/i,
  /\bopciones relacionadas\b/i,
  /\bopciones similares\b/i,
  /\bvi la propiedad\b/i,
  /\bya fue vendida\b/i,
  /\bya fue rentada\b/i,
  /\bagendar una visita\b/i,
  /\bquiero avanzar con la propiedad\b/i,
  /\bcomparto esta propiedad de luxetty\b/i,
  /\[propiedad\s+lux-/i,
  /luxetty\.com\/propiedad\//i,
];

/** Búsqueda orgánica de inventario (demanda) — activa resolución RAG sin código LUX. */
const ORGANIC_PROPERTY_SEARCH_PATTERNS = [
  /\b(busco|quiero|necesito|me interesa)\b.{0,50}\b(casa|departamento|depa|departamentos|terreno|propiedad|residencia|local)\b/i,
  /\b(casa|departamento|depa|terreno|propiedad|residencia|local)\b.{0,40}\b(en|con)\b/i,
  /\b(casa|departamento|depa)\b.{0,30}\b(renta|rentar|venta|comprar|alquiler)\b/i,
];

function normalizePropertyTitleForMatch(text) {
  return normalizeText(String(text || ''))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPropertyTitleHint(text) {
  const raw = cleanSpaces(String(text || ''));
  if (!raw) return null;

  const patterns = [
    /informaci[oó]n comparativa sobre\s+(?:LUX-[A-Z]\d{4}\s*[-—–]\s*)?(.+?)\s+y opciones similares/i,
    /informaci[oó]n sobre\s+(?:LUX-[A-Z]\d{4}\s*[-—–]\s*)?(.+?)\s+y opciones relacionadas/i,
    /vi la propiedad\s+(?:LUX-[A-Z]\d{4}\s+)?"([^"]+)"\s+que ya fue/i,
    /vi la propiedad\s+(?:LUX-[A-Z]\d{4}\s+)?(.+?)\s+que ya fue/i,
    /propiedad\s+LUX-[A-Z]\d{4}\s*[-—–]\s*(.+?)(?:\s*\(|\.|$)/i,
    /\[Propiedad\s+LUX-[A-Z]\d{4}\]\s*(.+?)(?:\.|$)/i,
  ];

  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m?.[1]) {
      let hint = cleanSpaces(m[1]).replace(/^["']|["']$/g, '');
      hint = hint.replace(/\(\$[\d,.\s]+(?:MXN|USD)?\)\.?$/i, '').trim();
      if (hint.length >= 8) return hint.slice(0, 180);
    }
  }

  const quoted = raw.match(/"([^"]{8,180})"/);
  if (quoted?.[1]) return cleanSpaces(quoted[1]);

  return null;
}

function shouldAttemptLoosePropertyResolution(text) {
  try {
    const { isRagDomainRoutingEnabled } = require('../config/accP0Flags');
    if (isRagDomainRoutingEnabled()) {
      const { shouldBlockInventoryForRulesIntent } = require('../conversation/v3/rag/domainIntentClassifier');
      if (shouldBlockInventoryForRulesIntent(text)) return false;
    }
  } catch {
    /* optional during partial deploy */
  }
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  if (extractPropertyCode(text)) return true;
  if (extractPropertyTitleHint(text)) return true;
  if (LANDING_REFERENCE_PATTERNS.some((re) => re.test(t))) return true;
  return ORGANIC_PROPERTY_SEARCH_PATTERNS.some((re) => re.test(t));
}

function tokenOverlapScore(hint, title) {
  const a = normalizePropertyTitleForMatch(hint);
  const b = normalizePropertyTitleForMatch(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.92;

  const stop = new Set(['de', 'en', 'la', 'el', 'los', 'las', 'con', 'para', 'una', 'uno', 'del', 'y']);
  const ta = new Set(a.split(' ').filter((w) => w.length > 2 && !stop.has(w)));
  const tb = new Set(b.split(' ').filter((w) => w.length > 2 && !stop.has(w)));
  if (!ta.size || !tb.size) return 0;

  let inter = 0;
  for (const w of ta) {
    if (tb.has(w)) inter += 1;
  }
  return inter / Math.max(ta.size, tb.size);
}

async function findPropertyRowsWithTieredSelect(db, applyFilter, logger, limit = 1) {
  let lastErr = null;
  for (let i = 0; i < SELECT_TIERS.length; i += 1) {
    const columns = SELECT_TIERS[i];
    try {
      let q = db.from('properties').select(columns);
      q = applyFilter(q);
      const { data, error } = await q.limit(limit);
      if (!error && Array.isArray(data) && data.length) return data;
      if (error) {
        lastErr = error;
        if (i < SELECT_TIERS.length - 1 && columnMissingError(error)) {
          logInventoryFallback(logger, 'column_or_schema_mismatch', { tier: i, message: error.message });
          continue;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    logInventoryFallback(logger, 'select_failed_retry', { message: String(lastErr.message || lastErr) });
  }
  return [];
}

async function findPublishedPropertiesByTitleHint(db, titleHint, logger = console, opts = {}) {
  const hint = cleanSpaces(String(titleHint || ''));
  if (!hint || hint.length < 8) return [];

  const normalizedHint = normalizePropertyTitleForMatch(hint);
  const keywords = normalizedHint
    .split(' ')
    .filter((w) => w.length > 3)
    .slice(0, 6);
  if (!keywords.length) return [];

  const seen = new Map();
  for (const keyword of keywords) {
    const rows = await findPropertyRowsWithTieredSelect(
      db,
      (q) => q.ilike('title', `%${keyword}%`),
      logger,
      12
    );
    for (const row of rows) {
      if (row?.id && !seen.has(row.id)) seen.set(row.id, row);
    }
  }

  const scored = [...seen.values()]
    .map((row) => {
      const normalizedShape = normalizeInventoryProperty(row);
      const score = tokenOverlapScore(hint, row.title || '');
      return { row, normalizedShape, score };
    })
    .filter((x) => x.score >= (opts.minScore ?? 0.45))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, opts.maxResults ?? 5);
}

function toCandidateSummary(entry) {
  const n = entry.normalizedShape || normalizeInventoryProperty(entry.row);
  return {
    id: String(n?.id || entry.row?.id || ''),
    code: cleanSpaces(String(n?.code || n?.listing_id || entry.row?.listing_id || '')) || null,
    title: n?.title || entry.row?.title || null,
    score: entry.score,
    location_label: n?.location_label || null,
    price_label: n?.price_label || null,
    public_url: n?.public_url || null,
  };
}

function resolveDisambiguationPick(text, candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;

  const code = extractPropertyCode(text);
  if (code) {
    const hit = list.find((c) => normalizeInventoryCode(c.code) === normalizeInventoryCode(code));
    if (hit?.id) return hit;
  }

  const t = normalizeText(String(text || ''));
  const m1 = t.match(/\b(?:la\s+)?(?:opci[oó]n|numero|n[uú]mero)\s*([1-3])\b/);
  const m2 = t.match(/^([1-3])\b/);
  let ordinalDigit = m1?.[1] || m2?.[1] || null;
  if (!ordinalDigit && /\bprimera\b/.test(t)) ordinalDigit = '1';
  if (!ordinalDigit && /\bsegunda\b/.test(t)) ordinalDigit = '2';
  if (!ordinalDigit && /\btercera\b/.test(t)) ordinalDigit = '3';
  if (ordinalDigit) {
    const idx = Number(ordinalDigit) - 1;
    if (list[idx]?.id) return list[idx];
  }

  return null;
}

function buildPropertyDisambiguationReply(candidates = []) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, 3);
  if (!list.length) {
    return 'Para orientarte bien, ¿me confirmas el código LUX de la propiedad (por ejemplo LUX-A0473)?';
  }
  const lines = list.map((c, i) => {
    const ref = c.code ? `${c.code}` : 'Sin código';
    const zone = c.location_label ? ` · ${c.location_label}` : '';
    const price = c.price_label ? ` · ${c.price_label}` : '';
    return `${i + 1}. ${ref} — ${c.title || 'Propiedad'}${zone}${price}`;
  });
  return `Encontré varias propiedades parecidas. ¿Cuál te interesa?\n\n${lines.join('\n')}\n\nResponde con el número o el código LUX (ej. LUX-A0473).`;
}

function wrapFoundResult(row) {
  const normalizedShape = normalizeInventoryProperty(row);
  const code = cleanSpaces(String(normalizedShape?.code || row.listing_id || '')) || null;
  return {
    status: 'found',
    property: { ...row, ...normalizedShape, raw: row },
    propertyId: row.id,
    normalized: normalizedShape,
    code,
    ambiguous: false,
    candidates: [],
  };
}

/**
 * Resolución unificada: código, URL/slug, título fuzzy.
 * @returns {{ status: 'found'|'ambiguous'|'not_found', property, propertyId, normalized, code, ambiguous, candidates }}
 */
async function resolveInboundPropertyReference(db, { code, text, hintZone, canaryPhone } = {}, logger = console) {
  const c = cleanSpaces(String(code || ''));
  const zoneHint = cleanSpaces(String(hintZone || '')) || extractZoneFromPropertyPhrase(text || '');

  if (c) {
    const byCode = await findPropertyByCode(db, c, logger);
    if (byCode.property) {
      return {
        status: 'found',
        property: byCode.property,
        propertyId: byCode.propertyId,
        normalized: byCode.normalized,
        code: byCode.normalized?.code || normalizeInventoryCode(c),
        ambiguous: false,
        candidates: [],
        resolution_path: 'direct_code',
        match_method: 'direct_code',
      };
    }
  }

  const looseText = String(text || '');

  const { isRagInventoryEffectiveForUser } = require('../config/accP0Flags');
  if (isRagInventoryEffectiveForUser(canaryPhone)) {
    const ragInv = require('./ragInventoryService');
    const ragOut = await ragInv.resolveInboundPropertyReference(
      db,
      { text: looseText, hintZone: zoneHint, canaryPhone },
      logger
    );
    if (ragOut.status === 'found') {
      return {
        status: 'found',
        property: ragOut.property,
        propertyId: ragOut.propertyId,
        normalized: ragOut.normalized,
        code: ragOut.normalized?.code || null,
        ambiguous: false,
        candidates: [],
        match_method: ragOut.match_method || 'rag_semantic',
        rag_meta: ragOut.rag_meta || null,
        resolution_path: 'rag_semantic_found',
      };
    }
    if (ragOut.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        property: null,
        propertyId: null,
        normalized: null,
        code: null,
        ambiguous: true,
        candidates: ragOut.candidates || [],
        match_method: ragOut.match_method || 'rag_semantic',
        rag_meta: ragOut.rag_meta || null,
        resolution_path: 'rag_semantic_ambiguous',
      };
    }
    if (ragOut.rag_meta) {
      return {
        status: ragOut.status || 'not_found',
        property: null,
        propertyId: null,
        normalized: null,
        code: null,
        ambiguous: false,
        candidates: [],
        match_method: ragOut.match_method || 'rag_semantic',
        rag_meta: ragOut.rag_meta,
        resolution_path: ragOut.reason ? `rag_semantic_${ragOut.reason}` : 'rag_semantic_fallback',
        reason: ragOut.reason || null,
      };
    }
  }

  const urlSlug = looseText.match(/luxetty\.com\/propiedad\/([a-z0-9-]+)/i);
  if (urlSlug?.[1]) {
    const bySlug = await findPropertyBySlug(db, urlSlug[1], logger);
    if (bySlug.property) {
      return {
        status: 'found',
        property: bySlug.property,
        propertyId: bySlug.propertyId,
        normalized: bySlug.normalized,
        code: bySlug.normalized?.code || null,
        ambiguous: false,
        candidates: [],
      };
    }
  }

  const titleHint = extractPropertyTitleHint(looseText);
  if (titleHint) {
    const scored = await findPublishedPropertiesByTitleHint(db, titleHint, logger);
    if (scored.length === 1) {
      return wrapFoundResult(scored[0].row);
    }
    if (scored.length > 1) {
      const top = scored[0].score;
      const close = scored.filter((s) => top - s.score <= 0.08).slice(0, 3);
      if (close.length === 1) {
        return wrapFoundResult(close[0].row);
      }
      const candidates = close.map(toCandidateSummary);
      return {
        status: 'ambiguous',
        property: null,
        propertyId: null,
        normalized: null,
        code: null,
        ambiguous: true,
        candidates,
      };
    }
  }

  if (zoneHint && /propiedad|casa|depa|depto|interesa|opciones/i.test(normalizeText(looseText))) {
    const row = await findPropertyRowWithTieredSelect(
      db,
      (q) => q.ilike('neighborhood', `%${zoneHint}%`),
      logger
    );
    if (row?.id) {
      const z = normalizeText(String(row.neighborhood || row.city || row.municipality || row.zone || ''));
      const zn = normalizeText(zoneHint);
      if (z && zn && (z.includes(zn) || zn.includes(z))) {
        return wrapFoundResult(row);
      }
    }
  }

  return {
    status: 'not_found',
    property: null,
    propertyId: null,
    normalized: null,
    code: null,
    ambiguous: false,
    candidates: [],
  };
}

/**
 * Punto de entrada webhook: código activo + texto usuario.
 */
async function findPropertyByInventoryReference(db, { code, text, hintZone } = {}, logger = console) {
  const resolved = await resolveInboundPropertyReference(db, { code, text, hintZone }, logger);
  if (resolved.status === 'found') {
    return {
      property: resolved.property,
      propertyId: resolved.propertyId,
      normalized: resolved.normalized,
      ambiguous: false,
      candidates: [],
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      property: null,
      propertyId: null,
      normalized: null,
      ambiguous: true,
      candidates: resolved.candidates,
    };
  }
  return { property: null, propertyId: null, normalized: null, ambiguous: false, candidates: [] };
}

function prunePropertyContextByCode(byCode, history, max = 5) {
  const o = byCode && typeof byCode === 'object' ? { ...byCode } : {};
  const codes = Array.isArray(history) ? history.map((h) => h?.code).filter(Boolean) : [];
  const keep = new Set(codes.slice(0, max));
  for (const k of Object.keys(o)) {
    if (!keep.has(k)) delete o[k];
  }
  return o;
}

function pushPropertyHistory(prevState, { code, interested_property_id }) {
  const c = cleanSpaces(String(code || ''));
  if (!c) return {};
  const prevHist = Array.isArray(prevState.property_history) ? [...prevState.property_history] : [];
  const filtered = prevHist.filter((e) => cleanSpaces(String(e?.code || '')) !== c);
  filtered.unshift({
    code: c,
    interested_property_id: interested_property_id != null ? String(interested_property_id) : null,
    at: new Date().toISOString(),
  });
  const property_history = filtered.slice(0, 5);
  const byCode = { ...(prevState.property_context_by_code && typeof prevState.property_context_by_code === 'object' ? prevState.property_context_by_code : {}) };
  return {
    property_history,
    property_context_by_code: prunePropertyContextByCode(byCode, property_history, 5),
    current_property_code: c,
    current_interested_property_id: interested_property_id != null ? String(interested_property_id) : null,
  };
}

function mergePropertyContextCache(prevState, code, snapshot) {
  const c = cleanSpaces(String(code || ''));
  if (!c || !snapshot) return {};
  const byCode = { ...(prevState.property_context_by_code && typeof prevState.property_context_by_code === 'object' ? prevState.property_context_by_code : {}) };
  byCode[c] = snapshot;
  return {
    property_context_by_code: prunePropertyContextByCode(byCode, prevState.property_history || [], 5),
  };
}

module.exports = {
  normalizeInventoryCode,
  normalizePropertyTitleForMatch,
  extractPropertyTitleHint,
  shouldAttemptLoosePropertyResolution,
  tokenOverlapScore,
  resolveInboundPropertyReference,
  resolveDisambiguationPick,
  buildPropertyDisambiguationReply,
  buildPublicPropertyUrl,
  getPropertyPublicFacts,
  normalizeInventoryProperty,
  findPropertyByCode,
  findPropertyBySlug,
  findPropertyByLooseReference,
  findPropertyByInventoryReference,
  findPublishedPropertiesByTitleHint,
  propertyHasPublicLink,
  propertyHasPrice,
  propertyOperationLabel,
  pushPropertyHistory,
  mergePropertyContextCache,
  prunePropertyContextByCode,
  SELECT_TIERS,
  extractZoneFromPropertyPhrase,
};
