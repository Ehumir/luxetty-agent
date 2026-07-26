'use strict';

const { normalizeText, cleanSpaces } = require('../../../utils/text');

/**
 * @param {string} t normalized
 * @returns {'whatsapp'|null}
 */
function parseChannelPreference(t) {
  if (!t) return null;
  if (/\bwhatsapp\b/i.test(t) || /\bwa\b/.test(t)) return 'whatsapp';
  return null;
}

/**
 * @param {string} head
 * @returns {boolean}
 */
function isLikelyFirstNameOnly(head) {
  const h = cleanSpaces(String(head || ''));
  if (!h || h.length < 2 || h.length > 48) return false;
  if (/\d/.test(h)) return false;
  const hn = normalizeText(h);
  if (/\b(esta en|que en|no en|en cumbres|en san|en garcia|en mitras|ubicad|municipio|colonia|zona)\b/.test(hn)) {
    return false;
  }
  // Frases de intención / refinamiento — no son nombres (P0 ARGOS continuidad).
  if (
    /\b(quiero|busco|necesito|comprar|vender|rentar|arrendar|presupuesto|millones?|cerca|avenida|anuncio|campana|campaña|opciones?|mostrar|muestrame|muéstrame|interesa|perdon|perdón|disculpa|realidad|sigue|continuar|barata|ruido|vigilancia|alberca|amenidades|comparar|jardin|jardín|estacionamiento|recamaras|recámaras|baños|banos)\b/.test(
      hn,
    )
  ) {
    return false;
  }
  const words = h.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  if (
    words.length > 1 &&
    /^(hola|buenas|hey|perdon|perdón|mejor|mas|más|ok|vale|claro|si|sí|la|el|los|las|sin|con|mas|más)$/.test(
      normalizeText(words[0]),
    )
  ) {
    return false;
  }
  // Una sola palabra genérica / stopword conversacional.
  if (
    words.length === 1 &&
    /^(ok|vale|claro|sigue|gracias|bueno|hola|si|sí|ya|va|nada|perfecto)$/.test(hn)
  ) {
    return false;
  }
  return /^[a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)*$/i.test(h);
}

const INVALID_COMPOUND_NAME_HEAD = new Set(
  [
    'nada',
    'no',
    'nop',
    'si',
    'sí',
    'ok',
    'vale',
    'claro',
    'ya',
    'bueno',
    'gracias',
    'va',
    'ninguno',
    'ninguna',
    'hola',
    'buenas',
    'hey',
    'perdon',
    'perdón',
    'disculpa',
    'mejor',
    'mas',
    'más',
  ].map((w) => normalizeText(w)),
);

function isInvalidCompoundNameHead(head) {
  return INVALID_COMPOUND_NAME_HEAD.has(normalizeText(cleanSpaces(String(head || ''))));
}

/**
 * Intenta partir "Nombre, resto" / "Nombre. resto" para nombre + cola (consentimiento / canal).
 * @param {string} raw
 * @returns {{ name: string, tail: string }|null}
 */
function splitNameAndTail(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Correcciones de presupuesto / montos: no partir como "Nombre, cola".
  if (/\b(?:millon|millones|mdp|\d)\b/i.test(s) && /\b(?:realidad|perdon|perdón|disculpa|presupuesto|al mes)\b/i.test(s)) {
    return null;
  }
  if (/\b(?:vi\s+su\s+anuncio|su\s+anuncio|campa[nñ]a)\b/i.test(s)) {
    return null;
  }
  const m = s.match(/^(.+?)[\s]*[.,]\s+(.+)$/s);
  if (m && isLikelyFirstNameOnly(m[1]) && !isInvalidCompoundNameHead(m[1])) {
    const tail = cleanSpaces(m[2]);
    const tailN = normalizeText(tail);
    if (
      /\b(?:en\s+realidad|realidad|presupuesto|millones?|quiero|busco|necesito|comprar|vender|rentar|anuncio|campana|campaña)\b/.test(
        tailN,
      )
    ) {
      return null;
    }
    return { name: cleanSpaces(m[1]), tail };
  }
  const m2 = s.match(/^(.+?)\s+(por\s+whatsapp|por\s+wa)\s*$/i);
  if (m2 && isLikelyFirstNameOnly(m2[1]) && !isInvalidCompoundNameHead(m2[1])) {
    return { name: cleanSpaces(m2[1]), tail: cleanSpaces(m2[2]) };
  }
  return null;
}

module.exports = {
  parseChannelPreference,
  isLikelyFirstNameOnly,
  isInvalidCompoundNameHead,
  splitNameAndTail,
};
