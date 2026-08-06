/*
 * Smoke test for IA v1.5 inactivity follow-ups.
 *
 * Run:
 *   node scripts/smoke-followups.js
 */

const {
  FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT,
  isInsideWhatsAppFreeTextWindow,
  getNextDueAction,
  resetAiStateForClosedConversation,
  runInactivityFollowups,
} = require('../services/followupAutomation');
const { isPautaConversation } = require('../conversation/pautaDetection');

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildMockSupabase(db) {
  function applyFilters(rows, filters) {
    return rows.filter((row) => filters.every((fn) => fn(row)));
  }

  function projectRows(rows, selectColumns) {
    if (!selectColumns || selectColumns === '*') return rows;

    const columns = String(selectColumns)
      .split(',')
      .map((col) => col.trim())
      .filter(Boolean);

    return rows.map((row) => {
      const projected = {};
      for (const column of columns) projected[column] = row[column];
      return projected;
    });
  }

  function makeQuery(table) {
    const state = {
      filters: [],
      orderBy: null,
      limitCount: null,
      selectColumns: '*',
      updatePayload: null,
      insertPayload: null,
      withSingle: false,
      withMaybeSingle: false,
    };

    const api = {
      select(columns = '*') {
        state.selectColumns = columns;
        return api;
      },
      eq(key, value) {
        state.filters.push((row) => row[key] === value);
        return api;
      },
      is(key, value) {
        // Supabase .is() checks for NULL or exact match
        if (value === null) {
          state.filters.push((row) => row[key] == null);
        } else {
          state.filters.push((row) => row[key] === value);
        }
        return api;
      },
      in(key, values) {
        state.filters.push((row) => values.includes(row[key]));
        return api;
      },
      order(key, options = {}) {
        state.orderBy = { key, ascending: options.ascending !== false };
        return api;
      },
      limit(count) {
        state.limitCount = count;
        return api;
      },
      insert(payload) {
        state.insertPayload = payload;
        return api;
      },
      update(payload) {
        state.updatePayload = payload;
        return api;
      },
      single() {
        state.withSingle = true;
        return api;
      },
      maybeSingle() {
        state.withMaybeSingle = true;
        return api;
      },
      then(resolve) {
        if (!db[table]) db[table] = [];

        if (state.insertPayload != null) {
          const rows = Array.isArray(state.insertPayload)
            ? state.insertPayload
            : [state.insertPayload];

          const inserted = rows.map((row, index) => ({
            id: row.id || `${table}-${db[table].length + index + 1}`,
            created_at: row.created_at || new Date().toISOString(),
            ...row,
          }));

          db[table].push(...inserted);

          if (state.withSingle || state.withMaybeSingle) {
            return resolve({ data: inserted[0] || null, error: null });
          }

          return resolve({ data: inserted, error: null });
        }

        if (state.updatePayload != null) {
          db[table] = db[table].map((row) => (
            applyFilters([row], state.filters).length > 0
              ? { ...row, ...state.updatePayload }
              : row
          ));

          let updatedRows = applyFilters(db[table], state.filters);
          updatedRows = projectRows(updatedRows, state.selectColumns);

          if (state.withSingle || state.withMaybeSingle) {
            return resolve({ data: updatedRows[0] || null, error: null });
          }

          return resolve({ data: updatedRows, error: null });
        }

        let rows = applyFilters(db[table], state.filters);

        if (state.orderBy) {
          const { key, ascending } = state.orderBy;
          rows = [...rows].sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            if (av === bv) return 0;
            if (av == null) return ascending ? -1 : 1;
            if (bv == null) return ascending ? 1 : -1;
            return ascending ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
          });
        }

        if (typeof state.limitCount === 'number') {
          rows = rows.slice(0, state.limitCount);
        }

        rows = projectRows(rows, state.selectColumns);

        if (state.withSingle || state.withMaybeSingle) {
          return resolve({ data: rows[0] || null, error: null });
        }

        return resolve({ data: rows, error: null });
      },
    };

    return api;
  }

  return {
    from(table) {
      return makeQuery(table);
    },
  };
}

async function testRunTwiceNoDuplicates() {
  const now = new Date();
  const db = {
    conversations: [
      {
        id: 'conv-1',
        phone: '5218111111111',
        status: 'open',
        channel: 'whatsapp',
        ai_state: {},
        last_message_at: hoursAgo(1),
        updated_at: hoursAgo(1),
      },
    ],
    conversation_messages: [
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        direction: 'inbound',
        sender_type: 'lead',
        message_type: 'text',
        message_text: 'hola',
        created_at: hoursAgo(1),
      },
      {
        id: 'msg-2',
        conversation_id: 'conv-1',
        direction: 'outbound',
        sender_type: 'ai_agent',
        message_type: 'text',
        message_text: 'respuesta',
        created_at: hoursAgo(0.95),
      },
    ],
    conversation_events: [],
  };

  const sentMessages = [];
  const supabase = buildMockSupabase(db);

  const sendWhatsAppText = async (to, body) => {
    sentMessages.push({ to, body });
  };

  const firstRun = await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now,
    limit: 50,
    logger: console,
  });
  assert(firstRun.sent === 1, 'Expected first run to send exactly one follow-up');

  const secondRun = await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now,
    limit: 50,
    logger: console,
  });
  assert(secondRun.sent === 0, 'Expected second run to send zero follow-ups');

  const sent1hEvents = db.conversation_events.filter((event) => event.type === 'followup_1h_sent');
  assert(sent1hEvents.length === 1, 'Expected single followup_1h_sent event after running job twice');
  assert(sentMessages.length === 1, 'Expected single outbound WhatsApp send after running job twice');
}

async function testOutside24hCloseWithoutFreeText() {
  const now = new Date();
  const db = {
    conversations: [
      {
        id: 'conv-2',
        phone: '5218222222222',
        status: 'open',
        channel: 'whatsapp',
        ai_state: {},
        last_message_at: hoursAgo(25),
        updated_at: hoursAgo(25),
      },
    ],
    conversation_messages: [
      {
        id: 'msg-a',
        conversation_id: 'conv-2',
        direction: 'inbound',
        sender_type: 'lead',
        message_type: 'text',
        message_text: 'hola',
        created_at: hoursAgo(25),
      },
      {
        id: 'msg-b',
        conversation_id: 'conv-2',
        direction: 'outbound',
        sender_type: 'ai_agent',
        message_type: 'text',
        message_text: 'respuesta',
        created_at: hoursAgo(24.9),
      },
    ],
    conversation_events: [],
  };

  const sentMessages = [];
  const supabase = buildMockSupabase(db);

  const sendWhatsAppText = async (to, body) => {
    sentMessages.push({ to, body });
  };

  const run = await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now,
    limit: 50,
    logger: console,
  });

  assert(run.closed === 1, 'Expected conversation to be closed when overdue by 25h');
  assert(run.sent === 0, 'Expected no free-text follow-up sent outside 24h window');
  assert(sentMessages.length === 0, 'Expected no WhatsApp free-text send outside 24h window');

  const blockedEvents = db.conversation_events.filter(
    (event) => event.type === FOLLOWUP_BLOCKED_OUTSIDE_24H_EVENT
  );
  assert(blockedEvents.length === 1, 'Expected one followup_blocked_outside_24h_window event');

  const closeEvents = db.conversation_events.filter(
    (event) => event.type === 'conversation_closed_by_inactivity'
  );
  assert(closeEvents.length === 1, 'Expected close event to be recorded');

  const conversation = db.conversations.find((row) => row.id === 'conv-2');
  assert(conversation?.status === 'closed', 'Expected conversation status to be closed');
}

// ─── Helpers para tests de pauta ────────────────────────────────────────────

function buildPautaAiState(extra = {}) {
  return {
    lead_flow: 'demand',
    operation_type: 'sale',
    whatsapp_referral: {
      headline: 'Casa en Monterrey',
      ad_id: 'ad-123',
      campaign_name: 'Campaña MTY',
      source_url: 'https://fb.com/ad/123',
      source_type: 'ad',
    },
    ...extra,
  };
}

function buildPautaConversation(extra = {}) {
  return {
    id: 'conv-pauta-1',
    phone: '5218110001111',
    status: 'open',
    channel: 'whatsapp',
    ai_state: buildPautaAiState(),
    assigned_agent_profile_id: null,
    contact_id: null,
    lead_id: null,
    last_message_at: hoursAgo(24),
    updated_at: hoursAgo(24),
    ...extra,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testPautaLeadCreatedOnClose() {
  const SPECIAL_AGENT_ID = 'special-agent-uuid-001';
  const db = {
    conversations: [buildPautaConversation()],
    conversation_messages: [
      {
        id: 'msg-p1',
        conversation_id: 'conv-pauta-1',
        direction: 'inbound',
        sender_type: 'lead',
        message_type: 'text',
        message_text: 'hola quiero info',
        created_at: hoursAgo(25),
      },
      {
        id: 'msg-p2',
        conversation_id: 'conv-pauta-1',
        direction: 'outbound',
        sender_type: 'ai_agent',
        message_type: 'text',
        message_text: 'respuesta',
        created_at: hoursAgo(24.9),
      },
    ],
    conversation_events: [],
    user_profiles: [{ id: SPECIAL_AGENT_ID, email: 'agente.especial@luxetty.com' }],
    contacts: [],
    leads: [],
    pipeline_stages: [],
  };

  const supabase = buildMockSupabase(db);
  const sendWhatsAppText = async () => {};

  const result = await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now: new Date(),
    limit: 50,
    logger: { info: () => {}, warn: () => {} },
  });

  assert(result.closed === 1, 'testPautaLeadCreatedOnClose: should close conversation');

  const pautaEvents = db.conversation_events.filter(
    (e) => e.type === 'pauta_abandoned_lead_created'
  );
  assert(pautaEvents.length === 1, 'testPautaLeadCreatedOnClose: should create exactly one pauta event');

  assert(db.leads.length === 1, 'testPautaLeadCreatedOnClose: should insert one lead');
  assert(
    db.leads[0].assigned_agent_profile_id === SPECIAL_AGENT_ID,
    'testPautaLeadCreatedOnClose: lead should be assigned to Agente Especial'
  );
  assert(
    db.leads[0].notes_summary.includes('pauta/referral'),
    'testPautaLeadCreatedOnClose: notes should mention pauta'
  );
  assert(
    db.leads[0].notes_summary.includes('Casa en Monterrey'),
    'testPautaLeadCreatedOnClose: notes should include ad headline'
  );
}

async function testPautaLeadNotDuplicatedOnSecondRun() {
  const SPECIAL_AGENT_ID = 'special-agent-uuid-001';
  const EXISTING_LEAD_ID = 'lead-already-exists';
  const db = {
    conversations: [
      buildPautaConversation({ lead_id: EXISTING_LEAD_ID, status: 'open' }),
    ],
    conversation_messages: [
      {
        id: 'msg-d1',
        conversation_id: 'conv-pauta-1',
        direction: 'inbound',
        sender_type: 'lead',
        message_type: 'text',
        message_text: 'hola',
        created_at: hoursAgo(25),
      },
      {
        id: 'msg-d2',
        conversation_id: 'conv-pauta-1',
        direction: 'outbound',
        sender_type: 'ai_agent',
        message_type: 'text',
        message_text: 'respuesta',
        created_at: hoursAgo(24.9),
      },
    ],
    conversation_events: [],
    user_profiles: [{ id: SPECIAL_AGENT_ID, email: 'agente.especial@luxetty.com' }],
    contacts: [],
    leads: [{ id: EXISTING_LEAD_ID, contact_id: null, is_active: true, is_archived: false }],
    pipeline_stages: [],
  };

  const supabase = buildMockSupabase(db);
  const sendWhatsAppText = async () => {};

  await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now: new Date(),
    limit: 50,
    logger: { info: () => {}, warn: () => {} },
  });

  const pautaCreatedEvents = db.conversation_events.filter(
    (e) => e.type === 'pauta_abandoned_lead_created'
  );
  assert(
    pautaCreatedEvents.length === 0,
    'testPautaLeadNotDuplicatedOnSecondRun: should not create duplicate lead when lead already exists'
  );

  const leadsCount = db.leads.filter((l) => l.id !== EXISTING_LEAD_ID).length;
  assert(leadsCount === 0, 'testPautaLeadNotDuplicatedOnSecondRun: no new leads should be inserted');
}

async function testNoPautaLeadWhenContactHasAgent() {
  const SPECIAL_AGENT_ID = 'special-agent-uuid-001';
  const CONTACT_AGENT_ID = 'contact-agent-uuid-999';
  const CONTACT_ID = 'contact-001';
  const db = {
    conversations: [
      buildPautaConversation({ contact_id: CONTACT_ID }),
    ],
    conversation_messages: [
      {
        id: 'msg-c1',
        conversation_id: 'conv-pauta-1',
        direction: 'inbound',
        sender_type: 'lead',
        message_type: 'text',
        message_text: 'hola',
        created_at: hoursAgo(25),
      },
      {
        id: 'msg-c2',
        conversation_id: 'conv-pauta-1',
        direction: 'outbound',
        sender_type: 'ai_agent',
        message_type: 'text',
        message_text: 'respuesta',
        created_at: hoursAgo(24.9),
      },
    ],
    conversation_events: [],
    user_profiles: [{ id: SPECIAL_AGENT_ID, email: 'agente.especial@luxetty.com' }],
    contacts: [
      {
        id: CONTACT_ID,
        full_name: 'Juan Perez',
        assigned_agent_profile_id: CONTACT_AGENT_ID,
      },
    ],
    leads: [],
    pipeline_stages: [],
  };

  const supabase = buildMockSupabase(db);
  const sendWhatsAppText = async () => {};

  await runInactivityFollowups({
    supabase,
    sendWhatsAppText,
    authorizeAutomation: async () => ({ allowAutomatedReply: true }),
    now: new Date(),
    limit: 50,
    logger: { info: () => {}, warn: () => {} },
  });

  assert(
    db.leads.length === 0,
    'testNoPautaLeadWhenContactHasAgent: should not create lead when contact has assigned agent'
  );

  const skippedEvents = db.conversation_events.filter(
    (e) => e.type === 'pauta_lead_skipped_contact_has_agent'
  );
  assert(
    skippedEvents.length === 1,
    'testNoPautaLeadWhenContactHasAgent: should record skipped event'
  );
}

// ─── isPautaConversation unit tests ──────────────────────────────────────────

function testIsPautaConversation() {
  assert(
    isPautaConversation({ whatsapp_referral: { source_type: 'ad', ad_id: '123' } }) === true,
    'isPautaConversation: should return true with valid referral'
  );
  assert(
    isPautaConversation({ whatsapp_referral: {} }) === false,
    'isPautaConversation: should return false with empty referral object'
  );
  assert(
    isPautaConversation({ whatsapp_referral: null }) === false,
    'isPautaConversation: should return false with null referral'
  );
  assert(
    isPautaConversation({ campaign_context: { property_code: 'LUX-A0453' } }) === true,
    'isPautaConversation: should return true with campaign_context property_code'
  );
  assert(
    isPautaConversation({}) === false,
    'isPautaConversation: should return false with no referral field'
  );
  assert(
    isPautaConversation(null) === false,
    'isPautaConversation: should return false with null state'
  );
}

async function main() {
  const now = new Date();

  const baseMessages = [
    {
      direction: 'inbound',
      sender_type: 'lead',
      created_at: hoursAgo(7),
    },
    {
      direction: 'outbound',
      sender_type: 'ai_agent',
      created_at: hoursAgo(6.95),
    },
  ];

  const firstDue = getNextDueAction({
    messages: baseMessages,
    sentEvents: new Set(),
    now,
  });
  assert(firstDue?.step?.key === '1h', 'Expected 1h follow-up first');

  const secondDue = getNextDueAction({
    messages: baseMessages,
    sentEvents: new Set(['followup_1h_sent']),
    now,
  });
  assert(secondDue?.step?.key === '6h', 'Expected 6h follow-up after 1h sent');

  const twentyHourMessages = [
    {
      direction: 'inbound',
      sender_type: 'lead',
      created_at: hoursAgo(21),
    },
    {
      direction: 'outbound',
      sender_type: 'ai_agent',
      created_at: hoursAgo(20.95),
    },
  ];

  const thirdDue = getNextDueAction({
    messages: twentyHourMessages,
    sentEvents: new Set(['followup_1h_sent', 'followup_6h_sent']),
    now,
  });
  assert(thirdDue?.step?.key === '20h', 'Expected 20h follow-up after 6h sent');

  const noDueAfterUserReply = getNextDueAction({
    messages: [
      ...baseMessages,
      {
        direction: 'inbound',
        sender_type: 'lead',
        created_at: hoursAgo(0.5),
      },
    ],
    sentEvents: new Set(['followup_1h_sent']),
    now,
  });
  assert(noDueAfterUserReply === null, 'Expected no follow-up after user replied');

  const noDueAfterHuman = getNextDueAction({
    messages: [
      ...baseMessages,
      {
        direction: 'outbound',
        sender_type: 'agent',
        created_at: hoursAgo(0.5),
      },
    ],
    sentEvents: new Set(['followup_1h_sent']),
    now,
  });
  assert(noDueAfterHuman === null, 'Expected no follow-up after human outbound');

  const closeDue = getNextDueAction({
    messages: [
      {
        direction: 'inbound',
        sender_type: 'lead',
        created_at: hoursAgo(24),
      },
      {
        direction: 'outbound',
        sender_type: 'ai_agent',
        created_at: hoursAgo(23.9),
      },
    ],
    sentEvents: new Set(['followup_1h_sent', 'followup_6h_sent', 'followup_20h_sent']),
    now,
  });
  assert(closeDue?.kind === 'close', 'Expected close at 23h+');

  const outsideWindowDue = getNextDueAction({
    messages: [
      {
        direction: 'inbound',
        sender_type: 'lead',
        created_at: hoursAgo(25),
      },
      {
        direction: 'outbound',
        sender_type: 'ai_agent',
        created_at: hoursAgo(24.9),
      },
    ],
    sentEvents: new Set(),
    now,
  });
  assert(outsideWindowDue?.kind === 'close', 'Expected close action candidate at 25h');
  assert(
    isInsideWhatsAppFreeTextWindow(outsideWindowDue.ageMs) === false,
    'Expected free-text window check to be false at 25h'
  );

  const reset = resetAiStateForClosedConversation({
    lead_flow: 'demand',
    operation_type: 'sale',
    lead_id: 'lead-1',
    assigned_agent_profile_id: 'agent-1',
  });
  assert(reset.lead_flow === null, 'Expected reset lead_flow');
  assert(reset.lead_id === 'lead-1', 'Expected lead_id to be preserved');

  await testRunTwiceNoDuplicates();
  await testOutside24hCloseWithoutFreeText();
  testIsPautaConversation();
  await testPautaLeadCreatedOnClose();
  await testPautaLeadNotDuplicatedOnSecondRun();
  await testNoPautaLeadWhenContactHasAgent();

  console.log('PASS IA v1.5 follow-up smoke');
}

main().catch((err) => {
  console.error('FAIL IA v1.5 follow-up smoke', err);
  process.exit(1);
});
