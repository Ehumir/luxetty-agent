# SQL drafts F2 — DO_NOT_APPLY

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Proyecto Supabase** | Luxetty `pjoxytwsvbeoivppczdx` (validado: tablas F2 **no** existen) |
| **Estado** | Borradores de diseño |

## Reglas

1. **`DO_NOT_APPLY`** — estos archivos son Markdown con SQL de referencia. **No** ejecutar en producción, staging ni `supabase db push` sin GO explícito de fase F2 + firma D1–D3.  
2. **ADVERTENCIA:** todo CREATE/ALTER aquí es **modificación de esquema**.  
3. Orden sugerido de apply futuro: topics → events → topic_properties → search_preferences (+ histories) → contact_consents.  
4. Cada archivo incluye **forward** y **reverse** SQL.  
5. Escritor runtime previsto: PERSEO service_role / topic service. Lector: ATENA UI vía RLS ownership, ARGOS admin.  
6. No indexar conversaciones en Knowledge Store.  
7. Preferir estados lifecycle estables: `OPEN | PAUSED | CLOSED | ARCHIVED`. Flujos REOPEN = **eventos** (`TOPIC_REOPEN_REQUESTED`, `TOPIC_REOPENED`), no estados persistentes `REOPENED` / `REOPEN_REQUESTED`.

## Inventario

| Archivo | Tabla(s) |
|---------|----------|
| `20260722_f2_conversation_topics.sql.md` | `conversation_topics` |
| `20260722_f2_conversation_topic_events.sql.md` | `conversation_topic_events` |
| `20260722_f2_conversation_topic_properties.sql.md` | `conversation_topic_properties` |
| `20260722_f2_topic_search_preferences.sql.md` | `topic_search_preferences`, `topic_budget_history`, `topic_zone_history` |
| `20260722_f2_contact_consents.sql.md` | `contact_consents` |

## Fuera de este pack (fases posteriores)

`visit_requests`, `media_analysis_results`, `agent_approval_requests`, `turn_trajectory_logs` (condicional D13).
