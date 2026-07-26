'use strict';

/**
 * Knowledge Graph ligero de ubicaciones — consume SoT Location Intelligence.
 * Anti-inventar colonia: solo aliases/colonies/zones activos.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} rawZone
 * @param {Console} [logger]
 * @returns {Promise<{
 *   input: string|null,
 *   canonical: string|null,
 *   aliases: string[],
 *   zoneName: string|null,
 *   colonyName: string|null,
 *   mustNotInvent: true,
 *   resolved: boolean,
 * }>}
 */
async function resolveZoneContext(db, rawZone, logger = console) {
  const input = cleanSpaces(String(rawZone || ''));
  const empty = {
    input: input || null,
    canonical: null,
    aliases: [],
    zoneName: null,
    colonyName: null,
    mustNotInvent: true,
    resolved: false,
  };
  if (!input || !db || typeof db.from !== 'function') return empty;

  const norm = normalizeText(input);
  try {
    // 1) location_aliases (canónico LI)
    const { data: locAlias } = await db
      .from('location_aliases')
      .select('alias_name, normalized_alias_name, target_type, target_id')
      .eq('is_active', true)
      .or(
        `normalized_alias_name.eq.${norm},alias_name.ilike.%${input.replace(/%/g, '')}%`
      )
      .limit(5);

    let colonyId = null;
    let zoneId = null;
    let aliasHits = [];

    for (const row of locAlias || []) {
      aliasHits.push(String(row.alias_name || ''));
      if (row.target_type === 'colony') colonyId = row.target_id;
      if (row.target_type === 'zone') zoneId = row.target_id;
    }

    // 2) colony_aliases
    const { data: colAlias } = await db
      .from('colony_aliases')
      .select('alias, colony_id')
      .eq('is_active', true)
      .ilike('alias', `%${input.replace(/%/g, '')}%`)
      .limit(5);

    for (const row of colAlias || []) {
      aliasHits.push(String(row.alias || ''));
      if (row.colony_id) colonyId = colonyId || row.colony_id;
    }

    let colonyName = null;
    let zoneName = null;

    if (colonyId) {
      const { data: colony } = await db
        .from('colonies')
        .select('id, name, municipality, zone_id')
        .eq('id', colonyId)
        .eq('is_active', true)
        .maybeSingle();
      if (colony) {
        colonyName = colony.name || null;
        zoneId = zoneId || colony.zone_id;
      }
    }

    if (zoneId) {
      const { data: zone } = await db
        .from('zones')
        .select('id, name')
        .eq('id', zoneId)
        .eq('is_active', true)
        .maybeSingle();
      if (zone) zoneName = zone.name || null;
    }

    // 3) Fallback: match directo colonies / zones por nombre
    if (!colonyName) {
      const { data: colonies } = await db
        .from('colonies')
        .select('id, name, zone_id')
        .eq('is_active', true)
        .ilike('name', `%${input.replace(/%/g, '')}%`)
        .limit(1);
      if (colonies?.[0]) {
        colonyName = colonies[0].name;
        if (colonies[0].zone_id && !zoneName) {
          const { data: zone } = await db
            .from('zones')
            .select('name')
            .eq('id', colonies[0].zone_id)
            .maybeSingle();
          zoneName = zone?.name || null;
        }
      }
    }

    if (!zoneName) {
      const { data: zones } = await db
        .from('zones')
        .select('id, name')
        .eq('is_active', true)
        .ilike('name', `%${input.replace(/%/g, '')}%`)
        .limit(1);
      if (zones?.[0]) zoneName = zones[0].name;
    }

    const canonical = colonyName || zoneName || null;
    const aliases = [...new Set(aliasHits.filter(Boolean))];

    return {
      input,
      canonical,
      aliases,
      zoneName,
      colonyName,
      mustNotInvent: true,
      resolved: !!canonical,
    };
  } catch (e) {
    const w = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
    w('zone_context_resolve_failed', { message: String(e?.message || e) });
    return empty;
  }
}

/**
 * Expande zona de búsqueda con aliases canónicos (para inventory SQL OR).
 * @param {object} ctx — salida de resolveZoneContext
 * @returns {string[]}
 */
function expandZoneSearchTerms(ctx) {
  if (!ctx || typeof ctx !== 'object') return [];
  const terms = [];
  if (ctx.canonical) terms.push(ctx.canonical);
  if (ctx.colonyName) terms.push(ctx.colonyName);
  if (ctx.zoneName) terms.push(ctx.zoneName);
  if (ctx.input) terms.push(ctx.input);
  for (const a of ctx.aliases || []) {
    if (a) terms.push(a);
  }
  return [...new Set(terms.map((t) => cleanSpaces(String(t))).filter((t) => t.length >= 2))];
}

module.exports = {
  resolveZoneContext,
  expandZoneSearchTerms,
};
