'use strict';

const { cleanSpaces } = require('../utils/text');
const { normalizeOperation } = require('./perseoP0Crm');

const BASE_FALLBACK =
  'Gracias por escribirnos. Ya registramos tu interés para no hacerte repetir la información. Para darte una respuesta correcta, un asesor de Luxetty continuará contigo por este mismo medio.';

function propertyTypeLabel(value) {
  const raw = cleanSpaces(String(value || '')).toLowerCase();
  if (/^(apartment|departamento|depa|depto)$/.test(raw)) return 'un departamento';
  if (/^(house|casa|residencia)$/.test(raw)) return 'una casa';
  if (/^(land|terreno|lote)$/.test(raw)) return 'un terreno';
  return null;
}

function buildHumanFallback({ aiState = {}, parsedSignals = {}, reason = 'unsafe_turn_outcome' } = {}) {
  const operation = normalizeOperation(aiState.operation_type || aiState.operationType || parsedSignals.operation_type);
  const type = propertyTypeLabel(
    aiState.property_type || aiState.propertyType || aiState.collectedFields?.propertyType || parsedSignals.property_type,
  );
  const location = cleanSpaces(String(
    aiState.location_text || aiState.locationText || parsedSignals.location_text || '',
  ));
  const opLabel = operation === 'rent' ? 'en renta' : operation === 'sale' ? 'en venta' : null;
  const verifiedBits = [type, opLabel, location ? `cerca de ${location}` : null].filter(Boolean);
  const responseText = verifiedBits.length >= 2
    ? `Gracias por escribirnos. Ya registramos que buscas ${verifiedBits.join(' ')}. Para darte opciones correctas, un asesor de Luxetty continuará contigo por este mismo medio.`
    : BASE_FALLBACK;
  return {
    responseText,
    reason,
    statePatch: {
      conversation_mode: 'HUMAN_WAITING',
      handoff_state: 'HUMAN_WAITING',
      handoff_sent: true,
      handoff_reason: reason,
      human_fallback_sent: true,
      automated_followups_blocked: true,
    },
    terminalResult: 'HUMAN_FALLBACK_SENT',
  };
}

function hasSafeAutomatedReply(reply) {
  const text = cleanSpaces(String(Array.isArray(reply) ? reply.join(' ') : reply || ''));
  if (!text) return false;
  if (/\bperfecto,\s*perfecto\b/i.test(text)) return false;
  return true;
}

module.exports = {
  BASE_FALLBACK,
  buildHumanFallback,
  hasSafeAutomatedReply,
};
