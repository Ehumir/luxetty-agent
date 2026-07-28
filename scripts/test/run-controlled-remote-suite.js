#!/usr/bin/env node
"use strict";

const target = process.argv[2];
const allowName = target === "staging" ? "PERSEO_ALLOW_STAGING_TESTS" : "PERSEO_ALLOW_CANARY_TESTS";
const projectRef = process.env.SUPABASE_PROJECT_REF || "";
const productionRef = process.env.PRODUCTION_SUPABASE_PROJECT_REF || "";

if (!["staging", "canary"].includes(target)) {
  console.error("remote_suite_target_invalid");
  process.exit(2);
}
if (process.env[allowName] !== "true") {
  console.error(`remote_suite_blocked:${allowName}_must_equal_true`);
  process.exit(2);
}
if (!projectRef || (productionRef && projectRef === productionRef)) {
  console.error("remote_suite_blocked:isolated_nonproduction_project_required");
  process.exit(2);
}

console.error(
  `remote_suite_preflight_only:${target}:configure_explicit_scenario_runner_after_human_gate`,
);
process.exit(2);
