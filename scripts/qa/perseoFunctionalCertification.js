'use strict';

/**
 * PERSEO — Certificación Funcional (producción / QA controlado).
 *
 * Metodología:
 *  - Ejecuta el MISMO cerebro V3 de producción vía argos/processInboundForArgos
 *    (sin persistencia operativa: NO escribe leads/contactos/notificaciones,
 *     NO envía WhatsApp). CRM se evalúa vía dry-run preview (previewCrmPipeline)
 *     con wrapper no-write sobre Supabase real.
 *  - Inventario/propiedades: lectura real de Supabase (SERVICE_ROLE) para
 *    hidratación de propiedad específica y CRM preview.
 *  - Fixtures reales inyectados para códigos LUX usados (valores tomados de DB).
 *
 * Salidas: docs/argos/evidence/perseo-functional-certification/*.json
 *
 * NOTA: Esta certificación NO parchea. Solo mide y reporta PASS/FAIL con evidencia.
 */

// ---- Env: cargar .env y activar gate ARGOS + mejor config posible de inventario ----
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }
process.env.PERSEO_ARGOS_ENABLED = 'true';
// Config "best-case" para el probe directo de capacidad de inventario:
process.env.PERSEO_INVENTORY_OPTIONS_ENABLED = process.env.PERSEO_INVENTORY_OPTIONS_ENABLED || 'true';
process.env.PERSEO_INVENTORY_OPTIONS_GLOBAL = process.env.PERSEO_INVENTORY_OPTIONS_GLOBAL || 'true';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { processInboundForArgos, resetArgosV3Session } = require('../../argos/processInboundForArgos');
const propertyFixtures = require('../../argos/propertyFixtures');
const inventoryOptionsService = require('../../services/inventoryOptionsService');

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'argos', 'evidence', 'perseo-functional-certification');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ---- Fixtures reales (valores verificados en DB, 2026-07-07) ----
Object.assign(propertyFixtures.PROPERTY_FIXTURES, {
  'LUX-A0453': {
    id: 'db-lux-a0453',
    code: 'LUX-A0453',
    title: 'QUINTA CAMPESTRE EN FRACCIONAMIENTO PRIVADO EN MONTEMORELOS',
    price: 4900000,
    price_label: '$4,900,000 MXN',
    public_url: 'https://luxetty.com/propiedad/quinta-campestre-en-fraccionamiento-privado-en-montemorelos',
    location_label: 'Country Hill, Montemorelos',
    is_active: true,
    is_published: true,
  },
  'LUX-A0475': {
    id: 'db-lux-a0475',
    code: 'LUX-A0475',
    title: 'CASA EN RENTA EN CUMBRES 4TO SECTOR CON ALBERCA',
    price: 40000,
    price_label: '$40,000 MXN',
    public_url: 'https://luxetty.com/propiedad/casa-en-renta-en-cumbres-4to-sector-con-alberca',
    location_label: 'Cumbres 4o Sector, Monterrey',
    is_active: true,
    is_published: true,
  },
});

const TIMESTAMP = new Date().toISOString();
const CANAL = 'argos_controlled_qa';
const PHONE = '+528100000000';

// ---- Helpers ----
function findEvent(events, type) {
  return (events || []).find((e) => e && e.type === type) || null;
}
function eventsOfPhase(events, phase) {
  return (events || []).filter((e) => e && e.phase === phase);
}
function replyText(reply) {
  if (Array.isArray(reply)) return reply.join('\n');
  return String(reply || '');
}
function hasLink(text) {
  return /https?:\/\/[^\s]+/i.test(String(text || ''));
}
function containsAny(text, arr) {
  const t = String(text || '').toLowerCase();
  return arr.some((k) => t.includes(k.toLowerCase()));
}
function extractLuxCodes(text) {
  const m = String(text || '').toUpperCase().match(/LUX-?A?\d{3,5}/g) || [];
  return m.map((c) => c.replace(/^LUX-?/, 'LUX-'));
}

async function runTurn(sessionId, text, opts = {}) {
  const t0 = Date.now();
  const result = await processInboundForArgos({
    session_id: sessionId || undefined,
    phone_sim: PHONE,
    text,
    supabaseRaw: supabase,
    scenarioSetup: opts.scenarioSetup || undefined,
    flags: { crm_dry_run: true },
  });
  const latency_ms = Date.now() - t0;
  const snap = result.conversation_snapshot || {};
  const parser = findEvent(result.events, 'parser_winner');
  const ragEvents = (result.events || []).filter((e) => /rag|retriev|chunk|semantic/i.test(e.type || ''));
  const invEvents = (result.events || []).filter((e) => /inventory/i.test(e.type || ''));
  const notifEvents = (result.events || []).filter((e) => /notification|notify|admin/i.test(e.type || ''));
  const metrics = {
    text_in: text,
    conversation_id: result.session_id ? `argos:${result.session_id}` : null,
    phone: PHONE,
    canal: CANAL,
    timestamp: new Date().toISOString(),
    pipeline: 'v3_primary',
    route: result.gates?.v3_primary_allowed ? 'v3_primary' : 'blocked',
    intent: snap.detected_intent || parser?.payload?.detected_intent || null,
    state: snap.conversation_stage || null,
    lead_flow: snap.lead_flow || null,
    operation_type: snap.operation_type || null,
    domain: snap.operation_type ? `real_estate:${snap.operation_type}` : 'real_estate',
    known_zone: snap.known_zone || null,
    known_budget: snap.known_budget ?? null,
    property_code: snap.property_code || null,
    valuation_requested: snap.valuation_requested === true,
    price_unknown: snap.price_unknown === true,
    handoff_sent: snap.handoff_sent === true,
    crm_ready: snap.crm_ready === true,
    rag_invoked: ragEvents.length > 0,
    inventory_invoked: invEvents.length > 0,
    chunks: 0,
    citations: extractLuxCodes(replyText(result.reply)),
    confidence: parser?.payload?.confidence ?? null,
    explicit_flow_switch: parser?.payload?.explicit_flow_switch ?? null,
    threshold: null,
    fallback_reason: result.error_code || null,
    response: replyText(result.reply),
    crm_execution_eligible: result.gates?.crm_execution_eligible === true,
    crm_skip_reason: result.gates?.crm_skip_reason || null,
    crm_dry_run: result.crm_dry_run || null,
    notification_events: notifEvents.map((e) => ({ type: e.type, payload: e.payload })),
    assignments: result.crm_dry_run?.assignment || null,
    latency_ms,
    raw_gates: result.gates || null,
  };
  return { result, metrics, sessionId: result.session_id };
}

// IMPORTANTE: encadenar el session_id REAL devuelto por processInboundForArgos.
// El primer turno se envía sin session_id (crea sesión nueva); los siguientes
// reutilizan el id devuelto para preservar continuidad de estado V3.
async function runConversation(_label, turns) {
  const records = [];
  let sid = null;
  for (const turn of turns) {
    const { metrics, sessionId } = await runTurn(sid, turn.text, turn.opts || {});
    sid = sessionId;
    records.push({ label: turn.label || null, ...metrics });
  }
  return records;
}

// ---- Evaluación por caso ----
function evalCase(caseId, checks) {
  const failed = checks.filter((c) => !c.pass);
  return {
    case: caseId,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failed_checks: failed.map((c) => c.name),
  };
}

// Códigos reales de renta/venta en Cumbres (verificados en DB)
const REAL_RENT_CODES = ['LUX-A0475', 'LUX-A0469', 'LUX-A0467'];
const REAL_SALE_CUMBRES = ['LUX-A0474', 'LUX-A0482', 'LUX-A0484'];
const ALL_REAL_CODES = new Set([
  ...REAL_RENT_CODES, ...REAL_SALE_CUMBRES,
  'LUX-A0453', 'LUX-A0470', 'LUX-A0451', 'LUX-A0466', 'LUX-A0458', 'LUX-A0459',
  'LUX-A0462', 'LUX-A0485', 'LUX-A0471', 'LUX-A0481', 'LUX-A0455', 'LUX-A0457',
  'LUX-A0460', 'LUX-A0473', 'LUX-A0465', 'LUX-A0463', 'LUX-A0461', 'LUX-A0452',
  'LUX-A0454', 'LUX-A0483', 'LUX-A0464',
]);

function noInventedCodes(rec) {
  const cited = extractLuxCodes(rec.response);
  const invented = cited.filter((c) => !ALL_REAL_CODES.has(c));
  return { pass: invented.length === 0, invented, cited };
}

function askedOperationTrio(text) {
  const t = String(text || '').toLowerCase();
  return /\bcompra\b.*\bventa\b.*\brenta\b|\bventa\b.*\brenta\b|\brenta\b.*\bo\b.*\bventa\b|compra,\s*venta\s*o\s*renta/.test(t);
}

async function main() {
  const suites = {};

  // ================= SUITE 1 — RENTA =================
  const rent = [];
  {
    const r1 = await runConversation('cert-r1', [
      { label: 'R1', text: '¿Qué opciones de casas en renta tienes en Cumbres?' },
    ]);
    const rec = r1[0];
    const inv = noInventedCodes(rec);
    rent.push({
      ...evalCase('R1', [
        { name: 'operation_rent', pass: rec.operation_type === 'rent' },
        { name: 'lead_flow_demand', pass: rec.lead_flow === 'demand' },
        { name: 'zone_cumbres', pass: containsAny(rec.known_zone, ['cumbres']) },
        { name: 'no_operation_trio_question', pass: !askedOperationTrio(rec.response) },
        { name: 'not_captation', pass: rec.lead_flow !== 'offer' && rec.valuation_requested !== true },
        { name: 'offers_real_options_with_link', pass: hasLink(rec.response) },
        { name: 'no_invented_property', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  {
    const r2 = await runConversation('cert-r2', [
      { label: 'R2', text: 'Busco una casa en renta en Cumbres de menos de 50 mil pesos.' },
    ]);
    const rec = r2[0];
    const inv = noInventedCodes(rec);
    rent.push({
      ...evalCase('R2', [
        { name: 'operation_rent', pass: rec.operation_type === 'rent' },
        { name: 'budget_50k', pass: Number(rec.known_budget) === 50000 },
        { name: 'zone_cumbres', pass: containsAny(rec.known_zone, ['cumbres']) },
        { name: 'offers_or_explains_honestly', pass: hasLink(rec.response) || containsAny(rec.response, ['no tengo', 'no cuento', 'no hay', 'alternativa']) },
        { name: 'no_invented_property', pass: inv.pass },
        { name: 'not_captation', pass: rec.lead_flow !== 'offer' },
      ]),
      metrics: rec,
    });
  }
  {
    const r3 = await runConversation('cert-r3', [
      { label: 'R3', text: 'Quiero rentar una casa con 3 recámaras y patio.' },
    ]);
    const rec = r3[0];
    const inv = noInventedCodes(rec);
    rent.push({
      ...evalCase('R3', [
        { name: 'operation_rent', pass: rec.operation_type === 'rent' },
        { name: 'lead_flow_demand', pass: rec.lead_flow === 'demand' },
        { name: 'not_switch_to_sale_or_captation', pass: rec.operation_type !== 'sale' && rec.lead_flow !== 'offer' && rec.valuation_requested !== true },
        { name: 'asks_zone_or_budget_or_offers', pass: containsAny(rec.response, ['zona', 'presupuesto', 'colonia', 'municipio']) || hasLink(rec.response) },
        { name: 'no_invented_property', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  suites.rent = rent;

  // ================= SUITE 2 — VENTA / COMPRA =================
  const sale = [];
  {
    const v1 = await runConversation('cert-v1', [
      { label: 'V1', text: '¿Qué casas tienes en venta en Cumbres?' },
    ]);
    const rec = v1[0];
    const inv = noInventedCodes(rec);
    sale.push({
      ...evalCase('V1', [
        { name: 'operation_sale', pass: rec.operation_type === 'sale' },
        { name: 'demand_not_seller', pass: rec.lead_flow === 'demand' && rec.valuation_requested !== true },
        { name: 'zone_cumbres', pass: containsAny(rec.known_zone, ['cumbres']) },
        { name: 'offers_real_options_with_link', pass: hasLink(rec.response) },
        { name: 'no_invented_property', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  {
    const v2 = await runConversation('cert-v2', [
      { label: 'V2', text: 'Tengo 5 millones, ¿qué puedo comprar?' },
    ]);
    const rec = v2[0];
    const inv = noInventedCodes(rec);
    sale.push({
      ...evalCase('V2', [
        { name: 'demand_buy', pass: rec.lead_flow === 'demand' },
        { name: 'budget_5m', pass: Number(rec.known_budget) === 5000000 },
        { name: 'not_seller', pass: rec.valuation_requested !== true && rec.lead_flow !== 'offer' },
        { name: 'offers_or_explains', pass: hasLink(rec.response) || containsAny(rec.response, ['opcion', 'zona', 'busco', 'buscar', 'presupuesto']) },
        { name: 'no_invented_property', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  {
    const v3 = await runConversation('cert-v3', [
      { label: 'V3', text: 'Busco casa en venta con alberca.' },
    ]);
    const rec = v3[0];
    const inv = noInventedCodes(rec);
    sale.push({
      ...evalCase('V3', [
        { name: 'operation_sale', pass: rec.operation_type === 'sale' },
        { name: 'demand_buy', pass: rec.lead_flow === 'demand' },
        { name: 'no_invented_amenity', pass: inv.pass && !containsAny(rec.response, ['jacuzzi garantizado', 'alberca en todas']) },
        { name: 'offers_or_asks', pass: hasLink(rec.response) || containsAny(rec.response, ['zona', 'presupuesto', 'opcion']) },
      ]),
      metrics: rec,
    });
  }
  suites.sale = sale;

  // ================= SUITE 3 — PROPIEDAD ESPECÍFICA (sesión única) =================
  const propRecords = await runConversation('cert-prop', [
    { label: 'P1', text: 'Háblame de la propiedad LUX-A0453.' },
    { label: 'P2', text: '¿Cuánto cuesta LUX-A0453?' },
    { label: 'P3', text: '¿Tiene alberca esa propiedad?' },
    { label: 'P4', text: 'Compárala con otra opción similar.' },
  ]);
  const prop = [];
  {
    const rec = propRecords[0];
    const inv = noInventedCodes(rec);
    prop.push({
      ...evalCase('P1', [
        { name: 'detects_code', pass: rec.property_code === 'LUX-A0453' || rec.citations.includes('LUX-A0453') },
        { name: 'real_zone_or_price', pass: containsAny(rec.response, ['montemorelos', 'country hill', '4,900,000', '4900000', '4.9']) },
        { name: 'no_other_property_mixed', pass: !rec.citations.some((c) => c !== 'LUX-A0453') },
        { name: 'no_invented', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  {
    const rec = propRecords[1];
    prop.push({
      ...evalCase('P2', [
        { name: 'price_or_honest_unknown', pass: containsAny(rec.response, ['4,900,000', '4900000', '4.9 mill', '$4,9']) || rec.price_unknown === true || containsAny(rec.response, ['no tengo certeza', 'no cuento con', 'confirmo con', 'verifico']) },
        { name: 'no_invented_price', pass: !/\$?\s?\d[\d,\.]*\s*(mxn|pesos|millones|mill)/i.test(rec.response) || containsAny(rec.response, ['4,900,000', '4900000', '4.9']) },
      ]),
      metrics: rec,
    });
  }
  {
    const rec = propRecords[2];
    // LUX-A0453 no tiene alberca en datos → correcto: NO afirmar que sí.
    prop.push({
      ...evalCase('P3', [
        { name: 'keeps_property_context', pass: rec.property_code === 'LUX-A0453' || rec.citations.includes('LUX-A0453') || containsAny(rec.response, ['montemorelos', 'quinta', 'propiedad']) },
        { name: 'no_hallucinated_pool', pass: !/\bs[ií],?\s+(tiene|cuenta con)\s+alberca\b/i.test(rec.response) },
      ]),
      metrics: rec,
    });
  }
  {
    const rec = propRecords[3];
    const inv = noInventedCodes(rec);
    prop.push({
      ...evalCase('P4', [
        { name: 'keeps_context', pass: rec.property_code === 'LUX-A0453' || rec.citations.includes('LUX-A0453') },
        { name: 'compares_without_inventing', pass: inv.pass },
      ]),
      metrics: rec,
    });
  }
  suites.property = prop;

  // ================= SUITE 4 — CAPTACIÓN =================
  const capt = [];
  {
    const c1 = await runConversation('cert-c1', [
      { label: 'C1', text: 'Quiero vender mi casa.' },
    ]);
    const rec = c1[0];
    capt.push({
      ...evalCase('C1', [
        { name: 'detects_captation', pass: rec.operation_type === 'sale' && (rec.lead_flow === 'offer' || rec.valuation_requested === true || containsAny(rec.response, ['vender', 'vend'])) },
        { name: 'not_treated_as_buyer', pass: rec.lead_flow !== 'demand' },
        { name: 'asks_property_data_or_contact', pass: containsAny(rec.response, ['zona', 'ubicaci', 'nombre', 'datos', 'caracter', 'recámaras', 'recamaras', 'contacto', 'metros']) },
      ]),
      metrics: rec,
    });
  }
  {
    const c2 = await runConversation('cert-c2', [
      { label: 'C2', text: 'Tengo una casa en Cumbres que quiero rentar.' },
    ]);
    const rec = c2[0];
    capt.push({
      ...evalCase('C2', [
        { name: 'detects_owner_offer', pass: rec.lead_flow === 'offer' || containsAny(rec.response, ['tu propiedad', 'tu casa', 'poner en renta', 'rentar tu']) },
        { name: 'not_demand_inventory', pass: rec.lead_flow !== 'demand' && !hasLink(rec.response) },
      ]),
      metrics: rec,
    });
  }
  {
    const c3 = await runConversation('cert-c3', [
      { label: 'C3', text: '¿Cuánto vale mi casa?' },
    ]);
    const rec = c3[0];
    capt.push({
      ...evalCase('C3', [
        { name: 'detects_valuation', pass: rec.valuation_requested === true || containsAny(rec.response, ['valuaci', 'valor', 'avalú', 'avalu']) },
        { name: 'asks_location_features_contact', pass: containsAny(rec.response, ['ubicaci', 'zona', 'caracter', 'metros', 'recámaras', 'recamaras', 'contacto', 'nombre']) },
        { name: 'no_invented_value', pass: !/\$?\s?\d[\d,\.]*\s*(mxn|pesos|millones)/i.test(rec.response) },
      ]),
      metrics: rec,
    });
  }
  suites.captation = capt;

  // Captación multi-turno hasta CRM_READY para auditar solicitud/notificación (dry-run).
  const captationFlow = await runConversation('cert-capt-flow', [
    { label: 'CF1', text: 'Quiero vender mi casa' },
    { label: 'CF2', text: 'Me llamo Jorge Ramírez' },
    { label: 'CF3', text: 'Está en Cumbres 4to Sector, Monterrey' },
    { label: 'CF4', text: 'Es una casa de 3 recámaras, 250 m2' },
    { label: 'CF5', text: 'Mi teléfono es 8112345678, sí quiero que me contacten' },
    { label: 'CF6', text: 'Sí, adelante' },
  ]);
  const captationReachedCrm = captationFlow.find((r) => r.crm_execution_eligible || r.crm_dry_run || r.crm_ready) || null;
  suites.captationFlow = {
    reached_crm: !!captationReachedCrm,
    crm_dry_run: captationReachedCrm?.crm_dry_run || null,
    final_stage: captationFlow[captationFlow.length - 1]?.state || null,
    turns: captationFlow,
  };

  // ================= SUITE 5 — CONVERSACIÓN LARGA (20 mensajes) =================
  const longTurns = [
    { label: '01_saludo', text: 'Hola, buenas tardes' },
    { label: '02_busca_renta', text: 'Estoy buscando una casa en renta' },
    { label: '03_zona', text: 'En Cumbres' },
    { label: '04_presupuesto', text: 'Mi presupuesto es de unos 45 mil al mes' },
    { label: '05_recamaras', text: 'Necesito 3 recámaras' },
    { label: '06_mascotas', text: '¿Aceptan mascotas? tengo un perro' },
    { label: '07_pregunta_opcion', text: '¿Qué opciones tienes?' },
    { label: '08_precio', text: '¿Cuánto cuesta la primera?' },
    { label: '09_ubicacion', text: '¿En qué parte exactamente está?' },
    { label: '10_requisitos', text: '¿Qué requisitos piden para rentar?' },
    { label: '11_otra_opcion', text: '¿Tienes otra opción?' },
    { label: '12_comparar', text: 'Compara esas dos opciones' },
    { label: '13_corrige', text: 'Corrijo, mi presupuesto es 50 mil no 45 mil' },
    { label: '14_ya_te_dije', text: 'Ya te dije que en Cumbres' },
    { label: '15_mas_barato', text: '¿Hay algo más barato?' },
    { label: '16_agendar', text: 'Quiero agendar una visita' },
    { label: '17_cambia_horario', text: 'Mejor cámbiala para el sábado en la tarde' },
    { label: '18_quien_atiende', text: '¿Quién me va a atender?' },
    { label: '19_resumen', text: '¿Me das un resumen de lo que vimos?' },
    { label: '20_cierre', text: 'Perfecto, muchas gracias' },
  ];
  const longRecords = await runConversation('cert-long', longTurns);
  // Evaluación de coherencia global
  const opsSeen = longRecords.map((r) => r.operation_type).filter(Boolean);
  const switchedToSale = opsSeen.includes('sale');
  const becameOffer = longRecords.some((r) => r.lead_flow === 'offer' || r.valuation_requested === true);
  const anyInvented = longRecords.some((r) => !noInventedCodes(r).pass);
  // Preguntas repetidas graves: misma respuesta exacta consecutiva ya la corta anti-loop;
  // aquí medimos si repite pregunta de zona/presupuesto tras haberla capturado.
  const zoneCapturedAt = longRecords.findIndex((r) => containsAny(r.known_zone, ['cumbres']));
  const repeatsZoneQuestion = zoneCapturedAt >= 0 && longRecords.slice(zoneCapturedAt + 1).some((r) => /en qué zona|qué zona|cuál zona|en que colonia/i.test(r.response));
  const anyLoopError = longRecords.some((r) => r.fallback_reason === 'ARGOS_LOOP_DETECTED' || r.fallback_reason === 'LOOP_DETECTED');
  const long = evalCase('LONG_20', [
    { name: 'kept_rent_intent', pass: !switchedToSale },
    { name: 'no_switch_to_captation', pass: !becameOffer },
    { name: 'no_invented_property', pass: !anyInvented },
    { name: 'no_repeat_zone_after_captured', pass: !repeatsZoneQuestion },
    { name: 'no_anti_loop_break', pass: !anyLoopError },
    { name: 'budget_corrected_to_50k', pass: Number(longRecords[12]?.known_budget) === 50000 || Number(longRecords[longRecords.length - 1]?.known_budget) === 50000 },
  ]);
  suites.long = { ...long, turns: longRecords };

  // ================= CAPABILITY PROBE (root-cause evidence) =================
  // Prueba DIRECTA del inventoryOptionsService contra DB real para documentar
  // que el inventario publicable existe (aunque el path V3 de prod NO lo invoque).
  let capability = { available: !!supabase, probes: [] };
  if (supabase) {
    for (const probe of [
      { name: 'rent_cumbres', operation: 'rent', zone: 'Cumbres', budgetMax: null, queryText: 'casas en renta en cumbres' },
      { name: 'rent_cumbres_50k', operation: 'rent', zone: 'Cumbres', budgetMax: 50000, queryText: 'renta cumbres menos de 50 mil' },
      { name: 'sale_cumbres', operation: 'sale', zone: 'Cumbres', budgetMax: null, queryText: 'casas en venta en cumbres' },
      { name: 'sale_5m', operation: 'sale', zone: null, budgetMax: 5000000, queryText: 'que puedo comprar con 5 millones' },
    ]) {
      try {
        const res = await inventoryOptionsService.searchInventoryOptions(supabase, { ...probe, limit: 3 }, console);
        capability.probes.push({
          probe: probe.name,
          source: res.source,
          relaxedZone: res.relaxedZone,
          count: (res.options || []).length,
          options: (res.options || []).map((o) => ({ id: o.id, code: o.code || o.listing_id, price: o.price, url: o.public_url, title: o.title })),
        });
      } catch (err) {
        capability.probes.push({ probe: probe.name, error: String(err && err.message || err) });
      }
    }
  }

  // ================= AGREGACIÓN =================
  function suiteVerdict(arr) {
    const cases = Array.isArray(arr) ? arr : [arr];
    const pass = cases.filter((c) => c.verdict === 'PASS').length;
    return { pass, total: cases.length, verdict: pass === cases.length ? 'PASS' : 'FAIL' };
  }

  // Captación: validaciones OBLIGATORIAS (solicitud/notificación end-to-end).
  const captationMandatory = {
    classification: suiteVerdict(capt),
    reached_crm_ready: suites.captationFlow.reached_crm === true,
    solicitud_created: !!(suites.captationFlow.crm_dry_run && !suites.captationFlow.crm_dry_run.skipped),
    notification_event: false, // no se emitió (flujo no llegó a CRM_READY)
    admin_notified: false,
    conversation_event: false,
    no_duplicate_lead: null, // no evaluable sin creación
  };
  captationMandatory.verdict =
    captationMandatory.classification.verdict === 'PASS' &&
    captationMandatory.reached_crm_ready &&
    captationMandatory.solicitud_created
      ? 'PASS'
      : 'FAIL';

  const summary = {
    timestamp: TIMESTAMP,
    methodology: 'argos/processInboundForArgos (cerebro V3 primary de producción, sin escrituras operativas; CRM dry-run preview; lecturas reales de Supabase)',
    production_config_note:
      'Inventario demanda: services/inventoryOptionsService + inventoryOptionsTurn cableados en index.js PRE-V3 (legacyHydration.matchedOptions). Flag PERSEO_INVENTORY_OPTIONS_ENABLED (default OFF) + allowlist/global. Composer V3 renderiza opciones o network fallback post-search.',
    rent: suiteVerdict(rent),
    sale: suiteVerdict(sale),
    property: suiteVerdict(prop),
    captation: { classification: suiteVerdict(capt), mandatory: captationMandatory, verdict: captationMandatory.verdict },
    long: suiteVerdict(long),
  };
  const allPass =
    summary.rent.verdict === 'PASS' &&
    summary.sale.verdict === 'PASS' &&
    summary.property.verdict === 'PASS' &&
    summary.captation.verdict === 'PASS' &&
    summary.long.verdict === 'PASS';
  summary.final_verdict = allPass ? 'PASS' : 'FAIL';

  // Análisis de fallas (root cause estructurado).
  const failureAnalysis = {
    F1_inventory_not_offered_in_v3: {
      severity: 'P0',
      suites: ['rent (R1)', 'sale (V1)', 'long'],
      what_failed: 'PERSEO no ofrece opciones reales con link en demanda (renta/venta).',
      detected_intent: 'rent/sale demand OK',
      expected: 'Ofrecer opciones publicables reales con URL cuando existen.',
      composer: 'Composer V3 pide nombre (name-first); no busca ni renderiza inventario.',
      rag_participated: false,
      inventory_participated: false,
      root_cause:
        'inventoryOptionsService (funcional, probado: devuelve opciones reales con link) está cableado en index.js SOLO dentro de if(!v3PrimaryHandled). Producción corre V3 primary global, por lo que el bloque nunca se ejecuta. processV3Turn es síncrono y no realiza búsqueda async de inventario.',
      minimal_fix:
        'Pre-buscar inventario (async) ANTES de processV3Turn cuando lead_flow=demand + contexto operativo, e inyectarlo al runtime V3 (legacyHydration/matchedProperties) para render con links; o mover el bloque de inventario fuera del gate legacy para el branch v3PrimaryHandled.',
    },
    F2_budget_thousands_misparse: {
      severity: 'P1',
      suites: ['rent (R2)', 'long (turnos 04/13)'],
      what_failed: '"menos de 50 mil pesos" => budget_max=50,000,000; "45 mil" => 45,000,000.',
      expected: '50 mil = 50,000; 45 mil = 45,000.',
      root_cause: 'Parser de presupuesto multiplica "mil" como millones en frases de renta/demanda.',
      minimal_fix: 'Corregir normalización de "mil"/"k" en el parser de presupuesto (renta mensual).',
    },
    F3_name_hallucination_corrijo: {
      severity: 'P1',
      suites: ['long (turno 13+)'],
      what_failed: 'Capturó "Corrijo" como nombre del cliente ("Perfecto, Corrijo...").',
      expected: 'No tratar verbos/correcciones como nombre propio.',
      root_cause: 'Extractor de nombre acepta la primera palabra de "Corrijo, mi presupuesto..." como full_name.',
      minimal_fix: 'Blacklist de verbos/correcciones ("corrijo", "corrige") en el extractor de nombre.',
    },
    F4_repeated_name_question: {
      severity: 'P1',
      suites: ['long (turnos 03-12)'],
      what_failed: 'Pidió el nombre ~8 veces sin avanzar ni ofrecer opciones.',
      expected: 'No repetir la misma pregunta; avanzar o entregar valor.',
      root_cause: 'Name-first gate bloquea el avance cuando el usuario no da nombre; no hay salida alterna.',
      minimal_fix: 'Límite de reintentos de nombre + fallback a búsqueda/handoff.',
    },
    F5_property_details_not_surfaced: {
      severity: 'P1',
      suites: ['property (P1/P2)'],
      what_failed: 'Con LUX-A0453 hidratado (precio $4,900,000, Montemorelos) responde "sin inventar datos" y pide nombre; no entrega precio/zona reales.',
      expected: 'Responder precio y zona reales publicados.',
      root_cause: 'Composer de propiedad no expone campos hidratados; prioriza name-first.',
      minimal_fix: 'Permitir responder precio/zona publicados de la propiedad activa antes de exigir nombre.',
    },
    F6_zone_capture_pollution: {
      severity: 'P2',
      suites: ['property (P1)'],
      what_failed: 'known_zone = "La Propiedad Lux-a0453" (capturó la frase como ubicación).',
      expected: 'No capturar "la propiedad LUX-..." como zona.',
      root_cause: 'extractLooseLocationPhrase captura texto que sigue a "la propiedad".',
      minimal_fix: 'Guard: excluir frases con "propiedad/referencia + código" del extractor de ubicación.',
    },
    F7_captation_never_reaches_crm: {
      severity: 'P0',
      suites: ['captation (flujo multi-turno)'],
      what_failed: 'Captación no llega a CRM_READY; se atora pidiendo precio del vendedor; no crea solicitud ni notificación.',
      expected: 'Crear solicitud/lead y emitir notification_event / notificar admin.',
      root_cause: 'El gate de qualifying exige precio del vendedor y no cierra con nombre+zona+contacto; nunca dispara CRM.',
      minimal_fix: 'Permitir cierre de captación (solicitud/notificación) con datos mínimos (nombre+zona+contacto+consentimiento) sin requerir precio.',
    },
    F8_wrong_composer_commission: {
      severity: 'P2',
      suites: ['long (turno 15)'],
      what_failed: '"¿Hay algo más barato?" (renta) => responde sobre comisión/porcentaje de venta.',
      expected: 'Responder en contexto de renta (opción más económica).',
      root_cause: 'Selección de composer cae en objeción de comisión (venta) para pregunta de demanda.',
      minimal_fix: 'Restringir composer de comisión al flujo offer/sale.',
    },
  };

  // ================= ESCRIBIR EVIDENCIA =================
  const write = (name, obj) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, null, 2));
  write('RENTAL_OPTIONS_TEST.json', { suite: 'rent', cases: rent });
  write('SALE_OPTIONS_TEST.json', { suite: 'sale', cases: sale });
  write('PROPERTY_SPECIFIC_TEST.json', { suite: 'property', cases: prop });
  write('CAPTATION_TEST.json', { suite: 'captation', cases: capt });
  write('LONG_CONVERSATION_20_MESSAGES.json', { suite: 'long', result: suites.long });
  write('CRM_NOTIFICATION_AUDIT.json', {
    captation_single_turn: capt.map((c) => ({ case: c.case, verdict: c.verdict, crm_execution_eligible: c.metrics.crm_execution_eligible, crm_skip_reason: c.metrics.crm_skip_reason, notification_events: c.metrics.notification_events })),
    captation_multi_turn_flow: suites.captationFlow,
  });
  write('PERSEO_FUNCTIONAL_CERTIFICATION.json', { summary, suites, capability });
  write('CAPABILITY_PROBE_INVENTORY.json', capability);
  write('FAILURE_ANALYSIS.json', { final_verdict: summary.final_verdict, failures: failureAnalysis });
  write('ARGOS_REPLAY_LINKS.json', {
    note: 'IDs de sesión ARGOS (conversation_id) para replay determinista vía argos/replay/replayEngine.js',
    rent: rent.map((c) => ({ case: c.case, conversation_id: c.metrics.conversation_id })),
    sale: sale.map((c) => ({ case: c.case, conversation_id: c.metrics.conversation_id })),
    property: { conversation_id: prop[0]?.metrics?.conversation_id, cases: prop.map((c) => c.case) },
    captation_single: capt.map((c) => ({ case: c.case, conversation_id: c.metrics.conversation_id })),
    captation_flow: { conversation_id: suites.captationFlow.turns[0]?.conversation_id },
    long: { conversation_id: suites.long.turns?.[0]?.conversation_id },
  });

  console.log('\n===== PERSEO FUNCTIONAL CERTIFICATION =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nEvidence written to:', OUT_DIR);
  return summary;
}

main().then((s) => {
  process.exit(0);
}).catch((err) => {
  console.error('CERT_RUNNER_FATAL', err);
  process.exit(1);
});
