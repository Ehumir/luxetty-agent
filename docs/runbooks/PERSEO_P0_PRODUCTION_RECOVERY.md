# PERSEO P0 — despliegue pausado, rollback y canary

## Alcance

Esta rama contiene exclusivamente #122, #123, #124 limitado a normalización, #125 y HF-05/06/07. No contiene F2 ni activa RAG nuevo.

## Flags y kill switch

- `PERSEO_P0_CRM_RECOVERY_ENABLED=false` por defecto.
- `PERSEO_AUTOMATED_RESPONSES_ENABLED=false` es el kill switch global del despliegue.
- Las 20 conversaciones auditadas permanecen con `ai_paused=true` y nunca participan en el canary.
- El código se despliega primero con ambos flags apagados. No se modifica `main` sin autorización.

## Precondiciones

1. Un único SHA con lint y suite hermética completa 3× verde.
2. Staging aislado con migraciones P0, 20/20 replays, retries/concurrencia/fallos parciales y rollback verde.
3. Cero P0/P1 abiertos y 100% de turnos con evento terminal en `perseo_p0_turn_traces`.
4. Confirmación humana explícita antes de cualquier conversación real.

## Despliegue pausado

1. Mantener `PERSEO_AUTOMATED_RESPONSES_ENABLED=false` y `PERSEO_P0_CRM_RECOVERY_ENABLED=false`.
2. Aplicar las dos migraciones P0; no aplicar ninguna migración F2.
3. Verificar health, conexiones, permisos `service_role` y ausencia de acceso `anon/authenticated`.
4. Activar sólo `PERSEO_P0_CRM_RECOVERY_ENABLED=true`; las respuestas continúan pausadas.
5. Confirmar que rollback y kill switch responden antes del canary.

## Canary autorizado

Primera etapa: 10 conversaciones internas (3 captación, 3 demanda, 2 naturales, 1 formulario Meta con encabezado no español, 1 handoff). Segunda etapa: máximo 5 conversaciones reales nuevas con supervisión humana. Cualquier contradicción, duplicado, propiedad/operación incorrecta, idioma distinto de español o outbound posterior a `HUMAN_WAITING` activa el kill switch y produce `NO-GO`.

## Rollback

1. Apagar `PERSEO_AUTOMATED_RESPONSES_ENABLED` inmediatamente.
2. Apagar `PERSEO_P0_CRM_RECOVERY_ENABLED`.
3. Revertir el deployment al SHA previo; no borrar contactos, leads o requests reales.
4. Para fixtures de staging, borrar sólo los registros identificados por prefijo de idempotencia `perseo-p0:staging:` dentro de una transacción y comprobar cero residuos.
5. La migración de tablas puede permanecer inerte. Si se exige rollback DDL en staging, eliminar primero políticas/función y después `perseo_p0_turn_traces` y `perseo_p0_crm_effects`; jamás ejecutar ese DDL en producción sin autorización separada.

## Evidencia mínima

Conservar SHA, salidas 3×, IDs de migración, conteos antes/después, 20 resultados, 15 resultados de canary, trazas terminales, verificación de español y resultado del rollback.
