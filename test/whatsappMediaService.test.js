const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getInboundMediaDescriptor,
  isAllowedDownload,
  normalizeMimeTypeForPolicy,
  evaluateGraphAndDescriptorMimePolicy,
  uniqueNormalizedMimeHints,
} = require('../services/whatsappMediaService');

test('descriptor detects downloadable image payload', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'image',
    image: {
      id: 'img-123',
      caption: 'Fachada principal',
      mime_type: 'image/jpeg',
      sha256: 'sha-img-1',
    },
  });

  assert.equal(descriptor.shouldDownload, true);
  assert.equal(descriptor.mediaType, 'image');
  assert.equal(descriptor.mediaId, 'img-123');
  assert.equal(descriptor.caption, 'Fachada principal');
  assert.equal(descriptor.mimeType, 'image/jpeg');
  assert.equal(descriptor.sha256, 'sha-img-1');
});

test('descriptor supports contacts and interactive as non-downloadable', () => {
  const contactsDescriptor = getInboundMediaDescriptor({ type: 'contacts' });
  const interactiveDescriptor = getInboundMediaDescriptor({ type: 'interactive' });

  assert.equal(contactsDescriptor.shouldDownload, false);
  assert.equal(interactiveDescriptor.shouldDownload, false);
  assert.equal(interactiveDescriptor.reason, 'skipped_unsupported');
});

test('descriptor handles document metadata', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'document',
    document: {
      id: 'doc-777',
      filename: 'escritura.pdf',
      caption: 'escritura completa',
      mime_type: 'application/pdf',
      sha256: 'sha-doc-1',
    },
  });

  assert.equal(descriptor.shouldDownload, true);
  assert.equal(descriptor.mediaId, 'doc-777');
  assert.equal(descriptor.fileName, 'escritura.pdf');
  assert.equal(descriptor.mimeType, 'application/pdf');
  assert.equal(descriptor.sha256, 'sha-doc-1');
});

test('normalizeMimeTypeForPolicy strips parameters (audio/ogg; codecs=opus)', () => {
  assert.equal(normalizeMimeTypeForPolicy('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(normalizeMimeTypeForPolicy('  IMAGE/JPEG ; charset=binary '), 'image/jpeg');
  assert.equal(normalizeMimeTypeForPolicy(null), null);
  assert.equal(normalizeMimeTypeForPolicy(''), null);
});

test('isAllowedDownload accepts audio/ogg with codecs parameter against allowlist', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'audio',
    audio: {
      id: 'aud-1',
      mime_type: 'audio/ogg; codecs=opus',
    },
  });
  const policy = isAllowedDownload(descriptor);
  assert.equal(policy.allowed, true);
  assert.equal(policy.reason, null);
});

test('isAllowedDownload rejects mime not in allowlist after normalization', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'audio',
    audio: {
      id: 'aud-2',
      mime_type: 'audio/wav; codecs=whatever',
    },
  });
  const policy = isAllowedDownload(descriptor);
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, 'skipped_unsupported_mime');
});

test('evaluateGraphAndDescriptorMimePolicy allows application/octet-stream when webhook has allowed audio', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'audio',
    audio: { id: 'a1', mime_type: 'audio/ogg; codecs=opus' },
  });
  const ev = evaluateGraphAndDescriptorMimePolicy(
    { mime_type: 'application/octet-stream', url: 'https://example.com/x' },
    descriptor
  );
  assert.equal(ev.allowed, true);
  assert.deepEqual(ev.hints, ['application/octet-stream', 'audio/ogg']);
});

test('evaluateGraphAndDescriptorMimePolicy reads metadata.mimeType camelCase', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'audio',
    audio: { id: 'a1', mime_type: 'audio/ogg; codecs=opus' },
  });
  const ev = evaluateGraphAndDescriptorMimePolicy(
    { mimeType: 'application/octet-stream' },
    descriptor
  );
  assert.equal(ev.allowed, true);
});

test('evaluateGraphAndDescriptorMimePolicy rejects when hints are only disallowed concrete types', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'audio',
    audio: { id: 'a1', mime_type: 'audio/webm' },
  });
  const ev = evaluateGraphAndDescriptorMimePolicy({ mime_type: 'audio/webm' }, descriptor);
  assert.equal(ev.allowed, false);
});

test('uniqueNormalizedMimeHints dedupes and preserves order', () => {
  const hints = uniqueNormalizedMimeHints(
    { mime_type: 'audio/ogg; codecs=opus' },
    { mimeType: 'audio/ogg; codecs=opus' }
  );
  assert.deepEqual(hints, ['audio/ogg']);
});

test('descriptor marks video as downloadable in Sprint C', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'video',
    video: {
      id: 'vid-1',
      mime_type: 'video/mp4',
      caption: 'Recorrido',
    },
  });

  assert.equal(descriptor.mediaType, 'video');
  assert.equal(descriptor.mediaId, 'vid-1');
  assert.equal(descriptor.caption, 'Recorrido');
  assert.equal(descriptor.shouldDownload, true);
  assert.equal(isAllowedDownload(descriptor).allowed, true);
});

test('descriptor marks sticker webp as downloadable in Sprint C', () => {
  const descriptor = getInboundMediaDescriptor({
    type: 'sticker',
    sticker: {
      id: 'stk-1',
      mime_type: 'image/webp',
    },
  });

  assert.equal(descriptor.mediaType, 'sticker');
  assert.equal(descriptor.mediaId, 'stk-1');
  assert.equal(descriptor.shouldDownload, true);
  assert.equal(isAllowedDownload(descriptor).allowed, true);
});
