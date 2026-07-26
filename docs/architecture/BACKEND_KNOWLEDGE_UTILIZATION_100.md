# Backend Knowledge Utilization 100% — Contrato (1A + 2A)

| Campo | Valor |
|-------|--------|
| **Estado** | CONTRATO ACTIVO — RAG Premium Consultivo |
| **Definición 100%** | 1A — conocimiento comercial autorizado y relevante por conversación |
| **Alcance** | 2A — ATENA + PERSEO + ARGOS |
| **Plan** | RAG Premium Consultivo ≥90% (sin Knowledge Graph / agentic pleno) |
| **Fecha** | 2026-07-22 |

```text
PLAN_APPROVED = YES
IMPLEMENTATION_GO = RAG_PREMIUM_CONSULTIVO
SCHEMA_MIGRATION_GO = FASE_E_PLUS_HYBRID_FTS
PRODUCTION_RAG_GO = YES (cert funcional PASS 2026-07-22; GLOBAL ON)
```

## Principio rector

Backend ATENA = fuente de verdad. RAG recupera y rankea (vector ± hybrid). Claims al usuario solo con `canAssertClaim` + hechos SQL publicables + campaign entity gate. Flags OFF = comportamiento idéntico a producción.

## Matriz SoT vs RAG

| Tipo de dato | Canal | Motivo |
|--------------|-------|--------|
| Precio, status, publicabilidad, código LUX | **SoT siempre** (post-RAG hydrate) | Frescura + anti-alucinación |
| Filtros demanda (op, zona, budget) | **SQL primero**; RAG **rerank / hybrid** | `inventoryOptionsService` |
| Descripción/amenities/tono/objeciones/scripts | **RAG + citation** | Semántica |
| Ownership / create lead / assignment | **Motor SoT** | Prioridad oficial |
| Teléfono, mensajes, leads, contactos | **Nunca RAG** | PII / ownership |
| Campaña activa / copy real | **SoT property fields** | Entity validation |
| Colonia canónica | **Location Intelligence SoT** | Evitar inventar zona |

## TurnContextPack (contrato runtime)

```js
{
  activeProperty: object|null,       // hechos SoT normalizados
  matchedOptions: object[],          // opciones publicables (id, title, price, public_url, …)
  inventorySearchMeta: {
    attempted: boolean,
    source: 'none'|'structured'|'structured+rag',
    operation: 'rent'|'sale'|null,
    zone: string|null,
    budgetMax: number|null,
    bedrooms: number|null,
    relaxedZone: boolean,
    emptyAfterSearch: boolean,
  }|null,
  ragContextPack: ContextPackV1|null,
  networkFallback: boolean,          // true solo post-search vacío
  freshness: { lagSeconds: number|null }|null,
}
```

Inyectado vía `legacyHydration` → `v3Runtime.applyLegacyHydrationToSession`.

## Owners

| Área | Owner |
|------|--------|
| Runtime conversacional / composer | PERSEO |
| Knowledge Store / CDC / index / hybrid RPC | ATENA |
| Certificación / panel madurez | ARGOS |

## Go / No-Go por fase (Premium Consultivo)

| Fase | GO | NO-GO |
|------|----|-------|
| 0 KPIs | Contrato + runbook actualizados; suites unitarias verdes | Flags prod tocados |
| 1 Cobertura+CDC | ≥95% publicables indexadas; worker procesa jobs | Jobs stuck / PII en chunks |
| 2 Search memory | 3 turnos mantienen op/zona/budget | Re-preguntar en bucle |
| 3 Domain routing | RQ-3 isolation; umbrales por dominio | Wrong-domain grounding |
| 4 Hybrid | LUX/título exacto mejora; latency ≤ budget | Regresión semantic / timeout |
| 5 Campaigns | Claim sin entidad bloqueado; 0 inventarios inventados | Seeds genéricos en claims |
| 6 Canary | Cert funcional PASS en allowlist | Invent listing/precio/URL → rollback flags |
| 7 GLOBAL | KPIs 48–72h verdes | Cert FAIL / freshness degradada |

## Madurez objetivo (8 capacidades)

| # | Capacidad | Objetivo |
|---|-----------|----------|
| 1 | Info propiedades (SoT) | ≥90% |
| 2 | Identificar necesidad | ≥90% |
| 3 | Opciones reales sin inventar | ≥90% |
| 4 | Fallback red post-search | ≥90% |
| 5 | Tono consultivo | ≥90% |
| 6 | Anti-loops | ≥90% |
| 7 | Campañas consultivas | ≥80% |
| 8 | Imágenes (media existente, no multimodal RAG) | ≥80% |

## Fuera de alcance

Knowledge Graph · Planner/agentic pleno · RAG multimodal fotos · FB/IG path RAG · CRM writes desde RAG.

## Anti-PII gate

Mantener `luxetty-atena/supabase/validation/rag_p0_no_pii_audit.sql` como gate de release. Nunca indexar contacts/leads/conversations/opportunities/transactions.
