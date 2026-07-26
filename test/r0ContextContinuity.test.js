'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const r0 = require('../conversation/r0ContextContinuity');
const { mergeContextualSignals } = require('../conversation/contextualMemoryResolver');
const { getDefaultAiState } = require('../conversation/aiState');
const { _private: idx } = require('../index');

describe('R0 P0.1.2 context continuity', () => {
  it('comprador demand + operation_type sale + presupuesto NO es sticky captación', () => {
    assert.equal(
      r0.isR0StickySaleCaptureThread({
        ...getDefaultAiState(),
        lead_flow: 'demand',
        operation_type: 'sale',
        location_text: 'Cumbres',
        budget_max: 8_000_000,
      }),
      false
    );
  });

  it('applyR0StickySignalsGuard elimina lead_flow demand y budget_max del parser en hilo venta', () => {
    const prev = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale', location_text: null };
    const sig = { lead_flow: 'demand', location_text: 'Cumbres', budget_max: 8_000_000, expected_price: null };
    const out = r0.applyR0StickySignalsGuard(prev, sig, 'está en Cumbres');
    assert.equal(out.lead_flow, undefined);
    assert.equal(out.budget_max, undefined);
    assert.equal(out.expected_price, 8_000_000);
    assert.equal(out.location_text, 'Cumbres');
  });

  it('permite cambio a demanda si el usuario lo dice explícitamente', () => {
    const prev = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale' };
    const sig = { lead_flow: 'demand' };
    const out = r0.applyR0StickySignalsGuard(prev, sig, 'busco casa en Cumbres');
    assert.equal(out.lead_flow, 'demand');
  });

  it('casas en renta / quiero rentar rompen sticky offer', () => {
    const prev = {
      ...getDefaultAiState(),
      lead_flow: 'offer',
      operation_type: 'sale',
      property_type: 'house',
      location_text: 'Cumbres',
    };
    const a = r0.applyR0StickySignalsGuard(prev, {}, 'Hola, ¿tienes casas en renta en zona Cumbres?');
    assert.equal(a.lead_flow, 'demand');
    assert.equal(a.operation_type, 'rent');
    const b = r0.applyR0StickySignalsGuard(prev, { lead_flow: 'offer' }, 'quiero rentar');
    assert.equal(b.lead_flow, 'demand');
    assert.equal(b.operation_type, 'rent');
    assert.equal(r0.explicitDemandSearchIntent('Hola, ¿tienes casas en renta en zona Cumbres?'), true);
  });

  it('buildConsultiveFallbackReply: quiero rentar no vuelve a venta', () => {
    const reply = idx.buildConsultiveFallbackReply({
      text: 'quiero rentar',
      signals: { lead_flow: 'offer' },
      aiState: {
        ...getDefaultAiState(),
        lead_flow: 'offer',
        operation_type: 'sale',
        location_text: 'Cumbres',
        property_type: 'house',
      },
    });
    assert.doesNotMatch(String(reply), /orientar con la venta|Sigo con tu venta/i);
    assert.match(String(reply), /búsqueda|buscar/i);
  });

  it('mergeContextualSignals no infiere budget_max de comprador cuando prev.operation_type es sale', () => {
    const prev = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale', location_text: 'Cumbres' };
    const built = { ...prev };
    const patch = mergeContextualSignals({}, prev, built, '8 millones');
    assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'budget_max'));
  });

  it('buildConsultiveFallbackReply: Cumbres con señales demand no dice buscar casa si aiState es venta', () => {
    const reply = idx.buildConsultiveFallbackReply({
      text: 'está en Cumbres',
      signals: { lead_flow: 'demand', location_text: 'Cumbres' },
      aiState: {
        ...getDefaultAiState(),
        lead_flow: 'offer',
        operation_type: 'sale',
        location_text: 'Cumbres',
      },
      contact: null,
      waProfileName: null,
    });
    assert.doesNotMatch(String(reply), /buscar casa/i);
    assert.match(String(reply), /venta|zona|Cumbres/i);
  });

  it('regresión guion venta: montos y nombre no disparan demanda', () => {
    let st = { ...getDefaultAiState(), lead_flow: 'offer', operation_type: 'sale', location_text: null };
    let r = idx.buildConsultiveFallbackReply({
      text: '8 millones',
      signals: { lead_flow: 'demand', budget_max: 8e6 },
      aiState: st,
    });
    assert.doesNotMatch(String(r), /buscar casa|presupuesto aproximado/i);

    st = { ...st, location_text: 'Cumbres', expected_price: 8e6 };
    r = idx.buildConsultiveFallbackReply({
      text: 'Jorge',
      signals: { lead_flow: 'demand', full_name: 'Jorge' },
      aiState: st,
    });
    assert.doesNotMatch(String(r), /búsqueda|buscar casa/i);
    assert.match(String(r), /venta|Jorge/i);
  });

  it('regresión Evelin: vender en García + proceso no pide presupuesto de compra', () => {
    const { parseMessageSignals } = require('../conversation/parsers');
    const { buildNextState, detectStateChange } = require('../conversation/stateUpdater');
    const { mergeContextualSignals, substituteForbiddenGenericDemandReply } = require('../conversation/contextualMemoryResolver');

    const msgs = [
      'Buenas noches me comparten información para promover una propiedad',
      'Vender una propiedad ubicada en garcia por la reserva',
      'Cual es el proceso',
    ];
    let prev = { ...getDefaultAiState() };
    let lastReply = '';
    for (const m of msgs) {
      let sig = parseMessageSignals(m, prev);
      sig = r0.applyR0StickySignalsGuard(prev, sig, m);
      const ct = detectStateChange(prev, sig);
      let next = buildNextState(prev, sig, ct);
      Object.assign(next, mergeContextualSignals(sig, prev, next, m));
      let reply = idx.buildConsultiveFallbackReply({
        text: m,
        signals: sig,
        aiState: next,
        contact: null,
        waProfileName: null,
      });
      const fbLoop = require('../conversation/antiLoopGuardrails').applyFallbackStreakRecovery(reply, {
        nextAiState: next,
        text: m,
        contact: null,
        waProfileName: null,
      });
      reply = fbLoop.reply;
      const sub = substituteForbiddenGenericDemandReply(reply, {
        text: m,
        aiState: next,
        hasValidName: false,
        matchedProperties: [],
      });
      lastReply = String(sub.messages);
      prev = next;
    }

    assert.equal(prev.lead_flow, 'offer');
    assert.equal(prev.location_text, 'García');
    assert.doesNotMatch(lastReply, /búsqueda|presupuesto aproximado|buscar casa/i);
    assert.match(lastReply, /proceso|prevaluaci|venta/i);
  });
});
