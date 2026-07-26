# PERSEO F3 — TurnContextPack Contract

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Estado** | CONTRATO + scaffolding types — **NOT wired** a `index.js` / `v3/index.js` |
| **Depende de** | F2 `active_topic_id` real para pack comercial completo |
| **Código** | `conversation/v3/context/turnContextPack.types.js` |

---

## 1. Principio

Un único objeto versionado `TurnContextPackV1` alimenta planner/composer/tools.  
**Prohibido** seguir creciendo `legacyHydration` ad-hoc como contrato oficial.

Orden de implementación: **diseñar F2∧F3 juntos → persistir F2 → builder F3 obligatorio**.

---

## 2. Fuentes (hidratación)

| Orden | Fuente | Campos típicos |
|------:|--------|----------------|
| 1 | Identity / conversation | `conversationId`, `contactId`, `channel`, `currentTurnId` |
| 2 | Topic / lead (F2) | `topic.activeTopicId`, lifecycle, control, handoff, `leadId` |
| 3 | History A/B/C | `history.activeTopicSummary`, ventana msgs |
| 4 | Intent / slots | `intent.primary`, confirmed/missing |
| 5 | SQL SoT | `inventory` **XOR** `propertyContext.activeProperty` |
| 6 | Location Intelligence | zone canonical |
| 7 | RAG | narrative cites (no precio/URL) |
| 8 | Tools plan | lectura N1 |
| 9 | Policy | `mustNot`, claim plan |
| 10 | Freshness | flags degrade / expires |

---

## 3. Fail-closed (obligatorio)

| Condición | Comportamiento |
|-----------|----------------|
| `PROPERTY_QA` sin `activeProperty` / property id | Pack **inválido** — no claims de precio/URL; pedir aclaración |
| Lead ambiguo (2+ activos / ask which) | No `leadId` efectivo; `decision_codes` include ask; no CRM write |
| Precio / URL / LUX sin SoT | Bloquear claim |
| Visita confirm copy | Bloquear sin HITL |
| Campaña / legal sin evidencia | Degradar / mustNot |
| `control_mode=HUMAN` | Pack puede build; outbound AI bloqueado |
| Topic CLOSED + inbound sin reopen confirm | No asociar media/slots al topic cerrado |

Validación mínima: `validateTurnContextPackMinimal` (unit, fail-closed).

---

## 4. Degradación (permitida)

| Señal | Flag en pack | Planner |
|-------|--------------|---------|
| RAG down / timeout | `degrade.rag` | inventory/SoT only |
| Comparables down | `degrade.comparables` | skip compare |
| Zone LI down | `degrade.zone` | pedir zona / raw |
| Media down | `degrade.media` | no claims inferidos |
| Journey prefs missing | `degrade.journey` | discovery questions |
| Topic not yet migrated | `topic.activeTopicId=null` + `degrade.topic` | dual-read ai_state (transitional) |

Degradación ≠ inventar hechos.

---

## 5. Versionado / tamaño

- `version: 'TurnContextPackV1'`  
- Max serializado redactado: **CONFIG_CANDIDATE ~32KB**  
- History token budget: CONFIG_CANDIDATE post-F1A  

---

## 6. Wiring status

| Artefacto | Estado |
|-----------|--------|
| `turnContextPack.types.js` | Scaffolding OK |
| `turnContextPack.contract.test.js` | Unit fail-closed OK |
| `turnContextPack.js` builder | **No creado / no requerido en este pack** |
| Import desde `index.js` / `conversation/v3/index.js` | **PROHIBIDO en esta fase** |

---

## 7. DoD F3 runtime (futuro)

- Builder produce pack en path V3  
- Validación fail-closed en canary ≥95% turnos comerciales  
- ARGOS asserts PROPERTY_QA / ambiguous lead  
- Flag `PERSEO_PACK_MANDATORY` default false → canary → global
