const { axios, WHATSAPP_TOKEN } = require('./whatsappService');
const {
  META_ACCESS_TOKEN,
  GRAPH_API_VERSION,
  MEDIA_DOWNLOAD_MAX_BYTES,
} = require('../config/env');

const GRAPH_VERSION = GRAPH_API_VERSION || 'v19.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = Number(MEDIA_DOWNLOAD_MAX_BYTES || 15 * 1024 * 1024);

const DOWNLOADABLE_TYPES = new Set(['image', 'audio', 'voice', 'document']);
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'application/pdf',
]);

function sanitizeFilename(name = '') {
  const text = String(name || '').trim();
  if (!text) return null;
  return text.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

/**
 * Graph/WABA sometimes returns MIME with parameters (e.g. audio/ogg; codecs=opus).
 * Allowlist checks use only the type/subtype (RFC 2045 media type without parameters).
 * @param {string|null|undefined} mime
 * @returns {string|null}
 */
function normalizeMimeTypeForPolicy(mime) {
  if (mime == null) return null;
  const s = String(mime).trim().toLowerCase();
  if (!s) return null;
  const base = s.split(';')[0].trim();
  return base || null;
}

function uniqueNormalizedMimeHints(metadata = {}, descriptor = {}) {
  const raw = [metadata?.mime_type, metadata?.mimeType, descriptor?.mimeType];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const n = normalizeMimeTypeForPolicy(r);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Graph / CDN often returns application/octet-stream while the webhook payload carries the real audio/* hint.
 * Allow download when: no hints, only generic binary, or any hint matches the Sprint 5A allowlist.
 */
function graphMimePolicyAllowsInboundDownload(normalizedHints) {
  if (!normalizedHints.length) return true;
  const onlyOctet =
    normalizedHints.length === 1 &&
    (normalizedHints[0] === 'application/octet-stream' ||
      normalizedHints[0] === 'binary/octet-stream');
  if (onlyOctet) return true;
  return normalizedHints.some((m) => ALLOWED_MIME_TYPES.has(m));
}

function evaluateGraphAndDescriptorMimePolicy(metadata = {}, descriptor = {}) {
  const hints = uniqueNormalizedMimeHints(metadata, descriptor);
  return { allowed: graphMimePolicyAllowsInboundDownload(hints), hints };
}

function pickStoredMimeType(descriptor, metadata, download) {
  const hints = uniqueNormalizedMimeHints(metadata, descriptor);
  const allowedFromHints = hints.find((m) => ALLOWED_MIME_TYPES.has(m));
  if (allowedFromHints) return allowedFromHints;
  const down = normalizeMimeTypeForPolicy(download?.mimeType);
  if (down && ALLOWED_MIME_TYPES.has(down)) return down;
  const desc = normalizeMimeTypeForPolicy(descriptor?.mimeType);
  if (desc && ALLOWED_MIME_TYPES.has(desc)) return desc;
  if (
    hints.length === 1 &&
    hints[0] === 'application/octet-stream' &&
    (descriptor.mediaType === 'audio' || descriptor.mediaType === 'voice')
  ) {
    return 'audio/ogg';
  }
  return desc || hints[0] || down || null;
}

function getAuthHeaders(options = {}) {
  const token = WHATSAPP_TOKEN || META_ACCESS_TOKEN || null;

  if (!token) {
    if (options.allowMissing === true) return {};
    const error = new Error('whatsapp_token_missing');
    error.code = 'whatsapp_token_missing';
    throw error;
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

function createServiceError(stage, err, fallbackMessage) {
  const status = Number(err?.response?.status || 0) || null;
  const responseData = err?.response?.data || null;
  const details = responseData?.error?.message || err?.message || fallbackMessage;
  const code = responseData?.error?.code || err?.code || null;

  return {
    stage,
    status,
    code,
    message: String(details || fallbackMessage),
    details: responseData,
  };
}

function getInboundMediaDescriptor(message = {}) {
  const type = message?.type || null;

  if (!type) {
    return {
      mediaType: null,
      mediaId: null,
      caption: null,
      fileName: null,
      mimeType: null,
      sha256: null,
      voice: false,
      shouldDownload: false,
      reason: 'missing_message_type',
    };
  }

  if (type === 'image') {
    return {
      mediaType: type,
      mediaId: message?.image?.id || null,
      caption: message?.image?.caption || null,
      fileName: null,
      mimeType: message?.image?.mime_type || null,
      sha256: message?.image?.sha256 || null,
      voice: false,
      shouldDownload: true,
    };
  }

  if (type === 'audio') {
    return {
      mediaType: type,
      mediaId: message?.audio?.id || null,
      caption: message?.audio?.caption || null,
      fileName: null,
      mimeType: message?.audio?.mime_type || null,
      sha256: message?.audio?.sha256 || null,
      voice: !!message?.audio?.voice,
      shouldDownload: true,
    };
  }

  if (type === 'voice') {
    return {
      mediaType: type,
      mediaId: message?.voice?.id || null,
      caption: null,
      fileName: null,
      mimeType: message?.voice?.mime_type || null,
      sha256: message?.voice?.sha256 || null,
      voice: true,
      shouldDownload: true,
    };
  }

  if (type === 'video') {
    return {
      mediaType: type,
      mediaId: message?.video?.id || null,
      caption: message?.video?.caption || null,
      fileName: null,
      mimeType: message?.video?.mime_type || null,
      sha256: message?.video?.sha256 || null,
      voice: false,
      shouldDownload: false,
      reason: 'skipped_video_not_processed',
    };
  }

  if (type === 'document') {
    return {
      mediaType: type,
      mediaId: message?.document?.id || null,
      caption: message?.document?.caption || null,
      fileName: sanitizeFilename(message?.document?.filename || null),
      mimeType: message?.document?.mime_type || null,
      sha256: message?.document?.sha256 || null,
      voice: false,
      shouldDownload: true,
    };
  }

  if (type === 'sticker') {
    return {
      mediaType: type,
      mediaId: message?.sticker?.id || null,
      caption: null,
      fileName: null,
      mimeType: message?.sticker?.mime_type || null,
      sha256: message?.sticker?.sha256 || null,
      voice: false,
      shouldDownload: false,
      reason: 'skipped_unsupported',
    };
  }

  return {
    mediaType: type,
    mediaId: null,
    caption: null,
    fileName: null,
    mimeType: null,
    sha256: null,
    voice: false,
    shouldDownload: false,
    reason: 'skipped_unsupported',
  };
}

function isAllowedDownload(descriptor = {}, options = {}) {
  const allowedMimeTypes = options.allowedMimeTypes || ALLOWED_MIME_TYPES;
  const mediaType = descriptor?.mediaType || null;
  const mimeType = normalizeMimeTypeForPolicy(descriptor?.mimeType);

  if (!DOWNLOADABLE_TYPES.has(mediaType)) {
    return { allowed: false, reason: 'skipped_unsupported' };
  }

  if (mimeType && !allowedMimeTypes.has(mimeType)) {
    return { allowed: false, reason: 'skipped_unsupported_mime' };
  }

  return { allowed: true, reason: null };
}

async function getWhatsAppMediaMetadata(mediaId, options = {}) {
  const timeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const httpClient = options.httpClient || axios;

  if (!mediaId) {
    const error = new Error('whatsapp_media_id_missing');
    error.code = 'whatsapp_media_id_missing';
    throw error;
  }

  try {
    const response = await httpClient.get(`${GRAPH_BASE_URL}/${encodeURIComponent(mediaId)}`, {
      headers: getAuthHeaders({ allowMissing: options.httpClient != null }),
      timeout,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return response.data || {};
  } catch (err) {
    const wrapped = new Error('whatsapp_media_metadata_failed');
    wrapped.code = 'whatsapp_media_metadata_failed';
    wrapped.context = createServiceError('metadata', err, 'Failed to fetch WhatsApp media metadata');
    throw wrapped;
  }
}

async function downloadWhatsAppMedia(mediaUrl, options = {}) {
  const timeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
  const httpClient = options.httpClient || axios;

  if (!mediaUrl) {
    const error = new Error('whatsapp_media_url_missing');
    error.code = 'whatsapp_media_url_missing';
    throw error;
  }

  try {
    const response = await httpClient.get(mediaUrl, {
      headers: getAuthHeaders({ allowMissing: options.httpClient != null }),
      timeout,
      responseType: 'arraybuffer',
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const buffer = Buffer.from(response.data || []);

    return {
      buffer,
      byteLength: buffer.byteLength,
      mimeType: normalizeMimeTypeForPolicy(response.headers?.['content-type']),
      contentLength: Number(response.headers?.['content-length'] || 0) || buffer.byteLength,
    };
  } catch (err) {
    const wrapped = new Error('whatsapp_media_download_failed');
    wrapped.code = 'whatsapp_media_download_failed';
    wrapped.context = createServiceError('download', err, 'Failed to download WhatsApp media');
    throw wrapped;
  }
}

async function resolveInboundMedia(message = {}, options = {}) {
  const descriptor = getInboundMediaDescriptor(message);
  const now = new Date().toISOString();

  if (!descriptor.shouldDownload) {
    return {
      success: false,
      status: descriptor.reason || 'skipped_unsupported',
      media_id: descriptor.mediaId || null,
      mime_type: descriptor.mimeType || null,
      buffer: null,
      size_bytes: null,
      error_code: descriptor.reason || 'media_not_downloadable',
      error_message: 'Media type is not enabled for download in Sprint 4A',
      downloaded_at: null,
      download_status: descriptor.reason || 'skipped_unsupported',
      ...descriptor,
    };
  }

  const policy = isAllowedDownload(descriptor, options);
  if (!policy.allowed) {
    return {
      success: false,
      status: policy.reason,
      media_id: descriptor.mediaId || null,
      mime_type: descriptor.mimeType || null,
      buffer: null,
      size_bytes: null,
      error_code: policy.reason,
      error_message: 'Media mime type is not allowed for download',
      downloaded_at: null,
      download_status: policy.reason,
      ...descriptor,
    };
  }

  if (!descriptor.mediaId) {
    return {
      success: false,
      status: 'failed',
      media_id: null,
      mime_type: descriptor.mimeType || null,
      buffer: null,
      size_bytes: null,
      error_code: 'media_id_missing',
      error_message: 'Media id is required',
      downloaded_at: null,
      download_status: 'failed',
      ...descriptor,
    };
  }

  try {
    const metadata = await getWhatsAppMediaMetadata(descriptor.mediaId, options);
    const mediaUrl = metadata?.url || null;
    const metadataMimeRaw = metadata?.mime_type || metadata?.mimeType || null;
    const mimeEval = evaluateGraphAndDescriptorMimePolicy(metadata, descriptor);

    if (!mimeEval.allowed) {
      return {
        success: false,
        status: 'skipped_unsupported_mime',
        media_id: descriptor.mediaId,
        mime_type: metadataMimeRaw || descriptor.mimeType || null,
        buffer: null,
        size_bytes: null,
        error_code: 'skipped_unsupported_mime',
        error_message: 'Media mime type from metadata is not allowed',
        downloaded_at: null,
        download_status: 'skipped_unsupported_mime',
        ...descriptor,
        metadata,
      };
    }

    if (!mediaUrl) {
      return {
        success: false,
        status: 'failed',
        media_id: descriptor.mediaId,
        mime_type: metadataMimeRaw || descriptor.mimeType || null,
        buffer: null,
        size_bytes: null,
        error_code: 'metadata_missing_media_url',
        error_message: 'Media URL missing in metadata response',
        downloaded_at: null,
        download_status: 'failed',
        ...descriptor,
        metadata,
      };
    }

    const download = await downloadWhatsAppMedia(mediaUrl, options);
    const storedMime = pickStoredMimeType(descriptor, metadata, download);

    return {
      success: true,
      status: 'downloaded',
      media_id: descriptor.mediaId,
      mime_type: storedMime,
      buffer: download.buffer,
      size_bytes: Number(download.byteLength || 0) || null,
      error_code: null,
      error_message: null,
      downloaded_at: now,
      download_status: 'downloaded',
      ...descriptor,
      metadata,
      download,
    };
  } catch (err) {
    return {
      success: false,
      status: 'failed',
      media_id: descriptor.mediaId || null,
      mime_type: descriptor.mimeType || null,
      buffer: null,
      size_bytes: null,
      error_code: err?.code || 'resolve_media_failed',
      error_message: err?.context?.message || err?.message || 'Unknown media resolution error',
      downloaded_at: null,
      download_status: 'failed',
      ...descriptor,
      error: err?.context || {
        stage: 'unknown',
        status: null,
        code: err?.code || null,
        message: err?.message || 'Unknown media resolution error',
        details: null,
      },
    };
  }
}

module.exports = {
  ALLOWED_MIME_TYPES,
  normalizeMimeTypeForPolicy,
  uniqueNormalizedMimeHints,
  evaluateGraphAndDescriptorMimePolicy,
  getWhatsAppMediaMetadata,
  downloadWhatsAppMedia,
  resolveInboundMedia,
  getInboundMediaDescriptor,
  isAllowedDownload,
};
