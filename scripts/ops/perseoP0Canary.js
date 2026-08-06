'use strict';

const { resolveAutomationPolicy } = require('../../conversation/perseoGatekeeper');

const CANARY_A = '11111111-1111-4111-8111-111111111111';
const NON_CANARY_B = '22222222-2222-4222-8222-222222222222';
const HUMAN_C = '33333333-3333-4333-8333-333333333333';
const pausedRow = { human_only_global: true, automation_enabled: false };

function config(killSwitch = false) {
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
    GIT_COMMIT_SHA: process.env.GIT_COMMIT_SHA || 'local-preflight',
  };
}

async function evaluate({ conversationId, route, aiState = {}, killSwitch = false }) {
  const telemetry = [];
  const decision = await resolveAutomationPolicy({
    conversationId,
    conversationRow: { id: conversationId, ai_state: aiState },
    messageId: `preflight:${conversationId}:${route}:${killSwitch}`,
    channel: 'ia',
    route,
    requestKind: route === 'followup' ? 'followup' : 'direct',
    env: config(killSwitch),
    globalPolicyRow: pausedRow,
    recordDecision: async (row) => telemetry.push(row),
  });
  return { decision: decision.decision, reason: decision.reason_code, telemetry: telemetry.length };
}

async function main() {
  const cases = {
    CANARY_A: await evaluate({ conversationId: CANARY_A, route: 'v3' }),
    NON_CANARY_B_LEGACY: await evaluate({ conversationId: NON_CANARY_B, route: 'legacy' }),
    NON_CANARY_B_V2: await evaluate({ conversationId: NON_CANARY_B, route: 'v2' }),
    NON_CANARY_B_V3: await evaluate({ conversationId: NON_CANARY_B, route: 'v3' }),
    NON_CANARY_B_FOLLOWUP: await evaluate({ conversationId: NON_CANARY_B, route: 'followup' }),
    HUMAN_C: await evaluate({ conversationId: HUMAN_C, route: 'v3', aiState: { conversation_mode: 'HUMAN_WAITING' } }),
    KILL_CANARY_A: await evaluate({ conversationId: CANARY_A, route: 'v3', killSwitch: true }),
    KILL_NON_CANARY_B: await evaluate({ conversationId: NON_CANARY_B, route: 'v3', killSwitch: true }),
    KILL_HUMAN_C: await evaluate({ conversationId: HUMAN_C, route: 'v3', aiState: { conversation_mode: 'HUMAN_WAITING' }, killSwitch: true }),
  };

  const pass =
    cases.CANARY_A.decision === 'ALLOW' &&
    Object.entries(cases).filter(([name]) => name !== 'CANARY_A').every(([, result]) => result.decision === 'BLOCK') &&
    Object.values(cases).every((result) => result.telemetry === 1);

  console.log(JSON.stringify({ kind: 'offline_canary_isolation_preflight', pass, cases }, null, 2));
  if (!pass) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});

module.exports = { main, evaluate };
