# PERSEO Readiness Premerge — ARGOS Runnable Report

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Suite** | `argos-matrix-100-runnable-premerge` (53 casos) |
| **Runtime** | local `argos/scenarioRunner` (rama reconcile PERSEO) |
| **CRM** | dry-run / deterministic |
| **Evidencia JSON** | `docs/argos/evidence/perseo-readiness-premerge/PERSEO_READINESS_PREMERGE.json` |

## Conteos

| Estado | Cantidad |
|--------|---------:|
| PASS | 46 |
| FAIL | 7 |
| XFAIL esperado (no ejecutados en esta corrida) | 23 |
| XPASS inesperado | 0 |
| NOT RUN (excluidos) | 24 |
| **Runnable total** | **53** |
| **Pass rate runnable** | **0.868** (need ≥ 1.0) |

## Fails (sin alterar expectativas)

| Case | Violaciones principales | Lectura |
|------|-------------------------|---------|
| ARGOS_PC_001 | intent sell≠rent; sticky no rompe | **P0** — escenario rent-break post-offer |
| ARGOS_PC_004 | seller→rent no aplicado | **P0** — mismo dominio |
| ARGOS_PC_011 | budget sigue 5M ≠ 3.5M | Corrección presupuesto no reflejada |
| ARGOS_PC_012 | rent→buy no aplicado | Switch operación |
| ARGOS_PC_017 | intent null | Campaña / entity |
| ARGOS_PC_071 | lead_type supply≠offer | Posible enum fixture vs runtime |
| ARGOS_PC_098 | known_name mismatch | Fixture larga; slot nombre |

**Nota:** Unit tests `conversationPriorityResolver` / `r0ContextContinuity` están verdes; el fallo ARGOS sugiere gap del harness multi-turno / evaluación `expected` vs path unitario. **No** se debilitaron fixtures.

## Veredicto ARGOS premerge

```text
ARGOS_RUNNABLE_SUBSET = FAIL
BLOQUEA_MERGE = YES
```
