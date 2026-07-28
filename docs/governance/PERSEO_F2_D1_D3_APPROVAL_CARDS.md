# PERSEO F2 — fichas ejecutivas D1–D3

Version: 1.0  
Date: 2026-07-28  
Status: **UNSIGNED — NO AUTHORIZATION**

These cards record one principal recommendation each. A recommendation is not a
signature. F2 remains blocked until every required approver records name, role,
decision, date, and acceptance evidence.

## D1 — one OPEN topic per conversation

| Field | Record |
| --- | --- |
| Exact decision | Approve a maximum of one `OPEN` topic per conversation; allow historical `PAUSED`, `CLOSED`, and `ARCHIVED` topics. |
| Recommended option | Approve the decision as written. |
| Business reason | Prevent mixing objectives, properties, and leads while retaining history. |
| Technical impact | Partial unique constraint; deterministic topic resolver; audited switch on material intent change. |
| Accepted risks | More explicit pauses/switches when a person alternates objectives. |
| Discarded alternatives | Multiple simultaneous OPEN topics require a selector and create ambiguous writes; unlimited OPEN topics are rejected. |
| Reversibility | Reversible by a later migration and resolver change; historical events remain. |
| Required approver | Product Director and Technical Director. |
| Acceptance record | **PENDING** — name, role, option, comment, and evidence link/checksum. |
| Approval date | **PENDING** |
| Document version | 1.0 |

Decision: ☐ approved ☐ rejected ☐ returned for changes  
Product name/role/signature/date: ______________________________  
Technical name/role/signature/date: _____________________________

## D2 — CRM gate for lead creation or reuse

| Field | Record |
| --- | --- |
| Exact decision | Create or reuse a lead only through the CRM gate when operation and role are clear, at least one of zone, budget, or property is known, and minimum identity is available. |
| Recommended option | Approve the decision as written; keep `topic.lead_id` nullable before the gate. |
| Business reason | Reduce unqualified or duplicate leads without losing early informational intent. |
| Technical impact | Topic resolution precedes the idempotent CRM gate; ambiguous matches fail closed for human clarification. |
| Accepted risks | A strict threshold can delay CRM readiness and must be measured. |
| Discarded alternatives | First-message creation produces noise; advisor-only creation loses automated qualified demand. |
| Reversibility | Threshold is configuration/contract driven and can be revised without deleting historical leads. |
| Required approver | Product, CRM/Ops, and Technical. |
| Acceptance record | **PENDING** — name, role, option, comment, and evidence link/checksum. |
| Approval date | **PENDING** |
| Document version | 1.0 |

Decision: ☐ approved ☐ rejected ☐ returned for changes  
Product name/role/signature/date: ______________________________  
CRM/Ops name/role/signature/date: ______________________________  
Technical name/role/signature/date: _____________________________

## D3 — configurable inactivity lifecycle

| Field | Record |
| --- | --- |
| Exact decision | Use initial configurable thresholds of 24 hours to pause, 72 hours to close, and 30 days to archive, evaluated in `America/Monterrey`; do not hardcode them. |
| Recommended option | Approve these values for the initial staging rehearsal and canary, subject to measured adjustment. |
| Business reason | Limit stale context while preserving a controlled return path. |
| Technical impact | Idempotent lifecycle job, timestamps and reason events; legacy conversations are not closed by this job. |
| Accepted risks | Weekends or long purchase cycles can cause premature closure and extra reconfirmation. |
| Discarded alternatives | Manual-only lifecycle leaves zombie topics; unspecified values make testing and operations nondeterministic. |
| Reversibility | Values are fully reversible by configuration; emitted audit history remains immutable. |
| Required approver | Product and Operations. |
| Acceptance record | **PENDING** — name, role, option, comment, and evidence link/checksum. |
| Approval date | **PENDING** |
| Document version | 1.0 |

Decision: ☐ approved ☐ rejected ☐ returned for changes  
Product name/role/signature/date: ______________________________  
Operations name/role/signature/date: ___________________________

## Closure rule

`D1`, `D2`, and `D3` stay `PENDING_EXPLICIT_APPROVAL` until the completed record
is stored in an auditable system. Codex cannot sign or approve these decisions.
