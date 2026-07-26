'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePriorityIntent,
  applyPriorityToSignals,
  PRIORITY,
} = require('../conversation/conversationPriorityResolver');
const { getDefaultAiState } = require('../conversation/aiState');

describe('conversationPriorityResolver', () => {
  it('humano gana siempre', () => {
    const p = resolvePriorityIntent('Asesor personal', getDefaultAiState(), {
      lead_flow: 'demand',
      property_code: 'LUX-A0001',
    });
    assert.equal(p.priority, PRIORITY.HUMAN);
  });

  it('seller gana sobre greeting implícito', () => {
    const p = resolvePriorityIntent(
      'Buenas noches me comparten información para promover una propiedad',
      getDefaultAiState(),
      {},
    );
    assert.equal(p.key, 'seller_capture');
    assert.equal(p.lead_flow, 'offer');
  });

  it('greeting no pisa seller sticky', () => {
    const prev = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale' };
    const p = resolvePriorityIntent('hola', prev, {});
    assert.equal(p.key, 'seller_capture');
  });

  it('Hola + casas en renta Cumbres es rent_search (no greeting)', () => {
    const text = 'Hola, ¿tienes casas en renta en zona Cumbres?';
    const p = resolvePriorityIntent(text, getDefaultAiState(), {});
    assert.equal(p.key, 'rent_search');
    assert.equal(p.lead_flow, 'demand');
    const {
      isGreetingOpeningText,
      isRentSearchText,
    } = require('../conversation/conversationPriorityResolver');
    assert.equal(isRentSearchText(text), true);
    assert.equal(isGreetingOpeningText(text), false);
  });

  it('demanda renta rompe sticky offer', () => {
    const prev = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale', property_type: 'house' };
    const p = resolvePriorityIntent('Hola, ¿tienes casas en renta en zona Cumbres?', prev, {});
    assert.equal(p.key, 'rent_search');
    assert.equal(p.lead_flow, 'demand');
    const sig = applyPriorityToSignals({}, 'quiero rentar', prev);
    assert.equal(sig.lead_flow, 'demand');
    assert.equal(sig.operation_type, 'rent');
  });

  it('opening no maneja greeting cuando hay renta+zona', () => {
    const opening = require('../conversation/conversationOpeningResolver');
    const o = opening.resolveConversationOpening({
      text: 'Hola, ¿tienes casas en renta en zona Cumbres?',
      previousAiState: getDefaultAiState(),
      nextAiState: { operation_type: 'rent', location_text: 'Cumbres', property_type: 'house' },
      parsedSignals: { operation_type: 'rent', location_text: 'Cumbres' },
      recentMessages: [{ direction: 'inbound' }, { direction: 'inbound' }],
    });
    assert.equal(o.handled, false);
    assert.equal(o.opening_type, 'rent_search');
    assert.equal(o.statePatch?.lead_flow, 'demand');
    assert.doesNotMatch(String(o.reply || ''), /compra, venta o renta/i);
  });

  it('meta_general antes que greeting genérico', () => {
    const p = resolvePriorityIntent(
      'Estoy navegando en facebook y Vi su página inmobiliaria',
      getDefaultAiState(),
      {},
    );
    assert.equal(p.key, 'meta_general');
    assert.ok(p.priority < PRIORITY.GREETING);
  });

  it('applyPriorityToSignals fuerza offer en vender+zona', () => {
    const sig = applyPriorityToSignals(
      { lead_flow: 'demand', location_text: 'García' },
      'Vender una propiedad ubicada en garcia por la reserva',
      getDefaultAiState(),
    );
    assert.equal(sig.lead_flow, 'offer');
  });
});
