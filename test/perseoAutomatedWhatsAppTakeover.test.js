'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  revalidateAutomatedReplyPolicy,
} = require('../services/perseoAutomatedWhatsApp');
const { PERSEO_REASON_CODES } = require('../conversation/perseoGatekeeper');

function clientForConversation(aiState, settings = { human_only_global: false, automation_enabled: true }) {
  return {
    from(table) {
      if (table === 'conversations') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: { id: 'conv-1', ai_state: aiState }, error: null };
          },
        };
      }
      if (table === 'ai_conversation_channel_settings') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: settings, error: null };
          },
        };
      }
      throw new Error(`tabla inesperada ${table}`);
    },
  };
}

test('revalidación pre-Graph bloquea policy vieja cuando humano tomó el chat', async () => {
  process.env.PERSEO_POLICY_V2_ENABLED = 'true';
  const initialPolicy = {
    policyResolution: 'ok',
    allowAutomatedReply: true,
    allowQaBypass: false,
    effectiveHumanLock: false,
    reason_code: PERSEO_REASON_CODES.AUTOMATION_ALLOWED,
  };

  const latest = await revalidateAutomatedReplyPolicy({
    conversationId: 'conv-1',
    to: '5210000000000',
    initialPolicy,
    client: clientForConversation({
      ai_control: { attention_mode: 'human', ai_paused: true },
    }),
  });

  assert.equal(latest.allowAutomatedReply, false);
  assert.equal(latest.effectiveHumanLock, true);
  assert.equal(latest.reason_code, PERSEO_REASON_CODES.CONVERSATION_HUMAN_ATTENTION);
  delete process.env.PERSEO_POLICY_V2_ENABLED;
});

test('revalidación pre-Graph es fail-closed si no puede leer conversación', async () => {
  const brokenClient = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'network' } }; },
      };
    },
  };

  const latest = await revalidateAutomatedReplyPolicy({
    conversationId: 'conv-1',
    to: '5210000000000',
    initialPolicy: { allowQaBypass: false },
    client: brokenClient,
  });

  assert.equal(latest.allowAutomatedReply, false);
  assert.equal(latest.effectiveHumanLock, true);
  assert.equal(latest.policyResolution, 'error');
});
