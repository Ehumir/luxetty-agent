'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const {
  classifyIcfFollowupReply,
  humanLockFromAiState,
  isWithinCustomerServiceWindow,
} = require('../services/icfDailyFollowup');
const {
  sendPerseoAutomatedWhatsApp,
  sendPerseoAutomatedWhatsAppTemplate,
} = require('../services/perseoAutomatedWhatsApp');

function fakePolicyClient(aiState = {}) {
  const conversation = { id: 'conv-1', ai_state: aiState };
  const chain = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: conversation, error: null }; },
  };
  return {
    from(table) {
      if (table !== 'conversations') throw new Error(`unexpected table ${table}`);
      return chain;
    },
  };
}

function outboundSaver() {
  return async ({ messages }) => ({
    outbound: messages,
    rows: [{ id: 'msg-1', metadata: {} }],
  });
}

describe('ICF daily follow-up response classifier', () => {
  it('confirms explicit affirmative answers', () => {
    assert.equal(classifyIcfFollowupReply('Sí').kind, 'confirm');
    assert.equal(classifyIcfFollowupReply('Quiero continuar').kind, 'confirm');
    assert.equal(classifyIcfFollowupReply('Sigo interesado').kind, 'confirm');
  });

  it('closes only the current service for a simple NO', () => {
    assert.deepEqual(classifyIcfFollowupReply('No'), { kind: 'decline', globalOptOut: false });
    assert.deepEqual(classifyIcfFollowupReply('No gracias'), { kind: 'decline', globalOptOut: false });
  });

  it('recognizes explicit global communication opt-out', () => {
    assert.deepEqual(classifyIcfFollowupReply('STOP'), { kind: 'decline', globalOptOut: true });
    assert.deepEqual(classifyIcfFollowupReply('No me escriban'), { kind: 'decline', globalOptOut: true });
    assert.deepEqual(classifyIcfFollowupReply('Dejen de contactarme'), { kind: 'decline', globalOptOut: true });
  });

  it('does not over-classify normal messages', () => {
    assert.equal(classifyIcfFollowupReply('¿Qué opciones tienen en Cumbres?').kind, 'unknown');
    assert.equal(classifyIcfFollowupReply('Hola').kind, 'unknown');
  });
});

describe('ICF follow-up safety helpers', () => {
  it('detects both canonical and legacy human locks', () => {
    assert.equal(humanLockFromAiState({ ai_control: { attention_mode: 'human', ai_paused: true } }), true);
    assert.equal(humanLockFromAiState({ attention_mode: 'human' }), true);
    assert.equal(humanLockFromAiState({ ai_control: { attention_mode: 'perseo', ai_paused: false } }), false);
  });

  it('uses text only inside a strict 24h customer-service window', () => {
    const now = new Date('2026-08-16T00:00:00.000Z');
    assert.equal(isWithinCustomerServiceWindow('2026-08-15T01:00:00.000Z', now), true);
    assert.equal(isWithinCustomerServiceWindow('2026-08-15T00:00:00.000Z', now), false);
    assert.equal(isWithinCustomerServiceWindow(null, now), false);
  });
});

describe('Automated WhatsApp Graph contract', () => {
  it('requires wamid for text success', async () => {
    const original = axios.post;
    axios.post = async () => ({ data: { messages: [] } });
    try {
      await assert.rejects(
        () => sendPerseoAutomatedWhatsApp({
          channel: 'ia',
          to: '5218100000001',
          messages: ['Hola'],
          conversationId: 'conv-1',
          policy: { allowAutomatedReply: true },
          policyClient: fakePolicyClient({}),
          saveOutboundMessages: outboundSaver(),
          saveConversationEvent: async () => {},
          logEvent: () => {},
        }),
        (err) => err?.code === 'WHATSAPP_GRAPH_MISSING_WAMID',
      );
    } finally {
      axios.post = original;
    }
  });

  it('fails closed when template name is not configured', async () => {
    const result = await sendPerseoAutomatedWhatsAppTemplate({
      channel: 'ia',
      to: '5218100000001',
      conversationId: 'conv-1',
      templateName: null,
      policy: { allowAutomatedReply: true },
      policyClient: fakePolicyClient({}),
      saveOutboundMessages: outboundSaver(),
      saveConversationEvent: async () => {},
      logEvent: () => {},
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason_code, 'whatsapp_template_not_configured');
  });

  it('sends approved-template payload through the same wrapper and returns wamid', async () => {
    const original = axios.post;
    let posted = null;
    axios.post = async (url, payload) => {
      posted = { url, payload };
      return { data: { messages: [{ id: 'wamid.template.1' }] } };
    };
    try {
      const result = await sendPerseoAutomatedWhatsAppTemplate({
        channel: 'ia',
        to: '5218100000001',
        conversationId: 'conv-1',
        templateName: 'luxetty_confirmacion_solicitud',
        templateLanguage: 'es_MX',
        displayText: 'Seguimos pendientes de confirmar tu solicitud.',
        policy: { allowAutomatedReply: true },
        policyClient: fakePolicyClient({}),
        saveOutboundMessages: outboundSaver(),
        saveConversationEvent: async () => {},
        logEvent: () => {},
      });

      assert.equal(result.sent, true);
      assert.equal(result.wamid, 'wamid.template.1');
      assert.equal(posted.payload.type, 'template');
      assert.equal(posted.payload.template.name, 'luxetty_confirmacion_solicitud');
      assert.equal(posted.payload.template.language.code, 'es_MX');
    } finally {
      axios.post = original;
    }
  });
});
