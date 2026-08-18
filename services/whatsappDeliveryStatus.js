'use strict';

const STATUS_RANK = Object.freeze({
  pending_send: 0,
  sent: 1,
  delivered: 2,
  read: 3,
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ['sent', 'delivered', 'read', 'failed'].includes(status) ? status : null;
}

function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function shouldApplyStatus(currentStatus, incomingStatus) {
  if (incomingStatus === 'failed') {
    return !['delivered', 'read'].includes(String(currentStatus || '').toLowerCase());
  }
  const currentRank = STATUS_RANK[String(currentStatus || '').toLowerCase()] ?? -1;
  const incomingRank = STATUS_RANK[incomingStatus] ?? -1;
  return incomingRank >= currentRank;
}

function buildDeliveryMetadata(existingMetadata, statusRow) {
  const metadata = { ...asObject(existingMetadata) };
  const incomingStatus = normalizeStatus(statusRow?.status);
  if (!incomingStatus) return metadata;

  const at = isoFromUnixSeconds(statusRow?.timestamp);
  const currentStatus = metadata.delivery_status || null;
  const statusTimestamps = { ...asObject(metadata.delivery_status_timestamps) };
  statusTimestamps[incomingStatus] = at;

  const next = {
    ...metadata,
    delivery_status_timestamps: statusTimestamps,
    last_delivery_webhook_at: new Date().toISOString(),
  };

  if (shouldApplyStatus(currentStatus, incomingStatus)) {
    next.delivery_status = incomingStatus;
  }

  if (incomingStatus === 'failed') {
    const errors = Array.isArray(statusRow?.errors) ? statusRow.errors : [];
    const firstError = errors[0] || null;
    next.delivery_failure = firstError
      ? {
          code: firstError.code ?? null,
          title: firstError.title ?? null,
          message: firstError.message ?? firstError.error_data?.details ?? null,
          details: firstError.error_data?.details ?? null,
          at,
        }
      : { at };
  }

  return next;
}

async function persistWhatsappDeliveryStatuses({ supabase, value, logEvent = console.info }) {
  const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
  if (statuses.length === 0) return { handled: false, updated: 0, ignored: 0 };

  let updated = 0;
  let ignored = 0;

  for (const statusRow of statuses) {
    const metaMessageId = String(statusRow?.id || '').trim();
    const incomingStatus = normalizeStatus(statusRow?.status);
    if (!metaMessageId || !incomingStatus) {
      ignored += 1;
      continue;
    }

    const { data: message, error: findError } = await supabase
      .from('conversation_messages')
      .select('id, conversation_id, metadata')
      .eq('meta_message_id', metaMessageId)
      .maybeSingle();

    if (findError) {
      console.error('whatsapp_delivery_status_lookup_error', findError);
      ignored += 1;
      continue;
    }
    if (!message?.id) {
      ignored += 1;
      logEvent('whatsapp_delivery_status_unmatched', { meta_message_id: metaMessageId, status: incomingStatus });
      continue;
    }

    const nextMetadata = buildDeliveryMetadata(message.metadata, statusRow);
    const { error: updateError } = await supabase
      .from('conversation_messages')
      .update({ metadata: nextMetadata })
      .eq('id', message.id);

    if (updateError) {
      console.error('whatsapp_delivery_status_update_error', updateError);
      ignored += 1;
      continue;
    }

    updated += 1;
    logEvent('whatsapp_delivery_status_updated', {
      conversation_id: message.conversation_id,
      message_id: message.id,
      meta_message_id: metaMessageId,
      status: incomingStatus,
    });
  }

  return { handled: true, updated, ignored };
}

module.exports = {
  STATUS_RANK,
  normalizeStatus,
  shouldApplyStatus,
  buildDeliveryMetadata,
  persistWhatsappDeliveryStatuses,
};
