'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  maybeHandleFollowupTemplateQaReply,
  extractQaTemplateReplyContext,
  classifyQaTemplateReply,
  sameQaPhone,
} = require('../conversation/qaSprint1Commands');

const QA_WAMID = 'wamid.qa.outbound.123';
const INBOUND_WAMID = 'wamid.qa.inbound.456';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_NUMBER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const INBOUND_ID = '44444444-4444-4444-8444-444444444444';

function webhookPayload(contextWamid = QA_WAMID, text = 'Continuar solicitud') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1913047555982064',
      changes: [{
        field: 'messages',
        value: {
          messages: [{
            id: INBOUND_WAMID,
            from: '5218181877351',
            type: 'button',
            context: { id: contextWamid, from: '5218120167770' },
            button: { text, payload: text },
          }],
        },
      }],
    }],
  };
}

function mockSupabase({ contextWamid = QA_WAMID, qaPhone = '528181877351', attemptFound = true } = {}) {
  const touched = [];
  const interactions = [];

  function query(table) {
    touched.push(table);
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      async maybeSingle() {
        if (table === 'conversation_messages') {
          return { data: { id: INBOUND_ID, raw_payload: webhookPayload(contextWamid) }, error: null };
        }
        if (table === 'followup_template_test_attempts') {
          return attemptFound
            ? { data: { id: ATTEMPT_ID, template_name: 'lux_solicitud_recibida_v1', test_number_id: TEST_NUMBER_ID, provider_message_id: contextWamid, status: 'sent' }, error: null }
            : { data: null, error: null };
        }
        if (table === 'followup_test_numbers') {
          return { data: { id: TEST_NUMBER_ID, phone_normalized: qaPhone, is_active: true }, error: null };
        }
        return { data: null, error: null };
      },
      async upsert(row) {
        interactions.push(row);
        return { data: row, error: null };
      },
    };
    return builder;
  }

  return { client: { from: query }, touched, interactions };
}

test('extracts Meta button context and classifies canonical QA replies', () => {
  const ctx = extractQaTemplateReplyContext(webhookPayload());
  assert.equal(ctx.contextWamid, QA_WAMID);
  assert.equal(ctx.replyText, 'Continuar solicitud');
  assert.equal(ctx.interactionType, 'button_reply');
  assert.deepEqual(classifyQaTemplateReply('Continuar solicitud'), { recognized: true, action: 'continue' });
  assert.deepEqual(classifyQaTemplateReply('Cerrar solicitud'), { recognized: true, action: 'close' });
});

test('MX QA phone comparison tolerates Meta 521 vs registered 52 formatting only by national number', () => {
  assert.equal(sameQaPhone('5218181877351', '528181877351'), true);
  assert.equal(sameQaPhone('5218181877351', '528112345678'), false);
});

test('matching QA context WAMID is isolated before CRM and logged', async () => {
  const { client, touched, interactions } = mockSupabase();
  const events = [];
  const result = await maybeHandleFollowupTemplateQaReply({
    supabase: client,
    metaMessageId: INBOUND_WAMID,
    from: '5218181877351',
    conversationId: CONVERSATION_ID,
    text: 'Continuar solicitud',
    nowIso: () => '2026-08-17T01:00:00.000Z',
    saveEventFn: async (conversationId, type, payload) => events.push({ conversationId, type, payload }),
    logEvent: () => {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.qaTemplateReply, true);
  assert.deepEqual(result.messages, []);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].recognized, true);
  assert.equal(interactions[0].recognized_action, 'continue');
  assert.equal(events[0].type, 'followup_template_qa_reply_isolated');
  assert.equal(touched.includes('leads'), false);
  assert.equal(touched.includes('contacts'), false);
  assert.deepEqual(touched, [
    'conversation_messages',
    'followup_template_test_attempts',
    'followup_test_numbers',
    'followup_template_test_interactions',
  ]);
});

test('matching QA WAMID with wrong phone fails closed and never enters CRM', async () => {
  const { client, touched, interactions } = mockSupabase({ qaPhone: '528112345678' });
  const events = [];
  const result = await maybeHandleFollowupTemplateQaReply({
    supabase: client,
    metaMessageId: INBOUND_WAMID,
    from: '5218181877351',
    conversationId: CONVERSATION_ID,
    text: 'Continuar solicitud',
    nowIso: () => '2026-08-17T01:00:00.000Z',
    saveEventFn: async (_conversationId, type) => events.push(type),
    logEvent: () => {},
  });

  assert.equal(result.handled, true);
  assert.equal(interactions[0].recognized, false);
  assert.equal(interactions[0].recognized_action, 'other');
  assert.equal(events[0], 'followup_template_qa_reply_phone_mismatch');
  assert.equal(touched.includes('leads'), false);
});

test('non-QA context WAMID is not intercepted', async () => {
  const { client, interactions } = mockSupabase({ contextWamid: 'wamid.real.customer', attemptFound: false });
  const result = await maybeHandleFollowupTemplateQaReply({
    supabase: client,
    metaMessageId: INBOUND_WAMID,
    from: '5218181877351',
    conversationId: CONVERSATION_ID,
    text: 'Continuar solicitud',
    nowIso: () => '2026-08-17T01:00:00.000Z',
    saveEventFn: async () => {},
    logEvent: () => {},
  });
  assert.equal(result, null);
  assert.equal(interactions.length, 0);
});
