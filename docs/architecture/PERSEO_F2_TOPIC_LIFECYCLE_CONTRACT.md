# PERSEO F2 — Topic Lifecycle Contract

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Estado** | CONTRATO DE DISEÑO — sin migrate / sin wire runtime |
| **Master Plan** | V2.1 §9–11, §29, Anexos J/K/O |
| **SQL drafts** | `docs/plans/sql-drafts/20260722_f2_*.sql.md` |

---

## 1. Resolver de tema (contrato)

```text
signal = detectTopicSignal(inbound)  # NEW | CONTINUE | REOPEN | AMBIGUOUS
active = topics where conversation_id=X AND lifecycle=OPEN  # max 1

if signal == CONTINUE and active:
  return active
if signal == NEW:
  pause_or_close(active) if needed → create OPEN topic (no slot inheritance)
if signal == REOPEN:
  ask confirm (1-line ref) → on confirm: set lifecycle=OPEN + emit TOPIC_REOPENED
  # NO persistent REOPENED/REOPEN_REQUESTED state
if signal == AMBIGUOUS or multi-lead:
  ask user; NO silent switch
if active is null and no create threshold:
  informational topic without lead_id OK
```

**Fail-safe:** ante duda → preguntar; no heredar presupuesto/zona/operación de otro topic/lead.

---

## 2. Lifecycle estable

| Estado | Significado |
|--------|-------------|
| `OPEN` | Tema activo (único por conversación) |
| `PAUSED` | Inactividad / pause explícita; no spamear slots |
| `CLOSED` | Cierre explícito o política; reopen solo con confirmación |
| `ARCHIVED` | Retención; no reabrir — usar topic hijo si hace falta |

**REOPEN** = eventos `TOPIC_REOPEN_REQUESTED` / `TOPIC_REOPENED` (+ transición a `OPEN`).  
Prohibido: `CLOSED → OPEN` silencioso; `ARCHIVED → OPEN`.

---

## 3. control_mode / handoff_state (máquinas separadas)

| control_mode | PERSEO |
|--------------|--------|
| `AI` | Responde |
| `HUMAN` | Silencio (salvo system/kill) |
| `MIXED` | Default OFF en V2.1 |

| handoff_state | Notas |
|---------------|-------|
| `NONE` … `EXPIRED` | Ver draft enum |
| ACCEPT/ACTIVE | Topic permanece `OPEN` o `PAUSED` — **handoff ≠ close** |
| `RETURNED_TO_AI` | Rebuild pack desde topic+events+prefs |

`HANDOFF_COMPLETED` como `closure_reason` **solo** si objetivo del tema concluido (Anexo K).

---

## 4. Ownership invariantes (P0)

1. Dueño del contacto prevalece en solicitudes activas.  
2. `topic_id` **nunca** decide ownership.  
3. Agente responsable de propiedad consultada ≠ dueño automático del contacto.  
4. Coordinación visita no cambia `lead`/`contact` owner.  
5. Reasignación solo flujo formal ATENA/DIOS/engine, auditada.  
6. RAG / planner / tools lectura **no** escriben assignment.

---

## 5. Lead idempotency — códigos de decisión (Anexo J)

| Código | Escenario | Acción |
|--------|-----------|--------|
| `LEAD_IDEMPOTENT_MSG` | `meta_message_id` / webhook retry | No write |
| `LEAD_REUSE_COMPATIBLE` | Lead abierto compatible por evidencia | Reutilizar |
| `LEAD_UPDATE_SLOTS` | Cambio presupuesto (no nueva solicitud) | Update slots |
| `LEAD_ASK_WHICH` | Dos leads activos / ambigüedad | Preguntar |
| `LEAD_NEW_TOPIC_POLICY` | Renta→compra / buyer+vende | Nuevo topic (+ lead vía gate) |
| `LEAD_NEW_AFTER_CLOSED` | Lead cerrado + nueva intención | Crear vía gate |
| `LEAD_NO_WRITE_INFORMATIONAL` | Topic informativo | No lead |
| `LEAD_NO_WRITE_PRE_THRESHOLD` | Contacto nuevo pre-umbral | No lead |
| `LEAD_LINK_ON_REOPEN` | Reopen topic con lead linked | Reutilizar lead; reconfirm slots |
| `LEAD_FORBIDDEN_RAG_WRITE` | Path RAG | No CRM write |

**No** existe regla oficial “7 días → reutilizar”. Ventanas temporales = indicador auxiliar de frescura únicamente.

---

## 6. Must-not (tests P0)

- Mezcla contactos / leads  
- Reopen silencioso CLOSED  
- Handoff ACCEPT → auto CLOSED  
- Ownership silenciosa  
- Herencia de slots cross-topic sin transición  
- Crear lead desde RAG

---

## 7. DoD diseño (esta fase)

- [x] SQL drafts forward+reverse  
- [x] Lifecycle sin estados REOPEN persistentes  
- [x] Anexo J códigos documentados  
- [ ] Firma D1–D3  
- [ ] APPLY migration (bloqueado)
