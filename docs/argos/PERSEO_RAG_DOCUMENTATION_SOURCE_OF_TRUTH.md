# PERSEO RAG — Documentation Source of Truth (F0A)

| Campo | Valor |
|-------|-------|
| **Versión** | 1.0 |
| **Fecha** | 2026-07-22 |
| **Estado** | VIGENTE |
| **Programa** | Master Plan V2.1 preparación implementación |

## Veredicto operativo vigente

| Campo | Valor |
|-------|-------|
| Contrato | `PRODUCTION_RAG_GO = YES` |
| Evidencia máquina | `docs/argos/evidence/perseo-functional-certification/PERSEO_FUNCTIONAL_CERTIFICATION.json` |
| `final_verdict` | **PASS** |
| Timestamp evidencia | `2026-07-22T08:03:02.519Z` |
| Commit runtime certificado (prod) | `ca4cccb` en `fix/rag-rq47-quality-hardening` |
| Deployment Railway | `d8655e81-bcbd-403e-9847-c8b59346b78d` · service `luxetty-perseo` · SUCCESS · 2026-07-22T17:37:37Z |
| Proyecto Railway | Luxetty IA Agents `e74fe868-99da-414c-9008-908a7b04adcc` |
| Master Plan | `docs/plans/PERSEO_RAG_PREMIUM_CONVERSATIONAL_EVOLUTION_MASTER_PLAN.md` **V2.1** |

> **Nota:** el JSON de evidencia está en `.gitignore` (`docs/argos/evidence/`). Existe localmente; no sustituye el contrato en git. Las auditorías deben citar ambos.

## Artefactos

| Artefacto | Ruta | Estado | Fecha | Commit / ref | Vigencia |
|-----------|------|--------|-------|--------------|----------|
| Master Plan V2.1 | `docs/plans/PERSEO_RAG_PREMIUM_CONVERSATIONAL_EVOLUTION_MASTER_PLAN.md` | VIGENTE | 2026-07-22 | local + repos | Programa |
| Contrato Backend Knowledge | `docs/architecture/BACKEND_KNOWLEDGE_UTILIZATION_100.md` | VIGENTE | 2026-07-22 | prod branch YES | Contrato |
| Runbook Knowledge 100 | `docs/argos/BACKEND_KNOWLEDGE_100_RUNBOOK.md` | VIGENTE | 2026-07-22 | prod | Operación |
| Cert MD (human) | `docs/argos/PERSEO_FUNCTIONAL_CERTIFICATION.md` | VIGENTE (header unificado F0A) | 2026-07-22 | — | Apunta a JSON PASS |
| Cert JSON (máquina) | `docs/argos/evidence/.../PERSEO_FUNCTIONAL_CERTIFICATION.json` | VIGENTE · gitignored | 2026-07-22T08:03:02Z | ca4cccb tree | **SoT veredicto** |
| Audit estado sistema | `docs/audits/LUXETTY_RAG_STATE_OF_SYSTEM_2026-07-22.md` | VIGENTE auditoría | 2026-07-22 | — | Diagnóstico |
| Snapshot ATENA frontend | `luxetty-atena/src/lib/argos/backendKnowledge100Snapshot.json` | **HISTÓRICO** post-F0A | 2026-07-22 | — | No contradecir YES |
| Este índice | `docs/argos/PERSEO_RAG_DOCUMENTATION_SOURCE_OF_TRUTH.md` | VIGENTE | 2026-07-22 | — | Índice F0A |

## Documentos históricos / superseded

| Documento | Marcado | Motivo |
|-----------|---------|--------|
| Headers FAIL/CANARY previos en `PERSEO_FUNCTIONAL_CERTIFICATION.md` | SUPERSEDED por PASS 2026-07-22 | Drift documental |
| Corridas canary 7-jul / parciales en evidence/ | HISTÓRICO | Conservar evidencia |
| `backendKnowledge100Snapshot.json` CANARY_ACTIVE | HISTÓRICO (actualizar en F0A ATENA) | Contradecía contrato YES |
| WhatsApp smoke FAIL B1_DEMAND_LONG (may 2026) | HISTÓRICO | Pre-GLOBAL |

## Matriz de flags (nombres; valores prod plaintext NO siempre visibles)

| Flag | Repo default código | Condición esperada post-GLOBAL (contrato) | Verificado en Railway plaintext |
|------|---------------------|-------------------------------------------|----------------------------------|
| `RAG_P0_ENABLED` / `RAG_P0_GLOBAL_MODE` | OFF / via env | ON en prod según contrato | **NO VERIFICADO EN PLAINTEXT** (dashboard humano) |
| `PERSEO_INVENTORY_OPTIONS_ENABLED` / `_GLOBAL` | OFF | GLOBAL true (contrato) | Names present; values hidden |
| `RAG_DOMAIN_ROUTING_ENABLED` | OFF | ON si RQ-3 activo | NO VERIFICADO |
| `RAG_RULES_ENABLED` | OFF | Depende | NO VERIFICADO |
| `RAG_RC11_TELEMETRY_ENABLED` | OFF | Si OFF → skips RAG sin evento | Sospecha F1A |
| Tools / images / media / planner | OFF | OFF hasta F3–F8 | NO VERIFICADO |
| Topic / pack / visit / agentic | N/A | OFF (F2–F9) | N/A |

## Drift main ↔ producción (F0B)

| | PERSEO | ATENA |
|--|--------|-------|
| Prod branch | `fix/rag-rq47-quality-hardening@ca4cccb` | CDC en `feat/rag-premium-hybrid@5e924a7` |
| `origin/main` (pre-reconcile) | `a915b29` | `bad8170` (movió 2026-07-22) |
| Rama reconciliación | `chore/reconcile-main-production-perseo-20260722` | `chore/reconcile-main-production-atena-20260722` |
| Merge a main / deploy desde main | **Pendiente autorización** | Pendiente |

## Regla de lectura para auditorías

1. Veredicto funcional → **JSON** PASS 2026-07-22.  
2. Contrato operativo → **BACKEND_KNOWLEDGE** `PRODUCTION_RAG_GO = YES`.  
3. Programa evolutivo → **Master Plan V2.1**.  
4. Cualquier FAIL/CANARY sin encabezado HISTÓRICO → tratar como drift y reportar.
