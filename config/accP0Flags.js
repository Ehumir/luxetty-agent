'use strict';

/**
 * ACC + RAG P0 feature flags (Sprint 1).
 * Defaults seguros: todo OFF en producción hasta canary Sprint 6.
 * @see docs/architecture/APA_ACC_RAG_P0_6_SPRINTS.md §7
 */

function envTrue(name) {
  return process.env[name] === 'true';
}

function splitAllowlist(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeAllowlistEntry(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Global rollout — 100% tráfico RAG (sin allowlist). Rollback: flag OFF.
 * @returns {boolean}
 */
function isRagGlobalModeEnabled() {
  return isRagP0Enabled() && envTrue('RAG_P0_GLOBAL_MODE');
}

/**
 * Usuario elegible para RAG (global mode o allowlist canary).
 * @param {string|null|undefined} phoneOrId
 * @returns {boolean}
 */
function isRagCanaryEligible(phoneOrId) {
  if (!isRagP0Enabled()) return false;
  if (isRagGlobalModeEnabled()) return true;
  const list = splitAllowlist(process.env.RAG_P0_ALLOWLIST);
  if (!list.length) return false;
  const normalized = normalizeAllowlistEntry(phoneOrId);
  if (!normalized) return false;
  return list.some((entry) => {
    const e = normalizeAllowlistEntry(entry);
    if (!e) return false;
    return normalized === e || normalized.endsWith(e) || e.endsWith(normalized);
  });
}

/**
 * Inventario RAG efectivo para un usuario concreto.
 */
function isRagInventoryEffectiveForUser(phoneOrId) {
  return isRagInventoryEnabled() && isRagCanaryEligible(phoneOrId);
}

/**
 * Reglas RAG efectivas para un usuario concreto.
 */
function isRagRulesEffectiveForUser(phoneOrId) {
  return isRagRulesEnabled() && isRagCanaryEligible(phoneOrId);
}

/**
 * @returns {boolean}
 */
function isAccP0Enabled() {
  return envTrue('ACC_P0_ENABLED');
}

/**
 * @returns {boolean}
 */
function isAccWhatsappGatewayEnabled() {
  return isAccP0Enabled() && envTrue('ACC_WHATSAPP_GATEWAY_ENABLED');
}

/**
 * @returns {boolean}
 */
function isAccFacebookEnabled() {
  return isAccP0Enabled() && envTrue('ACC_FACEBOOK_ENABLED');
}

/**
 * @returns {boolean}
 */
function isAccInstagramEnabled() {
  return isAccP0Enabled() && envTrue('ACC_INSTAGRAM_ENABLED');
}

/**
 * @returns {boolean}
 */
function isRagP0Enabled() {
  return envTrue('RAG_P0_ENABLED');
}

/**
 * @returns {boolean}
 */
function isRagInventoryEnabled() {
  return isRagP0Enabled() && envTrue('RAG_INVENTORY_ENABLED');
}

/**
 * @returns {boolean}
 */
function isRagRulesEnabled() {
  return isRagP0Enabled() && envTrue('RAG_RULES_ENABLED');
}

/**
 * RQ-3 — domain-aware routing (certificado). Requiere RAG_P0_ENABLED.
 * @returns {boolean}
 */
function isRagDomainRoutingEnabled() {
  return isRagP0Enabled() && envTrue('RAG_DOMAIN_ROUTING_ENABLED');
}

/**
 * RQ-4 — adaptive threshold por dominio. Requiere domain routing ON.
 * @returns {boolean}
 */
function isRagAdaptiveThresholdEnabled() {
  return isRagDomainRoutingEnabled() && envTrue('RAG_ADAPTIVE_THRESHOLD_ENABLED');
}

/**
 * RC-1.1 — validación entidad zona/colonia post-retrieval (NEG-03 fix).
 * @returns {boolean}
 */
function isRagRc11ZoneEntityValidationEnabled() {
  return isRagRulesEnabled() && envTrue('RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED');
}

/**
 * RC-1.1 — telemetría extendida (inventory paths, timing breakdown).
 * @returns {boolean}
 */
function isRagRc11TelemetryEnabled() {
  return isRagP0Enabled() && envTrue('RAG_RC11_TELEMETRY_ENABLED');
}

/**
 * RC-1.2 — validación entidad campaña post-retrieval (NEG-C01 fix).
 * @returns {boolean}
 */
function isRagRc12CampaignEntityValidationEnabled() {
  return isRagRulesEnabled() && envTrue('RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED');
}

/**
 * Hybrid FTS + vector retrieval (match_knowledge_chunks_hybrid).
 * @returns {boolean}
 */
function isRagHybridEnabled() {
  return isRagP0Enabled() && envTrue('RAG_HYBRID_ENABLED');
}

/**
 * Inventario demanda (SQL + RAG rerank) — OFF por defecto; canary por allowlist.
 * Independiente de RAG_P0: puede activarse solo para opciones de stock.
 */
function isInventoryOptionsEnabled() {
  return envTrue('PERSEO_INVENTORY_OPTIONS_ENABLED');
}

function isInventoryOptionsGlobal() {
  return isInventoryOptionsEnabled() && envTrue('PERSEO_INVENTORY_OPTIONS_GLOBAL');
}

function isInventoryOptionsEffectiveForUser(phoneOrId) {
  if (!isInventoryOptionsEnabled()) return false;
  if (isInventoryOptionsGlobal()) return true;
  const list = splitAllowlist(process.env.PERSEO_INVENTORY_OPTIONS_ALLOWLIST);
  if (!list.length) return false;
  const normalized = normalizeAllowlistEntry(phoneOrId);
  if (!normalized) return false;
  return list.some((entry) => {
    const e = normalizeAllowlistEntry(entry);
    if (!e) return false;
    return normalized === e || normalized.endsWith(e) || e.endsWith(normalized);
  });
}

/** Cover/gallery SoT in PROPERTY_QA — default OFF. */
function isRagPropertyImagesEnabled() {
  return envTrue('RAG_PROPERTY_IMAGES_ENABLED');
}

/** Planner tool-calling consultivo — default OFF. */
function isConsultiveToolsEnabled() {
  return envTrue('PERSEO_CONSULTIVE_TOOLS_ENABLED');
}

function isConsultiveToolsGlobal() {
  return isConsultiveToolsEnabled() && envTrue('PERSEO_CONSULTIVE_TOOLS_GLOBAL');
}

function isConsultiveToolsEffectiveForUser(phoneOrId) {
  if (!isConsultiveToolsEnabled()) return false;
  if (isConsultiveToolsGlobal()) return true;
  const list = splitAllowlist(process.env.PERSEO_CONSULTIVE_TOOLS_ALLOWLIST);
  if (!list.length) return false;
  const normalized = normalizeAllowlistEntry(phoneOrId);
  if (!normalized) return false;
  return list.some((entry) => {
    const e = normalizeAllowlistEntry(entry);
    if (!e) return false;
    return normalized === e || normalized.endsWith(e) || e.endsWith(normalized);
  });
}

/**
 * Lectura diagnóstica para ARGOS / logs (sin secretos).
 * @returns {Record<string, boolean | string[] | number>}
 */
function getAccRagP0FlagSnapshot() {
  return {
    ACC_P0_ENABLED: envTrue('ACC_P0_ENABLED'),
    ACC_WHATSAPP_GATEWAY_ENABLED: envTrue('ACC_WHATSAPP_GATEWAY_ENABLED'),
    ACC_FACEBOOK_ENABLED: envTrue('ACC_FACEBOOK_ENABLED'),
    ACC_INSTAGRAM_ENABLED: envTrue('ACC_INSTAGRAM_ENABLED'),
    RAG_P0_ENABLED: envTrue('RAG_P0_ENABLED'),
    RAG_INVENTORY_ENABLED: envTrue('RAG_INVENTORY_ENABLED'),
    RAG_RULES_ENABLED: envTrue('RAG_RULES_ENABLED'),
    RAG_HYBRID_ENABLED: envTrue('RAG_HYBRID_ENABLED'),
    PERSEO_INVENTORY_OPTIONS_ENABLED: envTrue('PERSEO_INVENTORY_OPTIONS_ENABLED'),
    PERSEO_INVENTORY_OPTIONS_GLOBAL: envTrue('PERSEO_INVENTORY_OPTIONS_GLOBAL'),
    ACC_P0_EFFECTIVE_WHATSAPP_GATEWAY: isAccWhatsappGatewayEnabled(),
    ACC_P0_EFFECTIVE_FACEBOOK: isAccFacebookEnabled(),
    ACC_P0_EFFECTIVE_INSTAGRAM: isAccInstagramEnabled(),
    RAG_P0_EFFECTIVE_INVENTORY: isRagInventoryEnabled(),
    RAG_P0_EFFECTIVE_RULES: isRagRulesEnabled(),
    RAG_P0_EFFECTIVE_HYBRID: isRagHybridEnabled(),
    INVENTORY_OPTIONS_EFFECTIVE: isInventoryOptionsEnabled(),
    RAG_DOMAIN_ROUTING_ENABLED: isRagDomainRoutingEnabled(),
    RAG_ADAPTIVE_THRESHOLD_ENABLED: isRagAdaptiveThresholdEnabled(),
    RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED: isRagRc11ZoneEntityValidationEnabled(),
    RAG_RC11_TELEMETRY_ENABLED: isRagRc11TelemetryEnabled(),
    RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED: isRagRc12CampaignEntityValidationEnabled(),
    RAG_P0_GLOBAL_MODE: isRagGlobalModeEnabled(),
    RAG_PROPERTY_IMAGES_ENABLED: isRagPropertyImagesEnabled(),
    PERSEO_CONSULTIVE_TOOLS_ENABLED: isConsultiveToolsEnabled(),
    PERSEO_CONSULTIVE_TOOLS_GLOBAL: isConsultiveToolsGlobal(),
    RAG_P0_ALLOWLIST_COUNT: isRagGlobalModeEnabled() ? 0 : splitAllowlist(process.env.RAG_P0_ALLOWLIST).length,
    ACC_CANARY_ALLOWLIST_COUNT: splitAllowlist(process.env.ACC_CANARY_ALLOWLIST).length,
    INVENTORY_OPTIONS_ALLOWLIST_COUNT: splitAllowlist(process.env.PERSEO_INVENTORY_OPTIONS_ALLOWLIST)
      .length,
  };
}

module.exports = {
  isAccP0Enabled,
  isAccWhatsappGatewayEnabled,
  isAccFacebookEnabled,
  isAccInstagramEnabled,
  isRagP0Enabled,
  isRagInventoryEnabled,
  isRagRulesEnabled,
  isRagDomainRoutingEnabled,
  isRagAdaptiveThresholdEnabled,
  isRagHybridEnabled,
  isRagRc11ZoneEntityValidationEnabled,
  isRagRc11TelemetryEnabled,
  isRagRc12CampaignEntityValidationEnabled,
  isRagGlobalModeEnabled,
  isRagCanaryEligible,
  isRagInventoryEffectiveForUser,
  isRagRulesEffectiveForUser,
  isInventoryOptionsEnabled,
  isInventoryOptionsGlobal,
  isInventoryOptionsEffectiveForUser,
  isRagPropertyImagesEnabled,
  isConsultiveToolsEnabled,
  isConsultiveToolsGlobal,
  isConsultiveToolsEffectiveForUser,
  getAccRagP0FlagSnapshot,
  splitAllowlist,
  normalizeAllowlistEntry,
};
