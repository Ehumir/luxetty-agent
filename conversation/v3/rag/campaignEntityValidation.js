'use strict';

/**
 * RC-1.2 — Validación de entidad campaña post-retrieval.
 * Solo aplica cuando el query menciona una campaña específica.
 * Si ningún chunk citado contiene la entidad → evidencia inválida → fallback.
 */

const GENERIC_STOPWORDS = new Set([
  'campana',
  'campanas',
  'campaña',
  'campañas',
  'anuncio',
  'anuncios',
  'publicacion',
  'pauta',
  'pautas',
  'meta',
  'facebook',
  'instagram',
  'captacion',
  'generica',
  'generico',
  'promocion',
  'promocional',
  'marketing',
  'ads',
  'vi',
  'su',
  'me',
  'interesa',
  'una',
  'de',
  'la',
  'el',
  'los',
  'las',
  'del',
  'por',
  'en',
]);

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Extrae tokens de entidad nombrada en consultas de campaña.
 * @param {string} query
 * @returns {string[]}
 */
function extractCampaignEntityTokens(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  const tokens = new Set();

  const patterns = [
    /\b(?:campa[nñ]a|campa[nñ]as)\s+(?:de\s+la\s+|de\s+el\s+|de\s+)?([A-Za-zÁÉÍÓÚáéíóú0-9][A-Za-zÁÉÍÓÚáéíóú0-9\s.-]{2,60})/i,
    /\b(?:anuncio|pauta)\s+(?:de\s+la\s+|de\s+el\s+|de\s+)?([A-Za-zÁÉÍÓÚáéíóú0-9][A-Za-zÁÉÍÓÚáéíóú0-9\s.-]{2,60})/i,
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
      meta.campaign_name,
      meta.campaign,
      meta.campana,
      meta.name,
      meta.title,
      meta.slug,
      meta.ad_name,
      meta.utm_campaign,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * @param {string} query
 * @param {object[]} chunks — chunks thresholded or candidates
 * @returns {{ valid: boolean, reason: string, entity_tokens: string[], matched_count?: number }}
 */
function validateCampaignEntityMatch(query, chunks) {
  const entityTokens = extractCampaignEntityTokens(query);
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
  extractCampaignEntityTokens,
  validateCampaignEntityMatch,
  normalizeToken,
};
