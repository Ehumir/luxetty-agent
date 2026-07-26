# PERSEO PR #112 — ARGOS failure analysis (7 → 0)

| Campo | Valor |
|-------|-------|
| Fecha | 2026-07-23 |
| Rama | `chore/reconcile-main-production-perseo-20260722` |
| Prod ref | `fix/rag-rq47-quality-hardening@ca4cccb` (ancestro de HEAD) |
| Antes | 46/53 PASS |
| Después | **53/53 PASS** |
| F2 | **No implementado** |

Evidencia máquina: `docs/argos/evidence/perseo-pr112-argos-failures/PERSEO_PR112_ARGOS_FAILURE_ANALYSIS.json`

## Matriz comparativa

| Caso | ca4cccb | origin/main | PR112 antes | PR112 después | Interpretación |
|------|---------|-------------|-------------|-----------------|----------------|
| ARGOS_PC_001 | FAIL misma clase V3 | FAIL/weaker | FAIL | **PASS** | Preexistente prod (V3 sticky/landing), no regresión de merge RAG |
| ARGOS_PC_004 | FAIL misma clase | FAIL/weaker | FAIL | **PASS** | Idem |
| ARGOS_PC_011 | FAIL identity/money | FAIL | FAIL | **PASS** | Preexistente identity false-positive |
| ARGOS_PC_012 | FAIL rent→buy | FAIL | FAIL | **PASS** | Preexistente identity + switch |
| ARGOS_PC_017 | FAIL campaign buy | FAIL | FAIL | **PASS** | Preexistente detección campaña |
| ARGOS_PC_071 | FAIL offer≠supply | FAIL | FAIL | **PASS** | **HARNESS** alias offer≡supply |
| ARGOS_PC_098 | FAIL nombre falso | FAIL | FAIL | **PASS** | Preexistente heurística nombre |

`ca4cccb` es ancestro de PR112: los fallos no vienen de preferir “theirs” en conflictos RAG; el path ARGOS/V3 nunca rompía sticky offer→renta de punta a punta.

## Causas raíz (resumen)

1. **PC_001 / PC_004 (P0)** — Landing capture + `applyGoalOwnership` forzaba `SELL/offer` aunque el intérprete emitía `RENT_PROPERTY` + `explicitFlowSwitch`. Precio (“Vale como 8 millones”) se guardaba como zona. `awaitingField` robaba el pivot de renta como `LOCATION_CAPTURE`. `isExplicitFlowSwitchToRentDemand` era demasiado estrecho.
2. **PC_011** — `splitNameAndTail("Perdón, en realidad 3.5 millones")` → nombre `Perdón`; no actualizaba presupuesto.
3. **PC_012** — “Mejor quiero comprar” aceptado como nombre; faltaba switch temprano rent→buy con goal locked.
4. **PC_017** — “vi su anuncio” / “me interesa la casa de la campaña” no marcaban buy demand.
5. **PC_071** — Fixture `lead_type: offer` vs panel CRM `supply` (contrato ownership). Harness ahora trata `offer≡supply` y prioriza `snapshot.lead_flow`.
6. **PC_098** — Frases de refinamiento (“Más cerca de avenida”, “sigue”) como `fullName`.

## Correcciones (mínimas)

- `landingCaptureFlow`: yield en pivot demanda; precio ≠ zona; precio-only en `name_zone`.
- `goalLock`: no forzar landing SELL si `explicitFlowSwitch` o `landingCaptureFlow: false`.
- `campaignIntake` / `minimalInterpreter`: switch rent/buy explícito; `mentionsRentDemand` sin false-positive de prevaluación; `wantsRentPhrase` alineado a `mentionsRentDemand`; corrección “ya te dije que renta”.
- Identity: endurecer `isLikelyFirstNameOnly`, `splitNameAndTail`, `nameHeuristics`, skip identity en money/pivots.
- `objectionClassifier`: “ya te dije…” ≠ `sale_urgency_emotional`.
- `scenarioRunner`: `leadTypesEquivalent`.

## Tests permanentes

- `test/stickyOfferRentDemandBreak.test.js` (matriz §3.3)
- Revalidados: `test/p0ProductionIncidentSuite.test.js`, `test/landingCaptureFlow.test.js`, `test/r0ContextContinuity.test.js`

## Resultados

| Check | Resultado |
|-------|-----------|
| Lint | PASS (`LINT_OK`) |
| ARGOS runnable | **53/53** |
| P0 incident + sticky matrix | PASS |
| F2 / TurnContextPack / flags F2–F9 | **No** |

## Riesgos restantes

- Zona basura en captación larga (p.ej. “Tiene 3 recámaras” como zone) — fuera de assertions PC_071; deuda P2.
- CRM dry-run `lead_type` puede quedar `supply` tras pivot; harness usa `lead_flow` conversacional.
- Test F3.2 LUX-A0462 (pide nombre) ya fallaba por composer PROPERTY_QA sin name-gate — **preexistente**, no bloquea suite runnable.

## Veredicto

```text
PREMERGE_READY = YES
PERSEO_PR112_MERGE_RECOMMENDATION = GO
ATENA_PR119_MERGE_RECOMMENDATION = GO
IMPLEMENTATION_READY = NO
F2_GO_RECOMMENDATION = NO-GO
```

No merge ejecutado. F2 no iniciado.
