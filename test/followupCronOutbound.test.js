'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sendPerseoAutomatedWhatsApp } = require('../services/perseoAutomatedWhatsApp');
const { getNextDueAction } = require('../services/followupAutomation');

describe('followup cron outbound hotfix', () => {
  it('sendPerseoAutomatedWhatsApp does not throw when saveOutboundMessages returns undefined', async () => {
    let graphCalls = 0;
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const result = await sendPerseoAutomatedWhatsApp({
        channel: 'ia',
        to: '5218100000001',
        messages: ['¿Deseas continuar?'],
        conversationId,
        messageId: `followup:${conversationId}:1h`,
        conversationRow: { id: conversationId, ai_state: {} },
        route: 'followup',
        requestKind: 'followup',
        env: {
          PERSEO_AUTOMATION_MODE: 'CANARY_ALLOWLIST',
          PERSEO_AUTOMATED_RESPONSES_ENABLED: 'true',
          PERSEO_CANARY_ENABLED: 'true',
          PERSEO_CANARY_CONVERSATION_IDS: conversationId,
          PERSEO_FOLLOWUPS_ENABLED: 'true',
          PERSEO_KILL_SWITCH: 'false',
        },
        globalPolicyRow: { human_only_global: true, automation_enabled: false },
        recordDecision: async () => {},
        checkMessageProcessed: async () => false,
        saveOutboundMessages: async () => {},
        saveConversationEvent: async () => {},
        logEvent: () => {},
        sendTransport: async () => { graphCalls += 1; },
      });

    assert.equal(result.sent, true);
    assert.deepEqual(result.outbound, ['¿Deseas continuar?']);
    assert.deepEqual(result.rows, []);
    assert.equal(graphCalls, 1);
  });

  it('getNextDueAction unchanged after outbound persist contract (no duplicate step)', () => {
    const now = new Date();
    const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
    const action = getNextDueAction({
      messages: [
        { direction: 'inbound', sender_type: 'lead', created_at: hoursAgo(2) },
        { direction: 'outbound', sender_type: 'ai_agent', created_at: hoursAgo(1.9) },
      ],
      sentEvents: new Set(),
      now,
    });
    assert.equal(action?.step?.key, '1h');
  });
});
