# PR-F2-03 — Idempotencia outbound

| Campo | Valor |
|---|---|
| Alcance | Intent ledger, lock, reconciliación y side effects puros |
| No alcance | Wiring, provider real, migration, flags o deploy |
| Clave | SHA-256 de conversation + inbound message + reply kind |
| Ventana dedupe | Permanente para la respuesta a ese inbound |

## Regla central

Se registra intención antes de llamar al proveedor. Un timeout con aceptación
incierta pasa a `provider_unknown` y **bloquea retry ciego**. Sólo la consulta al
proveedor/webhook puede reconciliar a `sent`; `not_found` permite retry usando la
misma idempotency key.

Estados: `intent_recorded`, `claimed`, `provider_unknown`, `sent`, `confirmed`,
`failed_retryable`, `cancelled`.

## Efectos

| Efecto | Constraint futuro | Retry/compensación |
|---|---|---|
| mensaje | unique `idempotency_key`; provider key | reconcile antes de retry incierto |
| confirmación | unique provider event; sequence monotónica | ignorar duplicado/out-of-order |
| notification | unique `(outbound_key,effect)` | replay seguro |
| task | unique `(outbound_key,effect)` | replay seguro |
| event | unique `(outbound_key,effect)` | append una vez |
| commercial effect | unique `(outbound_key,effect)` | compensación específica |

Telemetría: key, transición, attempt, provider status/id hash, latency, error
code, reconciliation outcome y dedupe outcome; sin body ni PII.

## Criterio acreditado offline

Dos workers, HTTP perdido, retry de proveedor, confirmación duplicada,
side-effects duplicados, envío concurrente, evento fuera de orden y fallo tras
intención convergen a una fila y un estado final sin duplicar efectos.

La garantía real sigue condicionada a constraints persistentes y a que el
proveedor acepte idempotency key o exponga lookup/reconciliation. Sin eso no se
debe afirmar exactly-once.
