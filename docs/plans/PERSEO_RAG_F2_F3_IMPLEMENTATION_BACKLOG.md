# PERSEO RAG — F2 / F3 Implementation Backlog

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Master Plan** | V2.1 Anexo F |
| **Estado** | Backlog de diseño — **NO iniciar** hasta `IMPLEMENTATION_READY` |
| **Gates** | F0B evidencia + F1A baseline + D1–D3 firmados + contratos revisados |

```text
IMPLEMENTATION_READY = NO
F2_GO_RECOMMENDATION = NO-GO
F3_GO_RECOMMENDATION = NO-GO
```

---

## Sprint map

### F2-DB — Schema (ATENA migrations; DO_NOT_APPLY hoy)

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-DB-01 | `conversation_topics` + enums lifecycle/control/handoff | Unique 1 OPEN; RLS; comments; reverse SQL |
| F2-DB-02 | `conversation_topic_events` append-only | Trigger no mutation; índices |
| F2-DB-03 | `conversation_topic_properties` | Unique ACTIVE; dual-read plan vs `ai_state` |
| F2-DB-04 | `topic_search_preferences` + budget/zone history | No KV crítico |
| F2-DB-05 | `contact_consents` | Distinto de preferences |
| F2-DB-06 | Dry-run + advisors + rollback drill | Evidencia ARGOS |

### F2-PERSEO — Topic service

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-P-01 | Topic resolver NEW/CONTINUE/REOPEN/AMBIGUOUS | Suites roles; silent reopen=0 |
| F2-P-02 | Emit topic events en transiciones | Audit close/reopen/handoff |
| F2-P-03 | Properties write path | “la segunda” ranking OK |
| F2-P-04 | Prefs + history on slot correct | SLOT_CORRECTED event |
| F2-P-05 | Flags `PERSEO_TOPIC_*` default OFF | Kill switch |
| F2-P-06 | Handoff≠close wiring | Anexo K tests |

### F2-ATENA UI

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-UI-01 | Mostrar lifecycle/control/handoff/lead | ConversationsPage |
| F2-UI-02 | Take control / return to AI | role_id + telemetría |
| F2-UI-03 | Pause/close/reopen actions | Events visibles |
| F2-UI-04 | Properties SHOWN/ACTIVE/REJECTED | Sin cards hero-noise; AtenaViewShell |

### F2-ARGOS

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-A-01 | Suites P0 topics (Anexo I 1–40) | 100/100 pre-canary subset runnable |
| F2-A-02 | KPI topic close/reopen/handoff | Dash |
| F2-A-03 | Must-not ownership + mix leads | =0 |

### F2-LEAD

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-L-01 | Decision codes Anexo J en `createOrReuseLeadFromConversation` | Códigos emitidos |
| F2-L-02 | Tests idempotency meta_message_id / multi-lead ask | dup webhook=0 |
| F2-L-03 | Prohibir write desde RAG path | Assert |

### F2-OWNERSHIP

| ID | Trabajo | DoD |
|----|---------|-----|
| F2-O-01 | Invariantes Anexo O + tests demand ownership | silent reassign=0 |
| F2-O-02 | Property interest ≠ ownership | topic_properties only |

---

### F3-SCHEMA — Pack contract

| ID | Trabajo | DoD |
|----|---------|-----|
| F3-S-01 | Types/constants `TurnContextPackV1` | Ya scaffolding |
| F3-S-02 | Contract tests fail-closed | Ya scaffolding |
| F3-S-03 | JSON schema opcional | Si se adopta |

### F3-BUILDER

| ID | Trabajo | DoD |
|----|---------|-----|
| F3-B-01 | `turnContextPack.js` builder | Hydration order §contract |
| F3-B-02 | Dual-read topic null degrade | Flag |
| F3-B-03 | Redaction + size budget | truncations metrica |

### F3-RUNTIME

| ID | Trabajo | DoD |
|----|---------|-----|
| F3-R-01 | Wire builder en V3 path detrás de flag | **No** en esta fase docs |
| F3-R-02 | Fail-closed blocks outbound unsafe claims | PROPERTY_QA etc |
| F3-R-03 | Consume pack en planner/composer | Sin legacy-only |

### F3-ARGOS

| ID | Trabajo | DoD |
|----|---------|-----|
| F3-A-01 | Pack valid % comercial | ≥95% canary cand. |
| F3-A-02 | Cases ambiguous lead / PROPERTY_QA | PASS |

### F3-ROLLOUT

| ID | Trabajo | DoD |
|----|---------|-----|
| F3-RO-01 | Allowlist → canary journey → global | 0 P0 |
| F3-RO-02 | Kill switch OFF | Rollback <5 min |

---

## Definition of Done — programa F2+F3

1. Migraciones aplicadas solo tras GO + reverse probado.  
2. 1 OPEN/conversación enforced.  
3. Handoff ACCEPT no cierra topic.  
4. Lead codes Anexo J en prod path.  
5. Ownership P0 PASS.  
6. Pack mandatory canary métrica verde.  
7. ARGOS evidencias archivadas.  
8. Flags documentados; plaintext prod verificado por humano.

---

## Referencias

- `PERSEO_RAG_DIRECTION_DECISIONS.md` (UNSIGNED)  
- `PERSEO_F2_TOPIC_LIFECYCLE_CONTRACT.md`  
- `PERSEO_F3_TURNCONTEXTPACK_CONTRACT.md`  
- `sql-drafts/README.md`
