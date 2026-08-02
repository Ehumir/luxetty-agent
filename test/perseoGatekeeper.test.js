'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAutomationPolicy,
  PERSEO_REASON_CODES,
  normalizePerseoAiControlFromRow,
} = require('../conversation/perseoGatekeeper');

const CANARY_A = '11111111-1111-4111-8111-111111111111';
const NON_CANARY_B = '22222222-2222-4222-8222-222222222222';
const HUMAN_C = '33333333-3333-4333-8333-333333333333';
const GLOBAL_PAUSED_ROW = { human_only_global: true, automation_enabled: false };

function env(overrides = {}) {
  return {
    PERSEO_AUTOMATION_MODE: 'CANARY_ALLOWLIST',
    PERSEO_AUTOMATED_RESPONSES_ENABLED: 'true',
    PERSEO_CANARY_ENABLED: 'true',
    PERSEO_CANARY_CONVERSATION_IDS: CANARY_A,
    PERSEO_FOLLOWUPS_ENABLED: 'true',
    PERSEO_KILL_SWITCH: 'false',
    PERSEO_QA_AUTOMATION_ENABLED: 'false',
    PERSEO_QA_ALLOWED_ENVIRONMENTS: 'staging',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    GIT_COMMIT_SHA: 'test-sha',
    ...overrides,
  };
}

async function decide(overrides = {}) {
  const decisions = [];
  const out = await resolveAutomationPolicy({
    conversationId: CANARY_A,
    conversationRow: { id: CANARY_A, ai_state: {} },
    messageId: 'wamid.test',
    from: '5218181877351',
    channel: 'ia',
    route: 'v3',
    requestKind: 'direct',
    env: env(),
    globalPolicyRow: GLOBAL_PAUSED_ROW,
    recordDecision: async (decision) => decisions.push(decision),
    ...overrides,
  });
  return { out, decisions };
}

test('normalización detecta pausa individual y HUMAN_WAITING', () => {
  const state = normalizePerseoAiControlFromRow({
    ai_state: { ai_paused: true, conversation_mode: 'HUMAN_WAITING' },
  });
  assert.equal(state.ai_paused, true);
  assert.equal(state.human_waiting, true);
});

test('1. GLOBAL_PAUSED bloquea conversación real', async () => {
  const { out } = await decide({ env: env({ PERSEO_AUTOMATION_MODE: 'GLOBAL_PAUSED', PERSEO_AUTOMATED_RESPONSES_ENABLED: 'false', PERSEO_CANARY_ENABLED: 'false', PERSEO_CANARY_CONVERSATION_IDS: '', PERSEO_FOLLOWUPS_ENABLED: 'false' }) });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.reason_code, PERSEO_REASON_CODES.GLOBAL_PAUSED);
});

for (const [number, route] of [[2, 'legacy'], [3, 'v2'], [4, 'v3']]) {
  test(`${number}. GLOBAL_PAUSED bloquea ruta ${route}`, async () => {
    const { out } = await decide({ route, env: env({ PERSEO_AUTOMATION_MODE: 'GLOBAL_PAUSED', PERSEO_AUTOMATED_RESPONSES_ENABLED: 'false', PERSEO_CANARY_ENABLED: 'false', PERSEO_CANARY_CONVERSATION_IDS: '', PERSEO_FOLLOWUPS_ENABLED: 'false' }) });
    assert.equal(out.decision, 'BLOCK');
    assert.equal(out.route, route);
  });
}

test('5. GLOBAL_PAUSED bloquea follow-up', async () => {
  const { out } = await decide({ route: 'followup', requestKind: 'followup', env: env({ PERSEO_AUTOMATION_MODE: 'GLOBAL_PAUSED', PERSEO_AUTOMATED_RESPONSES_ENABLED: 'false', PERSEO_CANARY_ENABLED: 'false', PERSEO_CANARY_CONVERSATION_IDS: '', PERSEO_FOLLOWUPS_ENABLED: 'false' }) });
  assert.equal(out.decision, 'BLOCK');
});

test('6. canary permite exclusivamente conversación autorizada', async () => {
  const { out, decisions } = await decide();
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CANARY_CONVERSATION_ALLOWED);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].deployed_sha, 'test-sha');
});

test('7. canary bloquea conversación no incluida', async () => {
  const { out } = await decide({ conversationId: NON_CANARY_B, conversationRow: { id: NON_CANARY_B, ai_state: {} } });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CANARY_CONVERSATION_NOT_ALLOWED);
});

test('8. canary bloquea allowlist vacía', async () => {
  const { out } = await decide({ env: env({ PERSEO_CANARY_CONVERSATION_IDS: '' }) });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CANARY_ALLOWLIST_EMPTY);
});

test('9. canary bloquea ID inválido', async () => {
  const { out } = await decide({ env: env({ PERSEO_CANARY_CONVERSATION_IDS: 'CANARY_A' }) });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CANARY_ID_INVALID);
});

test('10. kill switch bloquea conversación canary', async () => {
  const { out } = await decide({ env: env({ PERSEO_KILL_SWITCH: 'true' }) });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.KILL_SWITCH_ACTIVE);
});

test('11. pausa individual bloquea conversación canary', async () => {
  const { out } = await decide({ conversationRow: { id: CANARY_A, ai_state: { ai_paused: true } } });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CONVERSATION_HUMAN_ATTENTION);
});

test('12. HUMAN_WAITING bloquea conversación canary', async () => {
  const { out } = await decide({ conversationId: HUMAN_C, conversationRow: { id: HUMAN_C, ai_state: { conversation_mode: 'HUMAN_WAITING' } }, env: env({ PERSEO_CANARY_CONVERSATION_IDS: `${CANARY_A},${HUMAN_C}` }) });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.HUMAN_WAITING_ACTIVE);
});

test('13. retirar conversación de allowlist surte efecto inmediato', async () => {
  const first = await decide();
  const second = await decide({ env: env({ PERSEO_CANARY_CONVERSATION_IDS: NON_CANARY_B }) });
  assert.equal(first.out.decision, 'ALLOW');
  assert.equal(second.out.decision, 'BLOCK');
});

test('14. webhook duplicado no produce autorización', async () => {
  const { out } = await decide({ messageAlreadyProcessed: true });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.MESSAGE_ALREADY_PROCESSED);
});

test('15. retry vuelve a evaluar y no evade el gate', async () => {
  const { out } = await decide({ route: 'retry', requestKind: 'retry', messageAlreadyProcessed: true });
  assert.equal(out.decision, 'BLOCK');
});

test('16. worker diferido vuelve a evaluar membresía', async () => {
  const { out } = await decide({ conversationId: NON_CANARY_B, conversationRow: { id: NON_CANARY_B, ai_state: {} }, route: 'worker', requestKind: 'deferred' });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CANARY_CONVERSATION_NOT_ALLOWED);
});

test('17. QA autorizado funciona con sesión, identidad y ambiente explícitos', async () => {
  const previous = process.env.QA_ALLOWED_WHATSAPP_NUMBERS;
  process.env.QA_ALLOWED_WHATSAPP_NUMBERS = '5218181877351';
  try {
    const { out } = await decide({
      channel: 'qa',
      route: 'qa',
      qaSession: { isQa: true, authorized: true },
      env: env({ PERSEO_AUTOMATION_MODE: 'GLOBAL_PAUSED', PERSEO_AUTOMATED_RESPONSES_ENABLED: 'false', PERSEO_CANARY_ENABLED: 'false', PERSEO_CANARY_CONVERSATION_IDS: '', PERSEO_FOLLOWUPS_ENABLED: 'false', PERSEO_QA_AUTOMATION_ENABLED: 'true' }),
    });
    assert.equal(out.reason_code, PERSEO_REASON_CODES.QA_AUTOMATION_ALLOWED);
    assert.equal(out.decision, 'ALLOW');
  } finally {
    if (previous === undefined) delete process.env.QA_ALLOWED_WHATSAPP_NUMBERS;
    else process.env.QA_ALLOWED_WHATSAPP_NUMBERS = previous;
  }
});

test('18. QA no autorizado queda bloqueado', async () => {
  const { out } = await decide({ channel: 'qa', route: 'qa', qaSession: { isQa: true, authorized: false }, env: env({ PERSEO_QA_AUTOMATION_ENABLED: 'true' }) });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.QA_SESSION_NOT_AUTHORIZED);
});

test('19. configuración ausente produce bloqueo', async () => {
  const { out } = await decide({ env: {} });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.CONFIG_MISSING_OR_INVALID);
});

test('20. error interno del gatekeeper produce bloqueo', async () => {
  const supabase = { from() { throw new Error('boom'); } };
  const { out } = await decide({ supabase, globalPolicyRow: null });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.policyResolution, 'error');
});

test('telemetría fallida convierte ALLOW en BLOCK', async () => {
  const { out } = await decide({ recordDecision: async () => { throw new Error('telemetry down'); } });
  assert.equal(out.reason_code, PERSEO_REASON_CODES.TELEMETRY_WRITE_FAILED);
  assert.equal(out.decision, 'BLOCK');
});
