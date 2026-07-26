'use strict';

const { normalizePhoneNumber } = require('../utils/helpers');

/**
 * Solo coma o punto y coma — NO partir por espacios (permite "+52 81 1908 6196" en una entrada).
 */
function splitAllowlist(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Misma normalización que el webhook (`index.js` → `from`).
 */
function normalizeInboundPhoneForV3(phone) {
  return normalizePhoneNumber(phone) || digitsOnly(phone) || null;
}

function normalizeAllowlistEntry(entry) {
  return normalizePhoneNumber(entry) || digitsOnly(entry) || null;
}

function phonesEquivalent(inboundNorm, entryNorm) {
  if (!inboundNorm || !entryNorm) return false;
  if (inboundNorm === entryNorm) return true;

  const in10 =
    inboundNorm.length === 13 && inboundNorm.startsWith('521') ? inboundNorm.slice(3) : null;
  const en10 =
    entryNorm.length === 13 && entryNorm.startsWith('521') ? entryNorm.slice(3) : null;
  if (in10 && entryNorm === in10) return true;
  if (en10 && inboundNorm === en10) return true;
  if (in10 && en10 && in10 === en10) return true;

  return false;
}

/**
 * Diagnóstico explícito del gate V3 primary (F2 hotfix).
 * @param {{ phone: string, rawPhone?: string|null, argosMode?: boolean, propertyEntryEligible?: boolean, propertyEntryBypassReason?: string|null }} input
 */
function evaluateV3PrimaryGate(input) {
  const rawPhone = input?.rawPhone != null ? String(input.rawPhone) : String(input?.phone || '');
  const phoneArg = String(input?.phone || '');
  const cfg = getPerseoV3Config();
  const engineRequested = String(process.env.PERSEO_ENGINE || 'legacy').trim().toLowerCase() || 'legacy';
  const argosMode = input?.argosMode === true && process.env.PERSEO_ARGOS_ENABLED === 'true';

  const normalizedInbound = normalizeInboundPhoneForV3(phoneArg);
  const normalizedRaw = normalizeInboundPhoneForV3(rawPhone);

  const base = {
    v3_enabled: cfg.enabled,
    v3_shadow_mode: cfg.shadowMode,
    v3_engine_requested: engineRequested,
    v3_requires_perseo_engine_v3: false,
    argos_mode: argosMode,
    inbound_raw: rawPhone || null,
    inbound_normalized: normalizedInbound,
    inbound_normalized_from_raw: normalizedRaw,
    allowlist_entries_raw: cfg.qaAllowlist,
    allowlist_entries_normalized: cfg.qaAllowlist.map((e) => normalizeAllowlistEntry(e)),
  };

  if (argosMode) {
    if (!cfg.enabled) {
      return {
        ...base,
        allowlist_match: false,
        v3_primary_allowed: false,
        v3_primary_block_reason: 'v3_disabled',
        route: 'legacy_primary',
      };
    }
    return {
      ...base,
      allowlist_match: true,
      v3_primary_allowed: true,
      v3_primary_block_reason: null,
      route: 'v3_primary',
    };
  }

  if (!cfg.enabled) {
    return {
      ...base,
      allowlist_match: false,
      v3_primary_allowed: false,
      v3_primary_block_reason: 'v3_disabled',
      route: 'legacy_primary',
    };
  }

  if (cfg.globalMode) {
    return {
      ...base,
      allowlist_match: true,
      v3_primary_allowed: true,
      v3_primary_block_reason: null,
      v3_primary_bypass_reason: 'global_mode',
      route: 'v3_primary',
    };
  }

  if (!cfg.qaAllowlist.length) {
    return {
      ...base,
      allowlist_match: false,
      v3_primary_allowed: false,
      v3_primary_block_reason: 'allowlist_empty',
      route: 'legacy_primary',
    };
  }

  if (!normalizedInbound) {
    return {
      ...base,
      allowlist_match: false,
      v3_primary_allowed: false,
      v3_primary_block_reason: 'inbound_phone_unnormalizable',
      route: 'legacy_primary',
    };
  }

  let matchedEntry = null;
  for (const entry of cfg.qaAllowlist) {
    const entryNorm = normalizeAllowlistEntry(entry);
    if (phonesEquivalent(normalizedInbound, entryNorm)) {
      matchedEntry = entry;
      break;
    }
  }

  if (!matchedEntry) {
    if (
      process.env.PERSEO_V3_PROPERTY_ENTRY_AUTO_PRIMARY === 'true' &&
      input.propertyEntryEligible === true
    ) {
      return {
        ...base,
        allowlist_match: false,
        v3_primary_allowed: true,
        v3_primary_block_reason: null,
        v3_primary_bypass_reason: input.propertyEntryBypassReason || 'property_entry',
        route: 'v3_primary',
      };
    }
    return {
      ...base,
      allowlist_match: false,
      v3_primary_allowed: false,
      v3_primary_block_reason: 'allowlist_no_match',
      route: 'legacy_primary',
    };
  }

  return {
    ...base,
    allowlist_match: true,
    allowlist_matched_entry: matchedEntry,
    v3_primary_allowed: true,
    v3_primary_block_reason: null,
    route: 'v3_primary',
  };
}

/**
 * @returns {{
 *   enabled: boolean,
 *   shadowMode: boolean,
 *   handoffEnabled: boolean,
 *   crmDryRun: boolean,
 *   crmExecute: boolean,
 *   sessionDbReadthrough: boolean,
 *   qaAllowlist: string[],
 *   logStructured: boolean,
 * }}
 */
function getPerseoV3Config() {
  return {
    enabled: process.env.PERSEO_V3_ENABLED === 'true',
    globalMode: process.env.PERSEO_V3_GLOBAL_MODE === 'true',
    shadowMode: process.env.PERSEO_V3_SHADOW_MODE === 'true',
    handoffEnabled: process.env.PERSEO_V3_HANDOFF_ENABLED === 'true',
    crmDryRun: process.env.PERSEO_V3_CRM_DRY_RUN !== 'false',
    crmExecute: process.env.PERSEO_V3_CRM_EXECUTE === 'true',
    sessionDbReadthrough: process.env.PERSEO_V3_SESSION_DB_READTHROUGH !== 'false',
    propertyEntryAutoPrimary: process.env.PERSEO_V3_PROPERTY_ENTRY_AUTO_PRIMARY === 'true',
    qaAllowlist: splitAllowlist(process.env.PERSEO_V3_QA_ALLOWLIST),
    logStructured: process.env.PERSEO_V3_LOG === 'true',
    // ATENA Solicitantes Calificados V2 — OFF by default (PRODUCTION_ENFORCEMENT NO-GO)
    qualifiedApplicantsV2: process.env.PERSEO_QUALIFIED_APPLICANTS_V2 === 'true',
    qualifiedApplicantsPerseoGate:
      process.env.PERSEO_QUALIFIED_APPLICANTS_PERSEO_GATE === 'true',
  };
}

function isV3HandoffEnabled() {
  return getPerseoV3Config().handoffEnabled;
}

function isSessionDbReadthroughEnabled() {
  return getPerseoV3Config().sessionDbReadthrough;
}

function isPhoneOnV3Allowlist(phone) {
  return evaluateV3PrimaryGate({ phone }).allowlist_match;
}

/** Match contra PERSEO_V3_QA_ALLOWLIST sin exigir PERSEO_V3_ENABLED (canary APA Intake). */
function isPhoneOnPerseoQaAllowlist(phone) {
  const cfg = getPerseoV3Config();
  if (!cfg.qaAllowlist.length) return false;

  const normalizedInbound = normalizeInboundPhoneForV3(phone);
  if (!normalizedInbound) return false;

  for (const entry of cfg.qaAllowlist) {
    const entryNorm = normalizeAllowlistEntry(entry);
    if (phonesEquivalent(normalizedInbound, entryNorm)) {
      return true;
    }
  }
  return false;
}

function shouldRouteInboundToV3Core(phone) {
  return evaluateV3PrimaryGate({ phone }).v3_primary_allowed;
}

function resolveInboundRoutingMode(phone) {
  return evaluateV3PrimaryGate({ phone }).route;
}

module.exports = {
  getPerseoV3Config,
  isV3HandoffEnabled,
  isSessionDbReadthroughEnabled,
  isPhoneOnV3Allowlist,
  isPhoneOnPerseoQaAllowlist,
  shouldRouteInboundToV3Core,
  evaluateV3PrimaryGate,
  resolveInboundRoutingMode,
  normalizeInboundPhoneForV3,
  normalizeAllowlistEntry,
  splitAllowlist,
};
