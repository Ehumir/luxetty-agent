'use strict';

function humanLockFromAiState(aiState = {}) {
  const c = aiState?.ai_control && typeof aiState.ai_control === 'object' ? aiState.ai_control : {};
  return c.attention_mode === 'human' || c.ai_paused === true || aiState.attention_mode === 'human' || aiState.ai_paused === true;
}

function firstNameOnly(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean)[0] || 'Cliente';
}

function requestDescription(candidate = {}) {
  const lt = String(candidate.lead_type || '').toLowerCase();
  const op = String(candidate.operation || '').toLowerCase();
  if (lt === 'supply' && op === 'rent') return 'renta de tu propiedad';
  if (lt === 'supply') return 'venta de tu propiedad';
  if (op === 'rent') return 'renta de una propiedad';
  return 'compra de una propiedad';
}

function buildConfirmTemplate(candidate = {}) {
  const name = firstNameOnly(candidate.contact_name);
  const description = requestDescription(candidate);
  return {
    name,
    description,
    body: `Hola ${name}. Tu solicitud de ${description} con Luxetty sigue pendiente de confirmaci\u00f3n.`,
    components: [{
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: description },
      ],
    }],
  };
}

function normalizeReply(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00f1\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyIcfFollowupReply(text) {
  const t = normalizeReply(text);
  if (!t) return { kind: 'unknown' };
  const globalOptOut = /^(stop|baja)$/i.test(t) || /\b(no me (contacten|escriban|llamen)|dejen de (contactarme|escribirme|llamarme)|no quiero recibir (mensajes|whatsapp)|no contactar|no me manden mensajes)\b/i.test(t);
  if (globalOptOut) return { kind: 'decline', globalOptOut: true };
  const yes = new Set(['si','confirmo','quiero continuar','continuar','continuar solicitud','quiero seguir','sigo interesado','me interesa','adelante','si quiero','si continuar','si sigo interesado']);
  if (yes.has(t)) return { kind: 'confirm', globalOptOut: false };
  const no = new Set(['no','no gracias','ya no','ya no me interesa','no me interesa','no quiero continuar','ya no quiero continuar','no quiero el servicio','ya no quiero el servicio','cerrar solicitud']);
  if (no.has(t)) return { kind: 'decline', globalOptOut: false };
  return { kind: 'unknown' };
}

module.exports = { humanLockFromAiState, firstNameOnly, requestDescription, buildConfirmTemplate, classifyIcfFollowupReply };
