#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { suites } = require("./classifiedSuites");

const root = path.resolve(__dirname, "../..");
const suiteName = process.argv[2];
const requested = suites[suiteName];

if (!requested) {
  console.error(`unknown_offline_suite:${suiteName || "missing"}`);
  process.exit(2);
}

const missing = requested.filter((file) => !fs.existsSync(path.join(root, file)));
const files = requested.filter((file) => !missing.includes(file));
if (missing.length) {
  console.error(`suite_manifest_missing:${missing.join(",")}`);
  process.exit(2);
}

const bootstrap = path.join(root, "test/support/isolatedCertificationBootstrap.js");
const startedAt = new Date().toISOString();
const started = Date.now();
const result = spawnSync(process.execPath, ["--require", bootstrap, "--test", ...files], {
  cwd: root,
  env: {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    CI: "true",
    NODE_ENV: "test",
    TZ: "UTC",
    PERSEO_TEST_ISOLATED: "true",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-valid",
    OPENAI_API_KEY: "test-openai-key-not-valid",
  },
  encoding: "utf8",
  timeout: 120_000,
});

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

const report = {
  schema_version: "1.0",
  suite: suiteName,
  classification: "mandatory_offline",
  started_at: startedAt,
  duration_ms: Date.now() - started,
  exit_code: result.status ?? 1,
  timed_out: Boolean(result.error && result.error.code === "ETIMEDOUT"),
  network: "blocked",
  production_credentials: "not_inherited",
  files,
};
const reportDir = path.join(root, ".artifacts/test-reports");
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, `${suiteName}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(`classified_suite_report:${suiteName}:${report.exit_code}:${report.duration_ms}`);
process.exit(report.exit_code);
