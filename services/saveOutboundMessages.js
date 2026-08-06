'use strict';

const { normalizeOutboundMessages } = require('../utils/helpers');
const { saveConversationMessage } = require('./saveConversationMessage');

/**
 * Persist outbound fragments before Graph send (same contract as index.js webhook).
 */
async function saveOutboundMessages(supabase, { conversationId, messages, rawPayload = {} }) {
  const outbound = normalizeOutboundMessages(messages);
  const rows = [];
  const automationMessageId = rawPayload?.perseo_automation?.message_id || null;
  for (let index = 0; index < outbound.length; index += 1) {
    const messageText = outbound[index];
    const row = await saveConversationMessage(supabase, {
      conversationId,
      direction: 'outbound',
      senderType: 'ai_agent',
      messageType: 'text',
      messageText,
      metaMessageId: automationMessageId ? `perseo:${automationMessageId}:${index}` : null,
      rawPayload,
    });
    if (row?.id) rows.push(row);
  }
  return {
    outbound,
    rows,
    duplicate: rows.length > 0 && rows.every((row) => row?._deduplicated === true),
  };
}

module.exports = {
  saveOutboundMessages,
};
