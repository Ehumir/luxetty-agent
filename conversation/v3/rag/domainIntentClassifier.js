'use strict';

/**
 * RQ-3 — Clasificador determinístico de dominio (sin LLM).
 * Dominios oficiales únicamente.
 */

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

/** @typedef {{ domain: string, confidence: number, reason: string, secondary_domain?: string|null }} DomainIntent */

const HIGH = 0.92;
const MED = 0.78;
const LOW = 0.55;

/**
 * Reglas ordenadas por prioridad (captación antes que demanda inventario).
 * @type {Array<{ domain: string, weight: number, re: RegExp, reason: string }>}
 */
const INTENT_RULES = [
  {
    domain: 'commercial_objections',
    weight: HIGH,
    re: /\bcu[aá]nto\s+vale\b|\bvaluaci[oó]n\b|\baval[uú]o\b|\bcu[aá]nto\s+puedo\s+pedir\b/i,
    reason: 'valuacion_keywords',
  },
  {
    domain: 'commercial_objections',
    weight: HIGH,
    re: /\b(vender\s+mi|rentar\s+mi|captaci[oó]n|captar|propietario|listar\s+mi|poner\s+en\s+venta|ofrecer\s+mi\s+inmueble)\b/i,
    reason: 'captacion_propietario_keywords',
  },
  {
    domain: 'commercial_objections',
    weight: HIGH,
    re: /\bcomisi[oó]n\b|\bexclusiv|\bcu[aá]nto\s+cobran\b|\bhonorarios\b/i,
    reason: 'commercial_objection_keywords',
  },
  {
    domain: 'properties',
    weight: HIGH,
    re: /\bLUX-A\d{4}\b/i,
    reason: 'listing_id_explicit',
  },
  {
    domain: 'properties',
    weight: HIGH,
    re: /\b(busco|necesito|me interesa)\b.{0,50}\b(casa|departamento|depa|terreno|propiedad|residencia|local)\b/i,
    reason: 'demand_inventory_search',
  },
  {
    domain: 'properties',
    weight: MED,
    re: /\b(casa|departamento|depa|terreno)\b.{0,40}\b(en|con)\b/i,
    reason: 'property_type_location',
  },
  {
    domain: 'properties',
    weight: MED,
    re: /\b(casa|departamento|depa)\b.{0,30}\b(renta|rentar|venta|comprar|alquiler)\b/i,
    reason: 'property_operation_demand',
  },
  {
    domain: 'properties',
    weight: MED,
    re: /\b(jard[ií]n|rec[aá]maras?|ba[nñ]os?|amenidades?|alberca|estacionamiento)\b/i,
    reason: 'property_amenity_query',
  },
  {
    domain: 'properties',
    weight: MED,
    re: /\b(cu[aá]nto\s+cuesta|precio\s+de|info\s+de)\b.{0,30}\bLUX-/i,
    reason: 'listing_price_query',
  },
  {
    domain: 'assignment_rules',
    weight: HIGH,
    re: /\basignaci[oó]n\b|\bownership\b|\bdue[nñ]o\b|\bDIOS\s*mode\b|\bdios\s+mode\b/i,
    reason: 'assignment_keywords',
  },
  {
    domain: 'rules_atena',
    weight: MED,
    re: /\bsolicitud\b|\blead\b|\bcontacto\b|\bCRM\b/i,
    reason: 'atena_rules_keywords',
  },
  {
    domain: 'rules_perseo',
    weight: MED,
    re: /\bpol[ií]tica\b|\bregla\b|\bno\s+invent|\bPERSEO\b/i,
    reason: 'perseo_rules_keywords',
  },
  {
    domain: 'campaigns',
    weight: MED,
    re: /\bcampa[nñ]a\b|\bpauta\b|\bmeta\b|\bfacebook\b|\binstagram\b|\banuncio\b/i,
    reason: 'campaign_keywords',
  },
  {
    domain: 'zones',
    weight: MED,
    re: /\bcolonia\b|\bzona\b|\bubicaci[oó]n\b|\bsector\b|\bd[oó]nde\s+queda\b/i,
    reason: 'zone_keywords',
  },
  {
    domain: 'scripts',
    weight: LOW,
    re: /\b(buen\s+d[ií]a|buenas\s+tardes|hola|gracias|siguiente\s+paso|agendar)\b/i,
    reason: 'conversational_script',
  },
];

const SECONDARY_BY_DOMAIN = {
  commercial_objections: 'scripts',
  assignment_rules: 'rules_perseo',
  rules_atena: 'rules_perseo',
  rules_perseo: 'rules_atena',
  zones: 'scripts',
  campaigns: 'scripts',
  scripts: 'commercial_objections',
  properties: 'zones',
};

/** RQ-4.7 — cadena ordenada de dominios secundarios (sin búsqueda global). */
const SECONDARY_CHAIN_BY_DOMAIN = {
  commercial_objections: ['scripts', 'rules_perseo'],
  assignment_rules: ['rules_perseo'],
  rules_atena: ['rules_perseo'],
  rules_perseo: ['rules_atena'],
  zones: ['scripts'],
  campaigns: ['scripts', 'rules_perseo'],
  scripts: ['commercial_objections'],
  properties: ['zones'],
};

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RQ-4.7 — quita ruido del harness QA sin alterar intención. */
function stripHarnessNoise(text) {
  return normalizeText(text)
    .replace(/\s*\[rq5-[a-z0-9.-]+\]\s*/gi, ' ')
    .replace(/\s*\[rq47-[a-z0-9.-]+\]\s*/gi, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {DomainIntent}
 */
function classifyDomainIntent(text) {
  const t = normalizeText(text);
  if (!t) {
    return { domain: 'scripts', confidence: 0.3, reason: 'empty_text', secondary_domain: null };
  }

  const hits = [];
  for (const rule of INTENT_RULES) {
    if (rule.re.test(t)) {
      hits.push(rule);
    }
  }

  if (!hits.length) {
    return {
      domain: 'scripts',
      confidence: 0.4,
      reason: 'no_keyword_match_default_scripts',
      secondary_domain: 'commercial_objections',
    };
  }

  // Captación gana sobre demanda "quiero casa" cuando ambos matchean
  const captacion = hits.find((h) => h.reason === 'captacion_propietario_keywords');
  if (captacion) {
    return {
      domain: captacion.domain,
      confidence: captacion.weight,
      reason: captacion.reason,
      secondary_domain: SECONDARY_BY_DOMAIN[captacion.domain] || null,
    };
  }

  const primary = hits[0];
  const secondaryHit = hits.find((h) => h.domain !== primary.domain);

  let confidence = primary.weight;
  if (hits.length > 1 && secondaryHit) {
    confidence = Math.max(LOW, primary.weight - 0.12);
  }

  return {
    domain: primary.domain,
    confidence: Number(confidence.toFixed(3)),
    reason: primary.reason,
    secondary_domain:
      confidence < MED && secondaryHit
        ? secondaryHit.domain
        : SECONDARY_BY_DOMAIN[primary.domain] || null,
  };
}

/**
 * Compat RQ-1/RQ-2: devuelve dominio de reglas o null (excluye properties).
 * @param {string} text
 * @returns {string|null}
 */
function detectRulesDomain(text) {
  const intent = classifyDomainIntent(text);
  if (intent.domain === 'properties') return null;
  if (OFFICIAL_DOMAINS.includes(intent.domain) && intent.domain !== 'scripts') {
    return intent.domain;
  }
  if (intent.domain === 'scripts' && intent.confidence < LOW) return null;
  return intent.domain === 'scripts' ? null : intent.domain;
}

function isHighConfidence(intent) {
  return Number(intent?.confidence ?? 0) >= MED;
}

function shouldBlockInventoryForRulesIntent(text) {
  const intent = classifyDomainIntent(text);
  return intent.domain !== 'properties' && isHighConfidence(intent);
}

module.exports = {
  OFFICIAL_DOMAINS,
  CONFIDENCE_HIGH: HIGH,
  CONFIDENCE_MED: MED,
  CONFIDENCE_LOW: LOW,
  SECONDARY_BY_DOMAIN,
  SECONDARY_CHAIN_BY_DOMAIN,
  classifyDomainIntent,
  detectRulesDomain,
  isHighConfidence,
  shouldBlockInventoryForRulesIntent,
  stripHarnessNoise,
};
