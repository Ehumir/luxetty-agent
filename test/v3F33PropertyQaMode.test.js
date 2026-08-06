'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PREV_HANDOFF = process.env.PERSEO_V3_HANDOFF_ENABLED;
const PREV_CRM = process.env.PERSEO_V3_CRM_DRY_RUN;

before(() => {
  process.env.PERSEO_V3_HANDOFF_ENABLED = 'true';
  process.env.PERSEO_V3_CRM_DRY_RUN = 'true';
});

after(() => {
  if (PREV_HANDOFF === undefined) delete process.env.PERSEO_V3_HANDOFF_ENABLED;
  else process.env.PERSEO_V3_HANDOFF_ENABLED = PREV_HANDOFF;
  if (PREV_CRM === undefined) delete process.env.PERSEO_V3_CRM_DRY_RUN;
  else process.env.PERSEO_V3_CRM_DRY_RUN = PREV_CRM;
});

const { processV3Turn, clearV3Session, ADVISOR_CONTACT_CONSENT, V3_INTENT } = require('../conversation/v3');
const { mergeConversationState } = require('../conversation/v3/types/conversationState');
const { getSession, setSession } = require('../conversation/v3/core/sessionStore');
const { buildConversationSnapshot } = require('../argos/conversationSnapshot');

describe('F3.3A PROPERTY_QA_MODE + anti-loop', () => {
  it('tras nombre entra a PROPERTY_QA sin consent pending ni handoff inmediato', () => {
    const cid = 'f33-qa-entry';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'LUX-A0462 me interesa' });
    const r2 = processV3Turn({ conversationId: cid, phone: '521', text: 'Laura' });
    assert.equal(r2.state.propertySubMode, 'PROPERTY_QA');
    assert.equal(r2.state.advisorContactConsent, ADVISOR_CONTACT_CONSENT.UNKNOWN);
    assert.equal(r2.state.awaitingField, null);
    assert.match(String(r2.reply || ''), /Gracias|Sobre|orientarte|publicado/i);
    assert.doesNotMatch(String(r2.reply || ''), /te\s+contactan/i);
  });

  it('pregunta de precio responde con dato publicado cuando hay activeProperty', () => {
    const cid = 'f33-price';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'LUX-A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Pedro' });
    let st = getSession(cid);
    st = mergeConversationState(st, {
      activeProperty: {
        id: 'p1',
        price_label: '$6,500,000 MXN',
        public_url: 'https://luxetty.com/propiedad/casa-test',
        location_label: 'Zona norte',
      },
    });
    setSession(cid, st);
    const r = processV3Turn({ conversationId: cid, phone: '521', text: '¿Cuánto cuesta?' });
    assert.match(String(r.reply || ''), /6[, ]?500[, ]?000|6500000|precio listado/i);
    assert.ok((r.state.propertyQaAnswerCount || 0) >= 1);
    const snapshot = buildConversationSnapshot(r.state, { property_code: 'LUX-A9999' });
    assert.equal(snapshot.property_code, r.state.propertyListingCode);
    assert.deepEqual(snapshot.active_property, r.state.activeProperty);
    assert.deepEqual(snapshot.field_sources, r.state.fieldProvenance);
  });

  it('"mmm ok" en QA sin respuesta factual previa no acepta consentimiento ni fuerza CTA de contacto', () => {
    const cid = 'f33-soft';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'LUX-A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Luis' });
    const r = processV3Turn({ conversationId: cid, phone: '521', text: 'mmm ok' });
    assert.equal(r.state.advisorContactConsent, ADVISOR_CONTACT_CONSENT.UNKNOWN);
    assert.doesNotMatch(String(r.reply || ''), /te\s+contactan/i);
  });

  it('hidratación legacy: activeProperty por turno alimenta precio en PROPERTY_QA (como index.js + inventario)', () => {
    const cid = 'f33-hydrate';
    const fakeInv = {
      id: 'p-inventory-1',
      price_label: '$7,123,000 MXN',
      public_url: 'https://luxetty.com/propiedad/casa-demo',
      location_label: 'Centro',
      code: 'LUX-A0462',
    };
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'Hola, me interesa la propiedad A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });
    const r = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: '¿Me puedes dar el precio?',
      legacyHydration: {
        propertyListingCode: 'LUX-A0462',
        activeProperty: fakeInv,
      },
    });
    assert.match(String(r.reply || ''), /7[, ]?123|7123000|precio listado/i);
    assert.equal(r.state.activeProperty?.id, 'p-inventory-1');
  });

  it('precio / ubicación no se interpretan como LOCATION_CAPTURE (regresión plantilla con "zona")', () => {
    const cid = 'f33-not-location';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'Hola, me interesa la propiedad A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });
    const rPrice = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: '¿Me puedes dar el precio?',
    });
    assert.equal(rPrice.decision.detectedIntent, V3_INTENT.PROPERTY_FACT_QUESTION);
    assert.notEqual(rPrice.state.locationText, '¿Me puedes dar el precio?');
    const rWhere = processV3Turn({ conversationId: cid, phone: '521', text: '¿Dónde está?' });
    assert.equal(rWhere.decision.detectedIntent, V3_INTENT.PROPERTY_FACT_QUESTION);
    assert.notEqual(rWhere.state.locationText, '¿Dónde está?');
  });

  it('anti-loop: segundo intento de handoff CTA sin consentimiento cambia el mensaje', () => {
    const cid = 'f33-loop';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'LUX-A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Ana' });
    const r0 = processV3Turn({
      conversationId: cid,
      phone: '521',
      text: 'Quiero hablar con un asesor por favor',
    });
    const handoff1 = String(r0.reply || '');
    assert.match(handoff1, /asesor/i);
    const r1 = processV3Turn({ conversationId: cid, phone: '521', text: 'hola' });
    assert.match(String(r1.reply || ''), /paciencia|repetir|concreto/i);
    assert.notEqual(String(r1.reply || ''), handoff1);
  });

  it('tras respuesta útil, cierre suave permite oferta de handoff', () => {
    const cid = 'f33-soft-handoff';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'LUX-A0462' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Diego' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'info' });
    assert.ok((getSession(cid).propertyQaAnswerCount || 0) >= 1);
    const rClose = processV3Turn({ conversationId: cid, phone: '521', text: 'gracias' });
    assert.equal(rClose.state.advisorContactConsent, ADVISOR_CONTACT_CONSENT.REQUESTED);
    assert.equal(rClose.state.awaitingField, 'advisor_contact_consent');
    assert.match(String(rClose.reply || ''), /asesor|contact/i);
  });
});
