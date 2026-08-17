'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasValidHumanName,
  shouldAskForName,
  appendNameRequestIfNeeded,
  isPlaceholderContact,
} = require('../conversation/namePrompt');

test('sin nombre + pregunta precio → pide nombre', () => {
  const contact = { first_name: 'Cliente', last_name: '' };
  const aiState = { lead_flow: 'demand', full_name: null, awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Claro, te ayudo con el contexto de precio.', {
    contact,
    aiState,
    waProfileDisplayName: null,
    recentOutboundTexts: [],
    userInboundText: '¿Cuál es el precio?',
    leadFlow: 'demand',
    wantsVisit: false,
  });
  assert.match(String(messages), /nombre|cómo te llamas|registr/i);
});

test('sin nombre + venta → pide nombre', () => {
  const contact = null;
  const aiState = { lead_flow: 'offer', full_name: null, awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Sí, te puedo orientar con la venta.', {
    contact,
    aiState,
    recentOutboundTexts: [],
    userInboundText: 'Quiero vender mi casa',
    leadFlow: 'offer',
  });
  assert.match(String(messages), /nombre|llamas|registr/i);
});

test('sin nombre + visita → pide nombre', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { lead_flow: 'demand', wants_visit: true, awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Con gusto revisamos la visita.', {
    contact,
    aiState,
    recentOutboundTexts: [],
    userInboundText: 'Quiero verla',
    leadFlow: 'demand',
    wantsVisit: true,
  });
  assert.match(String(messages), /nombre|cómo te llamas|registr/i);
});

test('con nombre válido en ai_state → NO pide nombre', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { full_name: 'Mariana Ruiz', awaiting_field: null };
  const { messages, statePatch } = appendNameRequestIfNeeded('Texto de ayuda principal.', {
    contact,
    aiState,
    recentOutboundTexts: [],
    userInboundText: 'Hola',
  });
  assert.equal(messages, 'Texto de ayuda principal.');
  assert.deepEqual(statePatch, {});
});

test('contacto con nombre humano válido → NO pide nombre', () => {
  const contact = { first_name: 'Carlos', last_name: 'Pérez' };
  const aiState = { full_name: null, awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Seguimos con tu caso.', {
    contact,
    aiState,
    recentOutboundTexts: [],
  });
  assert.equal(messages, 'Seguimos con tu caso.');
  assert.ok(hasValidHumanName(contact, aiState));
});

test('placeholder Cliente → sí pide nombre', () => {
  const contact = { first_name: 'Cliente', last_name: '' };
  assert.ok(isPlaceholderContact(contact));
  const { messages } = appendNameRequestIfNeeded('Avanzamos con tu solicitud.', {
    contact,
    aiState: { awaiting_field: null },
    recentOutboundTexts: [],
  });
  assert.match(String(messages), /nombre|cómo te llamas|registr/i);
});

test('nombre inválido tipo multimedia → sí pide nombre', () => {
  const contact = { first_name: 'El usuario envió una imagen', last_name: '' };
  const aiState = { awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Recibido, seguimos.', {
    contact,
    aiState,
    recentOutboundTexts: [],
  });
  assert.match(String(messages), /nombre|cómo te llamas|registr/i);
});

test('si ya pidió nombre en outbound reciente → no repite', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { name_prompt_variant_index: 0, awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Segunda ayuda útil.', {
    contact,
    aiState,
    recentOutboundTexts: ['Para canalizarte con un asesor, ¿me compartes tu nombre?'],
    userInboundText: 'Ok',
  });
  assert.equal(messages, 'Segunda ayuda útil.');
});

test('handoff_sent + gracias + sin nombre: cierre corto sin reiniciar captura de identidad', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { handoff_sent: true, awaiting_field: null };
  const { messages, statePatch } = appendNameRequestIfNeeded('Gracias a ti. Si surge algo más, aquí estoy.', {
    contact,
    aiState,
    recentOutboundTexts: [],
    userInboundText: 'gracias',
  });
  assert.match(String(messages), /gracias a ti/i);
  assert.doesNotMatch(String(messages), /nombre|cómo te llamas|registr/i);
  assert.equal(statePatch.awaiting_field, undefined);
});

test('perfil WA útil + placeholder → confirma registro', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { awaiting_field: null };
  const { messages } = appendNameRequestIfNeeded('Te apoyo con gusto.', {
    contact,
    aiState,
    waProfileDisplayName: 'Carlos López',
    recentOutboundTexts: [],
    userInboundText: 'Info',
  });
  assert.match(String(messages), /registro como|registrarte como/i);
});

test('awaiting_field de preferencia de contacto → no interrumpe', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { awaiting_field: 'contact_preference' };
  const { messages } = appendNameRequestIfNeeded('Sobre tu preferencia de contacto.', {
    contact,
    aiState,
    recentOutboundTexts: [],
  });
  assert.equal(messages, 'Sobre tu preferencia de contacto.');
});

test('shouldAskForName coherente con append', () => {
  const contact = { first_name: 'Cliente' };
  const aiState = { awaiting_field: null };
  assert.equal(
    shouldAskForName({
      contact,
      aiState,
      currentReply: 'Ayuda',
      recentOutboundTexts: [],
    }),
    true
  );
  assert.equal(
    shouldAskForName({
      contact: { first_name: 'Ana' },
      aiState: {},
      currentReply: 'Ayuda',
      recentOutboundTexts: [],
    }),
    false
  );
});
