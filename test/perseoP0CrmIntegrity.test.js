'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOperation,
  classifyOrigin,
  buildIdempotencyKey,
  buildP0CrmPayload,
  commitP0CrmIntake,
} = require('../services/perseoP0Crm');

const conversationId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const propertyId = '33333333-3333-4333-8333-333333333333';

function base(overrides = {}) {
  return {
    conversationId,
    conversationRow: { id: conversationId, assigned_agent_profile_id: agentId },
    aiState: {
      meta_lead_form_flow: true,
      crm_payload_ready: true,
      full_name: 'Cliente Anónimo',
      lead_flow: 'demand',
      lead_type: 'demand',
      operation_type: 'purchase',
      location_text: 'Cumbres',
      campaign_context: {},
    },
    parsedSignals: {},
    property: null,
    propertyId: null,
    phone: '5218111111111',
    text: 'Mensaje anonimizado',
    rawPayload: { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.p0-case' }] } }] }] },
    ...overrides,
  };
}

test('normaliza Compra a sale y Renta a rent', () => {
  assert.equal(normalizeOperation('Compra'), 'sale');
  assert.equal(normalizeOperation('purchase'), 'sale');
  assert.equal(normalizeOperation('Renta'), 'rent');
});

test('vendedor de departamento no hereda propiedad rental de campaña', () => {
  const input = base({
    aiState: {
      ...base().aiState,
      lead_flow: 'offer',
      lead_type: 'supply',
      operation_type: 'sale',
      property_type: 'apartment',
      location_text: 'Zona Poniente',
      campaign_context: { campaign_type: 'seller_capture' },
    },
    propertyId,
    property: { id: propertyId, operation_type: 'rent', status: 'active', is_public: true },
  });
  const out = buildP0CrmPayload(input);
  assert.equal(out.ok, true);
  assert.equal(out.strippedCampaignProperty, true);
  assert.equal(out.payload.property_id, null);
  assert.equal(out.payload.operation, 'sale');
  assert.equal(out.payload.lead_type, 'supply');
});

test('vendedor de terreno no hereda casa publicada de pauta', () => {
  const input = base({
    aiState: {
      ...base().aiState,
      lead_flow: 'offer', lead_type: 'supply', operation_type: 'sale', property_type: 'land',
      campaign_context: { campaign_type: 'seller_capture', property_code: 'LUX-X0001' },
    },
    propertyId,
    property: { id: propertyId, operation_type: 'sale', status: 'active', is_public: true },
  });
  assert.equal(buildP0CrmPayload(input).payload.property_id, null);
});

test('comprador que responde Compra conserva sale', () => {
  assert.equal(buildP0CrmPayload(base()).payload.operation, 'sale');
});

test('arrendatario que responde Renta conserva rent', () => {
  const input = base({ aiState: { ...base().aiState, operation_type: 'rent' } });
  assert.equal(buildP0CrmPayload(input).payload.operation, 'rent');
});

test('contacto y lead existentes se envían para reutilización estricta', () => {
  const input = base({
    conversationRow: {
      id: conversationId,
      contact_id: '44444444-4444-4444-8444-444444444444',
      lead_id: '55555555-5555-4555-8555-555555555555',
      assigned_agent_profile_id: agentId,
    },
  });
  const payload = buildP0CrmPayload(input).payload;
  assert.equal(payload.contact_id, input.conversationRow.contact_id);
  assert.equal(payload.lead_id, input.conversationRow.lead_id);
});

test('formulario y webhook duplicados producen la misma llave', () => {
  const first = buildIdempotencyKey(base());
  const retry = buildIdempotencyKey({ ...base(), text: 'texto transformado después del parseo' });
  assert.equal(first, retry);
  assert.match(first, /^perseo-p0:[a-f0-9]{64}$/);
});

test('dos workers y retry de timeout reciben el mismo efecto lógico', async () => {
  const original = process.env.PERSEO_P0_CRM_RECOVERY_ENABLED;
  process.env.PERSEO_P0_CRM_RECOVERY_ENABLED = 'true';
  let calls = 0;
  const db = {
    rpc: async (_name, args) => {
      calls += 1;
      return { data: { request_id: 'request-1', replayed: calls > 1, key: args.p_payload.idempotency_key }, error: null };
    },
  };
  try {
    const [a, b] = await Promise.all([
      commitP0CrmIntake({ ...base(), supabase: db }),
      commitP0CrmIntake({ ...base(), supabase: db }),
    ]);
    assert.equal(a.result.request_id, b.result.request_id);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  } finally {
    if (original === undefined) delete process.env.PERSEO_P0_CRM_RECOVERY_ENABLED;
    else process.env.PERSEO_P0_CRM_RECOVERY_ENABLED = original;
  }
});

for (const [name, mutation, reason] of [
  ['propiedad inexistente', { property: null, propertyId, aiState: { ...base().aiState, property_specific_intent: true, campaign_context: { campaign_type: 'property_listing' } } }, 'campaign_property_not_verified'],
  ['propiedad despublicada', { propertyId, property: { id: propertyId, operation_type: 'sale', status: 'inactive', is_public: false }, aiState: { ...base().aiState, property_specific_intent: true, campaign_context: { campaign_type: 'property_listing' } } }, 'campaign_property_not_verified'],
  ['propiedad sin vínculo comprobable', { aiState: { ...base().aiState, property_specific_intent: true, campaign_context: { campaign_type: 'property_listing' } } }, 'campaign_property_not_verified'],
  ['operación de propiedad en conflicto', { propertyId, property: { id: propertyId, operation_type: 'rent', status: 'active', is_public: true, visible_on_website: true }, aiState: { ...base().aiState, property_specific_intent: true, campaign_context: { campaign_type: 'property_listing' } } }, 'property_operation_conflict'],
  ['pipeline/agente faltante se cierra', { conversationRow: { id: conversationId }, aiState: { ...base().aiState, assigned_agent_profile_id: null } }, 'assigned_agent_missing'],
]) {
  test(`${name}: fail-closed antes de escribir`, () => {
    const out = buildP0CrmPayload(base(mutation));
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason);
  });
}

test('errores después de contacto, lead o antes de request son atómicos en el RPC', () => {
  const migration = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'supabase', 'migrations', '20260802044818_perseo_p0_crm_transaction.sql'),
    'utf8',
  );
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /insert into public\.contacts/);
  assert.match(migration, /insert into public\.leads/);
  assert.match(migration, /insert into public\.requests/);
  assert.match(migration, /pipeline_stage_missing/);
  assert.match(migration, /conversation_link_conflict/);
  assert.match(migration, /revoke all on function[\s\S]*anon, authenticated/);
});

test('clasifica sin mezclar captación, demanda y conversación natural', () => {
  assert.equal(classifyOrigin({ meta_lead_form_flow: true, lead_flow: 'offer' }), 'seller_capture');
  assert.equal(classifyOrigin({ lead_flow: 'demand', operation_type: 'rent' }), 'tenant_demand');
  assert.equal(classifyOrigin({ lead_flow: 'demand', operation_type: 'purchase' }), 'buyer_demand');
  assert.equal(classifyOrigin({}), 'natural');
});
