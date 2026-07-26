# PERSEO RAG F1A — Telemetry Baseline

| Campo | Valor |
|-------|-------|
| **Fecha corte** | 2026-07-22 |
| **Proyecto** | Supabase Luxetty `pjoxytwsvbeoivppczdx` |
| **Evidencia máquina** | `docs/argos/evidence/rag-f1a-baseline/PERSEO_RAG_F1A_BASELINE.json` |
| **Fase** | F1A — restore observability (no new tables) |

---

## 1. Root cause (pre-F1A)

Tras **GLOBAL**, el tráfico de demanda es mayoritariamente **inventory SQL** (`inventory_only`), no hybrid RAG rules.

| Hecho | Evidencia |
|-------|-----------|
| `rag_query_logs` solo se escribe en path rules RAG (`fetchDomainAwareRulesContextPack` / `persistRagQueryLog`) | Código `domainRetrievalOrchestrator` / `ragService` |
| Skip / classification telemetry estaba gated por `RAG_RC11_TELEMETRY_ENABLED` | Histórico RC11; post-GLOBAL muchos turns no emitían |
| `rag_retrieval` events se detuvieron **2026-07-07** mientras `conversation_events` **otros tipos** continuaron | SQL baseline abajo |

**Fix F1A (código en rama reconcile — pending deploy):** siempre emitir skip + `retrieval_turn_classification` (y KPI `rag_retrieval` safe) **sin** depender del flag RC11 para el emit mínimo. No fingir filas en `rag_query_logs` cuando no hubo retrieval vectorial.

---

## 2. Baseline PRE (medido 2026-07-22)

| Métrica | Valor |
|---------|------:|
| `rag_query_logs` count | **500** |
| `rag_query_logs` last_at | **2026-07-07T06:47:31Z** |
| `rag_retrieval` events total | 718 |
| `rag_retrieval` since 2026-07-08 | **0** |
| `rag_retrieval` last_at | 2026-07-07T06:47:31Z |
| `conversation_events` since 2026-07-08 | **130** (otros tipos vivos) |
| `conversation_events` last_at | 2026-07-22T17:44:06Z |

Interpretación: la tubería de eventos **no** está muerta; el path de telemetría RAG/retrieval **sí** quedó en silencio post-GLOBAL + gating RC11.

---

## 3. Baseline POST

| Campo | Estado |
|-------|--------|
| Deploy F1A | **PENDING** — rama reconcile / PR; no medir como LIVE hasta deploy |
| Expected signals | `retrieval_turn_classification` y/o `rag_retrieval` con `kpi_version: f1a_1` en turns V3 |
| `rag_query_logs` | Solo crece cuando rules RAG corre; inventory_only **no** debe inventar logs |

Re-ejecutar SQL post-deploy y actualizar JSON `post` block.

---

## 4. Classification mix esperado (post)

Para demanda GLOBAL: mayoría `inventory_only` / `property_sot_only` / `no_retrieval_needed`; minoría `rag_retrieval` / `rag_and_inventory`.  
Usar ARGOS para afirmar mix — no tratar `rag_query_logs` quieto como fallo de inventory.

---

## 5. DoD F1A

- [x] Root cause documentada  
- [x] Baseline PRE SQL archivado  
- [ ] Deploy F1A  
- [ ] Baseline POST <24h inserts classification  
- [ ] KPIs seguridad Anexo M inputs observables
