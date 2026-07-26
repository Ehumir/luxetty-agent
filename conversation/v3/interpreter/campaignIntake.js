'use strict';

const { normalizeText, cleanSpaces } = require('../../../utils/text');

function isLuxettyAdvisorOwnerLead(normalizedText) {
  const t = String(normalizedText || '');
  return (
    /\bluxetty\b/.test(t) ||
    /\b(?:asesor|me contacte|me contacten|contacte un asesor|contacten un asesor)\b/.test(t)
  );
}

/**
 * Captación vendedor / valuación / publicación — patrones generales (sin zonas fijas).
 * Incluye variantes C2 retargeting (WhatsApp prefill editable).
 */
function matchesSellerAcquisitionPattern(normalizedText) {
  const t = String(normalizedText || '');
  if (/\bbusco\s+rentar\b/.test(t) || (/\bquiero\s+comprar\b/.test(t) && !/\bvender\b/.test(t))) {
    return false;
  }
  if (
    t.includes('me interesa') &&
    t.includes('propiedad') &&
    (t.includes('anunci') || t.includes('anuncio') || t.includes('vi '))
  ) {
    return false;
  }
  return (
    /\b(?:quiero|necesito|busco)\s+(?:ayuda|apoyo)\s+(?:para\s+)?vender\b/.test(t) ||
    /\b(?:como|qué|que)\s+(?:me\s+)?(?:pueden|podr[ií]an|podrias|podrías)\s+ayudar(?:me)?\s+a\s+vender\b/.test(t) ||
    /\bquiero\s+vender\s+(?:mi\s+)?(?:casa|propiedad|depa|departamento|inmueble|terreno)\b/.test(t) ||
    /\bponer\s+en\s+renta\b/.test(t) ||
    /\b(?:poner|ponga|ponerla)\s+(?:en\s+)?venta\b/.test(t) ||
    /\bpublicar\s+(?:mi\s+)?(?:casa|propiedad|depa|departamento|inmueble)\b/.test(t) ||
    /\bvaluaci[oó]n\s+(?:de\s+)?(?:mi\s+)?(?:casa|propiedad|inmueble)\b/.test(t) ||
    /\bvaluar\s+(?:mi\s+)?(?:casa|propiedad|inmueble|terreno)\b/.test(t) ||
    /\b(?:valorar|valuar)\s+(?:mi\s+)?(?:casa|propiedad|inmueble|terreno)\b/.test(t) ||
    /\b(?:cu[aá]nto\s+vale|saber\s+cu[aá]nto\s+vale|conocer\s+el\s+valor)\s+(?:de\s+)?(?:mi\s+)?(?:casa|propiedad|inmueble)\b/.test(t) ||
    /\b(?:captaci[oó]n|captacion)\s+(?:de\s+)?vendedor/i.test(t) ||
    /\b(?:estoy\s+)?(?:pensando|considerando)\s+(?:vender|rentar)\b/.test(t) ||
    /\b(?:estoy\s+)?(?:pensando|considerando)\s+vender\b/.test(t) ||
    /\bvender\s+o\s+rentar\s+mi\s+propiedad\b/.test(t) ||
    (/\bquiero\s+que\s+(?:me\s+)?contacte\s+(?:un\s+)?asesor\b/.test(t) &&
      /\b(?:vender|venta|valorar|valuar|valuaci|rentar|renta|pensando|considerando|mi\s+(?:casa|propiedad)|poner en)\b/.test(t) &&
      !/\b(?:revisar|referencia|disponible|visita|anunci)\b/.test(t)) ||
    (/\b(?:me\s+)?interesa\s+que\s+(?:un\s+)?asesor\s+me\s+contacte\b/.test(t) &&
      /\b(?:valor|valuar|valorar|vender|venta|mi\s+casa|mi\s+propiedad)\b/.test(t)) ||
    (/\b(?:me\s+)?gustar[ií]a\s+valorar(?:la|lo)?\b/.test(t) &&
      /\b(?:propiedad|casa|vender|inmueble)\b/.test(t)) ||
    (isLuxettyAdvisorOwnerLead(t) &&
      /\b(?:vender|venta|valorar|valuar|valuaci|rentar|renta|pensando|considerando|poner en)\b/.test(t) &&
      !/\bbusco\b/.test(t) &&
      !/\b(?:revisar|referencia|disponible|visita|anunci)\b/.test(t))
  );
}

/** C2 / retargeting: mensaje con marca Luxetty o pedido explícito de asesor humano. */
function isC2SellerRetargetingEntry(text) {
  const t = normalizeText(String(text || ''));
  if (!matchesSellerAcquisitionPattern(t) && !isAmbiguousOwnerPropertyOrientation(text)) return false;
  return (
    /\bluxetty\b/.test(t) ||
    /\bquiero\s+que\s+(?:me\s+)?contacte\s+(?:un\s+)?asesor\b/.test(t) ||
    /\b(?:estoy\s+)?(?:pensando|considerando)\s+(?:vender|rentar)\b/.test(t) ||
    /\b(?:me\s+)?interesa\s+que\s+(?:un\s+)?asesor\s+me\s+contacte\b/.test(t)
  );
}

function isAmbiguousOwnerPropertyOrientation(text) {
  const t = normalizeText(String(text || ''));
  return (
    /\borientaci[oó]n\s+sobre\s+(?:mi\s+)?propiedad\b/.test(t) &&
    !/\b(?:vender|rentar|valorar|valuar|venta|renta|poner en)\b/.test(t)
  );
}

/** sale | rent | mixed | null */
function inferOwnerOfferOperation(normalizedText) {
  const t = String(normalizedText || '');
  const rentOut = isRentOutOwnerPhrase(t);
  const sellSignals =
    /\b(?:vender|venta|valorar|valuar|valuaci|cu[aá]nto\s+vale|conocer\s+el\s+valor)\b/.test(t);
  const rentSignals =
    rentOut ||
    (/\b(?:rentar|renta|arrendar|poner en renta)\b/.test(t) &&
      /\b(?:mi\s+)?(?:casa|propiedad|inmueble|depa)\b/.test(t));
  if (sellSignals && rentSignals) return 'mixed';
  if (rentSignals) return 'rent';
  if (sellSignals) return 'sale';
  return null;
}

/** Zona libre tras patrones de venta / ubicación ("en San Pedro", "de Cumbres"). */
function extractLooseLocationPhrase(text) {
  if (isNonLocationPhrase(text)) return null;
  const t = normalizeText(text);
  const m = t.match(
    /\b(?:en|de)\s+([a-záéíóúñ0-9][a-záéíóúñ0-9\s,.-]{1,55}?)(?=\s*(?:\.|,|\?|!|$|\n)|\s+(?:me|mi|un|una|el|la|los|las|por|para|con|que|qué)\b)/i
  );
  if (!m) return null;
  const loc = cleanSpaces(m[1].replace(/[,]+$/g, ''));
  if (!loc || loc.length < 2) return null;
  if (/^(venta|renta|casa|propiedad|depa|departamento|terreno|lujo|info)$/i.test(loc)) return null;
  const locNorm = normalizeText(loc);
  // Never treat listing references as zones ("la propiedad LUX-A0453").
  if (/\blux[- ]?a?\d{3,5}\b/i.test(locNorm)) return null;
  if (/^(?:la\s+)?(?:propiedad|casa|depa|departamento|inmueble)\b/.test(locNorm)) return null;
  if (/\b(?:millon|millones|mil|pesos|presupuesto)\b/.test(locNorm)) return null;
  if (/\b(?:tienes|tienen|hay|menos|opciones|muestrame|mostrar)\b/.test(locNorm)) return null;
  const titled = loc
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return titled.length > 60 ? `${titled.slice(0, 57)}...` : titled;
}

/**
 * Corrección de intención / repetición ("ya te dije que renta").
 * No usar para filtrar ubicaciones — ver isNonLocationPhrase.
 */
function isIntentCorrectionPhrase(text) {
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  return (
    /\bya\s+te\s+dije\b/.test(t) ||
    /\bte\s+dije\s+que\b/.test(t) ||
    (/\bno\s+(?:es\s+)?eso\b/.test(t) && /\b(?:renta|venta|compra|comprar)\b/.test(t)) ||
    /\ben\s+realidad\s+(?:es|busco|quiero|renta)\b/.test(t)
  );
}

/**
 * Frases de frustración/negación que NO son ubicación.
 * Nota: NO usar isIntentCorrectionPhrase — "ya te dije que en San Pedro"
 * es corrección CON ubicación válida y debe conservarse.
 */
function isNonLocationPhrase(text) {
  const t = normalizeText(String(text || ''));
  if (!t) return true;
  return (
    /\bno\s+se\s+de\s+que\s+(?:hablas|me\s+hablas)\b/.test(t) ||
    /\bno\s+me\s+est[aá]s?\s+entendiendo\b/.test(t) ||
    /\bno\s+(?:te\s+)?entiendo\b/.test(t) ||
    /\bno\s+(?:me\s+)?entiendes\b/.test(t) ||
    /\bno\s+es\s+(?:eso|correcto|as[ií])\b/.test(t) ||
    /\bnada\s+que\s+ver\b/.test(t) ||
    /\best[aá]s?\s+mal\b/.test(t) ||
    /\bque\s+no\s+entiendes\b/.test(t)
  );
}

function isThinGenericInbound(normalizedText) {
  const t = cleanSpaces(String(normalizedText || ''));
  if (!t || t.length > 40) return false;
  return /^(info|informaci[oó]n|informacion|precio|precios|disponible\??|hola\??|buenas|hey|me interesa|interesa|disponibilidad\??)$/i.test(
    t
  );
}

function isRentOutOwnerPhrase(normalizedText) {
  const t = String(normalizedText || '');
  if (
    /\b(?:estoy\s+)?(?:pensando|considerando)\s+rentar\b/.test(t) &&
    (/\b(?:mi\s+)?(?:propiedad|casa|inmueble)\b/.test(t) || isLuxettyAdvisorOwnerLead(t))
  ) {
    return true;
  }
  if (
    isLuxettyAdvisorOwnerLead(t) &&
    /\b(?:quiero|necesito)\s+rentar\b/.test(t) &&
    /\b(?:propiedad|casa|inmueble)\b/.test(t) &&
    !/\bbusco\b/.test(t)
  ) {
    return true;
  }
  return (
    (/\b(?:quiero|necesito)\s+rentar\b/.test(t) &&
      /\b(?:que\s+tengo|mi\s+casa|mi\s+depa|mi\s+departamento|mi\s+propiedad|una\s+casa\s+que)\b/.test(t)) ||
    /\bponer\s+en\s+renta\b/.test(t) ||
    /\brentar\s+mi\b/.test(t) ||
    (/\brenta\b/.test(t) &&
      (/\bmi\s+casa\b/.test(t) || /\bmi\s+departamento\b/.test(t) || /\bmi\s+propiedad\b/.test(t)))
  );
}

function mentionsRentDemand(normalizedText) {
  const t = String(normalizedText || '');
  if (isRentOutOwnerPhrase(t)) return false;
  // Opción venta/renta en captación propietario — no es demanda de inventario.
  if (/\b(?:venta\s+o\s+renta|renta\s+o\s+venta)\b/.test(t)) return false;
  if (
    isLuxettyAdvisorOwnerLead(t) &&
    /\b(?:pensando|considerando|quiero|necesito)\s+rentar\b/.test(t) &&
    !/\bbusco\b/.test(t)
  ) {
    return false;
  }
  if (/\b(?:poner|ponerla|rentar\s+mi|mi\s+casa\s+en\s+renta)\b/.test(t) && /\b(?:renta|rentar)\b/.test(t)) {
    return false;
  }
  return (
    /\b(?:quiero|busco|necesito)\s+rentar\b/.test(t) ||
    /\brentar\s+(?:una|un|la|el)\b/.test(t) ||
    (/\brenta\b/.test(t) && /\b(?:busco|quiero)\b/.test(t)) ||
    // "me interesa" + renta solo si hay señal de inventario (casa/opciones), no prevaluación.
    (/\brenta\b/.test(t) &&
      /\binteresa\b/.test(t) &&
      /\b(?:casa|depa|departamento|opciones?|inmueble|propiedad)\b/.test(t) &&
      !/\bprevaluaci/.test(t) &&
      !/\b(?:tengo|mi)\s+(?:una\s+)?(?:casa|propiedad|inmueble)\b/.test(t)) ||
    // Inventario: "¿Qué opciones de casas en renta tienes en Cumbres?"
    /\b(?:opciones?|casas?|departamentos?|depas?|inmuebles?|propiedades?)\b.*\b(?:en\s+renta|renta)\b/.test(t) ||
    /\b(?:en\s+renta|renta)\b.*\b(?:opciones?|casas?|tienes|tienen|hay|muestrame|muéstrame)\b/.test(t) ||
    /\b(?:tienes|tienen|hay)\b.*\ben\s+renta\b/.test(t)
  );
}

/**
 * Comprador pidiendo inventario en venta — no confundir con captación vendedor.
 */
function mentionsBuyDemand(normalizedText) {
  const t = normalizeText(String(normalizedText || ''));
  if (!t) return false;
  if (/\b(?:mi|nuestra?|nuestro)\s+(?:casa|departamento|depa|propiedad|inmueble|terreno|local)\b/.test(t)) {
    return false;
  }
  if (/\b(?:quiero|deseo|necesito|voy\s+a|pienso|me\s+gustar[ií]a|quisiera)\s+vender\b/.test(t)) return false;
  if (/\bvender\s+(?:mi|nuestra?|nuestro)\b/.test(t)) return false;
  if (/\b(?:poner|ponerla|ponerlo)\s+en\s+venta\b/.test(t)) return false;
  if (matchesSellerAcquisitionPattern(t)) return false;
  if (/\b(?:quiero|busco|necesito)\s+comprar\b/.test(t)) return true;
  if (/\bme\s+interesa\s+comprar\b/.test(t)) return true;
  // Interés genérico en casa/propiedad — no si ya hay código de listado (PROPERTY_INQUIRY).
  if (
    /\bme\s+interesa\s+(?:la\s+)?(?:casa|depa|departamento|propiedad|inmueble)\b/.test(t) &&
    !/\blux[- ]?[a-z]?\d{3,5}\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(?:vi|vio)\s+su\s+anuncio\b/.test(t)) return true;
  if (/\bcampa[nñ]a\b/.test(t) && /\b(?:casa|depa|departamento|propiedad|interesa|cumbres)\b/.test(t)) return true;
  if (/\bcomprar\s+(?:una|un|la|el)\b/.test(t)) return true;
  if (/\b(?:qu[eé]\s+puedo\s+comprar|puedo\s+comprar|con\s+\d+\s+millones?\s+.*comprar)\b/.test(t)) return true;
  if (/\b(?:tengo|cuento\s+con|presupuesto)\b.*\b(?:millon|millones|mdp)\b.*\bcomprar\b/.test(t)) return true;
  if (/\b(?:opciones?|casas?|departamentos?|depas?|inmuebles?|propiedades?|terrenos?)\b.*\b(?:en\s+venta|venta|comprar)\b/.test(t)) {
    return true;
  }
  if (/\b(?:en\s+venta|venta)\b.*\b(?:opciones?|casas?|departamentos?|depas?|disponibles?)\b/.test(t)) return true;
  if (/\b(?:en\s+venta|venta)\b.*\b(?:tienes|tienen|hay|muestrame|muéstrame|mostrar)\b/.test(t)) return true;
  if (/\b(?:tienes|tienen|hay)\b.*\ben\s+venta\b/.test(t)) return true;
  return false;
}

/**
 * Búsqueda/demanda (compra o renta como cliente) — no debe activar landing de captación vendedor.
 */
function isDemandSearchInbound(text) {
  const t = normalizeText(String(text || ''));
  if (!t) return false;
  if (mentionsBuyDemand(t)) return true;
  if (mentionsRentDemand(t) && !/\b(?:mi\s+)?(?:casa|propiedad|inmueble)\b/.test(t)) return true;
  if (
    /\bbusco\b/.test(t) &&
    /\b(?:casa|depa|depto|departamento|inmueble|propiedad)\b/.test(t) &&
    !/\b(?:vender|rentar\s+mi|mi\s+casa|mi\s+propiedad|poner en)\b/.test(t)
  ) {
    return true;
  }
  if (
    /\b(?:estoy\s+)?buscando\b/.test(t) &&
    /\b(?:casa|depa|departamento|inmueble)\b/.test(t) &&
    !/\b(?:vender|mi\s+)\b/.test(t)
  ) {
    return true;
  }
  if (/\bquiero\s+comprar\b/.test(t) || /\bme\s+interesa\s+comprar\b/.test(t)) return true;
  if (/\bbusco\b/.test(t) && /\bcomprar\b/.test(t)) return true;
  if (/\b(?:qu[eé]\s+puedo\s+comprar|puedo\s+comprar)\b/.test(t)) return true;
  if (
    /\bbusco\b/.test(t) &&
    /\b(?:casa|depa|departamento|inmueble)\b/.test(t) &&
    /\b(?:venta|alberca|jardin|jard[ií]n|amueblad|garage|estacionamiento)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function isExplicitFlowSwitchToRentDemand(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (isRentOutOwnerPhrase(t)) return false;
  // Alineado con R0 explicitDemandSearchIntent / mentionsRentDemand (sticky offer → renta).
  if (mentionsRentDemand(t)) return true;
  return (
    t.includes('mejor quiero rentar') ||
    t.includes('mejor busco rentar') ||
    t.includes('cambio a renta') ||
    t.includes('quiero rentarla') ||
    t.includes('busco rentar') ||
    (t.includes('arrendar') && t.includes('quiero')) ||
    (/\bmejor\b/.test(t) && /\bbusco\b/.test(t) && /\brenta\b/.test(t)) ||
    (/\bahora\b/.test(t) && /\bbusco\b/.test(t) && /\brenta\b/.test(t))
  );
}

function isExplicitFlowSwitchToRentOut(text) {
  const t = normalizeText(text);
  return (
    t.includes('mejor la pongo en renta') ||
    t.includes('ponerla en renta') ||
    t.includes('quiero ponerla en renta') ||
    t.includes('rentarla en lugar de vender') ||
    t.includes('cambio de planes') && t.includes('renta')
  );
}

function isExplicitFlowSwitchToSellFromRent(text) {
  const t = normalizeText(text);
  return (
    t.includes('mejor quiero vender') ||
    t.includes('cambio a venta') ||
    t.includes('quiero venderla') ||
    t.includes('en realidad quiero vender') ||
    t.includes('no quiero rentar') && t.includes('vender')
  );
}

function isExplicitPropertyInquiryPhrase(text) {
  const t = normalizeText(text);
  return (
    /\bme interesa\s+(?:la\s+)?(?:propiedad|casa|depa|departamento|inmueble)\b/.test(t) ||
    /\b(?:informaci[oó]n|info)\s+(?:de|sobre)\s+(?:la\s+)?(?:propiedad|casa|depa|inmueble|codigo|código)\b/.test(t) ||
    /\b(?:h[aá]blame|cu[eé]ntame|dime)\s+(?:de|sobre)\s+(?:la\s+)?(?:propiedad|casa|depa|inmueble)\b/.test(t) ||
    /\b(?:precio|disponible|sigue disponible|aun disponible|aún disponible|todav[ií]a disponible)\b/.test(t) ||
    /\b(?:quiero|me gustar[ií]a)\s+ver\s+(?:la\s+)?(?:casa|propiedad|depa)\b/.test(t)
  );
}

module.exports = {
  matchesSellerAcquisitionPattern,
  isC2SellerRetargetingEntry,
  isAmbiguousOwnerPropertyOrientation,
  inferOwnerOfferOperation,
  isLuxettyAdvisorOwnerLead,
  extractLooseLocationPhrase,
  isThinGenericInbound,
  mentionsRentDemand,
  mentionsBuyDemand,
  isNonLocationPhrase,
  isDemandSearchInbound,
  isRentOutOwnerPhrase,
  isExplicitFlowSwitchToRentDemand,
  isExplicitFlowSwitchToRentOut,
  isExplicitFlowSwitchToSellFromRent,
  isExplicitPropertyInquiryPhrase,
  isIntentCorrectionPhrase,
};
