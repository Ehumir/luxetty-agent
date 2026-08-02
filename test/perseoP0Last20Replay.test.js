'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/perseo-last20-anonymized.json');
const { tryMetaLeadFormCaptureTurn } = require('../conversation/metaLeadFormCapture');
const { tryPropertyPautaHandoffTurn } = require('../conversation/propertyPautaHandoff');
const { resolvePriorityIntent } = require('../conversation/conversationPriorityResolver');
const { resolveConversationOpening } = require('../conversation/conversationOpeningResolver');
const { buildP0CrmPayload } = require('../services/perseoP0Crm');
const { startTurnTrace, buildTerminalRow } = require('../services/perseoTurnTrace');

const ids = {
  conversation: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  property: '33333333-3333-4333-8333-333333333333',
};

function propertyFor(fixture) {
  if (!String(fixture.property || '').startsWith('verified')) return null;
  return {
    id: ids.property,
    title: fixture.property_type === 'apartment' ? 'Departamento muestra' : 'Casa muestra',
    operation_type: fixture.operation,
    status: 'active',
    is_public: true,
    visible_on_website: true,
    zone: fixture.zone,
    price: fixture.operation === 'rent' ? 20000 : 5000000,
    currency_code: 'MXN',
    agent_profile_id: ids.agent,
  };
}

function sellerText(fixture) {
  return [
    'Completé el formulario.',
    'Nombre completo: Cliente Anónimo',
    `Tipo de propiedad: ${fixture.property_type === 'land' ? 'Terreno' : fixture.property_type === 'apartment' ? 'Departamento' : 'Casa'}`,
    `Colonia: ${fixture.zone}`,
    'Operación: Venta',
    '¿En cuánto tiempo?: Durante los próximos meses',
  ].join('\n');
}

function demandText(fixture) {
  const completion = fixture.id.startsWith('C05') ? 'Olá! Preenchi seu formulário.' : 'Completé el formulario.';
  const action = fixture.expected.route === 'visit'
    ? 'Agendar una visita'
    : fixture.expected.route === 'advisor'
      ? 'Hablar con un asesor'
      : 'Recibir más información';
  return [
    completion,
    'Nombre completo: Cliente Anónimo',
    'Email: anon@example.invalid',
    `¿Qué deseas hacer?: ${action}`,
  ].join('\n');
}

function hasOnlySpanishOutput(reply) {
  const value = String(reply || '').toLowerCase();
  return !/\b(obrigad[oa]|você|seu formulário|entraremos em contato|assessor responsável)\b/.test(value);
}

assert.equal(fixtures.length, 20, 'la cohorte debe contener exactamente 20 conversaciones');

for (const fixture of fixtures) {
  test(`${fixture.id}: replay conversacional + CRM + estado + traza`, () => {
    const property = propertyFor(fixture);
    let reply = '';
    let stateAfter = {};
    let route = fixture.expected.route;

    if (fixture.expected.route === 'seller_form') {
      const turn = tryMetaLeadFormCaptureTurn({
        text: sellerText(fixture),
        campaignContext: { campaign_type: 'seller_capture' },
        previousAiState: {},
        parsedSignals: {},
      });
      assert.equal(turn.handled, true);
      reply = turn.reply;
      stateAfter = turn.statePatch;
      assert.equal(stateAfter.operation_type, 'sale');
      assert.equal(stateAfter.property_type, fixture.property_type);
      assert.equal(stateAfter.location_text, fixture.zone);
      assert.doesNotMatch(reply, /completa (?:otro |el )?formulario|https?:\/\//i);
    } else if (fixture.expected.route === 'short_intent') {
      const previous = { lead_flow: 'demand', location_text: fixture.zone, budget_max: fixture.budget };
      const priority = resolvePriorityIntent('Compra', previous, {});
      const opening = resolveConversationOpening({
        text: 'Compra', previousAiState: previous, nextAiState: { ...previous, operation_type: 'sale' },
        parsedSignals: { lead_flow: 'demand', operation_type: 'sale' },
        recentMessages: [{ direction: 'inbound' }, { direction: 'inbound' }],
      });
      assert.equal(priority.key, 'buyer_search');
      assert.notEqual(opening.opening_type, 'greeting');
      stateAfter = { ...previous, operation_type: 'sale', intent_type: 'buy' };
      reply = 'Perfecto: buscas comprar en Cumbres. Conservaré esa operación y la zona. ¿Prefieres casa o departamento y cuántas recámaras necesitas?';
    } else if (fixture.expected.route === 'post_handoff') {
      const turn = tryPropertyPautaHandoffTurn({
        text: 'Hola, soy asesora',
        campaignContext: { campaign_type: 'property_listing' },
        property,
        previousAiState: { property_pauta_handoff_sent: true, handoff_sent: true, conversation_mode: 'HUMAN_WAITING' },
      });
      assert.equal(turn.handled, false);
      reply = '';
      stateAfter = { conversation_mode: 'HUMAN_WAITING', handoff_sent: true };
      assert.equal(fixture.expected.outbound_count, 0);
    } else {
      const turn = tryPropertyPautaHandoffTurn({
        text: demandText(fixture),
        campaignContext: { campaign_type: 'property_listing', property_code: property ? 'LUX-X0001' : null },
        property,
        previousAiState: {},
        parsedSignals: {},
      });
      assert.equal(turn.handled, true);
      reply = turn.reply;
      stateAfter = { ...turn.statePatch, operation_type: fixture.operation };
      assert.equal(stateAfter.conversation_mode, 'HUMAN_WAITING');
      if (fixture.expected.facts) {
        assert.match(reply, /Casa muestra|Departamento muestra/);
        assert.match(reply, /\$[\d,]+/);
      }
      if (fixture.expected.visit) assert.match(reply, /solicitud para visitar|visita/i);
      if (fixture.expected.no_property_claim) {
        assert.doesNotMatch(reply, /esta propiedad asignada|asesor responsable de (?:esta|la) propiedad/i);
      }
    }

    assert.equal(hasOnlySpanishOutput(reply), true);

    if (fixture.expected.route !== 'post_handoff' && fixture.expected.route !== 'short_intent') {
      const crm = buildP0CrmPayload({
        conversationId: ids.conversation,
        conversationRow: { id: ids.conversation, assigned_agent_profile_id: ids.agent },
        aiState: {
          ...stateAfter,
          meta_lead_form_flow: true,
          crm_payload_ready: true,
          campaign_context: { campaign_type: fixture.campaign_type },
          location_text: fixture.zone,
          property_type: fixture.property_type,
          budget_max: fixture.budget,
        },
        property,
        propertyId: property?.id || (String(fixture.property || '').startsWith('unrelated') ? ids.property : null),
        phone: '5218111111111',
        text: fixture.history.join(' | '),
        rawPayload: { id: `wamid-${fixture.id}` },
      });
      if (fixture.expected.crm === 'blocked') {
        assert.equal(crm.ok, false);
      } else {
        assert.equal(crm.ok, true);
        assert.equal(crm.payload.operation, fixture.expected.operation || fixture.operation);
        if (fixture.origin === 'captacion') assert.equal(crm.payload.property_id, null);
      }
    }

    const trace = startTurnTrace({
      conversationId: ids.conversation,
      inboundMessageId: `wamid-${fixture.id}`,
      text: fixture.history.at(-1),
      aiState: { conversation_mode: fixture.ai_state },
      conversationRow: { assigned_agent_profile_id: ids.agent },
    });
    const terminal = buildTerminalRow(trace, {
      stateAfter,
      reply,
      responseSource: route,
      selectedPipeline: 'legacy',
      terminalResult: reply ? 'sent' : 'skipped',
    });
    assert.ok(terminal.prompt_hash);
    assert.equal(terminal.terminal_result, reply ? 'sent' : 'skipped');
    assert.equal(terminal.state_after.conversation_mode, stateAfter.conversation_mode);
  });
}
