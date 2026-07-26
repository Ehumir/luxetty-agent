# PERSEO RAG — F2 SQL Draft Review (sin aplicar)

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Ubicación** | `docs/plans/sql-drafts/` |
| **Regla** | **DO_NOT_APPLY** — no mover a `supabase/migrations/` |

## Tabla de drafts

| Draft | Estado | Problemas | Corrección requerida | Listo para implementar |
|-------|--------|-----------|----------------------|------------------------|
| `20260722_f2_conversation_topics.sql.md` | REVIEW_OK_CONCEPTUAL | Enums lifecycle estables OK; falta política RLS detallada por rol agente; confirmar `control_mode`/`handoff_state` vs AI control legacy en `ai_state` | Completar policies SELECT para agents vía contact ownership; dual-read `ai_state` documentado | **NO** (falta review Dir + firma D1) |
| `20260722_f2_conversation_topic_events.sql.md` | REVIEW_OK_CONCEPTUAL | metadata_redacted OK; definir TTL/particionado | Añadir índice (topic_id, created_at); retención CONFIG_CANDIDATE | **NO** |
| `20260722_f2_conversation_topic_properties.sql.md` | REVIEW_OK_CONCEPTUAL | relationship_type enums a validar vs dominio; snapshot ≠ SoT precio | Unique parcial ACTIVE; precio live siempre SoT en app | **NO** |
| `20260722_f2_topic_search_preferences.sql.md` | REVIEW_OK_CONCEPTUAL | Historiales budget/zona append-only | Versionado + expires_at | **NO** |
| `20260722_f2_contact_consents.sql.md` | REVIEW_OK_CONCEPTUAL | Separado de preferences — correcto | Propósitos enum; evidence_message_id FK | **NO** |
| Visit / media / approval | FUERA DE F2 | Correctamente omitidos | — | N/A F2 |

## Checks transversales

| Check | Resultado |
|-------|-----------|
| No dependencia `public.requests` | OK |
| Ownership no en tablas topic | OK (Anexo O en app) |
| Unique un OPEN por conversation | Presente en draft topics |
| Reverse SQL | Presente conceptualmente en README/drafts |
| Lock risk | CREATE TYPE + CREATE TABLE — planear offline / bajo carga |
| Backfill histórico automático | Prohibido / no incluido — OK |
| Dual-read | Documentado en Master Plan; no SQL activo |
| RLS | Borrador service_role + agent select — **ampliar antes de apply** |

## Veredicto drafts

```text
F2_SQL_DRAFTS_REVIEW = PASS_CONCEPTUAL
F2_SQL_READY_TO_APPLY = NO
```
