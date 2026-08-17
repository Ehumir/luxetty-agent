'use strict';

/** Copy base PERSEO V1 — tono asesor humano, sin lenguaje operativo/CRM. */

const GLOBAL_OPENING_VARIANTS = Object.freeze([
  'Hola, soy el asesor IA de Luxetty. ¿Te apoyo para comprar, vender o rentar una propiedad?',
  'Hola, bienvenido a Luxetty. ¿Buscas comprar, vender o rentar una propiedad?',
  'Hola, con gusto te atiendo desde Luxetty. ¿Te apoyo con compra, venta o renta?',
  'Buen día. Soy el asistente de Luxetty. ¿Qué te gustaría hacer: comprar, vender o rentar?',
]);

const RESET_CONVERSATION_REPLY =
  'Listo, empezamos de nuevo. ¿En qué puedo ayudarte hoy?';

const MISUNDERSTANDING_PROMPT =
  'No estoy seguro de haberte entendido del todo. ¿Me ayudas con un poco más de detalle?';

const FINAL_CLOSE_LINE = 'Gracias por contactarnos. Que tengas excelente día.';

/**
 * @param {string|null|undefined} firstName
 */
function handoffAdvisorContinuation(firstName) {
  const nm = firstName ? String(firstName).trim() : null;
  if (nm) {
    return `Perfecto, ${nm}. Un asesor de Luxetty continuará contigo por este medio. Si necesitas algo más antes del contacto, dímelo.`;
  }
  return 'Perfecto. Un asesor de Luxetty continuará contigo por este medio. Si necesitas algo más antes del contacto, dímelo.';
}

/**
 * Consentimiento aceptado — handoff humano sin pregunta extra (cierre terminal en turno siguiente).
 * @param {string|null|undefined} firstName
 */
function consentAcceptedHandoff(firstName) {
  return handoffAdvisorContinuation(firstName);
}

/**
 * @param {string} zone
 */
function acknowledgedZone(zone) {
  const z = String(zone || '').trim();
  if (!z) return 'Perfecto.';
  return `Perfecto, en ${z}.`;
}

/**
 * @param {string} priceLabel
 */
function acknowledgedPrice(priceLabel) {
  const p = String(priceLabel || '').trim();
  if (!p) return 'Perfecto.';
  return `Perfecto, con ${p} como referencia.`;
}

/**
 * @param {string} zone
 * @param {string} [firstName]
 */
function askExpectedPrice(zone, firstName) {
  const z = zone || 'esa zona';
  const nm = firstName ? `${firstName}, ` : '';
  return `${nm}¿Qué precio tienes pensado manejar para la propiedad en ${z}?`;
}

/**
 * @param {string} zone
 */
function askMonthlyBudget(zone) {
  const z = zone || 'esa zona';
  return `¿Más o menos qué presupuesto mensual traes pensado para ${z}?`;
}

/**
 * @param {string} zone
 */
function askPurchaseBudget(zone) {
  const suffix = zone && zone !== 'esa zona' ? ` para buscar en ${zone}` : '';
  return `¿Más o menos qué presupuesto traes pensado${suffix}?`;
}

const SLOT_COPY = Object.freeze({
  sell_capture_name: [
    'Claro, con gusto te apoyo. ¿Me compartes tu nombre?',
    'Perfecto, te acompaño con la venta de tu propiedad. ¿Me dices tu nombre?',
    'Con gusto, seguimos con la venta. ¿Cómo te llamas?',
  ],
  demand_name: [
    'Perfecto. ¿Cómo te llamas?',
    'Claro. ¿Me compartes tu nombre?',
    'Con gusto. ¿Me dices tu nombre para seguir?',
  ],
  buy_location: '¿Qué zonas te interesan más?',
  sell_location: '¿En qué zona está la propiedad?',
  buy_property_type: '¿Qué tipo de propiedad buscas?',
  sell_property_type: '¿Qué tipo de propiedad es?',
  buy_bedrooms: '¿Cuántas recámaras necesitas?',
  sell_occupancy: '¿La propiedad está libre o actualmente habitada?',
  buy_privada: '¿Buscas algo en privada o te es indistinto?',
});

module.exports = {
  GLOBAL_OPENING_VARIANTS,
  RESET_CONVERSATION_REPLY,
  MISUNDERSTANDING_PROMPT,
  FINAL_CLOSE_LINE,
  SLOT_COPY,
  handoffAdvisorContinuation,
  consentAcceptedHandoff,
  acknowledgedZone,
  acknowledgedPrice,
  askExpectedPrice,
  askMonthlyBudget,
  askPurchaseBudget,
};
