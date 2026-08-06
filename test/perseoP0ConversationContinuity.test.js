'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessageSignals } = require('../conversation/parsers');
const { buildNextState, detectStateChange } = require('../conversation/stateUpdater');
const { mergeContextualSignals } = require('../conversation/contextualMemoryResolver');
const { resolvePriorityIntent } = require('../conversation/conversationPriorityResolver');
const { buildPropertyPautaReply } = require('../conversation/propertyPautaHandoff');

function applyTurn(previous, text) {
  const signals = parseMessageSignals(text, previous, { media: { type: 'text' } });
  const next = buildNextState(previous, signals, detectStateChange(previous, signals));
  Object.assign(next, mergeContextualSignals(signals, previous, next, text));
  return next;
}

test('Caso 1: renta Cumbres → 40 mil y 2 recámaras conserva todos los slots', () => {
  const first = applyTurn({}, 'Hola, ¿tienes casas en renta en Cumbres?');
  const second = applyTurn(first, '40 mil, 2 recámaras mínimo');
  assert.equal(second.lead_flow, 'demand');
  assert.equal(second.operation_type, 'rent');
  assert.equal(second.location_text, 'Cumbres');
  assert.equal(second.budget_max, 40000);
  assert.equal(second.bedrooms, 2);
  assert.equal(second.property_type, 'house');
});

test('Caso 2: respuesta corta Compra continúa demanda en Cumbres', () => {
  const previous = { lead_flow: 'demand', location_text: 'Cumbres' };
  const intent = resolvePriorityIntent('Compra', previous, {});
  const next = applyTurn(previous, 'Compra');
  assert.equal(intent.key, 'buyer_search');
  assert.equal(next.lead_flow, 'demand');
  assert.equal(next.operation_type, 'sale');
  assert.equal(next.location_text, 'Cumbres');
});

test('Caso 3: formulario seller preserva venta, tipo, zona y no solicita otro formulario', () => {
  const { tryMetaLeadFormCaptureTurn } = require('../conversation/metaLeadFormCapture');
  const turn = tryMetaLeadFormCaptureTurn({
    text: 'Completé el formulario.\nNombre completo: Cliente Anónimo\nTipo de propiedad: Departamento\nColonia: Zona Poniente\nOperación: Venta\n¿En cuánto tiempo?: Pronto',
    campaignContext: { campaign_type: 'seller_capture' },
    previousAiState: {},
  });
  assert.equal(turn.handled, true);
  assert.equal(turn.statePatch.operation_type, 'sale');
  assert.equal(turn.statePatch.property_type, 'apartment');
  assert.equal(turn.statePatch.location_text, 'Zona Poniente');
  assert.doesNotMatch(turn.reply, /completa.*formulario|https?:\/\//i);
});

test('Caso 4: solicitud de visita confirma acción y propiedad verificada', () => {
  const reply = buildPropertyPautaReply({
    text: 'Quiero agendar una visita',
    parsed: { labeled: { operation_raw: 'Agendar una visita' } },
    property: { title: 'Casa muestra', operation_type: 'rent', zone: 'Cumbres', price: 20000, currency_code: 'MXN' },
  });
  assert.match(reply, /solicitud para visitar.*Casa muestra/i);
  assert.match(reply, /disponibilidad y horario/i);
});
