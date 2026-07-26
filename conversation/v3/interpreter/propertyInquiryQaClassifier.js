'use strict';

const { normalizeText, cleanSpaces } = require('../../../utils/text');
const { CONVERSATION_GOALS } = require('../types/constants');

/**
 * Familias de intención para PROPERTY_INQUIRY (patrones, no frases literales únicas).
 * @typedef {'price'|'location'|'availability'|'credit'|'link'|'photos'|'visit'|'info'|'interest'|'layout'|'generic'} PropertyInquiryFactFamily
 */

/**
 * @param {import('../types/conversationState').ConversationState} state
 */
function isPropertyInquiryContext(state) {
  return (
    state &&
    state.conversationGoal === CONVERSATION_GOALS.PROPERTY_INQUIRY &&
    !!(state.propertyListingCode || state.activeProperty?.id)
  );
}

/**
 * @param {string} t normalizeText
 */
function isSoftCloseAck(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^(si|sí)$/i.test(s)) return false;
  if (
    /^(ok|va|vale|bueno|perfecto|perfecta|gracias|muchas\s+gracias|listo|listos|genial|dale|okey|okay|👍|🙌)$/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/^(mmm+\s*ok|mm+\s*ok|mmm+\s*va|mm+\s*va)$/i.test(s)) return true;
  if (/^(mmm|mm|mmmh)$/i.test(s) && s.length < 8) return true;
  return false;
}

/**
 * Intención fuerte de hablar con humano / visita / negociación formal.
 * @param {string} t normalizeText
 */
function wantsHumanOrVisit(t) {
  if (!t) return false;
  if (/\b(visita|visitar|verla|ver la|ver el|recorrido|agendar|cita|apartar|apartado|reservar)\b/.test(t)) return true;
  if (/\b(hablar|habla|chatear)\s+con\s+(alguien|una persona|un asesor|asesor|humano)\b/.test(t)) return true;
  if (/\b(asesor|asesora)\b/.test(t) && /\b(quiero|necesito|puedo|me\s+puedes|me\s+podr[ií]as|contact)\b/.test(t)) return true;
  if (/\b(negociar|negociaci[oó]n|oferta\s+formal|comprar\s+ya|comprarlo|cerrar\s+oper)\b/.test(t)) return true;
  if (/\b(coordinar|coordinen)\s+(una\s+)?(visita|llamada|llamar)\b/.test(t)) return true;
  return false;
}

/**
 * @param {string} t normalizeText
 * @returns {string|null}
 */
function classifyFactFamily(t) {
  if (!t) return null;
  if (/[?]{2,}|\b(jeje|mmm|mm+)\b/.test(t) && t.length < 24) return 'generic';
  if (/\b(precio|precios|cu[aá]nto|cuesta|valor|tarifa|pide|piden|costo|inversi[oó]n)\b/.test(t)) return 'price';
  if (/\b(ubicaci[oó]n|d[oó]nde|zona|colonia|direcci[oó]n|mapa|ubicad)\b/.test(t)) return 'location';
  if (/\b(disponible|disponibilidad|sigue|siguen|aun|aún|todav[ií]a|libre|activa)\b/.test(t)) return 'availability';
  if (/\b(cr[eé]dito|hipoteca|infonavit|fovisste|bancos|enganche)\b/.test(t)) return 'credit';
  if (/\b(link|url|enlace|mandame|m[aá]ndame|pasame|p[aá]same|p[aá]gina)\b/.test(t)) return 'link';
  if (/\b(fotos?|imagenes|im[aá]genes|galer[ií]a)\b/.test(t)) return 'photos';
  if (/\b(pisos|planta|niveles|patio|terreno|m2|m²|metros|rec[aá]maras?|habitaciones?|baños?|bath)\b/.test(t)) return 'layout';
  if (/\b(diferencia|diferencias|comparar|comparaci[oó]n|versus|vs|entre\s+las\s+dos)\b/.test(t)) return 'compare';
  if (/\b(info|informaci[oó]n|detalles|m[aá]s\s+detalles|saber\s+m[aá]s|cu[eé]ntame|h[aá]blame)\b/.test(t)) return 'info';
  if (/\b(me\s+interesa|interesa|me\s+gusta)\b/.test(t)) return 'interest';
  if (/\?/.test(t) && t.length < 120) return 'generic';
  if (t === 'hola' || t.startsWith('hola ') || t === 'buenas' || t === 'hey' || /^hola[!.👋\s]+$/i.test(t))
    return 'info';
  return null;
}

/**
 * @param {import('../types/conversationState').ConversationState} state
 * @param {string} text
 * @param {string} raw
 * @returns {{ kind: 'HUMAN_HANDOFF' }|{ kind: 'FACT', family: string }|{ kind: 'SOFT_CLOSE' }|null}
 */
function classifyPropertyInquiryTurn(state, text, raw) {
  if (!isPropertyInquiryContext(state)) return null;
  // SoT facts (precio/zona/URL) no requieren name-first; solo handoff comercial sí.
  const hasListing = !!(state.propertyListingCode || state.activeProperty?.id);
  const hasName = !!state.collectedFields?.fullName;
  const inQa = state.propertySubMode === 'PROPERTY_QA';
  if (!hasListing && !hasName && !inQa) return null;

  const t = normalizeText(String(text || ''));
  const rawTrim = cleanSpaces(String(raw || ''));
  if (!t && !rawTrim) return null;

  if (rawTrim && /^[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(rawTrim) && rawTrim.length < 32) {
    return { kind: 'FACT', family: 'interest' };
  }

  if (wantsHumanOrVisit(t)) {
    return { kind: 'HUMAN_HANDOFF' };
  }

  const fam = classifyFactFamily(t);
  if (fam) return { kind: 'FACT', family: fam };

  if (inQa && isSoftCloseAck(t)) {
    return { kind: 'SOFT_CLOSE' };
  }

  // Primer turno con código + "háblame / info" implícito.
  if (hasListing && !inQa && /\b(?:propiedad|casa|depa|lux[- ]?a?\d)/i.test(t)) {
    return { kind: 'FACT', family: 'info' };
  }

  return null;
}

module.exports = {
  isPropertyInquiryContext,
  classifyPropertyInquiryTurn,
  wantsHumanOrVisit,
  classifyFactFamily,
  isSoftCloseAck,
};
