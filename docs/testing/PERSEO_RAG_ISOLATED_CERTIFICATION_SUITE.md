# Suite obligatoria RAG aislada — preparación

Comando único:

```bash
npm run test:certification:isolated
```

## Garantías del runner

- construye un entorno hijo por allowlist;
- no hereda credenciales Supabase, OpenAI, Meta o WhatsApp;
- inyecta únicamente valores locales/test no válidos para módulos que crean
  clientes al importarse;
- neutraliza `dotenv.config()` antes de cargar código de aplicación;
- bloquea `fetch` salvo que una prueba instale explícitamente su mock;
- no ejecuta scripts live, staging, producción ni canary remoto;
- no incluye `ragKnowledgeStoreP0.test.js`, clasificado como obsoleto porque
  niega la integración runtime vigente y queda pendiente de reemplazo.

## Clasificación

- Unitarias/contrato: dominio, thresholds, métricas, ContextPack y reglas.
- Integración local con mocks: runtime RAG, inventario y fallback.
- Excluidas: red, staging, producción, ARGOS live y escrituras CRM.

Esta suite es el gate local inicial, no la certificación V1 completa. Las
pruebas de rol, staging, canary, tráfico real y rollback siguen siendo gates
separados.

## Comandos de precertificación

| Comando | Clase | Red/credenciales |
|---|---|---|
| `npm run test:unit` | obligatoria offline | bloqueadas/no heredadas |
| `npm run test:contracts` | obligatoria offline | bloqueadas/no heredadas |
| `npm run test:integration` | integración local con mocks | bloqueadas/no heredadas |
| `npm run test:rag-p0` | gate RAG P0 offline | bloqueadas/no heredadas |
| `npm run test:f2` | gate F2 offline disponible en main | bloqueadas/no heredadas |
| `npm run test:argos-offline` | ARGOS offline explícito | bloqueadas/no heredadas |
| `npm run test:staging` | preflight remoto | fail-closed por defecto |
| `npm run test:canary` | preflight remoto | fail-closed por defecto |

`npm run test:precert:3x` ejecuta las seis suites offline tres veces y genera
`.artifacts/test-reports/precertification-3x.json`. Cada runner tiene timeout de
120 segundos y bloquea `fetch`, `.env` y credenciales productivas.

`npm run test:classify` inventaría todos los `test/*.test.js`. Los tests no
incluidos en un gate explícito quedan `legacy_pending_classification`,
`manual_or_argos_review`, `staging` o `canary_productivo`; no se deshabilitan ni
se presentan como PASS. La revisión pendiente tiene owner y fecha en el reporte.

`ragRulesService.test.js` se alinea con el contrato real: verifica el resultado
observable —todas las fuentes pertenecen al dominio solicitado— y no exige
campos top-level que el servicio nunca exportó.

`v3F23Occupancy.test.js` conserva el comportamiento P0 —confirmar que la
propiedad está libre— sin congelar la frase histórica “Tomé que…”. La prueba
sustituta sigue fallando si esa confirmación desaparece.
