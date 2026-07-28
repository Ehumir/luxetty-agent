"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrations = path.resolve(__dirname, "../supabase/migrations");
const migrationName = fs
  .readdirSync(migrations)
  .find((name) => name.endsWith("_f2_04_rls_hardening.sql"));
const sql = fs.readFileSync(path.join(migrations, migrationName), "utf8");

test("RLS hardening denies anon and unrestricted authenticated writes", () => {
  assert.match(sql, /revoke all on table public\.conversation_referrals from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.notifications from public, anon/i);
  assert.match(sql, /revoke insert, delete, truncate, references, trigger[\s\S]*from authenticated/i);
  const authenticatedPolicies = [
    sql.slice(
      sql.indexOf("create policy conversation_referrals_scoped_select"),
      sql.indexOf("create policy conversation_referrals_service_write"),
    ),
    sql.slice(
      sql.indexOf('create policy "Users see own notifications"'),
      sql.indexOf("create policy notifications_service_write"),
    ),
  ].join("\n");
  assert.doesNotMatch(authenticatedPolicies, /with check\s*\(\s*true\s*\)/i);
});

test("referral reads require admin, assigned agent or managed scope", () => {
  assert.match(sql, /public\.is_admin\(\)/);
  assert.match(sql, /assigned_agent_profile_id = \(select public\.get_my_agent_profile_id\(\)\)/);
  assert.match(sql, /public\.can_manage_agent_profile\(c\.assigned_agent_profile_id\)/);
  assert.match(sql, /for select\s+to authenticated\s+using/i);
});

test("notification update has USING and WITH CHECK bound to auth uid", () => {
  const start = sql.indexOf('create policy "Users mark own notifications read"');
  const end = sql.indexOf("create policy notifications_service_write", start);
  const policy = sql.slice(start, end);
  assert.match(policy, /for update/i);
  assert.match(policy, /using \(\(select auth\.uid\(\)\)/i);
  assert.match(policy, /with check \(\(select auth\.uid\(\)\)/i);
});

test("privileged notification function is not exposed through Data API roles", () => {
  assert.match(sql, /revoke all on function %s from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function %s to service_role/i);
  assert.doesNotMatch(sql, /security definer/i);
});

test("migration has bounded locks and no destructive cascade", () => {
  assert.match(sql, /set lock_timeout = '5s'/i);
  assert.match(sql, /set statement_timeout = '60s'/i);
  assert.doesNotMatch(sql, /drop\s+(table|schema)[\s\S]*cascade/i);
});
