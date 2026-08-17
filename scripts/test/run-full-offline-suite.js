#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const testRoot = path.join(root, "test");
const bootstrap = path.join(testRoot, "support/isolatedCertificationBootstrap.js");
const repeatArg = process.argv.find((arg) => arg.startsWith("--repeat="));
const repetitions = Number(repeatArg?.split("=")[1] || 1);

function findTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTests(full);
    return entry.isFile() && entry.name.endsWith(".test.js") ? [full] : [];
  });
}

const files = [
  ...findTests(testRoot),
  ...findTests(path.join(root, "conversation")).filter((file) =>
    file.endsWith(".test.js"),
  ),
].sort();

if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  console.error("invalid_repeat_count");
  process.exit(2);
}

const commonGitDir = spawnSync(
  "git",
  ["rev-parse", "--git-common-dir"],
  { cwd: root, encoding: "utf8" },
).stdout.trim();
const primaryRepoRoot = commonGitDir
  ? path.dirname(commonGitDir)
  : root;
const atenaRoot =
  process.env.ATENA_ROOT ||
  path.resolve(primaryRepoRoot, "..", "luxetty-atena");

if (!fs.existsSync(atenaRoot)) {
  console.error(`atena_dependency_missing:${atenaRoot}`);
  process.exit(2);
}

const runs = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const fileResults = [];
  for (const [index, file] of files.entries()) {
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-timeout=30000", file],
      {
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
        ATENA_ROOT: atenaRoot,
        NODE_OPTIONS: `--require=${bootstrap}`,
      },
      encoding: "utf8",
        timeout: 45_000,
      },
    );
    const relativeFile = path.relative(root, file);
    const fileResult = {
      file: relativeFile,
      exit_code: result.status ?? 1,
      timed_out: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    };
    fileResults.push(fileResult);
    if (fileResult.exit_code !== 0 || fileResult.timed_out) {
      console.error(`complete_offline_file_fail:${relativeFile}`);
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
    } else if ((index + 1) % 25 === 0 || index + 1 === files.length) {
      console.log(
        `complete_offline_progress:${repetition}:${index + 1}/${files.length}`,
      );
    }
  }

  const run = {
    repetition,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    exit_code: fileResults.every(
      (result) => result.exit_code === 0 && !result.timed_out,
    )
      ? 0
      : 1,
    timed_out: fileResults.some((result) => result.timed_out),
    files: fileResults,
  };
  runs.push(run);
  if (run.exit_code !== 0 || run.timed_out) break;
}

const report = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  commit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  classification: "complete_offline",
  production_credentials: "not_inherited",
  network: "blocked",
  files,
  repetitions_requested: repetitions,
  repetitions_completed: runs.length,
  all_green:
    runs.length === repetitions &&
    runs.every((run) => run.exit_code === 0 && !run.timed_out),
  runs,
};

const reportDir = path.join(root, ".artifacts/test-reports");
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, "complete-offline.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

console.log(
  `complete_offline:${report.all_green ? "PASS" : "FAIL"}:${runs.length}/${repetitions}`,
);
process.exit(report.all_green ? 0 : 1);
