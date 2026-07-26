'use strict';

/**
 * R0 / P0.1.2 — Context Continuity Guardrail (sin Stage Engine ni Decision Core).
 * El estado persistido (offer / sale) manda sobre señales frágiles del turno actual.
 */

const { normalizeText, cleanSpaces } = require('../utils/text');
const { isLikelyShortPersonNameToken } = require('./antiLoopGuardrails');
const { formatPropertyTypeLabel } = require('../utils/formatting');
const {
  mentionsRentDemand,
  mentionsBuyDemand,
  isDemandSearchInbound,
} = require('./v3/interpreter/campaignIntake');

/**
 * Hilo de captación/venta protegido.
 * Nota: en `intent.js`, un comprador (demand) también recibe `operation_type === 'sale'`
 * (compra vs renta). Por eso NO basta con `operation_type === 'sale'` sin más.
 */
function isR0StickySaleCaptureThread(aiState = {}) {
  const st = aiState && typeof aiState === 'object' ? aiState : {};
  if (st.lead_flow === 'offer') return true;
  if (st.lead_flow === 'demand' && st.operation_type === 'sale') {
    const hasBuyerBudget = st.budget_max != null && Number.isFinite(Number(st.budget_max));
    if (hasBuyerBudget) return false;
    if (st.expected_price != null && Number.isFinite(Number(st.expected_price))) return true;
    if (st.sale_motivation != null && String(st.sale_motivation).trim()) return true;
    if (st.is_exploring_sale === true) return true;
  }
  return false;
}

/**
 * El usuario indica claramente que quiere pasar a búsqueda/compra/renta.
 */
function explicitDemandSearchIntent(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  // Inventario / renta / compra explícitos (alineado con campaignIntake).
  if (mentionsRentDemand(t) || mentionsBuyDemand(t) || isDemandSearchInbound(t)) return true;
  return (
    /\bbusco\b/.test(t) ||
    /\bbuscar\b/.test(t) ||
    t.includes('quiero comprar') ||
    t.includes('quiero rentar') ||
    t.includes('quiero arrendar') ||
    t.includes('en realidad busco') ||
    t.includes('no quiero vender') ||
    t.includes('no es venta') ||
    t.includes('tambien quiero comprar') ||
    t.includes('también quiero comprar') ||
    t.includes('ademas quiero rentar') ||
    t.includes('además quiero rentar') ||
    (t.includes('renta') && t.includes('busco')) ||
    (t.includes('compra') && t.includes('busco'))
  );
}

/**
 * Antes de `buildNextState`: evita que el parser vuelque offer/sale → demand ni `budget_max` de comprador
 * por mensajes cortos (número, zona, nombre, ok).
 */
function applyR0StickySignalsGuard(previousAiState = {}, parsedSignals = {}, inboundText = '') {
  const sig = parsedSignals && typeof parsedSignals === 'object' ? { ...parsedSignals } : {};
  const prev = previousAiState && typeof previousAiState === 'object' ? previousAiState : {};
  if (!isR0StickySaleCaptureThread(prev)) return sig;
  if (explicitDemandSearchIntent(inboundText)) {
    // Rompe sticky: fuerza demanda y limpia candados de captación.
    sig.lead_flow = 'demand';
    delete sig.intent_lock_sale_owner;
    delete sig.expected_price;
    if (!sig.operation_type) {
      const t = normalizeText(String(inboundText || ''));
      if (mentionsRentDemand(t) || /\brentar?\b/.test(t)) sig.operation_type = 'rent';
      else if (mentionsBuyDemand(t)) sig.operation_type = 'sale';
    }
    return sig;
  }

  if (sig.lead_flow === 'demand') {
    delete sig.lead_flow;
  }

  if (sig.budget_max != null && Number.isFinite(Number(sig.budget_max))) {
    const b = Number(sig.budget_max);
    if (sig.expected_price == null || !Number.isFinite(Number(sig.expected_price))) {
      sig.expected_price = b;
    }
    delete sig.budget_max;
  }

  return sig;
}

function isSaleProcessQuestion(text = '') {
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  return (
    t.includes('cual es el proceso') ||
    t.includes('cuál es el proceso') ||
    t.includes('como es el proceso') ||
    t.includes('cómo es el proceso') ||
    (t.includes('proceso') &&
      (t.includes('cual') || t.includes('cuál') || t.includes('como') || t.includes('cómo')))
  );
}

/**
 * Fallback consultivo cuando el hilo ya es venta/captación y el mensaje no es cambio explícito a demanda.
 */
function buildSaleCaptiveContinuityReply({ text = '', aiState = {}, loc = '', hasValidHumanName = false } = {}) {
  const raw = cleanSpaces(String(text || ''));
  const t = normalizeText(raw);
  const st = aiState && typeof aiState === 'object' ? aiState : {};
  const zone = cleanSpaces(String(loc || st.location_text || ''));
  const typeLabel = formatPropertyTypeLabel(st.property_type);
  const hasType = !!cleanSpaces(String(st.property_type || ''));
  const hasOccupancy = !!cleanSpaces(String(st.occupancy_status || ''));
  const priceHint =
    st.expected_price != null && Number.isFinite(Number(st.expected_price))
      ? Number(st.expected_price)
      : null;

  if (isSaleProcessQuestion(text)) {
    const z = zone ? ` en ${zone}` : '';
    const tail = hasValidHumanName
      ? ' ¿Te gustaría que un asesor te contacte para revisar tu propiedad?'
      : ' Para orientarte bien, ¿me compartes tu nombre?';
    return `El proceso de venta con Luxetty empieza con una prevaluación comercial sin costo: revisamos tu propiedad${z}, te orientamos sobre estrategia y, si te interesa, un asesor te acompaña en publicación y negociación.${tail}`.trim();
  }

  if (!t || t === 'si' || t === 'sí' || t === 'ok' || t === 'vale' || t === 'continuar' || t === 'sigue') {
    if (hasType && hasOccupancy && zone) {
      return `Listo, seguimos con la venta de tu ${typeLabel} en ${zone}. ¿Hay algo más que quieras aclarar sobre la propiedad?`;
    }
    if (hasType && zone) {
      return `Listo, seguimos con la venta de tu ${typeLabel} en ${zone}. ¿Está habitada, rentada o libre?`;
    }
    if (hasType) {
      return `Listo, seguimos con la venta de tu ${typeLabel}. ¿En qué colonia o municipio está la propiedad?`;
    }
    return zone
      ? `Listo, seguimos con la venta en ${zone}. ¿Quieres afinar tipo de inmueble o motivación de venta?`
      : 'Listo, seguimos con la venta. ¿En qué colonia o municipio está la propiedad?';
  }

  if (isLikelyShortPersonNameToken(raw) && raw.split(/\s+/).filter(Boolean).length <= 5) {
    const cap = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    const z = zone ? ` en ${zone}` : '';
    if (hasType) {
      return `Gracias, ${cap}. Sigo con tu venta${z}. ${hasOccupancy ? '¿Hay algo más sobre la propiedad?' : '¿Está habitada, rentada o libre?'}`;
    }
    return `Gracias, ${cap}. Sigo con tu venta${z}. ¿El inmueble es casa, departamento o terreno?`;
  }

  if (/\d/.test(raw) && (t.includes('millon') || t.includes('mdp') || /\b\d/.test(t))) {
    if (hasType && hasOccupancy) {
      return zone
        ? `Con lo que comentas sobre la venta en ${zone}, sigo sin prometer precios de mercado aquí. ¿Hay algo más que quieras aclarar?`
        : 'Con lo que comentas, sigo sin prometer precios de mercado aquí. ¿Hay algo más que quieras aclarar?';
    }
    return zone
      ? `Con lo que comentas sobre la venta en ${zone}, sigo sin prometer precios de mercado aquí. ¿Tipo de inmueble y si está habitada o libre?`
      : `Perfecto, con ese monto como referencia. ¿En qué colonia o municipio está la propiedad?`;
  }

  if (zone || t.includes('cumbres') || t.includes('zona') || t.includes('colonia') || t.includes('municipio')) {
    const z2 = zone || (raw.length < 80 ? raw : '');
    if (hasType && hasOccupancy) {
      return z2
        ? `Perfecto, tomé la zona (${z2}). Sigo con la venta de tu ${typeLabel}. ¿Hay algo más que quieras aclarar?`
        : `Sigo con la venta de tu ${typeLabel}. ¿Hay algo más que quieras aclarar?`;
    }
    if (hasType) {
      return z2
        ? `Perfecto, tomé la zona (${z2}). Sigo con la venta de tu ${typeLabel}. ¿Está habitada, rentada o libre?`
        : `Sigo con la venta de tu ${typeLabel}. ¿Está habitada, rentada o libre?`;
    }
    return z2
      ? `Perfecto, tomé la zona (${z2}). Sigo con la venta. ¿El inmueble es casa, departamento o terreno?`
      : `Sigo con la venta. ¿El inmueble es casa, departamento o terreno?`;
  }

  if (priceHint != null) {
    if (hasType && hasOccupancy && zone) {
      return `Sigo con la venta de tu ${typeLabel} en ${zone}. ¿Hay algo más que quieras aclarar?`;
    }
    return `Sigo con la venta de tu ${typeLabel}. ¿En qué colonia o municipio está la propiedad?`;
  }

  return `Sigo con la venta de tu ${typeLabel}. Cuéntame en una línea qué quieres afinar (zona, tipo o estado del inmueble).`;
}

module.exports = {
  isR0StickySaleCaptureThread,
  explicitDemandSearchIntent,
  applyR0StickySignalsGuard,
  buildSaleCaptiveContinuityReply,
  isSaleProcessQuestion,
};
