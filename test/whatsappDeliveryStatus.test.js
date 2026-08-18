'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStatus,
  shouldApplyStatus,
  buildDeliveryMetadata,
} = require('../services/whatsappDeliveryStatus');

test('normaliza solo estados WhatsApp soportados', () => {
  assert.equal(normalizeStatus('sent'), 'sent');
  assert.equal(normalizeStatus('DELIVERED'), 'delivered');
  assert.equal(normalizeStatus('read'), 'read');
  assert.equal(normalizeStatus('failed'), 'failed');
  assert.equal(normalizeStatus('unknown'), null);
});

test('no degrada read a delivered o sent', () => {
  assert.equal(shouldApplyStatus('read', 'delivered'), false);
  assert.equal(shouldApplyStatus('read', 'sent'), false);
  assert.equal(shouldApplyStatus('delivered', 'read'), true);
});

test('failed no pisa delivered/read tardíos', () => {
  assert.equal(shouldApplyStatus('sent', 'failed'), true);
  assert.equal(shouldApplyStatus('delivered', 'failed'), false);
  assert.equal(shouldApplyStatus('read', 'failed'), false);
});

test('conserva metadata y agrega timestamps de entrega', () => {
  const metadata = buildDeliveryMetadata(
    { source: 'agent_mode_reply', delivery_status: 'sent' },
    { status: 'delivered', timestamp: 1787026000 },
  );
  assert.equal(metadata.source, 'agent_mode_reply');
  assert.equal(metadata.delivery_status, 'delivered');
  assert.equal(typeof metadata.delivery_status_timestamps.delivered, 'string');
});

test('persiste detalle de error en failed', () => {
  const metadata = buildDeliveryMetadata(
    { delivery_status: 'sent' },
    {
      status: 'failed',
      timestamp: 1787026000,
      errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'outside window' } }],
    },
  );
  assert.equal(metadata.delivery_status, 'failed');
  assert.equal(metadata.delivery_failure.code, 131047);
  assert.equal(metadata.delivery_failure.details, 'outside window');
});
