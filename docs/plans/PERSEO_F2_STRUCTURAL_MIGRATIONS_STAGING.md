# PR-F2-05 — Migraciones estructurales F2 para staging

| Orden | Migration | Compatibilidad |
|---:|---|---|
| 1 | topics + eventos | aditiva; runtime viejo no las consulta |
| 2 | show batches + items | aditiva; legacy `last_shown_property_ids` intacto |
| 3 | ledgers F2/CDC/outbound | aditiva; workers actuales intactos |

Los borradores `docs/plans/sql-drafts/*.sql.md` permanecen `DO_NOT_APPLY` e
intactos. Estos archivos nuevos son revisables y sólo están destinados a
validación local/staging.

## Seguridad y locks

Todas las tablas públicas habilitan RLS. API roles no tienen write; topics y
batches permiten SELECT sólo por admin, agente asignado o supervisor dentro de
`can_manage_agent_profile`. Ledgers son service-only. `lock_timeout=5s`,
`statement_timeout=90s`, sin backfill ni `DROP CASCADE`.

## Repetición y fallo parcial

La CLI aplica cada archivo una vez por migration history. DDL de creación e
índices usa `if not exists`; policies son deterministas sobre un baseline limpio.
Un fallo aborta la migration transaccional y debe corregirse con forward-fix, no
marcarse aplicada manualmente.

## Métricas pendientes de staging

Duración, locks, filas afectadas, tamaño before/after, segundo `db push`, runtime
viejo/nuevo, fallo parcial y rollback todavía no están acreditados. Sin Docker
local ni staging autorizado, esta rama sólo acredita estructura y contratos
estáticos.

## Rollback operativo

Antes de writes: forward migration explícita puede retirar objetos. Después de
writes: flags/callers OFF y datos preservados; runtime viejo ignora tablas nuevas.
No borrar topics, mensajes, conversaciones, batches o ledgers como rollback.
