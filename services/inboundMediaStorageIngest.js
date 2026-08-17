'use strict';

/**
 * Sprint 5A — PR2: ingest diferido de multimedia inbound → Storage privado + metadata.whatsapp_media.
 * No Graph outbound; no gatekeeper; flag PERSEO_INBOUND_MEDIA_STORAGE_ENABLED (default false).
 */

const { META_ACCESS_TOKEN } = require('../config/env');
const { WHATSAPP_TOKEN } = require('./whatsappService');
const {
  resolveInboundMedia,
  getInboundMediaDescriptor,
  normalizeMimeTypeForPolicy,
} = require('./whatsappMediaService');
const { nowIso } = require('../utils/helpers');

const BUCKET_ID = 'whatsapp-inbound-media';

const SCHEDULED_MEDIA_TYPES = new Set([
  'image',
  'audio',
  'voice',
  'document',
  'sticker',
  'video',
]);

function hasGraphMediaToken() {
  return Boolean(String(WHATSAPP_TOKEN || '').trim() || String(META_ACCESS_TOKEN || '').trim());
}

function mimeToFileExtension(mime) {
  const m = normalizeMimeTypeForPolicy(mime) || '';
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'audio/ogg' || m === 'audio/opus') return 'ogg';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/mp4') return 'm4a';
  if (m === 'audio/aac') return 'aac';
  if (m === 'audio/amr') return 'amr';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/3gpp') return '3gp';
  return 'bin';
}

function captionPresentFromMessage(message = {}) {
  const t = message?.type;
  if (t === 'image') return Boolean(String(message?.image?.caption || '').trim());
  if (t === 'document') {
    return Boolean(
      String(message?.document?.caption || '').trim() || String(message?.document?.filename || '').trim()
    );
  }
  if (t === 'audio') return Boolean(String(message?.audio?.caption || '').trim());
  if (t === 'video') return Boolean(String(message?.video?.caption || '').trim());
  if (t === 'voice') return Boolean(String(message?.voice?.caption || '').trim());
  return false;
}

function documentFilenameFromMessage(message = {}) {
  if (message?.type !== 'document') return null;
  const raw = message?.document?.filename;
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return s || null;
}

function buildWhatsappMediaRecord({
  waMessageType,
  metaMediaId,
  mimeType,
  byteSize,
  storageBucket,
  storagePath,
  downloadStatus,
  ingestedAt,
  errorCode,
  filename,
  captionPresent,
}) {
  return {
    schema_version: 1,
    wa_message_type: waMessageType,
    meta_media_id: metaMediaId != null ? String(metaMediaId) : null,
    mime_type: mimeType != null ? String(mimeType) : null,
    byte_size: byteSize != null && Number.isFinite(Number(byteSize)) ? Number(byteSize) : null,
    storage_bucket: storageBucket != null ? String(storageBucket) : null,
    storage_path: storagePath != null ? String(storagePath) : null,
    download_status: downloadStatus,
    ingested_at: ingestedAt != null ? String(ingestedAt) : null,
    error_code: errorCode != null ? String(errorCode) : null,
    filename: filename != null ? String(filename) : null,
    caption_present: Boolean(captionPresent),
  };
}

/**
 * Merge solo la clave whatsapp_media sin pisar el resto de metadata (p.ej. delivery_status outbound).
 */
async function applyWhatsappMediaMetadata(supabase, messageId, whatsappMedia) {
  const { data: row, error: selErr } = await supabase
    .from('conversation_messages')
    .select('metadata')
    .eq('id', messageId)
    .maybeSingle();

  if (selErr) {
    return { ok: false, error: selErr };
  }
  if (!row) {
    return { ok: false, error: new Error('message_row_missing') };
  }

  const prev = row.metadata;
  const base =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};

  const merged = {
    ...base,
    whatsapp_media: whatsappMedia,
  };

  const { error: updErr } = await supabase
    .from('conversation_messages')
    .update({ metadata: merged })
    .eq('id', messageId);

  if (updErr) {
    return { ok: false, error: updErr };
  }
  return { ok: true };
}

/**
 * Si ya hay ingest exitoso, no re-ejecutar (evita trabajo duplicado en webhooks repetidos).
 */
async function shouldSkipIngestAlreadyStored(supabase, messageId) {
  const { data: row, error } = await supabase
    .from('conversation_messages')
    .select('metadata')
    .eq('id', messageId)
    .maybeSingle();

  if (error || !row) return false;
  const wm = row.metadata && typeof row.metadata === 'object' ? row.metadata.whatsapp_media : null;
  return wm && typeof wm === 'object' && wm.download_status === 'stored';
}

async function runInboundMediaIngest({ supabase, logEvent, conversationId, inboundMessageId, message }) {
  const log = typeof logEvent === 'function' ? logEvent : () => {};

  if (!supabase || !conversationId || !inboundMessageId || !message) {
    return;
  }

  const waType = message.type || null;
  if (!SCHEDULED_MEDIA_TYPES.has(waType)) {
    return;
  }

  if (String(process.env.PERSEO_INBOUND_MEDIA_STORAGE_ENABLED || '').toLowerCase() !== 'true') {
    log('perseo_inbound_media_ingest_skipped', {
      reason: 'flag_disabled',
      message_id: inboundMessageId,
      wa_message_type: waType,
    });
    return;
  }

  if (await shouldSkipIngestAlreadyStored(supabase, inboundMessageId)) {
    log('perseo_inbound_media_ingest_skipped', {
      reason: 'already_stored',
      message_id: inboundMessageId,
    });
    return;
  }

  log('perseo_inbound_media_ingest_scheduled', {
    message_id: inboundMessageId,
    wa_message_type: waType,
  });

  const descriptor = getInboundMediaDescriptor(message);
  const metaMediaId = descriptor.mediaId || null;
  const captionPresent = captionPresentFromMessage(message);
  const filename = documentFilenameFromMessage(message);

  if (!hasGraphMediaToken()) {
    const ingestedNow = nowIso();
    await applyWhatsappMediaMetadata(
      supabase,
      inboundMessageId,
      buildWhatsappMediaRecord({
        waMessageType: waType,
        metaMediaId,
        mimeType: descriptor.mimeType || null,
        byteSize: null,
        storageBucket: null,
        storagePath: null,
        downloadStatus: 'skipped_token_missing',
        ingestedAt: ingestedNow,
        errorCode: 'skipped_token_missing',
        filename,
        captionPresent,
      })
    );
    log('perseo_inbound_media_ingest_terminal', {
      message_id: inboundMessageId,
      download_status: 'skipped_token_missing',
    });
    return;
  }

  if (!descriptor.shouldDownload) {
    const ingestedNow = nowIso();
    await applyWhatsappMediaMetadata(
      supabase,
      inboundMessageId,
      buildWhatsappMediaRecord({
        waMessageType: waType,
        metaMediaId,
        mimeType: descriptor.mimeType || null,
        byteSize: null,
        storageBucket: null,
        storagePath: null,
        downloadStatus: 'skipped_unsupported',
        ingestedAt: ingestedNow,
        errorCode: descriptor.reason || 'skipped_unsupported',
        filename,
        captionPresent,
      })
    );
    log('perseo_inbound_media_ingest_terminal', {
      message_id: inboundMessageId,
      download_status: 'skipped_unsupported',
    });
    return;
  }

  const pendingRecord = buildWhatsappMediaRecord({
    waMessageType: waType,
    metaMediaId,
    mimeType: descriptor.mimeType || null,
    byteSize: null,
    storageBucket: null,
    storagePath: null,
    downloadStatus: 'pending',
    ingestedAt: null,
    errorCode: null,
    filename,
    captionPresent,
  });
  await applyWhatsappMediaMetadata(supabase, inboundMessageId, pendingRecord);

  const resolved = await resolveInboundMedia(message);
  const terminalTime = nowIso();
  const finalMime = resolved.mime_type || descriptor.mimeType || null;

  if (!resolved.success || !resolved.buffer) {
    const st =
      resolved.download_status === 'skipped_unsupported_mime'
        ? 'skipped_unsupported_mime'
        : 'failed';
    const errCode =
      st === 'failed'
        ? String(resolved.error_code || 'resolve_failed')
        : String(resolved.error_code || 'skipped_unsupported_mime');

    await applyWhatsappMediaMetadata(
      supabase,
      inboundMessageId,
      buildWhatsappMediaRecord({
        waMessageType: waType,
        metaMediaId,
        mimeType: finalMime,
        byteSize: resolved.size_bytes != null ? resolved.size_bytes : null,
        storageBucket: null,
        storagePath: null,
        downloadStatus: st,
        ingestedAt: terminalTime,
        errorCode: errCode,
        filename,
        captionPresent,
      })
    );
    log('perseo_inbound_media_ingest_failed', {
      message_id: inboundMessageId,
      download_status: st,
      error_code: errCode,
    });
    return;
  }

  const ext = mimeToFileExtension(finalMime);
  const storagePath = `${conversationId}/${inboundMessageId}.${ext}`;

  const { error: upErr } = await supabase.storage.from(BUCKET_ID).upload(storagePath, resolved.buffer, {
    contentType: normalizeMimeTypeForPolicy(finalMime) || 'application/octet-stream',
    upsert: true,
  });

  if (upErr) {
    await applyWhatsappMediaMetadata(
      supabase,
      inboundMessageId,
      buildWhatsappMediaRecord({
        waMessageType: waType,
        metaMediaId,
        mimeType: finalMime,
        byteSize: resolved.size_bytes != null ? resolved.size_bytes : null,
        storageBucket: BUCKET_ID,
        storagePath: null,
        downloadStatus: 'failed',
        ingestedAt: terminalTime,
        errorCode: String(upErr.message || 'storage_upload_failed').slice(0, 200),
        filename,
        captionPresent,
      })
    );
    log('perseo_inbound_media_ingest_failed', {
      message_id: inboundMessageId,
      download_status: 'failed',
      error_code: 'storage_upload_failed',
    });
    return;
  }

  const byteSize = resolved.size_bytes != null ? Number(resolved.size_bytes) : resolved.buffer.length;

  await applyWhatsappMediaMetadata(
    supabase,
    inboundMessageId,
    buildWhatsappMediaRecord({
      waMessageType: waType,
      metaMediaId,
      mimeType: finalMime,
      byteSize,
      storageBucket: BUCKET_ID,
      storagePath,
      downloadStatus: 'stored',
      ingestedAt: terminalTime,
      errorCode: null,
      filename,
      captionPresent,
    })
  );

  log('perseo_inbound_media_ingest_stored', {
    message_id: inboundMessageId,
    byte_size: byteSize,
    wa_message_type: waType,
  });
}

function scheduleInboundMediaIngest({ supabase, logEvent, conversationId, inboundMessageId, message }) {
  setImmediate(() => {
    runInboundMediaIngest({ supabase, logEvent, conversationId, inboundMessageId, message }).catch((err) => {
      const safe = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
      if (typeof logEvent === 'function') {
        logEvent('perseo_inbound_media_ingest_fatal', {
          message_id: inboundMessageId,
          err: safe,
        });
      } else {
        console.error('perseo_inbound_media_ingest_fatal', safe);
      }
    });
  });
}

module.exports = {
  BUCKET_ID,
  SCHEDULED_MEDIA_TYPES,
  scheduleInboundMediaIngest,
  runInboundMediaIngest,
  buildWhatsappMediaRecord,
  mimeToFileExtension,
  applyWhatsappMediaMetadata,
  shouldSkipIngestAlreadyStored,
  hasGraphMediaToken,
};
