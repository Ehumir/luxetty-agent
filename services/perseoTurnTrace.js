'use strict';

const crypto = require('node:crypto');
const { classifyOrigin } = require('./perseoP0Crm');

const PROMPT_VERSION = 'perseo-p0-recovery-v1';
const PROMPT_HASH = crypto.createHash('sha256').update(PROMPT_VERSION).digest('hex');

function redactText(value) {
  return String(value || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, '[EMAIL]')
    .replace(/(?:\+?52\s*)?(?:\d[\s()-]?){10,13}/g, '[TEL]')
    .replace(/\b(?:nombre|name)\s*:\s*[^\n|]+/gi, 'Nombre: [NOMBRE]')
    .slice(0, 4000);
}

function redactObject(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactObject(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactText(value) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(phone|whatsapp|email|full_name|first_name|last_name|raw_payload|prompt)$/i.test(key)) {
      out[key] = item == null ? null : '[REDACTED]';
    } else {
      out[key] = redactObject(item, depth + 1);
    }
  }
  return out;
}

function startTurnTrace({ conversationId, inboundMessageId, text, aiState, conversationRow, startedAt = Date.now() }) {
  return {
    turnId: crypto.randomUUID(),
    conversationId,
    inboundMessageId: inboundMessageId || null,
    message: redactText(text),
    stateBefore: redactObject(aiState || {}),
    conversationRow: conversationRow || {},
    startedAt,
  };
}

function buildTerminalRow(trace, details = {}) {
  const stateAfter = details.stateAfter || {};
  const crm = details.crmResult?.p0Result || details.crmResult || {};
  const reply = Array.isArray(details.reply) ? details.reply.join('\n\n') : details.reply;
  const campaign = stateAfter.campaign_context || trace.stateBefore.campaign_context || {};
  return {
    turn_id: trace.turnId,
    conversation_id: trace.conversationId,
    inbound_message_id: trace.inboundMessageId,
    origin: classifyOrigin(stateAfter),
    campaign: redactObject(campaign),
    entity_refs: {
      contact_id: crm.result?.contact_id || trace.conversationRow.contact_id || null,
      lead_id: crm.result?.lead_id || trace.conversationRow.lead_id || null,
      request_id: crm.result?.request_id || null,
      property_id: stateAfter.interested_property_id || null,
      assigned_agent_profile_id: stateAfter.assigned_agent_profile_id || trace.conversationRow.assigned_agent_profile_id || null,
    },
    message_redacted: trace.message,
    state_before: trace.stateBefore,
    classification: redactObject({
      intent: stateAfter.intent_type || null,
      operation: stateAfter.operation_type || null,
      lead_flow: stateAfter.lead_flow || null,
      domain: details.domain || null,
    }),
    context_redacted: redactObject({
      active_topic: stateAfter.active_topic || null,
      location_text: stateAfter.location_text || null,
      property_type: stateAfter.property_type || null,
      budget_min: stateAfter.budget_min ?? null,
      budget_max: stateAfter.budget_max ?? null,
      bedrooms: stateAfter.bedrooms ?? null,
      property_context: stateAfter.property_context || null,
    }),
    retrieval: redactObject(details.retrieval || { used: false, reason: 'not_used_or_not_reported' }),
    routing: {
      selected_pipeline: details.selectedPipeline || 'legacy',
      route: details.route || details.responseSource || null,
      deterministic: !String(details.responseSource || '').includes('engine'),
    },
    flags: redactObject(details.flags || {}),
    decision: redactObject({ response_source: details.responseSource || null, skip: details.skip === true }),
    response_redacted: redactText(reply),
    state_after: redactObject(stateAfter),
    crm_result: redactObject(crm),
    model: details.model || null,
    prompt_version: PROMPT_VERSION,
    prompt_hash: PROMPT_HASH,
    latency_ms: Math.max(0, Date.now() - trace.startedAt),
    handoff: redactObject({
      mode: stateAfter.conversation_mode || null,
      sent: stateAfter.handoff_sent === true,
      reason: stateAfter.handoff_reason || null,
      at: stateAfter.handoff_at || null,
      by: stateAfter.handoff_by || (stateAfter.handoff_sent ? 'perseo' : null),
    }),
    terminal_result: details.terminalResult || 'failed',
    error: redactObject(details.error ? { message: details.error.message || String(details.error) } : {}),
  };
}

async function persistTerminalTurn(supabase, trace, details = {}) {
  if (!trace || !supabase?.from) return { persisted: false, reason: 'missing_trace_or_client' };
  const row = buildTerminalRow(trace, details);
  const { error } = await supabase.from('perseo_p0_turn_traces').insert(row);
  if (error) return { persisted: false, reason: error.message || 'trace_insert_failed', row };
  return { persisted: true, row };
}

module.exports = {
  PROMPT_VERSION,
  PROMPT_HASH,
  redactText,
  redactObject,
  startTurnTrace,
  buildTerminalRow,
  persistTerminalTurn,
};
