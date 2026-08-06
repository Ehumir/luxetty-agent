'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROMPT_HASH,
  redactText,
  startTurnTrace,
  buildTerminalRow,
  persistTerminalTurn,
} = require('../services/perseoTurnTrace');

const conversationId = '11111111-1111-4111-8111-111111111111';

test('redacta teléfono, correo y nombre etiquetado', () => {
  const text = redactText('Nombre: Persona Real\nTel: +52 81 1234 5678\nCorreo: real@example.com');
  assert.doesNotMatch(text, /Persona Real|1234 5678|real@example/);
  assert.match(text, /\[NOMBRE\]|\[TEL\]|\[EMAIL\]/);
});

test('reconstruye mensaje → estado → clasificación → contexto → decisión → CRM → estado', () => {
  const trace = startTurnTrace({
    conversationId,
    inboundMessageId: 'wamid.anon',
    text: 'Compra en Cumbres, 40 mil, 2 recámaras',
    aiState: { operation_type: null },
    conversationRow: { contact_id: 'contact-anon' },
    startedAt: Date.now(),
  });
  const row = buildTerminalRow(trace, {
    stateAfter: {
      lead_flow: 'demand', operation_type: 'purchase', intent_type: 'buy',
      location_text: 'Cumbres', budget_max: 40000, bedrooms: 2,
    },
    responseSource: 'conversation_opening_resolver',
    selectedPipeline: 'legacy',
    reply: 'Perfecto, sigo con tu búsqueda de compra en Cumbres.',
    crmResult: { p0Result: { success: true, result: { lead_id: 'lead-anon', request_id: 'request-anon' } } },
    terminalResult: 'sent',
  });
  assert.equal(row.classification.operation, 'purchase');
  assert.equal(row.context_redacted.location_text, 'Cumbres');
  assert.equal(row.context_redacted.budget_max, 40000);
  assert.equal(row.entity_refs.request_id, 'request-anon');
  assert.equal(row.routing.deterministic, true);
  assert.equal(row.retrieval.used, false);
  assert.equal(row.prompt_hash, PROMPT_HASH);
  assert.equal(row.terminal_result, 'sent');
});

test('persiste exactamente un evento terminal', async () => {
  const rows = [];
  const db = { from: () => ({ insert: async (row) => { rows.push(row); return { error: null }; } }) };
  const trace = startTurnTrace({ conversationId, text: 'Asesor', aiState: {}, conversationRow: {} });
  const result = await persistTerminalTurn(db, trace, {
    stateAfter: { conversation_mode: 'HUMAN_WAITING', handoff_sent: true, handoff_reason: 'advisor_requested' },
    responseSource: 'wants_human_auto_escalation',
    reply: 'Gracias, ya recibí tu solicitud para hablar con un asesor. Te contactará para continuar.',
    terminalResult: 'sent',
  });
  assert.equal(result.persisted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handoff.mode, 'HUMAN_WAITING');
  assert.equal(rows[0].handoff.sent, true);
});
