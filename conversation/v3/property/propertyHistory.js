'use strict';

const { cleanSpaces } = require('../../../utils/text');
const { normalizeText } = require('../../../utils/text');

/**
 * @param {Array<{ code: string, at?: string }>|null|undefined} history
 * @param {string} code
 */
function appendPropertyHistory(history, code) {
  const c = cleanSpaces(String(code || ''));
  if (!c) return Array.isArray(history) ? [...history] : [];
  const prev = Array.isArray(history) ? history.filter((h) => h && h.code !== c) : [];
  const entry = { code: c, at: new Date().toISOString() };
  return [entry, ...prev].slice(0, 5);
}

function codeFromOption(option) {
  if (typeof option === 'string') return cleanSpaces(option) || null;
  return cleanSpaces(String(option?.code || option?.property_code || option?.listing_code || '')) || null;
}

function authorizedBatchCodes(state) {
  const source = Array.isArray(state.showBatch) && state.showBatch.length
    ? state.showBatch
    : Array.isArray(state.matchedOptions)
      ? state.matchedOptions
      : [];
  return [...new Set(source.map(codeFromOption).filter(Boolean))];
}

/**
 * Resuelve referencias ordinales a código de inventario.
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} text
 * @returns {string|null}
 */
function resolvePropertyReferenceCode(state, text) {
  const t = normalizeText(text);
  const hist = Array.isArray(state.propertyHistory) ? state.propertyHistory : [];
  const batch = authorizedBatchCodes(state);

  if (/\b(la\s+)?segunda\b|\bsegunda\s+propiedad\b|\bel\s+segundo\b/.test(t)) {
    return batch.length >= 2 ? batch[1] : null;
  }
  if (/\b(esa|esta)\s+(casa|propiedad)\b/.test(t)) {
    if (batch.length === 1) return batch[0];
    if (batch.length > 1) return null;
    const active = codeFromOption(state.activeProperty) || cleanSpaces(String(state.propertyListingCode || '')) || null;
    return active;
  }
  if (!hist.length && !batch.length) return null;

  if (/\b(la\s+)?primera\b|\bprimera\s+propiedad\b|\bel\s+primero\b/.test(t)) {
    if (batch.length) return batch[0];
    return cleanSpaces(String(hist[hist.length - 1]?.code || '')) || null;
  }
  if (/\b(la\s+)?ultima\b|\blo\s+ultimo\b|\bultima\s+propiedad\b/.test(t)) {
    return cleanSpaces(String(hist[0]?.code || '')) || null;
  }
  if (/\b(la\s+)?otra\b|\bese\s+otro\b|\bel\s+otro\b/.test(t) && hist.length >= 2) {
    return cleanSpaces(String(hist[0]?.code || '')) || null;
  }
  return null;
}

module.exports = {
  appendPropertyHistory,
  authorizedBatchCodes,
  resolvePropertyReferenceCode,
};
