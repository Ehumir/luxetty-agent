const { nowIso } = require('../utils/helpers');

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|null|undefined} metaMessageId
 */
async function inboundMessageAlreadyProcessed(supabase, metaMessageId) {
  try {
    if (!metaMessageId) return false;
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('id')
      .eq('direction', 'inbound')
      .eq('meta_message_id', metaMessageId)
      .limit(1);

    if (error) {
      console.error('Error checking inbound duplicate (fail-closed):', error);
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error('FATAL inboundMessageAlreadyProcessed (fail-closed):', err);
    return true;
  }
}

function hasMetaMessageId(metaMessageId) {
  return metaMessageId != null && String(metaMessageId).trim() !== '';
}

async function maybeHandleIcfFollowupInbound(supabase, { conversationId, direction, messageText }) {
  if (direction !== 'inbound' || !conversationId || !String(messageText || '').trim()) return null;
  try {
    const { handleIcfFollowupInbound } = require('./icfDailyFollowup');
    const result = await handleIcfFollowupInbound({
      supabase,
      conversationId,
      text: messageText,
      logger: console,
    });
    if (result?.handled) {
      const { markIcfInboundHandled } = require('./icfInboundInterlock');
      markIcfInboundHandled(conversationId);
      console.info('icf_followup_inbound_resolved', {
        conversation_id: conversationId,
        outcome: result.outcome || null,
      });
    }
    return result || null;
  } catch (err) {
    console.warn('icf_followup_inbound_resolution_skipped', {
      conversation_id: conversationId,
      error: String(err?.message || err),
    });
    return null;
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} params
 */
async function saveConversationMessage(supabase, {
  conversationId,
  direction,
  senderType,
  messageType,
  messageText,
  transcriptionText = null,
  metaMessageId = null,
  rawPayload = {},
  metadata = null,
}) {
  try {
    if (!conversationId) return null;

    if (direction === 'inbound' && metaMessageId) {
      const alreadyProcessed = await inboundMessageAlreadyProcessed(supabase, metaMessageId);
      if (alreadyProcessed) {
        const { data: existing } = await supabase
          .from('conversation_messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .eq('direction', 'inbound')
          .eq('meta_message_id', metaMessageId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return existing || null;
      }
    }

    const insertPayload = {
      conversation_id: conversationId,
      direction,
      sender_type: senderType,
      message_type: messageType,
      message_text: messageText,
      transcription_text: transcriptionText,
      meta_message_id: metaMessageId,
      raw_payload: rawPayload,
    };
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      insertPayload.metadata = metadata;
    }

    const { data, error } = await supabase
      .from('conversation_messages')
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      if (error.code === '23505' && hasMetaMessageId(metaMessageId)) {
        const { data: existingRow, error: fetchErr } = await supabase
          .from('conversation_messages')
          .select('*')
          .eq('meta_message_id', metaMessageId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!fetchErr && existingRow) {
          console.info('inbound_duplicate_insert_conflict_resolved', {
            conversation_id: conversationId,
            meta_message_id: metaMessageId,
            existing_message_id: existingRow.id,
            existing_conversation_id: existingRow.conversation_id,
          });
          return existingRow;
        }

        console.warn('inbound_duplicate_insert_conflict_missing_row', {
          conversation_id: conversationId,
          meta_message_id: metaMessageId,
          fetch_error: fetchErr?.message || null,
        });
        return null;
      }

      console.error('Error guardando mensaje:', error);
      return null;
    }

    await supabase
      .from('conversations')
      .update({ last_message_at: nowIso() })
      .eq('id', conversationId);

    await maybeHandleIcfFollowupInbound(supabase, {
      conversationId,
      direction,
      messageText,
    });

    return data;
  } catch (err) {
    console.error('FATAL saveConversationMessage:', err);
    return null;
  }
}

module.exports = {
  saveConversationMessage,
  inboundMessageAlreadyProcessed,
  maybeHandleIcfFollowupInbound,
};
