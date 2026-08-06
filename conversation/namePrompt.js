'use strict';

const { normalizeText, cleanSpaces } = require('../utils/text');
const { isUsefulContactName, isInvalidContactName, nowIso } = require('../utils/helpers');

function getContactDisplayName(contact) {
  if (!contact || typeof contact !== 'object') return '';
  const fn = String(contact.first_name || '').trim();
  const ln = String(contact.last_name || '').trim();
  const combined = [fn, ln].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  return String(contact.full_name || '').trim();
}

function isPlaceholderContact(contact) {
  if (!contact) return true;
  const fn = String(contact.first_name || '').trim();
  const ln = String(contact.last_name || '').trim();
  if (/^cliente$/i.test(fn) && !ln) return true;
  const disp = getContactDisplayName(contact);
  if (!disp) return true;
  const low = normalizeText(disp);
  if (low === 'cliente' || low === 'usuario' || low === 'sin nombre') return true;
  return false;
}

/**
 * Nombre humano válido ya registrado en contacto o en ai_state.
 * El nombre solo en perfil WhatsApp no cuenta como "registrado" hasta persistirse.
 */
function hasValidHumanName(contact = null, aiState = {}) {
  const fromState = cleanSpaces(aiState?.full_name || '');
  if (fromState && isUsefulContactName(fromState) && !isInvalidContactName(fromState)) {
    return true;
  }

  const display = getContactDisplayName(contact);
  if (!display) return false;
  if (isInvalidContactName(display)) return false;
  if (!isUsefulContactName(display)) return false;

  return !isPlaceholderContact(contact);
}

function mergeReplyText(reply) {
  if (Array.isArray(reply)) {
    return reply.map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
  }
  return cleanSpaces(String(reply || ''));
}

function replyAlreadyAsksName(reply) {
  const t = normalizeText(mergeReplyText(reply));
  if (!t) return false;

  return (
    t.includes('compartes tu nombre') ||
    t.includes('comparteme tu nombre') ||
    t.includes('compárteme tu nombre') ||
    t.includes('me regalas tu nombre') ||
    t.includes('como te llamas') ||
    t.includes('cómo te llamas') ||
    t.includes('tu nombre completo') ||
    (t.includes('confirmas') && t.includes('nombre')) ||
    t.includes('te registro como') ||
    t.includes('registrarte como') ||
    (t.includes('registr') && t.includes('nombre') && t.includes('?'))
  );
}

function outboundRecentlyPromptedName(recentOutboundTexts = []) {
  const tail = Array.isArray(recentOutboundTexts) ? recentOutboundTexts.slice(-3) : [];
  for (const raw of tail) {
    const t = normalizeText(String(raw || ''));
    if (!t) continue;
    if (
      t.includes('compartes tu nombre') ||
      t.includes('compárteme') ||
      t.includes('comparteme') ||
      t.includes('cómo te llamas') ||
      t.includes('como te llamas') ||
      t.includes('me regalas tu nombre') ||
      t.includes('te registro como') ||
      t.includes('registrarte como')
    ) {
      return true;
    }
  }
  return false;
}

function classifyNameHint({ userInboundText = '', leadFlow = null, wantsVisit = false, mergedReply = '' } = {}) {
  const u = normalizeText(userInboundText || '');
  const r = normalizeText(mergedReply || '');

  if (wantsVisit || u.includes('visita') || u.includes('quiero verla') || u.includes('verla')) {
    return 'visit';
  }
  if (
    u.includes('precio') ||
    u.includes('cuesta') ||
    u.includes('cuanto') ||
    u.includes('cuánto') ||
    r.includes('precio')
  ) {
    return 'price';
  }
  if (leadFlow === 'offer' || u.includes('vender') || u.includes('venta') || u.includes('valu')) {
    return 'sale';
  }
  if (leadFlow === 'demand') {
    return 'demand';
  }
  return 'generic';
}

const TEMPLATES = {
  price: [
    'Para registrarte bien, ¿me compartes tu nombre?',
    'Para dejarte registrado correctamente, ¿cómo te llamas?',
    'Con gusto te apoyo con eso. Para ubicarte en el sistema, ¿me regalas tu nombre?',
  ],
  sale: [
    'Antes de avanzar, ¿cómo te llamas?',
    'Para registrarlo prolijamente, ¿cómo te llamo?',
    'Si te parece, para seguir: ¿cómo te llamas?',
  ],
  visit: [
    'Con gusto revisamos la visita. Para dejarte registrado correctamente, ¿me compartes tu nombre?',
    'Listo, lo vemos. Para canalizarlo bien, ¿cómo te llamas?',
    'Claro. Para coordinar sin confusiones, ¿me regalas tu nombre?',
  ],
  demand: [
    'Para ubicar bien tu solicitud, ¿me compartes tu nombre y si buscas comprar o rentar?',
    'Claro, te ayudo. Para dejarlo registrado, ¿cómo te llamas y qué tipo de operación buscas?',
  ],
  generic: [
    'Claro, te ayudo. Para ubicar bien tu solicitud, ¿me compartes tu nombre y en qué te puedo orientar primero?',
    'Con gusto. Para registrarlo bien, ¿cómo te llamas?',
    'Perfecto. Para dejarte en el sistema sin errores, ¿me regalas tu nombre?',
  ],
};

function pickTemplateLine(hint, variantIndex) {
  const list = TEMPLATES[hint] || TEMPLATES.generic;
  const idx = Math.abs(Number(variantIndex) || 0) % list.length;
  return list[idx];
}

/**
 * @param {string|string[]} messages
 * @param {object} context
 * @returns {{ messages: string|string[], statePatch: object, setAwaitingFullName: boolean }}
 */
function appendNameRequestIfNeeded(messages, context = {}) {
  const {
    contact = null,
    aiState = {},
    waProfileDisplayName = null,
    recentOutboundTexts = [],
    userInboundText = '',
    leadFlow = null,
    wantsVisit = false,
  } = context;

  const arr = Array.isArray(messages) ? messages.map((s) => String(s || '').trim()).filter(Boolean) : [String(messages || '').trim()];
  if (arr.length === 0 || !cleanSpaces(arr.join(' '))) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  const merged = mergeReplyText(arr);

  if (hasValidHumanName(contact, aiState)) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  const isLegacyCourtesyClose = /si\s+surge\s+algo\s+m[aá]s/i.test(merged);
  if (aiState?.wants_human || (aiState?.handoff_sent && !isLegacyCourtesyClose)) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  const waiting = aiState?.awaiting_field;
  // No pisar confirmaciones de contacto; sí sumar nombre junto a zona/presupuesto/tipo/etc.
  const blocksNameAppend = ['contact_preference', 'contact_number_confirmed', 'contact_number'].includes(waiting);
  if (blocksNameAppend) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  if (replyAlreadyAsksName(merged)) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  if (outboundRecentlyPromptedName(recentOutboundTexts)) {
    return { messages, statePatch: {}, setAwaitingFullName: false };
  }

  if (context.nameAppendMode === 'name_only') {
    const fragment = 'Para registrarte bien, ¿me compartes tu nombre?';
    const last = arr[arr.length - 1];
    const combined = `${last} ${fragment}`.replace(/\s+/g, ' ').trim();
    const nextArr = [...arr.slice(0, -1), combined];
    const outMessages = Array.isArray(messages) ? nextArr : combined;
    const nextIdx = (Number(aiState?.name_prompt_variant_index || 0) + 1) % 48;
    const statePatch = {
      name_prompt_variant_index: nextIdx,
      name_prompt_last_at: nowIso(),
      name_prompt_last_signature: normalizeText(fragment).slice(0, 120),
    };
    const setAwaitingFullName = !waiting || waiting === 'full_name';
    if (!setAwaitingFullName && waiting) {
      statePatch.pending_name_capture = true;
    }
    return { messages: outMessages, statePatch, setAwaitingFullName };
  }

  const profile = cleanSpaces(String(waProfileDisplayName || ''));
  let fragment = null;

  if (
    profile &&
    isUsefulContactName(profile) &&
    !isInvalidContactName(profile) &&
    isPlaceholderContact(contact) &&
    !normalizeText(merged).includes(normalizeText(profile))
  ) {
    const first = profile.split(/\s+/)[0] || profile;
    const cap = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    const vi = Number(aiState?.name_prompt_variant_index || 0);
    fragment =
      vi % 2 === 0
        ? `¿Te registro como ${cap}? Si no, dime cómo quieres que aparezca tu nombre.`
        : `Para dejarlo bien en sistema, ¿te parece bien registrarte como ${cap}? Si prefieres otro, dímelo.`;
  } else {
    const hint = classifyNameHint({
      userInboundText,
      leadFlow,
      wantsVisit,
      mergedReply: merged,
    });
    const vi = Number(aiState?.name_prompt_variant_index || 0);
    fragment = pickTemplateLine(hint === 'demand' ? 'demand' : hint, vi);
  }

  const last = arr[arr.length - 1];
  const combined = `${last} ${fragment}`.replace(/\s+/g, ' ').trim();

  const nextArr = [...arr.slice(0, -1), combined];
  const outMessages = Array.isArray(messages) ? nextArr : combined;

  const nextIdx = (Number(aiState?.name_prompt_variant_index || 0) + 1) % 48;
  const statePatch = {
    name_prompt_variant_index: nextIdx,
    name_prompt_last_at: nowIso(),
    name_prompt_last_signature: normalizeText(fragment).slice(0, 120),
  };

  const setAwaitingFullName = !waiting || waiting === 'full_name';
  if (!setAwaitingFullName && waiting) {
    statePatch.pending_name_capture = true;
  }

  return { messages: outMessages, statePatch, setAwaitingFullName };
}

function shouldAskForName(context) {
  if (hasValidHumanName(context.contact, context.aiState)) return false;
  const merged = mergeReplyText(context.currentReply ?? '');
  if (!merged) return false;
  if (replyAlreadyAsksName(merged)) return false;
  const w = context.aiState?.awaiting_field;
  if (['contact_preference', 'contact_number_confirmed', 'contact_number'].includes(w)) return false;
  if (outboundRecentlyPromptedName(context.recentOutboundTexts || [])) return false;
  return true;
}

module.exports = {
  getContactDisplayName,
  hasValidHumanName,
  isPlaceholderContact,
  shouldAskForName,
  appendNameRequestIfNeeded,
  replyAlreadyAsksName,
  outboundRecentlyPromptedName,
  classifyNameHint,
};
