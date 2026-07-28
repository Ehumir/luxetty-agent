# PERSEO + RAG F2 — precertification authorization report

Date: 2026-07-28  
Version: 1.0  
Final recommendation: **F2 READY WITH TECHNICAL BLOCKERS**

No production write, migration, repair, reindex, deploy, merge, flag activation,
or legacy removal was performed.

## 1. D1–D3

All three decisions remain `PENDING_EXPLICIT_APPROVAL`. Versioned executive cards
are ready, but no signature or acceptance record exists. This independently caps
the outcome at governance blockers.

## 2. F1A baseline or waiver

Neither an accepted real baseline nor a signed waiver exists. Both final routes
are prepared. Codex has not approved either.

## 3. RLS

Branch `codex/f2-04-rls-hardening`, commit `83e9fcb`, contains a new staging
migration for explicit referral scope, removal of unrestricted authenticated
notification inserts, own-scope notification access, service-role operations,
and restricted privileged-function execution. Static tests pass 5/5 and lint is
green. Dynamic actor tests and Data API verification are not accredited because
no isolated database was available.

## 4. Idempotency

- CDC: branch `codex/f2-02-cdc-idempotency`, commit `c785034`; 6/6 tests pass.
- Outbound: branch `codex/f2-03-outbound-idempotency`, commit `39503c6`; 6/6 tests pass.

The contracts cover concurrent claims, retries, partial failures, provider-commit
unknown, duplicate/out-of-order confirmation, compensation/reconciliation, and
single application of commercial side effects. They remain pure contracts with
no runtime wiring.

## 5. Nineteen contactless conversations

Read-only classification, with no PII:

- 7 closed/no-lead: legacy tolerable, retain.
- 1 closed/linked-lead: correctable candidate, manual FK verification required.
- 10 open/no-lead: incomplete, business decision required.
- 1 open/high-volume: high-risk incomplete, priority human review.

No automatic contact inference or reassignment is authorized.

## 6. Fifteen contacts with multiple active leads

Read-only classification found valid multiple intents/listings, three mixed or
duplicate-review groups, and incomplete legacy signatures. No contact merge or
lead closure is authorized. Branch `codex/f2-06-integrity-exceptions`, commit
`3b65d07`, includes record-level classification, SELECT-only dry-runs, and 6/6
tests enforcing non-mutating SQL.

## 7. Migrations

Branch `codex/f2-05-structural-migrations`, commit `44efd7a`, contains three new,
ordered, additive staging migrations for topics/events, show batches/items, and
effect ledgers. They include RLS/grants/indexes and avoid destructive backfill or
`DROP CASCADE`. Static migration tests pass 5/5. Historical `DO_NOT_APPLY`
artifacts remain untouched.

Duration, observed locks, affected rows, before/after size, repeat execution,
partial-failure behavior, and recovery remain unmeasured because the migrations
were not applied to an isolated database. Docker/Podman was unavailable locally.

## 8. Global suite

Branch `codex/prepare-isolated-certification-suite`, commits `400f6ef` and
`2423a96`, provides explicit commands for unit, contracts, integration, RAG P0,
F2, ARGOS offline, staging, and canary classes. Offline precertification passed
three consecutive runs:

- 190 tests per run; 570 total;
- P0, F2, contracts, unit, integration, and ARGOS-offline all green;
- zero hangs and zero network/production credentials;
- automated classification/report artifacts;
- staging and canary commands fail closed unless an explicit isolated nonprod
  target and runner are configured.

The three-run evidence does not yet combine commits from all isolated F2 branches,
so the integrated commit remains unaccredited.

## 9. Rehearsal

Not authorized and not executed. Entry gates failed simultaneously: unsigned
D1–D3, no accepted baseline/waiver, no dynamic RLS review, migrations not proven
on a disposable database, no snapshot, no named human owner, and no integrated
green commit.

## 10. Rollback

A 26-control rehearsal and rollback procedure is prepared. Actual rollback result:
**NOT EXECUTED**. Therefore runtime/schema rollback cannot be certified.

## 11. Wiring

PR-F2-07 was intentionally not prepared: its explicit prerequisites require
reviewed contracts, reproducible migrations, green integrated tests, and available
staging. No production runtime was connected and all flags remain unchanged.
PR-F2-08 telemetry/canary is likewise deferred.

## 12. Residual risks

| ID | Severity | Risk | Closure evidence |
| --- | --- | --- | --- |
| G-01 | P1 | D1–D3 unsigned | auditable approvals |
| G-02 | P1 | no accepted F1A baseline/waiver | signed pilot evidence or valid waiver |
| T-01 | P0 gate | RLS actor matrix not dynamically tested | isolated role/Data API report |
| T-02 | P0 gate | migrations not rehearsed or rolled back | controls 1–26 PASS |
| T-03 | P1 | isolated branches not tested as one commit | integrated 3× green report |
| T-04 | P1 | integrity exceptions need owners | signed disposition; no auto repair |
| T-05 | P2 | staging/canary runners intentionally unconfigured | isolated project and runner |
| T-06 | P2 | GitHub authentication invalid | restored CLI/app authorization |

No new verified production incident was introduced by this work. `P0 gate`
means a missing safety accreditation, not evidence that production is failing.

## 13. Evidence and local commits

| PR order | Local branch | Commit | State |
| --- | --- | --- | --- |
| F2-01 | `codex/prepare-isolated-certification-suite` | `400f6ef`, `2423a96` | locally reviewable |
| F2-02 | `codex/f2-02-cdc-idempotency` | `c785034` | locally reviewable |
| F2-03 | `codex/f2-03-outbound-idempotency` | `39503c6` | locally reviewable |
| F2-04 | `codex/f2-04-rls-hardening` | `83e9fcb` | static evidence only |
| F2-05 | `codex/f2-05-structural-migrations` | `44efd7a` | static evidence only |
| F2-06 | `codex/f2-06-integrity-exceptions` | `3b65d07` | locally reviewable |
| F2-07 | — | — | gated; not prepared |
| F2-08 | — | — | gated; not prepared |
| F2-09 | `codex/f2-09-precertification-evidence` | this branch HEAD | prepared, not executed |

No branch was pushed and no GitHub PR was opened because the available GitHub
authentication is invalid. This does not authorize bypassing review.

## 14. Required next changes

1. Obtain auditable D1–D3 decisions.
2. Execute and sign the F1A pilot, or obtain a valid time-bounded waiver.
3. Restore GitHub authentication and publish F2-01 through F2-06 and F2-09 in
   order for review.
4. Build an integration branch from reviewed commits and run offline gates 3×.
5. Provide an isolated Supabase project, snapshot, staging-only credentials, and
   named rehearsal owners.
6. Execute role/Data API tests, migrations, all 26 controls, and actual rollback.
7. Only after those PASS, prepare F2-07 wiring behind OFF flags and F2-08 canary.

## 15. Authorization recommendation

**F2 READY WITH TECHNICAL BLOCKERS**

The versioned technical preparation is materially advanced, but authorization to
apply F2 is not recommended. Governance signatures are absent and essential
database, integrated-suite, staging, and rollback evidence does not yet exist.
