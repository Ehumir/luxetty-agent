'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const previous = {
  handoff: process.env.PERSEO_V3_HANDOFF_ENABLED,
  inventory: process.env.PERSEO_INVENTORY_OPTIONS_ENABLED,
  inventoryGlobal: process.env.PERSEO_INVENTORY_OPTIONS_GLOBAL,
  crm: process.env.PERSEO_P0_CRM_RECOVERY_ENABLED,
};

before(() => {
  process.env.PERSEO_V3_HANDOFF_ENABLED = 'true';
  process.env.PERSEO_INVENTORY_OPTIONS_ENABLED = 'true';
  process.env.PERSEO_INVENTORY_OPTIONS_GLOBAL = 'true';
  process.env.PERSEO_P0_CRM_RECOVERY_ENABLED = 'true';
});

after(() => {
  for (const [key, value] of Object.entries({
    PERSEO_V3_HANDOFF_ENABLED: previous.handoff,
    PERSEO_INVENTORY_OPTIONS_ENABLED: previous.inventory,
    PERSEO_INVENTORY_OPTIONS_GLOBAL: previous.inventoryGlobal,
    PERSEO_P0_CRM_RECOVERY_ENABLED: previous.crm,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { processV3Turn, clearV3Session } = require('../conversation/v3');
const { normalizeLocationFromUserText } = require('../conversation/v3/interpreter/locationNormalizer');
const { resolveInventoryOptionsForTurn } = require('../services/inventoryOptionsTurn');
const inventoryOptionsService = require('../services/inventoryOptionsService');
const { buildHumanFallback, hasSafeAutomatedReply } = require('../services/perseoHumanFallback');
const { commitP0CrmIntake } = require('../services/perseoP0Crm');

describe('PERSEO P0 — Hospital Materno Infantil', () => {
  it('reconoce el hito geográfico y pide nombre + presupuesto sin mostrar inventario', () => {
    assert.equal(
      normalizeLocationFromUserText('por el área del hospital materno infantil'),
      'Hospital Materno Infantil',
    );
    const conversationId = 'hospital-materno-p0';
    clearV3Session(conversationId);
    const result = processV3Turn({
      conversationId,
      phone: '5218100000000',
      text: 'Buen día, busco renta de departamento por el área del hospital materno infantil',
    });
    assert.equal(result.decision.detectedIntent, 'RENT_PROPERTY');
    assert.equal(result.state.operationType, 'rent');
    assert.equal(result.state.propertyType, 'apartment');
    assert.equal(result.state.locationText, 'Hospital Materno Infantil');
    assert.match(result.reply, /departamento en renta cerca del Hospital Materno Infantil/i);
    assert.match(result.reply, /nombre/i);
    assert.match(result.reply, /presupuesto mensual/i);
    assert.doesNotMatch(result.reply, /Mitras|Cumbres|Perfecto,\s*perfecto/i);
    assert.equal(result.state.awaitingField, 'full_name');
  });

  it('no consulta inventario mientras falte presupuesto', async () => {
    let dbReads = 0;
    const result = await resolveInventoryOptionsForTurn({
      db: { from() { dbReads += 1; throw new Error('unexpected_inventory_read'); } },
      text: 'Buen día, busco renta de departamento por el área del hospital materno infantil',
      phone: '5218100000000',
      previousAiState: {
        lead_flow: 'demand',
        operation_type: 'rent',
        property_type: 'apartment',
        location_text: 'Hospital Materno Infantil',
      },
    });
    assert.equal(result, null);
    assert.equal(dbReads, 0);
  });

  it('no amplía la zona sin aceptación explícita', async () => {
    let searches = 0;
    const query = {
      select() { return this; },
      eq() { return this; },
      lte() { return this; },
      gte() { return this; },
      or() { return this; },
      order() { return this; },
      limit() { searches += 1; return Promise.resolve({ data: [], error: null }); },
    };
    const result = await inventoryOptionsService.searchInventoryOptions(
      { from() { return query; } },
      {
        operation: 'rent',
        zone: 'Hospital Materno Infantil',
        budgetMax: 10_000,
        propertyType: 'apartment',
      },
      { warn() {} },
    );
    assert.equal(searches, 1);
    assert.equal(result.relaxedZone, false);
    assert.deepEqual(result.options, []);
  });
});

describe('PERSEO P0 — CRM provisional y fallback terminal', () => {
  it('crea CRM desde el primer turno comercial aunque falten nombre y presupuesto', async () => {
    let rpcPayload = null;
    const result = await commitP0CrmIntake({
      supabase: {
        rpc: async (_name, args) => {
          rpcPayload = args.p_payload;
          return { data: { contact_id: 'contact-1', lead_id: 'lead-1', request_id: 'request-1' }, error: null };
        },
      },
      conversationId: '11111111-1111-4111-8111-111111111111',
      conversationRow: { assigned_agent_profile_id: '22222222-2222-4222-8222-222222222222' },
      aiState: {
        lead_flow: 'demand',
        operation_type: 'rent',
        property_type: 'apartment',
        location_text: 'Hospital Materno Infantil',
      },
      parsedSignals: {},
      phone: '5218100000000',
      text: 'Busco renta de departamento cerca del Hospital Materno Infantil',
      rawPayload: { message_id: 'wamid.hospital-p0' },
    });
    assert.equal(result.handled, true);
    assert.equal(result.success, true);
    assert.equal(rpcPayload.operation, 'rent');
    assert.equal(rpcPayload.location_text, 'Hospital Materno Infantil');
    assert.equal(rpcPayload.full_name, null);
  });

  it('fallback conserva datos verificados, entrega a humano y bloquea IA posterior', () => {
    const result = buildHumanFallback({
      aiState: {
        operation_type: 'rent',
        property_type: 'apartment',
        location_text: 'Hospital Materno Infantil',
      },
      reason: 'inventory_timeout',
    });
    assert.match(result.responseText, /departamento en renta cerca de Hospital Materno Infantil/i);
    assert.equal(result.statePatch.conversation_mode, 'HUMAN_WAITING');
    assert.equal(result.statePatch.automated_followups_blocked, true);
    assert.equal(result.terminalResult, 'HUMAN_FALLBACK_SENT');
    assert.equal(hasSafeAutomatedReply(''), false);
    assert.equal(hasSafeAutomatedReply('Perfecto, perfecto.'), false);
  });
});
