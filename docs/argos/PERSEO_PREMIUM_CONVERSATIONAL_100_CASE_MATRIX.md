# PERSEO Premium Conversational — 100 Case Matrix (ARGOS)

**Date:** 2026-07-22  
**Source:** Master Plan V2.1 — Anexo I  
**Fixtures:** `docs/argos/scenarios/ARGOS_PC_001.v1.json` … `ARGOS_PC_100.v1.json`  
**Suite:** `docs/argos/suites/argos-matrix-100-premium-conversational.json`  
**Generator:** `scripts/argos/generatePremiumConversational100.js`

## Purpose

Executable corpus (≥100) for premium conversational certification. Pre-canary release target is **100/100 PASS** (replay, CRM dry-run). Until F2/F7/F9 land, fixtures that need topic lifecycle, visits, or multimodal runtime are gated.

## Schema

Aligned to `DEMAND_002_FULL.v1.json`:

- `schema_version` `"1.0"`
- `scenario_code`, `scenario_version` `1`, `priority`, `family`, `category`, `title`, `description`
- `messages` (strings; media as `{ type, ... }`)
- `flags.deterministic_mode` + `flags.crm_dry_run` = true
- `expected` / `must_not`
- Optional `tags` + `gate` when F2+ required:
  - `EXPECTED_FAIL_PRE_F2` — runs today but expected to fail until phase
  - `NOT_RUN_REQUIRES_F2` — excluded from scored denominator until `until_phase`

## Distribution (Anexo I)

| Range | Family | Count | Notes |
| ----- | ------ | ----: | ----- |
| 1–20 | continuity / roles | 20 | Rent Cumbres, sticky break, switches, anaphora, budget, inventory, campaign, informational |
| 21–30 | ownership | 10 | Contact owner, DIOS, bypass, visit multi-asesor |
| 31–40 | handoff / control | 10 | Mostly `EXPECTED_FAIL_PRE_F2` (topic lifecycle) |
| 41–50 | lead idempotency | 10 | meta_message_id, webhook, reuse, rent→buy policy |
| 51–60 | visits | 10 | `NOT_RUN_REQUIRES_F2` until **F9** |
| 61–70 | consent / commercial | 10 | WA/call/withdraw/share; CRM_READY timing |
| 71–78 | captation | 8 | Seller dossier, no invent price/legal/publish |
| 79–90 | multimodal | 12 | `NOT_RUN` until **F7** |
| 91–100 | adversarial / tools / long | 10 | Injection, invent URL/LUX, long 20+, PROPERTY_QA |

## Gate counts (generated)

| Status | Count |
| ------ | ----: |
| RUNNABLE (no gate) | 53 |
| EXPECTED_FAIL_PRE_F2 | 23 |
| NOT_RUN_REQUIRES_F2 | 24 |
| **Total** | **100** |

## Pass-rate expectation

**Pre-F2 suite scoring**

1. **Runnable** scenarios: must **PASS** at `runnable_pass_rate = 1.0`.
2. **EXPECTED_FAIL_PRE_F2**: credited as suite success when they fail as expected (`xfail_credit: true`).
3. **NOT_RUN_REQUIRES_F2**: **excluded** from denominator until `until_phase` (F2 / F7 / F9).
4. Scored target: `scored_pass_rate = 1.0` over `runnable + EXPECTED_FAIL_PRE_F2`.

**Post-phase / pre-canary**

- After F2 + F7 + F9 capabilities: **100/100 PASS**, `pass_rate = 1.0` over all files.
- Does **not** replace independent P0 suites.

## Runnable now (do not mark EXPECTED_FAIL)

Examples intentionally ungated: demand rent/buy (e.g. PC_002), sticky offer→rent break (PC_001), buyer/seller switches, budget correction, empty inventory honesty, LUX property QA guards, captation seller flows, long conversation (PC_098), invent URL/LUX must_not (PC_096/097), adversarial injection (PC_091).

## Inventory table

| Code | Pri | Family | Category | Journey | Gate | Until | Title |
| ---- | --- | ------ | -------- | ------- | ---- | ----- | ----- |
| ARGOS_PC_001 | P0 | continuity | sticky_offer_rent_break | mixed | RUNNABLE | — | Sticky offer + break a renta |
| ARGOS_PC_002 | P0 | continuity | rent_cumbres_greeting | renter | RUNNABLE | — | Greeting + casas en renta Cumbres |
| ARGOS_PC_003 | P0 | continuity | buyer_to_seller_switch | mixed | RUNNABLE | — | Buyer → seller switch |
| ARGOS_PC_004 | P0 | continuity | seller_to_rent_demand | mixed | RUNNABLE | — | Seller → rent demand |
| ARGOS_PC_005 | P0 | continuity | two_active_leads | mixed | EXPECTED_FAIL_PRE_F2 | F2 | Dos leads activos — desambiguar |
| ARGOS_PC_006 | P0 | continuity | closed_lead_new_search | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Lead cerrado + nueva búsqueda |
| ARGOS_PC_007 | P0 | continuity | closed_topic_ambiguous | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Tema CLOSED + mensaje ambiguo |
| ARGOS_PC_008 | P0 | continuity | reopen_confirm | buyer | EXPECTED_FAIL_PRE_F2 | F2 | REOPEN — usuario confirma |
| ARGOS_PC_009 | P0 | continuity | reopen_decline | buyer | EXPECTED_FAIL_PRE_F2 | F2 | REOPEN — usuario declina |
| ARGOS_PC_010 | P0 | continuity | anaphora_la_segunda | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Anáfora “la segunda” / “esa” / “más barata” |
| ARGOS_PC_011 | P0 | continuity | budget_correction | buyer | RUNNABLE | — | Corrección de presupuesto |
| ARGOS_PC_012 | P0 | continuity | rent_to_buy | mixed | RUNNABLE | — | Renta → compra |
| ARGOS_PC_013 | P0 | continuity | zone_change | buyer | RUNNABLE | — | Cambio de zona |
| ARGOS_PC_014 | P0 | continuity | empty_inventory | renter | RUNNABLE | — | Inventory vacío — fallback honesto |
| ARGOS_PC_015 | P0 | continuity | inactive_property_post_show | buyer | RUNNABLE | — | Propiedad inactive post-show |
| ARGOS_PC_016 | P0 | continuity | price_changed_sot | buyer | RUNNABLE | — | Precio cambió en SoT |
| ARGOS_PC_017 | P0 | continuity | campaign_entity | buyer | RUNNABLE | — | Campaña / entity validation |
| ARGOS_PC_018 | P0 | continuity | new_contact | buyer | RUNNABLE | — | Contacto nuevo — umbral pre-CRM |
| ARGOS_PC_019 | P0 | continuity | existing_contact | buyer | RUNNABLE | — | Contacto existente — preserve owner |
| ARGOS_PC_020 | P0 | continuity | informational_no_lead | informational | RUNNABLE | — | Informativo sin lead + timeout awaiting field |
| ARGOS_PC_021 | P0 | ownership | existing_contact_other_property_agent | buyer | RUNNABLE | — | Contacto existente × propiedad otro asesor |
| ARGOS_PC_022 | P0 | ownership | new_contact_property | buyer | RUNNABLE | — | Contacto nuevo × propiedad |
| ARGOS_PC_023 | P0 | ownership | multi_solicitud_same_owner | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Multi-solicitud mismo owner |
| ARGOS_PC_024 | P0 | ownership | formal_reassignment | buyer | RUNNABLE | — | Reasignación formal |
| ARGOS_PC_025 | P0 | ownership | property_responsible_changes | buyer | RUNNABLE | — | Property responsible cambia |
| ARGOS_PC_026 | P0 | ownership | visit_two_advisors | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visita con 2 asesores distintos |
| ARGOS_PC_027 | P0 | ownership | perseo_infers_assignment_must_not | buyer | RUNNABLE | — | PERSEO infiere assignment (must-not) |
| ARGOS_PC_028 | P0 | ownership | tool_assignment_contradiction | buyer | RUNNABLE | — | Tool assignment contradictoria |
| ARGOS_PC_029 | P0 | ownership | dios_override | buyer | RUNNABLE | — | DIOS Mode override |
| ARGOS_PC_030 | P0 | ownership | demand_contact_owner_bypass | buyer | RUNNABLE | — | Demand contact_owner_bypass |
| ARGOS_PC_031 | P0 | handoff | handoff_requested | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Handoff REQUESTED |
| ARGOS_PC_032 | P0 | handoff | handoff_accept_human | buyer | EXPECTED_FAIL_PRE_F2 | F2 | ACCEPT → HUMAN sin CLOSED |
| ARGOS_PC_033 | P0 | handoff | advisor_reply_silence_ai | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Advisor reply — AI silencio |
| ARGOS_PC_034 | P0 | handoff | handoff_expired_no_response | buyer | EXPECTED_FAIL_PRE_F2 | F2 | No response → EXPIRED |
| ARGOS_PC_035 | P0 | handoff | returned_to_ai_context | buyer | EXPECTED_FAIL_PRE_F2 | F2 | RETURNED_TO_AI recupera contexto |
| ARGOS_PC_036 | P0 | handoff | user_msg_while_human | buyer | EXPECTED_FAIL_PRE_F2 | F2 | User msg mientras HUMAN |
| ARGOS_PC_037 | P0 | handoff | advisor_closes_topic | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Advisor cierra tema |
| ARGOS_PC_038 | P0 | handoff | topic_pause | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Pause topic |
| ARGOS_PC_039 | P0 | handoff | abandon_inactivity | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Abandono por inactividad |
| ARGOS_PC_040 | P0 | handoff | reopen_post_handoff | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Reopen post-handoff |
| ARGOS_PC_041 | P0 | lead_idempotency | meta_message_id_retry | buyer | RUNNABLE | — | meta_message_id retry |
| ARGOS_PC_042 | P0 | lead_idempotency | webhook_dup | buyer | RUNNABLE | — | Webhook duplicate |
| ARGOS_PC_043 | P0 | lead_idempotency | same_search_minutes_later | buyer | RUNNABLE | — | Misma búsqueda minutos después |
| ARGOS_PC_044 | P0 | lead_idempotency | budget_change_no_new_lead | buyer | RUNNABLE | — | Cambio presupuesto — no new lead auto |
| ARGOS_PC_045 | P0 | lead_idempotency | zone_change_idempotency | buyer | RUNNABLE | — | Cambio zona — política ask/reuse |
| ARGOS_PC_046 | P0 | lead_idempotency | rent_to_buy_new_topic_policy | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Renta→compra — new topic/lead policy |
| ARGOS_PC_047 | P0 | lead_idempotency | buyer_plus_sells | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Buyer + vende |
| ARGOS_PC_048 | P0 | lead_idempotency | new_specific_property | buyer | RUNNABLE | — | Nueva propiedad específica |
| ARGOS_PC_049 | P0 | lead_idempotency | closed_lead_idempotency | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Lead cerrado — nueva intención |
| ARGOS_PC_050 | P0 | lead_idempotency | two_leads_ask_campaign_qa_crm | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Dos leads / campaña / qa_crm_force / dry-run / RAG no write |
| ARGOS_PC_051 | P0 | visits | visit_request_draft | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit request draft |
| ARGOS_PC_052 | P0 | visits | visit_pending | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit pending |
| ARGOS_PC_053 | P0 | visits | visit_confirm_human | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit confirm humano |
| ARGOS_PC_054 | P0 | visits | visit_reject | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit reject |
| ARGOS_PC_055 | P0 | visits | visit_reschedule | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit reschedule |
| ARGOS_PC_056 | P0 | visits | visit_expire_sla | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit expire SLA |
| ARGOS_PC_057 | P0 | visits | visit_multi_property_agents | buyer | NOT_RUN_REQUIRES_F2 | F9 | Multi-property distinct agents |
| ARGOS_PC_058 | P0 | visits | visit_confirm_ne_attend | buyer | NOT_RUN_REQUIRES_F2 | F9 | Confirm ≠ attend |
| ARGOS_PC_059 | P0 | visits | visit_cancel_owner | buyer | NOT_RUN_REQUIRES_F2 | F9 | Cancel por owner |
| ARGOS_PC_060 | P0 | visits | visit_never_auto_confirm | buyer | NOT_RUN_REQUIRES_F2 | F9 | Never auto-confirm copy |
| ARGOS_PC_061 | P1 | consent | wa_consent_yes | buyer | RUNNABLE | — | WhatsApp consent yes |
| ARGOS_PC_062 | P1 | consent | wa_consent_no | buyer | RUNNABLE | — | WhatsApp consent no |
| ARGOS_PC_063 | P1 | consent | call_decline | buyer | RUNNABLE | — | Call decline |
| ARGOS_PC_064 | P1 | consent | consent_withdraw | buyer | RUNNABLE | — | Consent withdraw |
| ARGOS_PC_065 | P1 | consent | share_advisor | buyer | RUNNABLE | — | Share with advisor grant |
| ARGOS_PC_066 | P1 | consent | visit_consent_missing | buyer | NOT_RUN_REQUIRES_F2 | F9 | Visit consent missing |
| ARGOS_PC_067 | P1 | consent | preferences_ne_consent | buyer | RUNNABLE | — | Preferences ≠ consent |
| ARGOS_PC_068 | P1 | consent | handoff_without_call_grant | buyer | EXPECTED_FAIL_PRE_F2 | F2 | Handoff sin call grant |
| ARGOS_PC_069 | P1 | consent | consent_reconfirm | buyer | RUNNABLE | — | Reconfirm consent |
| ARGOS_PC_070 | P1 | consent | incomplete_ficha_crm_ready_timing | buyer | RUNNABLE | — | Ficha incompleta / CRM_READY timing |
| ARGOS_PC_071 | P1 | captation | dossier_ready | seller | RUNNABLE | — | Captación dossier ready |
| ARGOS_PC_072 | P1 | captation | missing_fields | seller | RUNNABLE | — | Captación missing fields |
| ARGOS_PC_073 | P1 | captation | conflicted_price | seller | RUNNABLE | — | Conflicted price |
| ARGOS_PC_074 | P1 | captation | inferred_ne_fact | seller | RUNNABLE | — | Inferred ≠ fact |
| ARGOS_PC_075 | P1 | captation | human_reject_dossier | seller | EXPECTED_FAIL_PRE_F2 | F2 | Human reject dossier |
| ARGOS_PC_076 | P1 | captation | docs_sensitive | seller | RUNNABLE | — | Docs sensitive |
| ARGOS_PC_077 | P1 | captation | no_legal_title_claim | seller | RUNNABLE | — | No legal title claim |
| ARGOS_PC_078 | P1 | captation | no_publish | seller | RUNNABLE | — | No publish incomplete |
| ARGOS_PC_079 | P1 | multimodal | image_ok | mixed | NOT_RUN_REQUIRES_F2 | F7 | Image ok |
| ARGOS_PC_080 | P1 | multimodal | image_blur | mixed | NOT_RUN_REQUIRES_F2 | F7 | Image blur |
| ARGOS_PC_081 | P1 | multimodal | image_id_doc | mixed | NOT_RUN_REQUIRES_F2 | F7 | ID doc image |
| ARGOS_PC_082 | P1 | multimodal | escritura_lookalike | mixed | NOT_RUN_REQUIRES_F2 | F7 | Escritura lookalike |
| ARGOS_PC_083 | P1 | multimodal | prompt_injection_image | mixed | NOT_RUN_REQUIRES_F2 | F7 | Prompt injection via image |
| ARGOS_PC_084 | P1 | multimodal | audio_ok | mixed | NOT_RUN_REQUIRES_F2 | F7 | Audio ok |
| ARGOS_PC_085 | P1 | multimodal | audio_low_conf_budget | mixed | NOT_RUN_REQUIRES_F2 | F7 | Audio low-conf budget |
| ARGOS_PC_086 | P2 | multimodal | audio_contradicts_text | mixed | NOT_RUN_REQUIRES_F2 | F7 | Audio contradice texto |
| ARGOS_PC_087 | P2 | multimodal | audio_multi_topic | mixed | NOT_RUN_REQUIRES_F2 | F7 | Audio multi-topic |
| ARGOS_PC_088 | P2 | multimodal | image_post_closed | mixed | NOT_RUN_REQUIRES_F2 | F7 | Image post-CLOSED |
| ARGOS_PC_089 | P2 | multimodal | media_retention | mixed | NOT_RUN_REQUIRES_F2 | F7 | Media retention policy |
| ARGOS_PC_090 | P2 | multimodal | media_cost_timeout | mixed | NOT_RUN_REQUIRES_F2 | F7 | Media cost / timeout |
| ARGOS_PC_091 | P2 | adversarial | prompt_injection_text | informational | RUNNABLE | — | Prompt injection text |
| ARGOS_PC_092 | P2 | adversarial | cross_contact_data_ask | informational | RUNNABLE | — | Cross-contact data ask |
| ARGOS_PC_093 | P2 | adversarial | tool_timeout | buyer | RUNNABLE | — | Tool timeout |
| ARGOS_PC_094 | P2 | adversarial | tool_error | buyer | RUNNABLE | — | Tool error |
| ARGOS_PC_095 | P2 | adversarial | empty_rag_sql_ok | buyer | RUNNABLE | — | Empty RAG + SQL ok |
| ARGOS_PC_096 | P2 | adversarial | invent_url | buyer | RUNNABLE | — | Must-not invent URL |
| ARGOS_PC_097 | P2 | adversarial | invent_lux | buyer | RUNNABLE | — | Must-not invent LUX |
| ARGOS_PC_098 | P2 | adversarial | long_20_plus_turns | buyer | RUNNABLE | — | Long conversation 20+ turns |
| ARGOS_PC_099 | P2 | adversarial | planner_loop_questions | buyer | RUNNABLE | — | Planner loop questions |
| ARGOS_PC_100 | P2 | adversarial | pack_fail_closed_property_qa | buyer | RUNNABLE | — | Pack fail-closed PROPERTY_QA |

## Regeneration

```bash
node scripts/argos/generatePremiumConversational100.js
```

Overwrites the 100 JSON fixtures, suite file, and this document.

## Prohibitions

- No production runtime changes from this corpus alone.
- No CRM writes (`crm_dry_run: true`).
- No `public.requests`.
- No invent property/price/link.
- Handoff must not auto-close topic (asserted in handoff family).
- Visits never auto-confirm.

---

*Generated 2026-07-22 from Anexo I.*
