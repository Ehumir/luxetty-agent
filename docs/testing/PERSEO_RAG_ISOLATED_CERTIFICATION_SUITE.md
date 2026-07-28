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

`ragRulesService.test.js` se alinea con el contrato real: verifica el resultado
observable —todas las fuentes pertenecen al dominio solicitado— y no exige
campos top-level que el servicio nunca exportó.
