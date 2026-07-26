# PERSEO / ARGOS — Trajectory Logging Design (F1B)

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Fase** | F1B — **GO diseño / NO-GO implementación** hasta firma D13 |
| **Master Plan** | V2.1 §31.2, §29.2 `turn_trajectory_logs`, Anexo F B-P0-05b |
| **Estado** | DISEÑO — sin migración, sin flag de prod |
| **Clasificación** | Interno |

> **ADVERTENCIA:** crear `turn_trajectory_logs` requiere modificación de esquema. Este documento **no** autoriza `APPLY`.

---

## 1. Objetivo

Auditar la trayectoria de decisión por turno (intent → retrieval → tools → claims → lifecycle/control/handoff) **sin** persistir transcripts, TurnContextPack completo ni PII.

F1A restaura observabilidad existente (`rag_query_logs` en path rules + `conversation_events` classification). F1B solo añade trayectoria **si** D13 lo firma y el volumen/query lo justifican.

---

## 2. Opciones comparadas

### Opción A — Extender `conversation_events`

Reutilizar tabla existente (`id`, `conversation_id`, `type`, `payload` jsonb, `created_at`, `created_by`).

Tipos nuevos / extendidos (candidatos):

| `type` | Rol |
|--------|-----|
| `retrieval_turn_classification` | Clasificación F1A por turno (inventory_only, rag_retrieval, …) |
| `rag_retrieval` | Ya existe; payload KPI safe (latencia, domain, skip reason, log id) |
| `turn_trajectory` *(opcional F1B)* | Snapshot compacto de decisión (IDs/hashes/códigos) |
| `topic_*` | Tras F2: espejo ligero o correlación vía `topic_id` en payload |

**Pros:** cero migración; RLS/admin ya existe (`conversation_events_admin_select`); ARGOS ya consulta por `type`; kill switch = dejar de emitir; rollback trivial.  
**Contras:** queries analíticas sobre JSONB; retención/volumen compartidos con otros eventos; menos tipado.

### Opción B — Structured application logs

Emitir JSON a Railway/stdout (p95, decision_codes, …) y scrapear con ARGOS/log drain.

**Pros:** sin DB; sampling fácil; barato al inicio.  
**Contras:** no consultable por SQL SoT; retención de plataforma opaca; difícil join con `conversation_id`/`topic_id` en ATENA UI; no sustituye evidencia certificable durable.

### Opción C — Storage sampling (bucket evidencias)

Escribir muestras redactadas a Storage (cert runs, canary windows) con TTL.

**Pros:** buen fit para suites ARGOS / post-mortems; control de volumen.  
**Contras:** no es telemetría continua; URLs/paths; más ops; no dash comercial online.

### Opción D — Tabla `turn_trajectory_logs`

Tabla dedicada tipada (§29.2 Master Plan).

**Pros:** índices, retención propia, queries ARGOS eficientes a escala.  
**Contras:** migración + RLS + jobs TTL; riesgo de scope creep PII; premature hasta baseline F1A.

---

## 3. Matriz de decisión (score 1–5; mayor = mejor)

| Criterio (peso) | A Events | B Logs | C Storage | D Table |
|-----------------|---------:|-------:|----------:|--------:|
| Time-to-value / sin migrate (5) | **5** | 4 | 3 | 1 |
| Query ARGOS / ATENA (5) | 4 | 1 | 2 | **5** |
| PII / minimización (5) | **4** | 3 | 4 | 4* |
| Volumen / costo (4) | 3 | **4** | **5** | 2 |
| Certificabilidad durable (4) | **4** | 2 | 4 | **5** |
| Kill switch / rollback (3) | **5** | 4 | 4 | 3 |
| Alineación F1A ya en código (3) | **5** | 2 | 1 | 1 |
| **Score ponderado** | **117** | 74 | 87 | 87 |

\*Tabla D solo si schema PII firmado; score asume redacción estricta.

---

## 4. Recomendación D13

**Preferir Opción A (extender `conversation_events`)** — en particular:

1. **Siempre** emitir `retrieval_turn_classification` (+ `rag_retrieval` KPI) en el path V3 (F1A; ya scaffolding en `retrievalTurnClassification.js` / `ragTurnOrchestrator.js`).
2. Si F1B necesita más campos de decisión, usar `type = 'turn_trajectory'` con payload **redactado** (misma tabla).
3. **Opción D (`turn_trajectory_logs`) solo si**, post-baseline F1A + canary:
   - volumen de eventos hace lento el dashboard ARGOS, **o**
   - se requieren índices/TTL/particionado distintos a `conversation_events`, **o**
   - Legal exige segregación física de telemetría.

**No** elegir B como SoT. **C** queda como complemento de evidencias de certificación, no como trayectoria online.

---

## 5. Campos permitidos / prohibidos

### Permitidos (payload / columnas)

| Campo | Notas |
|-------|-------|
| `conversation_id`, `topic_id` (post-F2), `turn_id` / `message_id` hash | IDs |
| `intent.primary`, `decision_codes[]` | Códigos, no texto libre largo |
| `classification`, `sources_consulted[]`, `rag_query_log_id` | Retrieval |
| `tools[]`, `claim_codes[]`, `must_not_hit[]` | Decisiones |
| `lifecycle`, `control_mode`, `handoff_state` snapshots | Post-F2 |
| `latencies_ms`, `error_codes`, `fallback_used` | Métricas |
| `included_fact_ids` / `excluded_fact_ids` (hashes) | Anti-alucinación audit |
| `kpi_version` | Versionado payload |

### Prohibidos

- Transcript / cuerpo de mensaje WhatsApp  
- TurnContextPack completo  
- PII (nombre, teléfono, email, dirección exacta)  
- Audio/imagen bytes o URLs firmadas de larga vida  
- Consentimientos sensibles en claro (solo `consent_purpose` + status code)  
- Precios inventados / copy final al usuario  
- Contenido de embeddings / query_text en claro (usar hash)

---

## 6. RLS, retención, sampling, kill switch, rollback

| Control | Diseño |
|---------|--------|
| **RLS** | Igual filosofía que `conversation_events`: service_role PERSEO escribe; `is_admin()` / roles ATENA leen; agentes solo vía ownership si se expone UI |
| **Retención** | `CONFIG_CANDIDATE` — candidato **90d** hot + archive/delete job; no fijar hasta baseline volumen |
| **Sampling** | `CONFIG_CANDIDATE` — 100% classification F1A; trajectory extendida candidata 10–25% prod / 100% allowlist canary |
| **Kill switch** | `PERSEO_TRAJECTORY_LOGGING_ENABLED` default **false** (solo si se añade writer F1B). Classification F1A **no** debe depender de RC11 telemetry flag |
| **Rollback** | Dejar de insertar; opcional DELETE por `type` + ventana; si hubo tabla D → reverse SQL (DROP) tras dual-read off |

---

## 7. Estimación de volumen — `CONFIG_CANDIDATE_PENDING_BASELINE`

Datos auditados 2026-07-22 (Supabase Luxetty `pjoxytwsvbeoivppczdx`):

| Señal | Valor |
|-------|------:|
| `rag_query_logs` rows | 500 |
| `rag_query_logs` last_at | 2026-07-07 |
| `rag_retrieval` events total | 718 |
| `rag_retrieval` since 2026-07-08 | **0** |
| `conversation_events` since 2026-07-08 | 130 (otros tipos siguen vivos) |

**Candidato post-F1A (no autorizado como umbral):**

| Escenario | Events/día (cand.) | Storage/mes (cand.) |
|-----------|-------------------:|--------------------:|
| Solo classification + rag KPI (~0.5–1 KB) | 200–2 000 | 6–60 MB |
| + turn_trajectory 100% (~1–2 KB) | ×2 | ×2 |
| Tabla D particionada | igual + índice overhead | — |

Re-medir tras deploy F1A en rama reconcile antes de autorizar D.

---

## 8. Ejemplo de payload redactado

```json
{
  "kpi_version": "f1b_traj_1",
  "turn_id": "msg_hash_9f3a…",
  "topic_id": null,
  "intent": { "primary": "DEMAND_RENT" },
  "classification": "inventory_only",
  "decision_codes": ["INV_SQL_OK", "RAG_SKIP_PROPERTIES_DEFERRED"],
  "sources_consulted": ["inventory_sql"],
  "tools": [],
  "claim_codes": ["NO_PRICE_CLAIM"],
  "lifecycle": null,
  "control_mode": null,
  "handoff_state": null,
  "latencies_ms": { "total": 412, "inventory": 180 },
  "error_codes": [],
  "rag_query_log_id": null,
  "included_fact_ids": [],
  "excluded_fact_ids": ["fact_hash_…"]
}
```

---

## 9. Secuencia de autorización

1. F1A deploy + baseline (`docs/argos/PERSEO_RAG_F1A_TELEMETRY_BASELINE.md`).  
2. Firma **D13** en `PERSEO_RAG_DIRECTION_DECISIONS.md`.  
3. Si D13 = A: implementar writer `turn_trajectory` detrás de flag OFF.  
4. Si D13 = D: **ADVERTENCIA esquema** + PR migración ATENA + PII review Legal.  
5. Canary allowlist → medir volumen → GLOBAL o rollback.

**Veredicto diseño:** Opción A primero; D condicional.
