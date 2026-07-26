# PERSEO RAG — Direction Decisions Pack (D1–D13)

| Campo | Valor |
|-------|-------|
| **Fecha** | 2026-07-22 |
| **Master Plan** | V2.1 §40 |
| **Estado de firmas** | **UNSIGNED** |
| **Uso** | Provisional para diseño F2/F3; **no** autoriza implementación F2–F9 |

> Toda fila es **recomendación de ingeniería**. Dirección debe firmar (nombre + fecha) antes de GO de fase bloqueada.

---

## Estado global

```text
PACK_STATUS = UNSIGNED
IMPLEMENTATION_READY = NO
F2_GO = NO-GO
F3_GO = NO-GO
```

---

## Tabla D1–D13

| ID | Decisión | Opciones | Recomendación técnica | Impacto | Riesgo si se ignora | Bloquea fase | Firma |
|----|----------|----------|----------------------|---------|---------------------|--------------|-------|
| **D1** | Temas `OPEN` simultáneos por conversación | 1 vs 2+ | **1 OPEN** (unique parcial); otros `PAUSED`/`CLOSED` | Simplifica resolver + UI; desambiguación explícita | Mezcla de slots / leads | **F2** | UNSIGNED |
| **D2** | Umbral crear lead | temprano vs al calificar | Crear vía CRM gate al umbral mín. (op+rol + zona\|budget\|property + identidad); topic puede existir sin `lead_id` | Menos leads basura; alineado Anexo J | Leads huérfanos / spam CRM | **F2** | UNSIGNED |
| **D3** | Inactividad pause/close/archive | 24h/72h/30d vs otros | Pause **24h**, close **72h**, archive **30d** como `CONFIG_CANDIDATE` | Menos topics zombi | Spam reopen / memoria stale | **F2** | UNSIGNED |
| **D4** | Retención media (img/audio) | 30/90/180d | **90d** candidato | Coste storage + Legal | Over-retention PII | **F7** | UNSIGNED |
| **D5** | Proveedor visión/STT | OpenAI actual vs otro | **Mantener actual** hasta F7 canary | Menos churn | Vendor lock / coste | **F7** | UNSIGNED |
| **D6** | Consent multimodal obligatorio | sí/no | **Sí** — aviso + flag antes de process_images/audio | Cumplimiento | Procesar media sin grant | **F7** | UNSIGNED |
| **D7** | SLA confirmación visita | 2h/4h/8h laboral | **4h laboral** candidato | Expectativa ops | Visitas EXPIRED prematuras | **F9** | UNSIGNED |
| **D8** | Handoff sin consent `phone_call` | bloquear vs WA-only | Permitir handoff **WhatsApp** si grant `whatsapp_contact`; **prohibir** afirmar llamada sin `phone_call` | Honestidad comercial | Promesa falsa de llamada | **F4** | UNSIGNED |
| **D9** | Network fallback externo (portal) | on/off | **Off** — Luxetty inventario propio SoT | Anti-alucinación | Listings inventados | **F5** | UNSIGNED |
| **D10** | Cuándo Agentic N2 | post umbrales | Tras F3–F4 + 14d N1 GLOBAL sin P0 | Seguridad | Acciones reversibles prematuras | **F9** | UNSIGNED |
| **D11** | Owner GLOBAL ARGOS | rol | **ARGOS lead + Product** | Accountability KPI | Dash huérfano | **F1+** | UNSIGNED |
| **D12** | Reconciliación main↔prod | merge auto vs rama+PR+CI+ARGOS | **Reconciliación controlada** (Anexo N); **prohibido merge automático** | Preserva commits | Regresión renta/sticky | **F0B** | UNSIGNED |
| **D13** | Trajectory F1B | tabla vs eventos vs logs | **Preferir A** (`conversation_events` + classification/`rag_retrieval`); tabla D solo si query/volumen post-baseline | Evita migrate prematuro | PII / coste DB | **F1B** | UNSIGNED |

---

## Tabla de aceptación (firmar — no pre-marcar)

| ID | Recomendación | Aprobado | Rechazado | Comentario |
|----|---------------|----------|-----------|------------|
| D1 | Máx. 1 topic OPEN | ☐ | ☐ | |
| D2 | Lead vía CRM gate al calificar | ☐ | ☐ | |
| D3 | Tiempos configurables (cand. 24h/72h/30d) | ☐ | ☐ | |
| D4 | Retención media 90d cand. | ☐ | ☐ | |
| D5 | Mantener proveedor visión/STT actual | ☐ | ☐ | |
| D6 | Consent multimodal obligatorio | ☐ | ☐ | |
| D7 | SLA visita 4h laboral cand. | ☐ | ☐ | |
| D8 | Handoff WA con grant; no call sin consent | ☐ | ☐ | |
| D9 | Network fallback externo OFF | ☐ | ☐ | |
| D10 | Agentic N2 bloqueado hasta umbrales | ☐ | ☐ | |
| D11 | ARGOS + Product autorizan GLOBAL | ☐ | ☐ | |
| D12 | Reconciliación controlada (no merge auto) | ☐ | ☐ | |
| D13 | Events antes que tabla trajectory | ☐ | ☐ | |

## Firmas (vacío hasta Dirección)

| Rol | Nombre | Fecha | Notas |
|-----|--------|-------|-------|
| Dirección Producto | | | |
| Dirección Técnica | | | |
| Legal / Privacidad (D4, D6, D13) | | | |
| ARGOS Owner (D11) | | | |

---

## Dependencias cruzadas

- **F2 impl** requiere D1–D3 (+ ownership Anexo O + lead Anexo J) firmados + F0B evidencia + F1A baseline.  
- **F1B impl** requiere D13.  
- **F3** requiere F2 con `active_topic_id` real (diseño conjunto OK sin migrate).  
- Pack UNSIGNED ⇒ `IMPLEMENTATION_READY = NO`.

---

## Referencias

- Master Plan V2.1 §40, Anexos J/K/N/O  
- `docs/architecture/PERSEO_ARGOS_TRAJECTORY_LOGGING_DESIGN.md` (D13)  
- `docs/plans/PERSEO_RAG_F2_F3_IMPLEMENTATION_BACKLOG.md`
