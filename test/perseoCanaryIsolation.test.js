'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendPerseoAutomatedWhatsApp } = require('../services/perseoAutomatedWhatsApp');

const CANARY_A = '11111111-1111-4111-8111-111111111111';
const NON_CANARY_B = '22222222-2222-4222-8222-222222222222';
const HUMAN_C = '33333333-3333-4333-8333-333333333333';

function canaryEnv(killSwitch = false) {
  return {
    PERSEO_AUTOMATION_MODE: 'CANARY_ALLOWLIST',
    PERSEO_AUTOMATED_RESPONSES_ENABLED: 'true',
    PERSEO_CANARY_ENABLED: 'true',
    PERSEO_CANARY_CONVERSATION_IDS: `${CANARY_A},${HUMAN_C}`,
    PERSEO_FOLLOWUPS_ENABLED: 'true',
    PERSEO_KILL_SWITCH: String(killSwitch),
    PERSEO_QA_AUTOMATION_ENABLED: 'false',
    PERSEO_QA_ALLOWED_ENVIRONMENTS: 'staging',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    GIT_COMMIT_SHA: 'isolation-sha',
  };
}

function harness() {
  const sent = [];
  const persisted = [];
  const processed = new Set();
  const decisions = [];
  const send = async ({
    conversationId,
    messageId,
    conversationRow = { id: conversationId, ai_state: {} },
    route = 'v3',
    requestKind = 'direct',
    env = canaryEnv(false),
  }) => sendPerseoAutomatedWhatsApp({
    channel: 'ia',
    to: '5210000000000',
    messages: ['Respuesta controlada'],
    conversationId,
    messageId,
    conversationRow,
    route,
    requestKind,
    env,
    globalPolicyRow: { human_only_global: true, automation_enabled: false },
    recordDecision: async (decision) => decisions.push(decision),
    checkMessageProcessed: async ({ conversationId: cid, messageId: mid }) => processed.has(`${cid}:${mid}`),
    saveOutboundMessages: async ({ rawPayload }) => {
      persisted.push({ conversationId, messageId, rawPayload });
      processed.add(`${conversationId}:${messageId}`);
      return { outbound: ['Respuesta controlada'], rows: [{ id: `row-${persisted.length}` }] };
    },
    saveConversationEvent: async () => {},
    sendTransport: async (to, body) => sent.push({ conversationId, messageId, to, body }),
  });
  return { sent, persisted, decisions, send };
}

test('aislamiento mínimo: CANARY_A una vez; NON_CANARY_B y HUMAN_C cero outbound', async () => {
  const h = harness();
  const first = await h.send({ conversationId: CANARY_A, messageId: 'msg-a' });
  const duplicate = await h.send({ conversationId: CANARY_A, messageId: 'msg-a' });
  const nonCanary = await h.send({ conversationId: NON_CANARY_B, messageId: 'msg-b' });
  const human = await h.send({
    conversationId: HUMAN_C,
    messageId: 'msg-c',
    conversationRow: { id: HUMAN_C, ai_state: { conversation_mode: 'HUMAN_WAITING' } },
  });

  assert.equal(first.sent, true);
  assert.equal(duplicate.sent, false);
  assert.equal(nonCanary.sent, false);
  assert.equal(human.sent, false);
  assert.deepEqual(h.sent.map((entry) => entry.conversationId), [CANARY_A]);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.decisions.length, 4);
});

test('aislamiento mínimo: follow-up sólo posible para CANARY_A', async () => {
  const h = harness();
  const allowed = await h.send({ conversationId: CANARY_A, messageId: 'followup:a:1h', route: 'followup', requestKind: 'followup' });
  const blocked = await h.send({ conversationId: NON_CANARY_B, messageId: 'followup:b:1h', route: 'followup', requestKind: 'followup' });
  assert.equal(allowed.sent, true);
  assert.equal(blocked.sent, false);
  assert.equal(h.sent.length, 1);
});

test('aislamiento mínimo: kill switch produce cero outbound para las tres', async () => {
  const h = harness();
  for (const [conversationId, messageId] of [[CANARY_A, 'kill-a'], [NON_CANARY_B, 'kill-b'], [HUMAN_C, 'kill-c']]) {
    const result = await h.send({ conversationId, messageId, env: canaryEnv(true) });
    assert.equal(result.sent, false);
    assert.equal(result.reason_code, 'KILL_SWITCH_ACTIVE');
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.persisted.length, 0);
});

test('conflicto concurrente al persistir bloquea el segundo transporte', async () => {
  const decisions = [];
  let transportCalls = 0;
  const result = await sendPerseoAutomatedWhatsApp({
    channel: 'ia',
    to: '5210000000000',
    messages: ['Respuesta controlada'],
    conversationId: CANARY_A,
    messageId: 'race-message',
    conversationRow: { id: CANARY_A, ai_state: {} },
    route: 'v3',
    env: canaryEnv(false),
    globalPolicyRow: { human_only_global: true, automation_enabled: false },
    recordDecision: async (decision) => decisions.push(decision),
    checkMessageProcessed: async () => false,
    saveOutboundMessages: async () => ({ outbound: ['Respuesta controlada'], rows: [{ id: 'existing' }], duplicate: true }),
    saveConversationEvent: async () => {},
    sendTransport: async () => { transportCalls += 1; },
  });
  assert.equal(result.sent, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason_code, 'MESSAGE_ALREADY_PROCESSED');
  assert.equal(transportCalls, 0);
  assert.deepEqual(decisions.map((decision) => decision.decision), ['ALLOW', 'BLOCK']);
});
