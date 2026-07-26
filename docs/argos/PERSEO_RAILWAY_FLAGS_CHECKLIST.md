# Railway Flags Checklist (captura humana — no modificar valores)

| Campo | Valor |
|-------|-------|
| **Proyecto** | Luxetty IA Agents `e74fe868-99da-414c-9008-908a7b04adcc` |
| **Service** | `luxetty-perseo` |
| **Deploy observado** | `d8655e81` @ `fix/rag-rq47-quality-hardening` / `ca4cccb` |
| **Agente** | Valores plaintext **NO visibles** vía MCP en esta sesión |

## Instrucción a Dirección / operador Railway

Abrir Variables del servicio `luxetty-perseo` (production) y completar la columna **Valor prod**.

| Flag | Existe (sí/no) | Valor prod | Default código | Debe estar ON/OFF | Riesgo |
|------|----------------|------------|----------------|-------------------|--------|
| `RAG_P0_ENABLED` | | | OFF | ON (contrato GLOBAL) | Telemetría/RAG rules |
| `RAG_P0_GLOBAL_MODE` | | | OFF | ON | Cobertura |
| `RAG_INVENTORY_ENABLED` | | | OFF | ON si inventory RAG | |
| `RAG_RULES_ENABLED` | | | OFF | ON para rules path | F1A logs |
| `RAG_DOMAIN_ROUTING_ENABLED` | | | OFF | ON | RQ-3 |
| `RAG_ADAPTIVE_THRESHOLD_ENABLED` | | | OFF | ON | RQ-4 |
| `RAG_HYBRID_ENABLED` | | | OFF | ON | hybrid |
| `RAG_RC11_ZONE_ENTITY_VALIDATION_ENABLED` | | | OFF | ON | anti invent zona |
| `RAG_RC11_TELEMETRY_ENABLED` | | | OFF | Prefer ON post-F1A | skips |
| `RAG_RC12_CAMPAIGN_ENTITY_VALIDATION_ENABLED` | | | OFF | ON | |
| `PERSEO_INVENTORY_OPTIONS_ENABLED` | | | OFF | ON | |
| `PERSEO_INVENTORY_OPTIONS_GLOBAL` | | | OFF | **ON** (contrato) | |
| `PERSEO_CONSULTIVE_TOOLS_ENABLED` / GLOBAL | | | OFF | **OFF** | F8 |
| `PERSEO_RAG_PROPERTY_IMAGES_*` | | | OFF | **OFF** | F7 |
| `PERSEO_MEDIA_*` | | | OFF | **OFF** | F7 |
| `PERSEO_MESSAGE_PLANNER_ENABLED` | | | OFF | **OFF** | F4 |
| `PERSEO_TOPIC_LIFECYCLE_ENABLED` | | | N/A | **OFF** / ausente | F2 |
| `PERSEO_JOURNEY_MEMORY_ENABLED` | | | N/A | **OFF** | F2 |
| `PERSEO_TURN_CONTEXT_PACK_MANDATORY` | | | N/A | **OFF** | F3 |
| `PERSEO_VISIT_REQUESTS_ENABLED` | | | N/A | **OFF** | F9 |
| `PERSEO_AGENTIC_REVERSIBLE_ENABLED` | | | N/A | **OFF** | F9 |
| `PERSEO_HUMAN_APPROVAL_ACTIONS_ENABLED` | | | N/A | **OFF** | F9 |
| `PERSEO_TRAJECTORY_LOGGING_ENABLED` | | | N/A | **OFF** hasta D13 | F1B |
| `PERSEO_V3_ENABLED` / primary | | | — | ON | Runtime |
| `PERSEO_V3_CRM_EXECUTE` | | | — | dry-run / allowlist | CRM |

**No cambiar valores en esta misión.**
