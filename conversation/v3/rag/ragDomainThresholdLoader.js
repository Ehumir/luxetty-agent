'use strict';

/**
 * RQ-4 — Loader runtime de thresholds por dominio (certificado offline).
 * Lee RAG_DOMAIN_THRESHOLDS_JSON una sola vez al cargar el módulo.
 * Sin recalibración ni edición dinámica.
 */

const { DEFAULT_MIN_SCORE } = require('./ragPolicy');
const { isRagAdaptiveThresholdEnabled } = require('../../../config/accP0Flags');

const OFFICIAL_DOMAINS = [
  'properties',
  'commercial_objections',
  'assignment_rules',
  'rules_atena',
  'rules_perseo',
  'zones',
  'campaigns',
  'scripts',
];

/** Valores certificados RQ-4 — fallback si env ausente cuando adaptive ON */
const RQ4_CERTIFIED_THRESHOLDS = {
  properties: 0.78,
  commercial_objections: 0.55,
  assignment_rules: 0.55,
  rules_atena: 0.45,
  rules_perseo: 0.45,
  zones: 0.45,
  campaigns: 0.45,
  scripts: 0.72,
};

let _loaded = false;
let _thresholds = null;
let _loadError = null;
let _source = 'none';

function isValidThreshold(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.4 && v <= 0.95;
}

function parseThresholdJson(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const map = parsed?.thresholds && typeof parsed.thresholds === 'object' ? parsed.thresholds : parsed;
  if (!map || typeof map !== 'object') {
    throw new Error('RAG_DOMAIN_THRESHOLDS_JSON must be object or { thresholds: {...} }');
  }
  const out = {};
  for (const domain of OFFICIAL_DOMAINS) {
    const v = Number(map[domain]);
    if (map[domain] != null && !isValidThreshold(v)) {
      throw new Error(`invalid threshold for ${domain}: ${map[domain]}`);
    }
    if (isValidThreshold(v)) out[domain] = v;
  }
  if (!Object.keys(out).length) {
    throw new Error('RAG_DOMAIN_THRESHOLDS_JSON has no valid domain entries');
  }
  return out;
}

function loadThresholdsOnce() {
  if (_loaded) return;
  _loaded = true;

  if (!isRagAdaptiveThresholdEnabled()) {
    _thresholds = {};
    _source = 'disabled_adaptive_flag';
    return;
  }

  const raw = process.env.RAG_DOMAIN_THRESHOLDS_JSON;
  if (!raw || !String(raw).trim()) {
    _thresholds = { ...RQ4_CERTIFIED_THRESHOLDS };
    _source = 'rq4_certified_defaults';
    return;
  }

  try {
    _thresholds = parseThresholdJson(raw);
    for (const domain of OFFICIAL_DOMAINS) {
      if (_thresholds[domain] == null && RQ4_CERTIFIED_THRESHOLDS[domain] != null) {
        _thresholds[domain] = RQ4_CERTIFIED_THRESHOLDS[domain];
      }
    }
    _source = 'env_json';
  } catch (err) {
    _loadError = String(err.message || err);
    _thresholds = { ...RQ4_CERTIFIED_THRESHOLDS };
    _source = 'rq4_certified_fallback_after_error';
  }
}

function getMinScoreForDomain(domain) {
  loadThresholdsOnce();
  if (!isRagAdaptiveThresholdEnabled()) {
    return DEFAULT_MIN_SCORE;
  }
  const d = domain || 'scripts';
  return _thresholds?.[d] ?? DEFAULT_MIN_SCORE;
}

function getThresholdAuditSnapshot() {
  loadThresholdsOnce();
  return {
    adaptive_enabled: isRagAdaptiveThresholdEnabled(),
    source: _source,
    load_error: _loadError,
    global_fallback: DEFAULT_MIN_SCORE,
    domain_count: _thresholds ? Object.keys(_thresholds).length : 0,
    thresholds: _thresholds ? { ..._thresholds } : {},
    certified_reference: RQ4_CERTIFIED_THRESHOLDS,
  };
}

function resetThresholdLoaderForTests() {
  _loaded = false;
  _thresholds = null;
  _loadError = null;
  _source = 'none';
}

module.exports = {
  OFFICIAL_DOMAINS,
  RQ4_CERTIFIED_THRESHOLDS,
  getMinScoreForDomain,
  getThresholdAuditSnapshot,
  resetThresholdLoaderForTests,
  parseThresholdJson,
};
