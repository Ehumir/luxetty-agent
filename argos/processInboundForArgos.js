'use strict';

const v3InboundBridge = require('../conversation/v3/core/v3InboundBridge');
const { setSession, getSession, clearSession } = require('../conversation/v3/core/sessionStore');
const { getPerseoV3Config } = require('../config/perseoV3Flags');
const { evaluateV3CrmExecutionGate } = require('../conversation/v3/crm/executionGate');
const { createArgosNoWriteSupabase } = require('./argosNoWriteSupabase');
const { createArgosTrace, traceEvent, flushTrace } = require('./argosTrace');
const { buildConversationSnapshot } = require('./conversationSnapshot');
const { applyInboundSourceToAiState } = require('../conversation/inboundSourceClassifier');
const { buildTechnicalPanel } = require('./technicalPanelBuilder');
const { previewCrmPipeline } = require('./previewCrmPipeline');
const { isDeterministicMode, applyArgosSimulationEnv } = require('./deterministicMode');
const { collectCrmGateBlockers } = require('./crmGateDiagnostics');
const {
  ARGOS_MAX_ASSISTANT_REPLIES_CONSECUTIVE,
  ARGOS_ERROR_CODES,
} = require('./constants');
const {
  createSession,
  getSession: getArgosSession,
  updateSession,
  appendTranscript,
} = require('./argosSessionStore');
const {
  mergeReplyText,
  normalizeOutboundSignature,
} = require('../conversation/antiLoopGuardrails');
const { resolveArgosLegacyHydration, resolveArgosLegacyHydrationAsync } = require('./propertyFixtures');
const { executeV3CrmIfEligible } = require('../conversation/v3/crm/crmExecutor');
const { isCrmRuntimePersistentEnabled } = require('../config/perseoM401Flags');

function argosConversationId(session_id) {
  return `argos:${session_id}`;
}

function checkAntiLoop(session, reply) {
  const text = mergeReplyText(reply);
  const sig = normalizeOutboundSignature(text);
  if (session.last_outbound_signature && session.last_outbound_signature === sig) {
    session.assistant_replies_consecutive = (session.assistant_replies_consecutive || 0) + 1;
  } else {
    session.assistant_replies_consecutive = 1;
  }
  session.last_outbound_signature = sig;
  if (session.assistant_replies_consecutive >= ARGOS_MAX_ASSISTANT_REPLIES_CONSECUTIVE) {
    return { loop: true, code: ARGOS_ERROR_CODES.LOOP_DETECTED };
  }
  return { loop: false };
}

/**
 * @param {{
 *   session_id?: string,
 *   phone_sim: string,
 *   text: string,
 *   flags?: object,
 *   supabaseRaw?: object,
 *   scenarioSetup?: object,
 *   logEvent?: Function,
 *   media?: object|null,
 * }} input
 */
async function processInboundForArgos(input) {
  const trace = createArgosTrace();
  const flags = input.flags || {};
  const argosEnv = applyArgosSimulationEnv(flags);
  let session_id = input.session_id;

  try {
    return await processInboundForArgosCore(input, trace, flags, argosEnv);
  } finally {
    argosEnv.restore();
  }
}

async function processInboundForArgosCore(input, trace, flags, argosEnv) {
  let session_id = input.session_id;

  traceEvent(trace, {
    type: 'argos_turn_started',
    phase: 'gate',
    payload: { session_id: session_id || null, turn: null },
  });
  traceEvent(trace, {
    type: 'argos_enabled',
    phase: 'gate',
    visibility: 'debug',
    payload: { enabled: true },
  });

  let session = session_id ? getArgosSession(session_id) : null;
  if (!session) {
    session = createSession({ phone_sim: input.phone_sim, flags });
    session_id = session.session_id;
  }

  session.turn_count = (session.turn_count || 0) + 1;
  traceEvent(trace, {
    type: 'argos_turn_started',
    phase: 'gate',
    payload: { session_id, turn: session.turn_count },
  });

  appendTranscript(session_id, { role: 'user', text: input.text });

  if (isDeterministicMode(flags)) {
    traceEvent(trace, {
      type: 'deterministic_mode',
      phase: 'gate',
      visibility: 'debug',
      payload: { active: true },
    });
  }
  traceEvent(trace, {
    type: 'argos_simulation_env',
    phase: 'gate',
    visibility: 'debug',
    payload: { v3_handoff_enabled: argosEnv.handoffEnabled },
  });

  const conversationId = argosConversationId(session_id);
  const priorState = getSession(conversationId);
  let legacyHydration = resolveArgosLegacyHydration({
    setup: input.scenarioSetup,
    text: input.text,
    persistedPropertyCode: priorState?.propertyListingCode || null,
  });
  if (input.supabaseRaw && !legacyHydration?.activeProperty?.id) {
    legacyHydration =
      (await resolveArgosLegacyHydrationAsync(
        {
          setup: input.scenarioSetup,
          text: input.text,
          persistedPropertyCode: priorState?.propertyListingCode || null,
        },
        input.supabaseRaw
      )) || legacyHydration;
  }

  // Premium consultivo: mismas opciones reales que producción (SQL + flags), vía ARGOS.
  if (input.supabaseRaw) {
    try {
      const { resolveInventoryOptionsForTurn } = require('../services/inventoryOptionsTurn');
      const inv = await resolveInventoryOptionsForTurn({
        db: input.supabaseRaw,
        text: input.text,
        phone: input.phone_sim,
        previousAiState: {
          operation_type: priorState?.operationType || null,
          location_text: priorState?.locationText || null,
          budget_max: priorState?.budget ?? null,
          bedrooms: priorState?.bedrooms ?? null,
          lead_flow: priorState?.leadFlow || null,
          conversation_goal: priorState?.conversationGoal || null,
        },
        logger: console,
      });
      if (inv) {
        legacyHydration = {
          ...(legacyHydration || {}),
          matchedOptions: inv.matchedOptions || [],
          inventorySearchMeta: inv.inventorySearchMeta || null,
        };
        traceEvent(trace, {
          type: 'inventory_options_search',
          phase: 'hydration',
          visibility: 'event',
          payload: {
            count: (inv.matchedOptions || []).length,
            source: inv.inventorySearchMeta?.source || null,
            empty: !!inv.inventorySearchMeta?.emptyAfterSearch,
            operation: inv.inventorySearchMeta?.operation || null,
          },
        });
      }
    } catch (invErr) {
      traceEvent(trace, {
        type: 'inventory_options_search_error',
        phase: 'hydration',
        visibility: 'debug',
        payload: { error: String(invErr?.message || invErr) },
      });
    }

    // Comparables SoT cuando hay activeProperty + intención de comparar / QA.
    try {
      const ap = legacyHydration?.activeProperty;
      const wantsCompare = /\b(compar|similar|parecid|otras?\s+opciones?)\b/i.test(String(input.text || ''));
      if (ap?.id && wantsCompare) {
        const { findComparables } = require('../services/comparablesService');
        const cmp = await findComparables(input.supabaseRaw, { activeProperty: ap, limit: 3 }, console);
        if (cmp.options?.length) {
          legacyHydration = {
            ...(legacyHydration || {}),
            matchedComparables: cmp.options,
          };
        }
      }
    } catch (cmpErr) {
      traceEvent(trace, {
        type: 'comparables_search_error',
        phase: 'hydration',
        visibility: 'debug',
        payload: { error: String(cmpErr?.message || cmpErr) },
      });
    }

    // Tool-calling consultivo (flag OFF por defecto).
    try {
      const { runConsultiveTools, isConsultiveToolsEffectiveForUser } = require('../conversation/v3/planner/consultiveToolsPlanner');
      if (isConsultiveToolsEffectiveForUser(input.phone_sim)) {
        const toolsOut = await runConsultiveTools({
          db: input.supabaseRaw,
          text: input.text,
          phone: input.phone_sim,
          state: {
            ...(priorState || {}),
            activeProperty: legacyHydration?.activeProperty || priorState?.activeProperty,
            locationText: priorState?.locationText,
            ragContextPack: legacyHydration?.ragContextPack || priorState?.ragContextPack,
          },
          logger: console,
        });
        if (toolsOut.toolsCalled.length) {
          const r = toolsOut.results;
          legacyHydration = {
            ...(legacyHydration || {}),
            consultiveTools: toolsOut,
            matchedComparables:
              r.get_comparables?.options || legacyHydration?.matchedComparables || undefined,
            matchedOptions:
              r.search_inventory_options?.matchedOptions || legacyHydration?.matchedOptions || undefined,
            inventorySearchMeta:
              r.search_inventory_options?.inventorySearchMeta ||
              legacyHydration?.inventorySearchMeta ||
              undefined,
            zoneContext: r.get_zone_context || undefined,
          };
          traceEvent(trace, {
            type: 'consultive_tools',
            phase: 'hydration',
            visibility: 'event',
            payload: { tools: toolsOut.toolsCalled },
          });
        }
      }
    } catch (toolErr) {
      traceEvent(trace, {
        type: 'consultive_tools_error',
        phase: 'hydration',
        visibility: 'debug',
        payload: { error: String(toolErr?.message || toolErr) },
      });
    }
  }

  const v3Result = await v3InboundBridge.tryV3PrimaryReply({
    conversationId,
    phone: input.phone_sim,
    text: input.text,
    media: input.media ?? null,
    argosMode: true,
    legacyHydration,
    logEvent: (type, payload) => {
      traceEvent(trace, { type, phase: 'v3', payload, visibility: 'event' });
    },
  });

  traceEvent(trace, {
    type: 'v3_primary_gate',
    phase: 'gate',
    visibility: 'debug',
    payload: {
      allowlist_match: v3Result.gate?.allowlist_match,
      argos_mode: v3Result.gate?.argos_mode,
      v3_primary_allowed: v3Result.gate?.v3_primary_allowed,
    },
  });

  traceEvent(trace, {
    type: 'whatsapp_blocked',
    phase: 'safety',
    visibility: 'debug',
    payload: { reason: 'argos_mode' },
  });

  if (v3Result.guard) {
    traceEvent(trace, {
      type: 'rule_guard_result',
      phase: 'guard',
      visibility: 'debug',
      source: { module: 'conversation/v3/rules/ruleGuard', fn: 'evaluateRuleGuard' },
      payload: v3Result.guard,
    });
  }

  if (v3Result.decision) {
    traceEvent(trace, {
      type: 'parser_winner',
      phase: 'parser',
      visibility: 'debug',
      source: { module: 'conversation/v3/interpreter/minimalInterpreter', fn: 'interpretUserMessage' },
      payload: {
        detected_intent: v3Result.decision.detectedIntent,
        confidence: v3Result.decision.confidence,
        explicit_flow_switch: v3Result.decision.explicitFlowSwitch,
      },
    });
  }

  const pcl = v3Result.policyCrossLayer;
  if (pcl?.segments) {
    traceEvent(trace, {
      type: 'segments',
      phase: 'understanding',
      visibility: 'debug',
      payload: { segments: pcl.segments },
    });
  }
  if (pcl?.responsePlan) {
    traceEvent(trace, {
      type: 'response_plan',
      phase: 'understanding',
      visibility: 'debug',
      payload: { plan: pcl.responsePlan },
    });
  }
  if (pcl?.policyResult) {
    traceEvent(trace, {
      type: 'policy_decision',
      phase: 'policy',
      visibility: 'debug',
      payload: pcl.policyResult,
    });
  }
  if (v3Result.mediaIntake) {
    traceEvent(trace, {
      type: 'media_intake',
      phase: 'media',
      visibility: 'debug',
      payload: v3Result.mediaIntake,
    });
  }

  let reply = 'No pude procesar tu mensaje en este momento.';
  let v3State = v3Result.v3State || getSession(conversationId);

  if (v3Result.handled && v3Result.reply) {
    reply = v3Result.reply;
    if (v3Result.v3State) {
      v3State = v3Result.v3State;
      setSession(conversationId, v3State);
      traceEvent(trace, {
        type: 'state_transition',
        phase: 'v3',
        visibility: 'debug',
        source: { module: 'conversation/v3/core/v3Runtime', fn: 'processV3Turn' },
        payload: {
          conversation_stage: v3State.conversationStage,
          handoff_stage: v3State.handoffStage,
          advisor_contact_consent: v3State.advisorContactConsent,
          qualification_complete: v3State.qualificationComplete,
          crm_payload_ready: v3State.crmPayloadReady,
        },
      });
    }
  } else if (v3State) {
    reply = '¿En qué puedo ayudarte con tu búsqueda o propiedad?';
  }

  const loopCheck = checkAntiLoop(session, reply);
  if (loopCheck.loop) {
    const flushed = flushTrace(trace);
    return {
      session_id,
      error_code: loopCheck.code,
      message: 'Anti-loop: identical consecutive assistant replies',
      conversation_snapshot: buildConversationSnapshot(v3State, session.legacy_ai_state),
      events: flushed.events,
      debug_trace: flushed.debug_trace,
    };
  }

  appendTranscript(session_id, { role: 'assistant', text: reply });
  updateSession(session_id, session);

  const cfg = getPerseoV3Config();
  const crmGate = evaluateV3CrmExecutionGate({
    state: v3State || {},
    phone: input.phone_sim,
    argosMode: true,
    argosPreview: true,
  });

  traceEvent(trace, {
    type: 'crm_gate_blockers',
    phase: 'gate',
    visibility: 'debug',
    payload: collectCrmGateBlockers(v3State || {}, {
      phone: input.phone_sim,
      argosMode: true,
      argosPreview: true,
    }),
  });

  const gates = {
    argos_enabled: true,
    v3_primary_allowed: !!v3Result.gate?.v3_primary_allowed,
    crm_execution_eligible: crmGate.eligible,
    crm_skip_reason: crmGate.eligible ? null : crmGate.reason,
  };

  // Deterministic ARGOS: skip async runtime writes, but keep CRM dry-run preview for gate tests.
  const skipCrmRuntimeSideEffects = isDeterministicMode(flags);

  let crm_runtime_out = null;
  if (!skipCrmRuntimeSideEffects && isCrmRuntimePersistentEnabled() && v3State) {
    const supabaseRaw = input.supabaseRaw;
    crm_runtime_out = await executeV3CrmIfEligible({
      v3State,
      phone: input.phone_sim,
      conversationRow: { id: conversationId },
      supabase: supabaseRaw ? createArgosNoWriteSupabase(supabaseRaw) : null,
      argosMode: true,
      crmDryRun: flags.crm_dry_run !== false,
      logEvent: (type, payload) => traceEvent(trace, { type, phase: 'crm_runtime', payload }),
    });
    if (crm_runtime_out?.v3State) {
      v3State = crm_runtime_out.v3State;
      setSession(conversationId, v3State);
    }
  }

  let crm_dry_run = null;
  if (flags.crm_dry_run !== false && v3State && crmGate.eligible) {
    const supabaseRaw = input.supabaseRaw;
    if (supabaseRaw) {
      const supabase = createArgosNoWriteSupabase(supabaseRaw);
      crm_dry_run = await previewCrmPipeline({
        v3State,
        phone_sim: input.phone_sim,
        sessionMeta: {
          contact_id: session.contact_id,
          lead_id: session.lead_id,
          qa_crm_force_new_lead: session.qa_crm_force_new_lead,
          conversation_id: conversationId,
        },
        supabase,
        trace,
      });
      traceEvent(trace, {
        type: 'crm_preview_completed',
        phase: 'crm_preview',
        payload: { skipped: crm_dry_run.skipped },
      });
    }
  }

  session.legacy_ai_state = applyInboundSourceToAiState(session.legacy_ai_state || {}, {
    messageText: input.text,
    aiState: session.legacy_ai_state || {},
    referral: input.referral || null,
    rawPayload: input.raw_payload || null,
  });
  updateSession(session_id, session);

  const conversation_snapshot = buildConversationSnapshot(v3State, session.legacy_ai_state);
  const technical_panel = buildTechnicalPanel({
    v3State,
    legacyAiState: session.legacy_ai_state,
    crmDryRun: crm_dry_run,
    gates,
  });

  const flushed = flushTrace(trace);
  return {
    session_id,
    reply,
    conversation_snapshot,
    technical_panel,
    crm_dry_run,
    gates,
    events: flushed.events,
    debug_trace: flushed.debug_trace,
  };
}

function resetArgosV3Session(session_id) {
  clearSession(argosConversationId(session_id));
}

module.exports = {
  processInboundForArgos,
  resetArgosV3Session,
  argosConversationId,
};
