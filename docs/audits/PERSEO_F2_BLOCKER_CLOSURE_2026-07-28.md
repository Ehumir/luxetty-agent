# PERSEO F2 — Blocker closure evidence

Date: 2026-07-28  
Candidate branch: `codex/f2-certification-integrated`  
Production: not modified  
Verdict: `NO-GO`

## Closed blockers

- The 16 previously failing global test files were corrected without excluding,
  skipping or weakening a suite.
- A complete offline discovery run passed `176/176` test files. The run used
  synthetic OpenAI/Supabase values, blocked external network, and allowed only
  loopback sockets required by local HTTP tests.
- All 15 legacy `SECURITY DEFINER` views were audited and changed to
  `security_invoker=true`.
- Grants on those views were reduced to intentional `SELECT` access.
- Supabase Security Advisor changed from 17 ERROR findings to 0 ERROR findings.
- `cos_feature_flags` now has RLS enabled and forced, has no
  anon/authenticated grants, remains readable by `service_role`, and returns
  HTTP 401 through the staging Data API publishable key.
- PostGIS runtime compatibility remained green:
  `ST_Transform(ST_SetSRID(ST_MakePoint(...), 4326), 3857)` returned a valid
  projected point after the view/COS hardening.
- Issue #120 now requests an explicit `APPROVED` or `REJECTED` for each of
  D1–D3 and does not infer signatures.

## Remaining technical blocker: PostGIS catalog exposure

`public.spatial_ref_sys` is still directly readable by `anon` and
`authenticated`:

- staging Data API probe: HTTP 200 with `[{"srid":2000}]`;
- `has_table_privilege('anon', ..., 'select') = true`;
- `has_table_privilege('authenticated', ..., 'select') = true`;
- owner: `supabase_admin`;
- migration executor: `postgres`;
- `pg_has_role('postgres', 'supabase_admin', 'member') = false`;
- attempts to revoke grants or enable RLS through the supported migration
  channel return `INVALID_ARGUMENT`.

This is not waived. It requires a Supabase administrative action that can run
as `supabase_admin`, or an approved platform-supported relocation/rebuild of
PostGIS. Production was not touched.

## Gates not claimable while the blocker remains

- Commit `9a3fdd1c695bd6ab46fb3d39d7d8d94da7bb6b88` completed three
  consecutive green runs: `176/176 × 3`, with no timed-out, skipped or
  excluded test files. A documentation-only successor commit must repeat this
  gate before being called the frozen final candidate.
- The empty-branch bootstrap has not passed twice; the repository still has
  demonstrated migration-history drift.
- The existing F1A measurement is database retrieval only and does not yet
  correlate message, conversation, event, citation and fallback end to end.
- D1, D2 and D3 remain `PENDING` until authorized humans respond explicitly.
- Full final rehearsal/rollback therefore cannot pass.
- F2-07 and F2-08 remain gated and were not prepared or activated.

## Required external action

On staging project `wpilxldebsmiagsfvyba`, remove direct
`anon`/`authenticated` Data API access to `public.spatial_ref_sys` using a
Supabase-supported administrative path, then provide evidence that:

1. `/rest/v1/spatial_ref_sys?select=srid&limit=1` no longer returns data to the
   publishable key;
2. `ST_Transform` and the current runtime remain functional.

After that action, resume empty-branch bootstrap, F1A end-to-end baseline,
three-run certification, rehearsal/rollback, and only then F2-07/F2-08.
