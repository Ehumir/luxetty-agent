'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROPERTY_PAUTA_HANDOFF_REPLY,
  buildPropertyPautaReply,
  isPropertyDemandMetaLeadForm,
  isPropertyPautaHandoffThread,
  tryPropertyPautaHandoffTurn,
} = require('../conversation/propertyPautaHandoff');

const LAURO_FORM = `¡Hola! Completé el formulario y me gustaría obtener más información sobre tu negocio.
Email: laurodepaulajr@gmail.com
Full name: Lauro de Paula
Phone number: +528110222656
¿Qué deseas hacer?: 📋 Recibir más información`;

describe('property pauta handoff', () => {
  it('detecta Meta Lead Form de demanda (Recibir más información)', () => {
    assert.equal(
      isPropertyDemandMetaLeadForm({
        text: LAURO_FORM,
        message: { type: 'text' },
        campaignContext: null,
        previousAiState: {},
        parsedSignals: {},
      }),
      true,
    );
  });

  it('responde con contexto verificable de la propiedad y deja el hilo esperando al humano', () => {
    const turn = tryPropertyPautaHandoffTurn({
      text: LAURO_FORM,
      message: { type: 'text' },
      campaignContext: { campaign_type: 'property_listing', property_code: 'LUX-A0461' },
      property: {
        title: 'Casa en Cumbres',
        operation_type: 'sale',
        neighborhood: 'Cumbres 5o Sector',
        price: 8500000,
        currency_code: 'MXN',
      },
      previousAiState: {},
      parsedSignals: {},
    });

    assert.equal(turn.handled, true);
    assert.match(String(turn.reply), /Casa en Cumbres/);
    assert.match(String(turn.reply), /Cumbres 5o Sector/);
    assert.match(String(turn.reply), /\$8,500,000/);
    assert.doesNotMatch(String(turn.reply), /Claro, te ayudo/i);
    assert.doesNotMatch(String(turn.reply), /comprar o rentar/i);
    assert.equal(turn.statePatch.lead_flow, 'demand');
    assert.equal(turn.statePatch.property_pauta_handoff_sent, true);
    assert.equal(turn.statePatch.handoff_sent, true);
    assert.equal(turn.statePatch.conversation_mode, 'HUMAN_WAITING');
    assert.equal(turn.statePatch.full_name, 'Lauro De Paula');
    assert.equal(turn.responseSource, 'property_pauta_meta_lead_form');
  });

  it('follow-up en hilo pauta no repite handoff y queda para el gate HUMAN_WAITING', () => {
    const first = tryPropertyPautaHandoffTurn({
      text: LAURO_FORM,
      message: { type: 'text' },
      campaignContext: null,
      previousAiState: {},
      parsedSignals: {},
    });

    const followUp = tryPropertyPautaHandoffTurn({
      text: 'Esta casa que está en el post me gustaría ver fotos',
      message: { type: 'text' },
      campaignContext: null,
      previousAiState: { ...(first.statePatch || {}) },
      parsedSignals: {},
    });

    assert.equal(followUp.handled, false);
    assert.equal(followUp.reason, 'post_handoff_mode_gate');
  });

  it('si no hay propiedad verificable no afirma que exista una asignada', () => {
    const reply = buildPropertyPautaReply({
      parsed: { labeled: { operation_raw: 'Recibir más información' } },
      property: null,
    });
    assert.match(reply, /validaremos el anuncio de origen/i);
    assert.doesNotMatch(reply, /asesor que tiene esta propiedad asignada/i);
  });

  it('hilo pauta con referral + property_code activa handoff', () => {
    assert.equal(
      isPropertyPautaHandoffThread(
        {
          lead_flow: 'demand',
          property_code: 'LUX-A0461',
          whatsapp_referral: { source_url: 'https://facebook.com/ad' },
          campaign_context: { campaign_type: 'property_listing', property_code: 'LUX-A0461' },
        },
        null,
      ),
      true,
    );
  });

  it('detecta Meta Lead Form colapsado (cleanSpaces del webhook)', () => {
    const { cleanSpaces } = require('../utils/text');
    const collapsed = cleanSpaces(LAURO_FORM);

    assert.equal(
      isPropertyDemandMetaLeadForm({
        text: collapsed,
        message: { type: 'text' },
        campaignContext: null,
        previousAiState: {},
        parsedSignals: {},
      }),
      true,
    );

    const turn = tryPropertyPautaHandoffTurn({
      text: collapsed,
      message: { type: 'text' },
      campaignContext: null,
      previousAiState: {},
      parsedSignals: {},
    });
    assert.equal(turn.handled, true);
    assert.match(turn.reply, /validaremos el anuncio de origen/i);
    assert.doesNotMatch(turn.reply, /propiedad asignada/i);
  });

  it('detecta Meta Lead Form en inglés (pauta demanda)', () => {
    const englishForm =
      'Hello! I filled out your form and would like to know more about your business. Email: montgzz11@gmail.com Full name: Aurora Castillo Phone number: +528120930143 ¿Qué deseas hacer?: Recibir más información';

    assert.equal(
      isPropertyDemandMetaLeadForm({
        text: englishForm,
        message: { type: 'text' },
        campaignContext: null,
        previousAiState: {},
        parsedSignals: {},
      }),
      true,
    );
  });

  it('regresión real anonimizada: reconoce formulario completado en portugués', () => {
    const portugueseForm = `Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.
¿Cómo llevaría a cabo la operación?: Con crédito
¿Qué deseas hacer?: 📋 Recibir más información
Phone number: +520000000000
Si decide llevar a cabo una operación, ¿en cuánto la realizaría?: 6-9 meses
Full name: Cliente Anonimizado
Email: cliente@example.com`;

    const turn = tryPropertyPautaHandoffTurn({
      text: portugueseForm,
      message: { type: 'text' },
      campaignContext: { campaign_type: 'property_listing', property_code: 'LUX-TEST' },
      previousAiState: {},
      parsedSignals: {},
    });

    assert.equal(turn.handled, true);
    assert.equal(turn.responseSource, 'property_pauta_meta_lead_form');
    assert.doesNotMatch(String(turn.reply), /compra, venta o renta/i);
  });

  it('no intercepta Meta Lead Form de captación propietarios (C1)', () => {
    const sellerForm = `¡Hola! Completé el formulario y me gustaría obtener más información sobre tu negocio.
• nombre_completo: Javier Velázquez
• número_de_teléfono: +528110225732
• ¿en_qué_colonia_se_encuentra?: Cumbres
• ¿qué_te_gustaría_hacer?: Vender
• ¿qué_tipo_de_propiedad_es?: Casa`;

    assert.equal(
      isPropertyDemandMetaLeadForm({
        text: sellerForm,
        message: { type: 'text' },
        campaignContext: null,
        previousAiState: {},
        parsedSignals: {},
      }),
      false,
    );
  });
});
