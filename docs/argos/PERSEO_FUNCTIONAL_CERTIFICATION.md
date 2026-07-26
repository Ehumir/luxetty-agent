# ARGOS · PERSEO Functional Certification

> **VIGENTE (F0A 2026-07-22):** veredicto máquina **PASS** · `PRODUCTION_RAG_GO = YES`.  
> SoT JSON: `docs/argos/evidence/perseo-functional-certification/PERSEO_FUNCTIONAL_CERTIFICATION.json` @ `2026-07-22T08:03:02.519Z`  
> Índice documental: `docs/argos/PERSEO_RAG_DOCUMENTATION_SOURCE_OF_TRUTH.md`  
> Runtime prod certificado: `fix/rag-rq47-quality-hardening@ca4cccb` · Railway deploy `d8655e81`

---

## HISTÓRICO / SUPERSEDED — no usar como estado actual

> Las tablas FAIL/CANARY/PARTIAL debajo describen corridas **anteriores** (canary inventario / 7-jul).  
> **SUPERSEDED** por el JSON PASS del 22-jul-2026. Conservadas solo como evidencia de evolución.

### Veredicto por suite (canary histórico — SUPERSEDED)

| Suite | Resultado histórico | Nota |
|---|---|---|
| Renta | PARTIAL (2/3) | SUPERSEDED → PASS 3/3 en JSON 22-jul |
| Venta / Compra | PARTIAL (1/3) | SUPERSEDED → PASS 3/3 |
| Propiedad específica | FAIL (2/4) | SUPERSEDED → PASS 4/4 |
| Captación | FAIL CRM_READY | SUPERSEDED → PASS |
| Conversación larga | PASS | Confirmado en JSON |
| **Global histórico** | **FAIL** | **SUPERSEDED → PASS** |

### Updates del 22-jul (contexto)

- **RAG Primer Mundo / scope B:** cert funcional PASS global. Railway contrato: inventory GLOBAL + RAG_P0_GLOBAL. CDC cron activo. Comparables/zone/fotos/tools OFF→canary.
- Snapshot ATENA `backendKnowledge100Snapshot.json` con `CANARY_ACTIVE` es **HISTÓRICO** tras F0A (no contradice YES).

## Evidencia

`docs/argos/evidence/perseo-functional-certification/` (gitignored)  
Contrato: `docs/architecture/BACKEND_KNOWLEDGE_UTILIZATION_100.md`
