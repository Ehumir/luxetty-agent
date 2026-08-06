'use strict';

const { cleanSpaces, normalizeText } = require('../../../utils/text');
const { isConversationalFlexEnabled } = require('../../../config/perseoM405Flags');
const { fuzzyResolveZone, isFuzzyKnownZoneToken } = require('../../flexibility/typoTolerance');
const { recordFlexApplied } = require('../../flexibility/flexTelemetry');

/**
 * Extrae zona/colonia desde frases tipo "Está en San Pedro".
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeLocationFromUserText(raw) {
  let t = cleanSpaces(String(raw || ''));
  if (!t) return null;

  try {
    const { isNonLocationPhrase } = require('./campaignIntake');
    if (isNonLocationPhrase(t)) return null;
  } catch {
    /* ignore circular require during bootstrap */
  }

  // Corrección conversacional: "No, está en San Pedro" → zona San Pedro
  t = t.replace(/^(?:no|nop|nope)[,\s]+/i, '').trim();

  const lower = normalizeText(t);
  let explicitLocation = false;

  // Referencias geográficas naturales a hitos (p. ej. hospitales). La frase
  // introductoria aporta el contexto geográfico; no se acepta texto libre sin
  // ese ancla.
  const landmark = t.match(
    /\b(?:por\s+(?:el\s+)?[aá]rea\s+d(?:e|el)|cerca\s+d(?:e|el)|alrededor\s+d(?:e|el))\s+(.+?)(?=\s*(?:[,.?!]|$))/i,
  );
  if (landmark?.[1]) {
    const value = cleanSpaces(landmark[1]).replace(/^(?:la|el)\s+/i, '');
    if (value && value.length <= 80 && !/\b(?:presupuesto|pesos|rec[aá]maras?)\b/i.test(value)) {
      return value
        .split(/\s+/)
        .map((word) => word.length ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word)
        .join(' ');
    }
  }

  const fuzzy = isConversationalFlexEnabled() ? fuzzyResolveZone(t) : null;
  if (fuzzy) {
    recordFlexApplied('zone', { canonical: fuzzy });
    return fuzzy;
  }
  /** Preguntas sin ancla de lugar no son colonia (evita contaminar `location_text` en flujos mixtos). */
  if (
    /\?/.test(t) &&
    /^(¿|\s)*(donde|dónde)\s+(esta|está|estan|están|esta el|esta la)?\s*\??$/i.test(lower.replace(/\s+/g, ' ').trim())
  ) {
    return null;
  }
  if (/\?/.test(t) && /\b(cuanto|cuánto|cuesta|precio|me\s+puedes\s+dar)\b/i.test(lower) && !/\b(en|colonia|zona\s+de)\s+\w+/i.test(lower)) {
    return null;
  }

  if (lower.includes('cumbres')) {
    explicitLocation = true;
    return 'Cumbres';
  }
  if (/\bsan\s+pedro\b/.test(lower)) {
    explicitLocation = true;
    return 'San Pedro';
  }
  if (/\bgarcia\b/.test(lower) || /\bgarcía\b/.test(lower)) {
    explicitLocation = true;
    return 'García';
  }
  if (/\bcarretera\s+nacional\b/.test(lower)) {
    explicitLocation = true;
    return 'Carretera Nacional';
  }

  const queEn = t.match(/\bque\s+en\s+(.+)$/i);
  if (queEn && queEn[1]) {
    t = cleanSpaces(queEn[1]);
  }

  const prefixPatterns = [
    /^(?:no,?\s*)?(?:esta|está|ubicada|ubicado|queda|se encuentra|localizada|localizado)\s+en\s+(.+)$/i,
    /^(?:en|la zona es|zona|colonia|municipio)\s+(.+)$/i,
    /^(?:es|seria|sería)\s+en\s+(.+)$/i,
  ];

  for (const pattern of prefixPatterns) {
    const m = t.match(pattern);
    if (m && m[1]) {
      t = cleanSpaces(m[1]);
      explicitLocation = true;
      break;
    }
  }

  if (!explicitLocation) return null;

  t = t.replace(/^(?:la|el|los|las)\s+/i, '').trim();
  if (!t) return null;
  if (t.length > 120) t = t.slice(0, 120);
  if (/^(busco|quiero|necesito)\b/i.test(t)) return null;

  return t;
}

/**
 * @param {string} raw
 */
function isBareKnownZoneToken(raw) {
  const t = normalizeText(String(raw || ''));
  if (!t || t.split(/\s+/).length > 3) return false;
  if (
    /^(cumbres|san pedro|garcia|garcía|carretera nacional|monterrey|valle oriente|san nicolas|san nicolás)$/.test(
      t,
    )
  ) {
    return true;
  }
  if (isConversationalFlexEnabled() && isFuzzyKnownZoneToken(raw)) return true;
  return false;
}

module.exports = {
  normalizeLocationFromUserText,
  isBareKnownZoneToken,
};
