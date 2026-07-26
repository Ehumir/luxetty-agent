# PERSEO — Commercial KPI Baseline

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Master Plan** | V2.1 Anexo M |
| **Owner candidato** | ARGOS + Product (D11 UNSIGNED) |

---

## Regla de lectura

| Clase | Significado |
|-------|-------------|
| **available** | Medible hoy con tablas/eventos existentes (aunque imperfecto) |
| **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | Requiere F2/F3/F7/F9 (topics, consents ledger, visits, pack) — **no inventar** números |

---

## Matriz

| KPI (Anexo M) | Estado baseline | Fuente hoy | Nota |
|---------------|-----------------|------------|------|
| Aceptación contacto humano (`share_with_advisor`) | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | `contact_consents` (no existe) | Preferencias ≠ consent |
| Aceptación WA / llamada | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | `contact_consents` | `contact_communication_preferences` existe, **0 rows** |
| Rechazo / retiro consent | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | consents | — |
| Completitud ficha | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | topic summary | — |
| Confianza ficha | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | pack | Post F3 |
| Campos re-preguntados por asesor | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | topic_events | F2 |
| Preguntas avg pre-handoff | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | trajectory/events | F1B/F2 |
| Abandono post-pregunta | **available** (proxy débil) | conversaciones / stages | No atribuir solo a PERSEO |
| Tiempo a `CRM_READY` | **available** (proxy) | V3 stages / events si emitidos | Segmentar journey post-F2 |
| Tiempo a handoff / respuesta humana | **available** (proxy) | gatekeeper / handoff events | Formalizar con `handoff_state` F2 |
| Props mostradas / seleccionadas / comparadas | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | `conversation_topic_properties` | Hoy: `ai_state.last_shown_property_ids` legacy — no baseline oficial |
| Visitas req / conf / rej / exp | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | `visit_requests` | F9; `tasks` visit type existe pero ≠ contrato multi-asesor |
| Dossier ready / rejected | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | capture F6 | — |
| Cierres / reaperturas / recontacto | **BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT** | topic_events | F2 |
| Conversión a oportunidad | **available** (CRM) | `opportunities` | Observar; **no** atribuir exclusivo a PERSEO |
| Retrieval classification mix | **available** post-F1A deploy | `conversation_events` | Ver F1A baseline PRE quiet |
| Empty search rate (demand w/ zone) | **available** post-F1A | inventory meta en events | Observar vs spike |

---

## Seguridad vs comercial

KPIs de **seguridad** (mezcla leads, invent precio, reopen silencioso, ownership, handoff→CLOSED) parten de baseline F1A/F2 tests (=0).  
KPIs **comerciales** no deben publicarse como “baseline 0%” si la feature no está encendida — marcar `BASELINE_STARTS_AFTER_FEATURE_ENABLEMENT`.

---

## Próxima medición

1. Post deploy F1A → classification mix + empty search.  
2. Post F2 canary → props/events/handoff formales.  
3. Post consents → grants/denies.  
4. Nunca rellenar gaps con estimaciones de marketing.
