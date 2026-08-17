#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const suites = ["unit", "contracts", "integration", "rag-p0", "f2", "argos-offline"];
const runs = [];

for (let repetition = 1; repetition <= 3; repetition += 1) {
  const run = { repetition, suites: [] };
  for (const suite of suites) {
    const result = spawnSync(process.execPath, ["scripts/test/run-classified-suite.js", suite], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 180_000,
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    run.suites.push({ suite, exit_code: result.status ?? 1 });
    if ((result.status ?? 1) !== 0) {
      runs.push(run);
      writeSummary();
      process.exit(result.status ?? 1);
    }
  }
  runs.push(run);
}

writeSummary();
process.exit(0);

function writeSummary() {
  const output = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    repetitions_requested: 3,
    repetitions_completed: runs.length,
    all_equal_and_green:
      runs.length === 3 &&
      runs.every((run) => run.suites.length === suites.length) &&
      runs.every((run) => run.suites.every((suite) => suite.exit_code === 0)),
    runs,
  };
  const reportDir = path.join(root, ".artifacts/test-reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "precertification-3x.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(`precertification_3x:${output.all_equal_and_green ? "PASS" : "FAIL"}`);
}
