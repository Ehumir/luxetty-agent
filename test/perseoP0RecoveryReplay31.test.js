'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const historical = require('./fixtures/perseo-last20-anonymized.json');
const cohort = require('./fixtures/perseo-recovery-cohort-11.json');
const { processV3Turn, clearV3Session } = require('../conversation/v3');
const { tryMetaLeadFormCaptureTurn } = require('../conversation/metaLeadFormCapture');
const { buildPropertyPautaReply } = require('../conversation/propertyPautaHandoff');
const { buildHumanFallback } = require('../services/perseoHumanFallback');
const { buildP0CrmPayload, buildIdempotencyKey } = require('../services/perseoP0Crm');
const { startTurnTrace, buildTerminalRow } = require('../services/perseoTurnTrace');

const previousHandoff = process.env.PERSEO_V3_HANDOFF_ENABLED;
process.env.PERSEO_V3_HANDOFF_ENABLED = 'true';
test.after(() => {
  if (previousHandoff === undefined) delete process.env.PERSEO_V3_HANDOFF_ENABLED;
  else process.env.PERSEO_V3_HANDOFF_ENABLED = previousHandoff;
});

const IDS = {
  conversation: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  property: '33333333-3333-4333-8333-333333333333',
};

assert.equal(historical.length, 20);
assert.equal(cohort.length, 11);
assert.equal(historical.length + cohort.length, 31, 'la matriz de cierre debe contener 31 escenarios');

function verifiedProperty(fixture) {
  if (fixture.route !== 'property_linked') return null;
  return {
    id: IDS.property,
    listing_id: fixture.property_code,
    title: 'Casa verificada en Mitras Centro',
    operation_type: fixture.operation,
    status: 'active',
    is_public: true,
    visible_on_website: true,
    zone: fixture.zone,
    price: 3_500_000,
    currency_code: 'MXN',
    agent_profile_id: IDS.agent,
  };
}

function stateFor(fixture) {
  return {
    lead_flow: fixture.route === 'seller_form' ? 'offer' : 'demand',
    lead_type: fixture.route === 'seller_form' ? 'supply' : 'demand',
    operation_type: fixture.operation,
    property_type: fixture.property_type,
    location_text: fixture.zone,
  };
}

for (const fixture of cohort) {
  test(`${fixture.id}: ${fixture.expected}`, () => {
    let reply;
    let stateAfter = stateFor(fixture);
    let outcome;
    const property = verifiedProperty(fixture);

    if (fixture.route === 'hospital') {
      clearV3Session(fixture.id);
      const turn = processV3Turn({
        conversationId: fixture.id,
        phone: '5218100000000',
        text: fixture.messages[0],
      });
      reply = turn.reply;
      stateAfter = {
        ...stateAfter,
        operation_type: turn.state.operationType,
        property_type: turn.state.propertyType,
        location_text: turn.state.locationText,
        awaiting_field: turn.state.awaitingField,
      };
      outcome = 'AUTOMATED_RESPONSE_SENT';
      assert.match(reply, /departamento en renta cerca del Hospital Materno Infantil/i);
      assert.match(reply, /nombre/i);
      assert.match(reply, /presupuesto mensual/i);
      assert.doesNotMatch(reply, /Mitras|Cumbres|Perfecto,\s*perfecto/i);
    } else if (fixture.route === 'seller_form') {
      const turn = tryMetaLeadFormCaptureTurn({
        text: fixture.messages.join('\n'),
        campaignContext: { campaign_type: 'seller_capture' },
        previousAiState: {},
        parsedSignals: {},
      });
      assert.equal(turn.handled, true);
      reply = turn.reply;
      stateAfter = { ...stateAfter, ...turn.statePatch };
      outcome = 'AUTOMATED_RESPONSE_SENT';
      assert.equal(stateAfter.operation_type, 'sale');
      assert.doesNotMatch(reply, /completa (?:otro |el )?formulario|https?:\/\//i);
    } else if (fixture.route === 'property_linked') {
      reply = buildPropertyPautaReply({
        text: fixture.messages[0],
        property,
      });
      stateAfter = {
        ...stateAfter,
        interested_property_id: property.id,
        property_specific_intent: true,
      };
      outcome = 'AUTOMATED_RESPONSE_SENT';
      assert.match(reply, /Mitras Centro|Casa verificada/i);
      assert.doesNotMatch(reply, /Cumbres|otra propiedad/i);
    } else {
      const fallback = buildHumanFallback({
        aiState: stateAfter,
        reason: fixture.fallback_reason,
      });
      reply = fallback.responseText;
      stateAfter = { ...stateAfter, ...fallback.statePatch };
      outcome = fallback.terminalResult;
      assert.equal(stateAfter.conversation_mode, 'HUMAN_WAITING');
      assert.match(reply, /asesor de Luxetty continuará contigo/i);
    }

    assert.ok(String(reply || '').trim(), 'no se acepta silencio');
    assert.doesNotMatch(reply, /\b(obrigad[oa]|você|seu formulário)\b/i);

    let crmResult = null;
    if (fixture.operation) {
      const crm = buildP0CrmPayload({
        conversationId: IDS.conversation,
        conversationRow: { id: IDS.conversation, assigned_agent_profile_id: IDS.agent },
        aiState: {
          ...stateAfter,
          meta_lead_form_flow: fixture.route === 'seller_form',
          crm_payload_ready: fixture.route === 'seller_form',
          property_specific_intent: fixture.route === 'property_linked',
        },
        property,
        propertyId: property?.id || null,
        phone: '5218100000000',
        text: fixture.messages.at(-1),
        rawPayload: { message_id: `wamid.${fixture.id}` },
      });
      assert.equal(crm.ok, true, crm.reason);
      assert.equal(crm.payload.operation, fixture.operation);
      assert.equal(crm.payload.location_text, fixture.zone);
      const firstKey = buildIdempotencyKey({
        conversationId: IDS.conversation,
        rawPayload: { message_id: `wamid.${fixture.id}` },
        text: fixture.messages.at(-1),
      });
      const retryKey = buildIdempotencyKey({
        conversationId: IDS.conversation,
        rawPayload: { message_id: `wamid.${fixture.id}` },
        text: fixture.messages.at(-1),
      });
      assert.equal(firstKey, retryKey);
      crmResult = {
        p0Result: {
          success: true,
          result: { contact_id: 'contact', lead_id: 'lead', request_id: 'request' },
        },
      };
    }

    const trace = startTurnTrace({
      conversationId: IDS.conversation,
      inboundMessageId: `wamid.${fixture.id}`,
      text: fixture.messages.at(-1),
      aiState: {},
      conversationRow: { assigned_agent_profile_id: IDS.agent },
    });
    const row = buildTerminalRow(trace, {
      stateAfter,
      reply,
      responseSource: fixture.route,
      selectedPipeline: 'v3',
      terminalResult: outcome,
      crmResult,
    });
    assert.equal(row.terminal_result, 'sent');
    assert.equal(row.decision.outcome, outcome);
    if (fixture.operation) {
      assert.equal(row.entity_refs.contact_id, 'contact');
      assert.equal(row.entity_refs.lead_id, 'lead');
      assert.equal(row.entity_refs.request_id, 'request');
    }
  });
}
