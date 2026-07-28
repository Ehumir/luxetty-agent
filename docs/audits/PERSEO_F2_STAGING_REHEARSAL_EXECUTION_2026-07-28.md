# PERSEO F2 — Staging rehearsal execution

Date: 2026-07-28  
Environment: Supabase branch `agata-prop01-staging-v2` (`wpilxldebsmiagsfvyba`)  
Production project: not modified  
Verdict: `NO-GO`

## Scope executed

The rehearsal applied the F2-04 and F2-05 migrations to the isolated staging
branch, exercised RLS through database actors and the Data API, tested CDC and
outbound idempotency, measured an F1A database retrieval baseline, and removed
all synthetic fixtures.

Applied migrations:

1. `f2_04_rls_hardening`
2. `f2_04_conversation_scope_select`
3. `f2_05_topics_and_events`
4. `f2_05_show_batches`
5. `f2_05_effect_ledgers`
6. `f2_05_advisor_fixes`

## Dynamic authorization results

| Actor | In-scope conversation/referral | Own notification | Cross-agent data |
| --- | ---: | ---: | ---: |
| Administrator | allowed | allowed | allowed by role |
| Supervisor in scope | allowed | not applicable | denied outside scope |
| Assigned agent | allowed | allowed | denied |
| Unassigned agent | denied | denied | denied |
| Unrelated coordinator | denied | denied | denied |
| Service role | allowed | allowed | allowed for internal processing |
| Anonymous | denied | denied | denied |

Authenticated users were also denied referral INSERT/UPDATE/DELETE, notification
INSERT, and conversation writes. The service role retained the required write
privileges.

Data API probes with the staging publishable key returned HTTP 401 for anonymous
reads of `conversation_referrals` and `notifications`.

New F2 tables were tested dynamically: the assigned agent could read the
synthetic topic, event, show batch and batch item; an unassigned agent received
zero rows for all four resources.

## Idempotency results

- Duplicate OPEN-topic creation retained one OPEN topic.
- Duplicate topic event retained one event.
- Duplicate show-batch and show-item operations retained one row each.
- Duplicate CDC composite key retained one ledger row.
- CDC deactivation and reactivation produced the expected versioned final state.
- Duplicate outbound idempotency key retained one ledger row.
- Outbound state progressed `provider_unknown -> sent -> confirmed`.
- Duplicate outbound side effects retained one effect.

## Rollback and data preservation

All synthetic referrals, notifications, messages, conversations, topics, topic
events, show batches, show items, CDC ledgers and outbound ledgers were deleted.

Baseline and post-cleanup counts matched:

- `conversations`: 92 before, 92 after.
- `conversation_messages`: 2456 before, 2456 after.
- Remaining synthetic topics: 0.
- Remaining synthetic CDC rows: 0.
- Remaining synthetic outbound rows: 0.

The additive schema and RLS forward-fix remain on the isolated staging branch.
No production migration, deployment, flag activation, reindex or data write was
performed.

## F1A baseline

Five controlled retrieval queries were executed against the existing staging
knowledge store with F2 runtime wiring disabled:

- retrieval rows: 17;
- top hits: 5;
- average similarity: 0.866972;
- domains represented: 3;
- source types represented: 3;
- execution time: 121.717 ms total, approximately 24.3 ms/query;
- shared blocks: 58,284 hits, 0 reads, 0 writes, 0 temp.

This is a real database-retrieval baseline. It is not an end-to-end runtime
baseline correlating message, conversation, event, citation and fallback.

## Blocking evidence

1. The complete offline suite enumerated 176 test files and finished with 160
   green files and 16 red files. Therefore a 3x green run on one commit does not
   exist.
2. The red files include P0 ARGOS/flexibility, handoff, media, replay and
   conversation-integrity assertions. They are not excluded or waived.
3. Supabase security advisors on the staging baseline report 17 ERROR findings
   and 375 WARN findings, predominantly legacy `SECURITY DEFINER` views.
4. RLS is disabled on `public.cos_feature_flags` and
   `public.spatial_ref_sys`. No policy was invented or applied because the
   intended access model has not been approved.
5. A newly created data-less branch
   `f2-certification-staging-20260728` (`ctakkchudihqairfeavb`) failed its
   migration bootstrap, demonstrating production schema/migration-history
   drift.
6. D1, D2 and D3 remain unsigned.
7. The F1A evidence does not yet cover end-to-end runtime correlation.

Because the rehearsal is not green, F2-07 runtime wiring and F2-08
telemetry/canary were not prepared or activated. Their explicit prerequisite in
the authorization was not met.

