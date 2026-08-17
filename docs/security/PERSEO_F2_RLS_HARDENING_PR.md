# PR-F2-04 — Hardening RLS para staging

| Campo | Valor |
|---|---|
| Alcance | referrals, notifications y RPC de emisión |
| No alcance | Producción, wiring, datos, topics o migrations estructurales |
| Migration | `*_f2_04_rls_hardening.sql` |

## Acceso resultante

| Actor | Referrals | Notifications |
|---|---|---|
| anon | denegado | denegado |
| authenticated sin relación | denegado | sólo propias |
| agente asignado | SELECT de conversación asignada | sólo propias |
| supervisor | SELECT dentro de `can_manage_agent_profile` | sólo propias |
| admin | SELECT | sólo propias por Data API; operación interna por servicio |
| service_role | CRUD | CRUD/RPC |

`TO authenticated` nunca aparece solo: referrals usa pertenencia/alcance y
notifications usa `user_id = auth.uid()`. UPDATE tiene `USING` y `WITH CHECK`.
No se agregó `SECURITY DEFINER`.

## Pruebas

La prueba contractual verifica grants, predicados, UPDATE, exposición de función,
timeouts y ausencia de `DROP CASCADE`. El test dinámico por JWT/roles queda como
gate obligatorio de staging; no puede acreditarse sólo por inspección SQL.

## Deployment/rollback

Staging: snapshot de policies/grants, migration, matriz por actor, advisors y
consumidores. Rollback es forward-fix que restaura el snapshot; jamás desactiva
RLS. Si el consumidor legítimo falla, detener callers y restaurar grants/policy
anterior. No aplicar en producción sin autorización posterior.
