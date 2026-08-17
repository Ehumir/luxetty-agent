# PR-F2-02 — Idempotencia CDC

| Campo | Valor |
|---|---|
| Alcance | Contrato/state machine CDC puro y tests |
| No alcance | Wiring, migration, reindex remoto o producción |
| Clave | `(entity_type, entity_id, source_version_sha256)` |
| Ventana dedupe | Permanente por versión de fuente |

## Estados y recuperación

`pending → claimed → chunks_saved → embedding_saved → completed`.
Todo fallo persistible pasa a `retryable`; deactivation lleva a `inactive` y
reactivation vuelve a `pending`. Un retry conserva IDs ya guardados y sólo
continúa el paso faltante.

El constraint futuro será unique sobre la clave anterior. Chunks y embeddings
necesitan además unique `(job_id, ordinal)` o una clave derivada de
`source_version + chunk_fingerprint`. La migration pertenece a PR-F2-05.

## Escenarios acreditados offline

- job repetido;
- timeout y retry;
- dos workers;
- update sin cambio/con cambio;
- desactivación/reactivación;
- fallo después de chunks y antes de embedding;
- fallo después de embedding y antes del cierre;
- recuperación sin duplicar chunks ni embeddings.

Telemetría mínima futura: key, state transition, attempt, worker, error code,
duration y counts; nunca contenido/chunks/PII.

## Rollback

Sin wiring, revertir este PR no altera datos. Con persistencia futura, rollback
operativo detiene el worker/flag y conserva ledger/chunks/embeddings para
reconciliación; nunca `DROP CASCADE`.
