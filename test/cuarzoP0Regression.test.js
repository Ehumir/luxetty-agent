'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const antiLoop = require('../conversation/antiLoopGuardrails');
const cuarzoHandoff = require('../conversation/cuarzoHandoff');
const cuarzoFallbacks = require('../conversation/cuarzoFallbacks');
const humanEscalation = require('../conversation/humanEscalation');
const { getDefaultAiState } = require('../conversation/aiState');
const { simulateTurn } = require('./qaMatrixP0ConversationalHarness');
const { buildSaleCaptiveContinuityReply } = require('../conversation/r0ContextContinuity');

describe('Cuarzo P0 — regresión conversacional', () => {
  it('detecta "Está repitiendo todo" como frustración', () => {
    const fr = antiLoop.detectConversationalFrustration('Está repitiendo todo');
    assert.equal(fr.frustrated, true);
    assert.ok(fr.markers.includes('esta_repitiendo') || fr.markers.includes('repitiendo_todo'));
  });

  it('frustración → handoff terminal con resumen operativo', () => {
    const prev = {
      ...getDefaultAiState(),
      lead_flow: 'offer',
      operation_type: 'sale',
      property_type: 'house',
      occupancy_status: 'occupied',
      location_text: 'Hacienda Mitras',
    };
    const esc = cuarzoHandoff.resolveFrustrationTerminalHandoff({
      previousAiState: prev,
      nextAiState: prev,
      text: 'Está repitiendo todo',
      inboundFrustration: { frustrated: true, markers: ['esta_repitiendo'] },
    });
    assert.equal(esc.handled, true);
    assert.equal(esc.statePatch.handoff_sent, true);
    assert.ok(esc.statePatch.handoff_summary);
    assert.equal(esc.statePatch.handoff_summary.reason_code, 'frustration');
    assert.match(String(esc.reply), /disculpa|asesor|Luxetty/i);
    assert.doesNotMatch(String(esc.reply), /Gracias,\s*Está repitiendo/i);
  });

  it('asesor explícito sin wants_human previo → handoff', () => {
    const esc = humanEscalation.resolveWantsHumanEscalationTurn({
      previousAiState: { lead_flow: 'offer' },
      nextAiState: { lead_flow: 'offer' },
      parsedSignals: {},
      text: 'Mejor que me atienda un asesor',
    });
    assert.equal(esc.handled, true);
    assert.equal(esc.statePatch.handoff_sent, true);
    assert.ok(esc.statePatch.handoff_summary);
  });

  it('post-handoff: Ok → ACK corto sin calificación comercial', () => {
    const prev = { handoff_sent: true, lead_flow: 'offer', full_name: 'María López' };
    const ack = cuarzoHandoff.resolvePostHandoffTurn({
      previousAiState: prev,
      nextAiState: prev,
      text: 'Ok',
    });
    assert.equal(ack.handled, true);
    assert.match(String(ack.reply), /asesor de Luxetty/i);
    assert.doesNotMatch(String(ack.reply), /tipo de inmueble|habitada|nombre/i);
  });

  it('post-handoff: mensaje comercial ambiguo → hold sin repreguntar slots', () => {
    const prev = { handoff_sent: true, lead_flow: 'offer' };
    const hold = cuarzoHandoff.resolvePostHandoffTurn({
      previousAiState: prev,
      nextAiState: prev,
      text: 'Sigo con lo mismo de antes',
    });
    assert.equal(hold.handled, true);
    assert.match(String(hold.reply), /canalizado|asesor/i);
    assert.doesNotMatch(String(hold.reply), /casa, departamento|habitada/i);
  });

  it('sticky slots oferta: no repregunta tipo si ya es casa habitada', () => {
    const ai = {
      lead_flow: 'offer',
      property_type: 'house',
      occupancy_status: 'occupied',
      location_text: 'Hacienda Mitras',
    };
    const reply = buildSaleCaptiveContinuityReply({
      text: 'ok',
      aiState: ai,
    });
    assert.doesNotMatch(reply, /casa, departamento|terreno/i);
    assert.doesNotMatch(reply, /habitada, rentada o libre/i);
  });

  it('legal_sensitive → fallback honesto + handoff', () => {
    const turn = cuarzoFallbacks.resolveCuarzoOutOfScopeTurn({
      text: 'Es sucesión intestada con herederos en disputa',
      parsedSignals: { legal_sensitive: true },
      inboundContext: {},
      previousAiState: {},
      nextAiState: { lead_flow: 'offer' },
    });
    assert.equal(turn.handled, true);
    assert.match(String(turn.reply), /asistente IA de Luxetty/i);
    assert.match(String(turn.reply), /asesor humano/i);
    assert.equal(turn.statePatch.handoff_sent, true);
  });

  it('transcript 5640 — frustración y handoff terminal', () => {
    let ai = {
      ...getDefaultAiState(),
      lead_flow: 'offer',
      operation_type: 'sale',
      property_type: 'house',
      occupancy_status: 'occupied',
      location_text: 'Hacienda Mitras',
    };
    const outbound = [];

    const frustration = simulateTurn({
      userText: 'Está repitiendo todo',
      aiState: ai,
      contact: { first_name: 'Cliente', last_name: '' },
      outboundHistory: outbound,
    });
    assert.match(frustration.assistantText, /asesor|Luxetty|disculpa/i);
    assert.doesNotMatch(frustration.assistantText, /Gracias,\s*Está repitiendo/i);
    ai = frustration.aiState;

    const advisor = simulateTurn({
      userText: 'Mejor que me atienda un asesor',
      aiState: ai,
      contact: { first_name: 'Cliente', last_name: '' },
      outboundHistory: [frustration.assistantText],
    });
    assert.match(advisor.assistantText, /asesor|Luxetty/i);

    ai = { ...advisor.aiState, handoff_sent: true };

    const okTurn = simulateTurn({
      userText: 'Ok',
      aiState: ai,
      contact: { first_name: 'Cliente', last_name: '' },
      outboundHistory: [advisor.assistantText],
    });
    // Ya hubo handoff y hold; el tercer ACK debe quedar en silencio para no
    // duplicar mensajes ni reabrir calificación.
    assert.equal(okTurn.assistantText, '');
    assert.doesNotMatch(okTurn.assistantText, /tipo de inmueble|habitada|nombre/i);
  });
});
