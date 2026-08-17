# F2 isolated staging rehearsal — 26 controls

Version: 1.0  
Status: **PREPARED — NOT EXECUTED**  
Forbidden target: production

## Simultaneous entry gate

| Gate | Current result |
| --- | --- |
| D1–D3 signed or explicitly not required for rehearsal | FAIL — unsigned |
| RLS prepared and reviewed with actor tests | FAIL — static review only |
| Ordered migrations reproducible on a disposable database | FAIL — not applied dynamically |
| P0 and F2 suites green on the integrated commit | FAIL — isolated branches only |
| Staging proves no production credentials | NOT VERIFIED |
| Snapshot confirmed | NOT AVAILABLE |
| Rollback documented | PASS — procedure prepared |
| No open P0 | NOT ACCREDITED |
| Human rehearsal owner present | NOT RECORDED |

**Stop decision:** do not create or mutate a Supabase staging database until all
rows pass at the same time.

## Evidence record for every control

Capture owner, exact commit, migration set/checksums, start/end timestamps,
commands, redacted output, result, incident, and rollback point.

1. Record D1–D3 approvals or an explicit signed rehearsal-only exemption.
2. Record an accepted F1A baseline or valid waiver.
3. Identify the isolated project ref and prove it is not production.
4. Verify staging-only secrets by presence/fingerprint, never by logging values.
5. Name Engineering, ARGOS, Ops, security reviewer, and incident channel.
6. Confirm snapshot/restore point and the rollback clock owner.
7. Export initial schema, migration history, grants, policies, functions,
   triggers, indexes, sizes, and row counts without PII.
8. Run preflight for nulls, duplicate signatures, available space, long
   transactions, and lock conflicts.
9. Apply the ordered versioned migrations with statement and lock timeouts.
10. Re-run migration tooling and prove no duplicate application or schema drift.
11. Record duration, locks, affected rows, and size delta per migration.
12. Execute the RLS role/operation matrix: admin, in-scope supervisor, assigned
    agent, unassigned agent, unrelated authenticated user, anon, and service.
13. Test illegal reassignment and cross-agent/cross-office access; both must fail.
14. Verify grants, Data API exposure, privileged functions, and security/performance
    advisors against the expected diff.
15. Load synthetic representative legacy/topic/batch fixtures with no production PII.
16. Validate lazy backfill behavior; do not run a bulk production-style backfill.
17. Run integrity and idempotency races for topic, source, chunk, embedding,
    event, notification, task, CDC, and outbound effects.
18. Validate topic lifecycle and the one-OPEN constraint under concurrency.
19. Validate `show_batch`, first/second/last/previous/that/other references, and
    inventory/property consistency.
20. Validate `TurnContextPack` size, redaction, citations, fail-closed, and
    deterministic fallback.
21. Validate RAG classification, skip, retrieval, domain, latency, errors,
    citations, persistence, and full event correlation.
22. Validate capture, assisted valuation, CRM gate, and zero writes from RAG.
23. Inject partial failures, provider-commit-unknown, timeout, duplicate webhook,
    duplicate event, concurrent worker, and out-of-order state transitions.
24. Run the old runtime unchanged against the additive schema.
25. Run the new runtime behind OFF-by-default flags, then test kill switch and
    return to the old runtime without deleting data.
26. Execute full rollback, target under 15 minutes, then verify messages,
    conversations, created topics, RLS isolation, telemetry recovery, integrity,
    and post-rollback smoke tests.

## Rollback principles

- Flags OFF first; stop CDC/outbound claims safely.
- Restore the previous deployment only in isolated staging.
- Prefer forward-fix for additive schema; never use `DROP CASCADE`.
- Preserve messages, conversations, topics, ledgers, and audit history.
- A destructive restore is incident-only and requires separate human authority.

The rehearsal is PASS only if control 26 is actually executed and chronological
evidence shows functional rollback in less than 15 minutes or records an
explicitly accepted deviation.
