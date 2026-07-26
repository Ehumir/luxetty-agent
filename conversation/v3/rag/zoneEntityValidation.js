'use strict';

/**
 * RC-1.1 — Validación de entidad zona/colonia post-retrieval.
 * Solo aplica cuando el query menciona una colonia/zona específica.
 * Si ningún chunk citado contiene la entidad → evidencia inválida → fallback.
 */

const GENERIC_STOPWORDS = new Set([
  'zona',
  'colonia',
  'ubicacion',
  'sector',
  'donde',
  'queda',
  'info',
  'informacion',
  'busco',
  'quiero',
  'necesito',
  'monterrey',
  'nuevo',
  'leon',
  'mexico',
  'municipio',
  'fraccionamiento',
  'fracc',
]);

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Extrae tokens de entidad nombrada en consultas de zona/colonia.
 * @param {string} query
 * @returns {string[]}
 */
function extractZoneEntityTokens(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  const tokens = new Set();

  const patterns = [
    /\b(?:zona|colonia|sector|fraccionamiento)\s+(?:de\s+la\s+|de\s+el\s+|de\s+)?([A-Za-zÁÉÍÓÚáéíóú0-9][A-Za-zÁÉÍÓÚáéíóú0-9\s.-]{2,60})/i,
    /\ben\s+([A-Za-zÁÉÍÓÚáéíóú0-9][A-Za-zÁÉÍÓÚáéíóú0-9\s.-]{2,40})/i,
  ];

  for (const re of patterns) {
    const m = clean.match(re);
    if (!m?.[1]) continue;
    const segment = m[1].replace(/[.?!,]+$/g, '').replace(/\s+en\s+.+$/i, '').trim();
    const full = normalizeToken(segment);
    if (full.length >= 5 && !GENERIC_STOPWORDS.has(full)) {
      tokens.add(full);
    }
    for (const part of segment.split(/[\s.-]+/)) {
      const n = normalizeToken(part);
      if (n.length >= 5 && !GENERIC_STOPWORDS.has(n)) {
        tokens.add(n);
      }
    }
  }

  return [...tokens];
}

function chunkHaystack(chunk) {
  const meta = chunk?.metadata || {};
  return normalizeToken(
    [
      chunk?.content,
      chunk?.title,
      meta.zone_name,
      meta.colony,
      meta.colonia,
      meta.name,
      meta.title,
      meta.slug,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * @param {string} query
 * @param {object[]} chunks — chunks thresholded
 * @returns {{ valid: boolean, reason: string, entity_tokens: string[], matched_count?: number }}
 */
function validateZoneEntityMatch(query, chunks) {
  const entityTokens = extractZoneEntityTokens(query);
  if (!entityTokens.length) {
    return { valid: true, reason: 'no_specific_entity', entity_tokens: [] };
  }

  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) {
    return { valid: false, reason: 'no_chunks', entity_tokens: entityTokens };
  }

  const matched = list.filter((c) => {
    const hay = chunkHaystack(c);
    return entityTokens.some((t) => t.length >= 5 && hay.includes(t));
  });

  if (!matched.length) {
    return { valid: false, reason: 'entity_not_in_citations', entity_tokens: entityTokens };
  }

  return {
    valid: true,
    reason: 'entity_matched',
    entity_tokens: entityTokens,
    matched_count: matched.length,
  };
}

module.exports = {
  extractZoneEntityTokens,
  validateZoneEntityMatch,
  normalizeToken,
};
