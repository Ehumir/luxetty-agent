'use strict';

/**
 * Comparables conversacionales v0 — 2–3 similares SoT vía inventoryOptionsService.
 * Nunca inventa: solo filas publicables con URL.
 */

const inventoryOptionsService = require('./inventoryOptionsService');
const { normalizeText, cleanSpaces } = require('../utils/text');

/**
 * @param {object|null|undefined} activeProperty
 * @returns {{operation:string|null, zone:string|null, budgetMax:number|null, propertyType:string|null}}
 */
function criteriaFromActiveProperty(activeProperty) {
  const ap = activeProperty && typeof activeProperty === 'object' ? activeProperty : {};
  const price = ap.price != null && Number.isFinite(Number(ap.price)) ? Number(ap.price) : null;
  const op = ap.operation_type || ap.operation || null;
  const zone =
    cleanSpaces(String(ap.neighborhood || ap.zone || ap.location_label || ap.municipality || '')) ||
    null;
  const propertyType = ap.property_type || ap.property_category || null;
  // Banda ±20 % alrededor del precio publicado.
  const budgetMax = price != null ? Math.round(price * 1.2) : null;
  return { operation: op, zone, budgetMax, propertyType };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{activeProperty?:object, excludePropertyId?:string, limit?:number, queryText?:string}} input
 * @param {Console} [logger]
 */
async function findComparables(db, input = {}, logger = console) {
  const ap = input.activeProperty;
  if (!ap || !ap.id) {
    return { options: [], source: 'none', reason: 'no_active_property' };
  }
  const criteria = criteriaFromActiveProperty(ap);
  if (!criteria.operation && !criteria.zone && criteria.budgetMax == null) {
    return { options: [], source: 'none', reason: 'insufficient_criteria' };
  }

  const limit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 3;
  const res = await inventoryOptionsService.searchInventoryOptions(
    db,
    {
      operation: criteria.operation || 'sale',
      zone: criteria.zone,
      budgetMax: criteria.budgetMax,
      propertyType: criteria.propertyType,
      queryText:
        input.queryText ||
        cleanSpaces(`${criteria.operation || ''} ${criteria.zone || ''} similares`),
      limit: limit + 3,
    },
    logger
  );

  const excludeId = String(input.excludePropertyId || ap.id);
  const options = (res.options || [])
    .filter((o) => o && o.id && String(o.id) !== excludeId)
    .filter((o) => o.public_url && o.price != null)
    .slice(0, limit);

  return {
    options,
    source: res.source || 'none',
    operation: res.operation,
    zone: res.zone,
    budgetMax: res.budgetMax,
    relaxedZone: !!res.relaxedZone,
  };
}

/**
 * Texto consultivo con URLs SoT (sin inventar).
 * @param {object[]} options
 * @param {{greet?:string, ref?:string}} [opts]
 */
function formatComparablesReply(options, opts = {}) {
  const greet = opts.greet || '';
  const ref = opts.ref || 'esta propiedad';
  if (!Array.isArray(options) || !options.length) {
    return `${greet}No tengo aún otras fichas publicables comparables a ${ref} en este canal. Puedo afinar por zona o presupuesto si me das un rango.`;
  }
  const lines = options.map((o, i) => {
    const code = o.code || o.listing_id || '';
    const price = o.price_label || (o.price != null ? String(o.price) : '');
    const zone = o.location_label || o.neighborhood || o.zone || '';
    const url = o.public_url || '';
    return `${i + 1}. ${code || o.title || 'Opción'}${price ? ` — ${price}` : ''}${
      zone ? ` · ${zone}` : ''
    }${url ? `\n${url}` : ''}`;
  });
  return `${greet}Comparables publicables cerca de ${ref} (datos de inventario, no inventados):\n${lines.join('\n')}`;
}

module.exports = {
  criteriaFromActiveProperty,
  findComparables,
  formatComparablesReply,
  normalizeText,
};
