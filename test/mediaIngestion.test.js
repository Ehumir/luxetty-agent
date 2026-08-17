const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractInboundMediaMetadata,
  extractInboundSignalText,
} = require('../conversation/mediaIngestion');
const {
  buildInboundMessageContext,
  buildMediaAcknowledgementReply,
} = require('../conversation/mediaSignals');
const { detectIntent } = require('../conversation/intent');
const {
  resolveInboundMedia,
} = require('../services/whatsappMediaService');

test('A) payload image: extrae media_id/mime/caption y ack sin afirmar vision', () => {
  const message = {
    id: 'wamid.img.1',
    from: '5218111111111',
    timestamp: '1710000000',
    type: 'image',
    image: {
      id: 'img-100',
      mime_type: 'image/jpeg',
      sha256: 'abc123',
      caption: 'quiero vender esta casa',
    },
  };

  const metadata = extractInboundMediaMetadata(message, { conversationId: 'conv-1', from: message.from });
  const inbound = buildInboundMessageContext(message);
  const reply = buildMediaAcknowledgementReply(inbound.media);

  assert.equal(metadata.type, 'image');
  assert.equal(metadata.media_id, 'img-100');
  assert.equal(metadata.mime_type, 'image/jpeg');
  assert.equal(metadata.caption, 'quiero vender esta casa');
  assert.match(reply, /recib[ií] la imagen/i);
  assert.doesNotMatch(reply, /ya vi|analic[eé]|revisi[oó]n autom[aá]tica/i);
});

test('B) payload audio/voice: detecta media y no afirma escucha', () => {
  const audioMessage = {
    id: 'wamid.aud.1',
    from: '5218111111111',
    timestamp: '1710000001',
    type: 'audio',
    audio: {
      id: 'aud-100',
      mime_type: 'audio/ogg',
      sha256: 'sha-aud-1',
      voice: true,
    },
  };

  const metadata = extractInboundMediaMetadata(audioMessage, {});
  const inbound = buildInboundMessageContext(audioMessage);
  const reply = buildMediaAcknowledgementReply(inbound.media);

  assert.equal(metadata.type, 'audio');
  assert.equal(metadata.media_id, 'aud-100');
  assert.equal(metadata.mime_type, 'audio/ogg');
  assert.equal(metadata.voice, true);
  assert.match(reply, /recib[ií] tu audio/i);
  assert.doesNotMatch(reply, /ya escuch[eé]|ya transcrib[ií]/i);
});

test('C) payload document PDF: detecta filename y mime_type', () => {
  const docMessage = {
    id: 'wamid.doc.1',
    from: '5218111111111',
    timestamp: '1710000002',
    type: 'document',
    document: {
      id: 'doc-100',
      filename: 'escritura final.pdf',
      mime_type: 'application/pdf',
      caption: 'escritura de la propiedad',
    },
  };

  const metadata = extractInboundMediaMetadata(docMessage, {});

  assert.equal(metadata.type, 'document');
  assert.equal(metadata.media_id, 'doc-100');
  assert.equal(metadata.filename, 'escritura_final.pdf');
  assert.equal(metadata.mime_type, 'application/pdf');
});

test('D) payload location: extrae lat/lng/name/address y respuesta util', () => {
  const locationMessage = {
    id: 'wamid.loc.1',
    from: '5218111111111',
    timestamp: '1710000003',
    type: 'location',
    location: {
      latitude: 25.665,
      longitude: -100.312,
      name: 'Cumbres',
      address: 'Monterrey, NL',
    },
  };

  const metadata = extractInboundMediaMetadata(locationMessage, {});
  const inbound = buildInboundMessageContext(locationMessage);
  const reply = buildMediaAcknowledgementReply(inbound.media);

  assert.equal(metadata.location.latitude, 25.665);
  assert.equal(metadata.location.longitude, -100.312);
  assert.equal(metadata.location.name, 'Cumbres');
  assert.equal(metadata.location.address, 'Monterrey, NL');
  assert.match(reply, /esa ubicaci[oó]n corresponde/i);
});

test('E) payload interactive button_reply: extrae id/title y texto de señal', () => {
  const interactiveMessage = {
    id: 'wamid.int.1',
    from: '5218111111111',
    timestamp: '1710000004',
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: {
        id: 'btn-sell',
        title: 'Quiero vender',
      },
    },
  };

  const metadata = extractInboundMediaMetadata(interactiveMessage, {});
  const signalText = extractInboundSignalText(interactiveMessage);

  assert.equal(metadata.interactive.interactive_type, 'button_reply');
  assert.equal(metadata.interactive.button_reply_id, 'btn-sell');
  assert.equal(metadata.interactive.button_reply_title, 'Quiero vender');
  assert.equal(signalText, 'Quiero vender');
});

test('F) error descargando media: no rompe y retorna failed', async () => {
  const message = {
    id: 'wamid.img.fail',
    from: '5218111111111',
    timestamp: '1710000005',
    type: 'image',
    image: {
      id: 'img-fail-1',
      mime_type: 'image/jpeg',
    },
  };

  let callCount = 0;
  const httpClient = {
    async get() {
      callCount += 1;
      if (callCount === 1) {
        return { data: { url: 'https://signed-meta-url.test/file' } };
      }
      const err = new Error('download failed');
      err.response = { status: 503, data: { error: { message: 'service unavailable', code: 503 } } };
      throw err;
    },
  };

  const result = await resolveInboundMedia(message, { httpClient, skipAuth: true });

  assert.equal(result.success, false);
  assert.equal(result.download_status, 'failed');
  assert.equal(result.error_code, 'whatsapp_media_download_failed');
});

test('G) tipo no soportado: registra skipped_unsupported', async () => {
  const message = {
    id: 'wamid.stk.1',
    from: '5218111111111',
    timestamp: '1710000006',
    type: 'sticker',
    sticker: {
      id: 'stk-1',
      mime_type: 'image/webp',
    },
  };

  const result = await resolveInboundMedia(message);

  assert.equal(result.success, false);
  assert.equal(result.download_status, 'skipped_unsupported');
});

test('H) regresion texto normal: intencion sigue funcionando', () => {
  const intent = detectIntent('quiero vender mi casa en Cumbres', {});
  assert.equal(intent.leadType, 'offer');
});
