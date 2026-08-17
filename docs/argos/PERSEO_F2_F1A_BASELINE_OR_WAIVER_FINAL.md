# F1A — final baseline pilot or waiver routes

Version: 1.0  
Date: 2026-07-28  
Current status: **NO ACCEPTED REAL BASELINE / NO SIGNED WAIVER**

Local reports or synthetic tests do not replace either route.

## Route A — minimum real baseline pilot, F2 OFF

### Controlled cohort

- Named authorized users only.
- Labeled test conversations and approved non-sensitive or synthetic data.
- Current runtime and legacy/V3 routing unchanged; all F2 flags remain OFF.
- Controlled messages cover classification, skip, successful retrieval, no-hit,
  domain mismatch, fallback, citation, persistence, and error handling.
- Each run records commit, configuration fingerprint, conversation/message/event
  correlation IDs, owner, start/end, and cleanup record.

### Required measurements

| Area | Evidence |
| --- | --- |
| Routing | classification, skip reason, legacy or V3 path |
| Retrieval | attempted/hit/no-hit, domain, source count |
| Answer | fallback, citation presence and resolvability |
| Reliability | errors, timeouts, persistence success |
| Performance | end-to-end and retrieval latency, including p95 |
| Correlation | message ID → conversation ID → event/query record |
| Privacy | no unapproved PII in evidence; redaction check |

### Acceptance

- Every planned message is correlated end to end.
- All required fields are present or explicitly `not_applicable`.
- Zero P0; zero untreated P1; no cross-conversation or cross-agent exposure.
- No unexpected production credential use by test tooling.
- Retrieval/citation/fallback results are reviewed by ARGOS, Product, and
  Technical owners.
- Evidence manifest is immutable and checksummed.

### Immediate stop

Stop on an unapproved recipient, unexpected write outside the labeled cohort,
PII leakage, broken correlation, cross-scope access, P0 behavior, unexplained P1,
or any indication that an F2 flag is active.

### Cleanup

Record which synthetic artifacts may be removed, which audit events must be
retained, who performed cleanup, before/after counts, and verification that no
real contact or lead was modified.

Sign-off: ARGOS __________ Product __________ Technical __________ Date ________

## Route B — time-bounded waiver

Codex cannot approve this waiver.

```text
WAIVER_ID:
EVIDENCE_MISSING:
WHY_IT_WAS_NOT_OBTAINED:
RESIDUAL_RISK:
COMPENSATING_CONTROLS:
AUTHORIZED_SCOPE:
MAXIMUM_COHORT:
VALID_FROM:
EXPIRES_AT:
RESPONSIBLE_OWNER:
BASELINE_OBLIGATION_DURING_STAGING:
EVIDENCE_DUE_AT:
AUTOMATIC_NO_GO_CONDITIONS:
  - expiration
  - missing owner or signature
  - any P0
  - untreated P1
  - incomplete correlation or telemetry
  - RLS cross-scope exposure
  - scope or cohort exceeded

ARGOS — name/role/signature/date:
PRODUCT — name/role/signature/date:
TECHNICAL — name/role/signature/date:
LEGAL/PRIVACY (if applicable) — name/role/signature/date:
```

An empty required field, indefinite validity, scope stated as “all F2,” or a
missing signature invalidates the waiver. Even a valid waiver requires obtaining
the baseline during isolated staging; failure by `EVIDENCE_DUE_AT` is automatic
NO-GO.
