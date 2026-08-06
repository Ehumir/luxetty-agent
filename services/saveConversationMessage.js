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

function markDeduplicated(row) {
  if (!row || typeof row !== 'object') return row;
  try {
    Object.defineProperty(row, '_deduplicated', { value: true, enumerable: false });
  } catch (_error) {
    // Sólo metadato de proceso; la fila sigue siendo segura aunque no sea extensible.
  }
  return row;
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

        return markDeduplicated(existing || null);
      }
    }

    const { data, error } = await supabase
      .from('conversation_messages')
      .insert({
        conversation_id: conversationId,
        direction,
        sender_type: senderType,
        message_type: messageType,
        message_text: messageText,
        transcription_text: transcriptionText,
        meta_message_id: metaMessageId,
        raw_payload: rawPayload,
      })
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
          return markDeduplicated(existingRow);
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
      .update({
        last_message_at: nowIso(),
      })
      .eq('id', conversationId);

    return data;
  } catch (err) {
    console.error('FATAL saveConversationMessage:', err);
    return null;
  }
}

module.exports = {
  saveConversationMessage,
  inboundMessageAlreadyProcessed,
};
