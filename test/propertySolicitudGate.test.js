'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCaptureUrl,
  buildGateMessages,
  evaluatePropertySolicitudGate,
  isCompletedSellerCapture,
} = require('../services/propertySolicitudGate');

describe('propertySolicitudGate', () => {
  it('buildCaptureUrl incluye slug y query captura', () => {
    const url = buildCaptureUrl({ slug: 'casa-en-puerta-de-hierro' });
    assert.match(url, /\/propiedad\/casa-en-puerta-de-hierro\?captura=1$/);
  });

  it('buildGateMessages es conversacional y no vacío', () => {
    const messages = buildGateMessages('https://luxetty.com/propiedad/demo?captura=1');
    assert.equal(messages.length, 3);
    assert.match(messages[0], /registrar tu solicitud/i);
    assert.match(messages[1], /captura=1/);
    assert.match(messages[2], /escríbeme de nuevo/i);
  });

  it('no vuelve a pedir formulario cuando el formulario de captación ya quedó completo', async () => {
    const aiState = {
      meta_lead_form_flow: true,
      meta_lead_form_ack_sent: true,
      qualification_complete: true,
      crm_payload_ready: true,
      lead_flow: 'offer',
      intent_lock_sale_owner: true,
      operation_type: 'sale',
      property_type: 'apartment',
      location_text: 'Zona Poniente',
      // Reproduce la contaminación observada: la campaña resolvió una
      // propiedad de inventario ajena al formulario del propietario.
      interested_property_id: '77f2ed6a-398d-40e4-99fc-6f476fd06de2',
      property_specific_intent: true,
    };

    assert.equal(isCompletedSellerCapture({ aiState }), true);

    const result = await evaluatePropertySolicitudGate({
      supabase: null,
      phone: '5210000000000',
      aiState,
      parsedSignals: { lead_flow: 'offer', intent_lock_sale_owner: true },
      propertyId: aiState.interested_property_id,
      property: { slug: 'propiedad-ajena' },
      text: 'Completé el formulario. Quiero vender.',
    });

    assert.equal(result.requiresCapture, false);
    assert.equal(result.bypassReason, 'completed_seller_capture');
    assert.equal(result.statePatch.property_solicitud_pending, false);
    assert.equal(result.statePatch.property_solicitud_capture_url, null);
  });
});
