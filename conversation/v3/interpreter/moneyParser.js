'use strict';

const { normalizeText } = require('../../../utils/text');
const { isPhoneLikeText } = require('../../../utils/phoneMoneyGuard');
const { isConversationalFlexEnabled } = require('../../../config/perseoM405Flags');
const { parseFlexMoneyAmount } = require('../../flexibility/slangLexicon');
const { recordFlexApplied } = require('../../flexibility/flexTelemetry');

/**
 * @param {string} text
 * @returns {number|null}
 */
function parseMoneyAmount(text) {
  if (isPhoneLikeText(text)) return null;

  const flex = parseFlexMoneyAmount(text);
  if (flex?.amount != null) {
    if (isConversationalFlexEnabled()) {
      recordFlexApplied('money', { confidence: flex.confidence });
    }
    return flex.amount;
  }

  const t = normalizeText(text);
  // "menos de 50 mil" must win before the millions default on empty unit.
  const belowMil = t.match(
    /(?:por\s+)?(?:debajo|menos|menor)\s+(?:de|a)\s+(\d+(?:[.,]\d+)?)\s*(?:mil|miles)\b/
  );
  if (belowMil) {
    const n = Number(belowMil[1].replace(',', '.'));
    if (Number.isFinite(n) && n > 0 && n < 10_000) return Math.round(n * 1_000);
  }
  const below = t.match(
    /(?:por\s+)?(?:debajo|menos)\s+de\s+(\d+(?:[.,]\d+)?)\s*(millones|millon|millón|m\b|mdp)?/
  );
  if (below) {
    const n = Number(below[1].replace(',', '.'));
    const unit = below[2] || '';
    // Empty unit after "menos de N" defaults to millions only when no "mil" nearby.
    if (unit === 'm' || !unit || /millon/.test(unit) || unit === 'mdp') {
      return Math.round(n * 1_000_000);
    }
  }
  const mill = t.match(/(\d+(?:[.,]\d+)?)\s*(millones|millon|millón|mdp)/);
  if (mill) {
    const n = Number(mill[1].replace(',', '.'));
    return Math.round(n * 1_000_000);
  }
  const mShort = t.match(/\b(\d+(?:[.,]\d+)?)\s*m\b/);
  if (mShort) return Math.round(Number(mShort[1].replace(',', '.')) * 1_000_000);
  const mdp = t.match(/\b(\d+(?:[.,]\d+)?)\s*mdp\b/);
  if (mdp) return Math.round(Number(mdp[1].replace(',', '.')) * 1_000_000);

  const mil = t.match(
    /\b(?:presupuesto|renta\s+mensual|mensualidad|hasta|max|de)?\s*(\d+(?:[.,]\d+)?)\s*mil\b/
  );
  if (mil) {
    const n = Number(mil[1].replace(',', '.'));
    if (Number.isFinite(n) && n > 0 && n < 10_000) return Math.round(n * 1_000);
  }

  const plain = t.match(/(?:\$|mxn\s*)?(\d{1,3}(?:,\d{3})+|\d{4,7})\b/);
  if (plain) {
    const n = Number(String(plain[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1_000 && n <= 500_000_000) return Math.round(n);
  }

  return null;
}

module.exports = {
  parseMoneyAmount,
};
