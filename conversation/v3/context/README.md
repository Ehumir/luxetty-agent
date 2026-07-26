# conversation/v3/context — scaffolding

**Estado:** NOT WIRED · 2026-07-22

Este directorio prepara el contrato **TurnContextPackV1** para F3.

| Archivo | Rol |
|---------|-----|
| `turnContextPack.types.js` | JSDoc typedefs + shape constants + `validateTurnContextPackMinimal` |
| `turnContextPack.contract.test.js` | Unit fail-closed (sin DB) |

## Prohibiciones (fase diseño)

- **No** importar desde `index.js`, `conversation/v3/index.js`, `v3Runtime.js`, ni `argos/processInboundForArgos.js`.  
- **No** reemplazar `legacyHydration` todavía.  
- **No** crear builder productivo aquí hasta GO F3 + F2 `active_topic_id`.

## Siguiente paso (futuro)

Añadir `turnContextPack.js` builder detrás de flag `PERSEO_PACK_MANDATORY` default false, con tests de integración y wiring explícito en PR dedicado.
