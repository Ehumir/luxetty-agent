#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { suites } = require("./classifiedSuites");

const root = path.resolve(__dirname, "../..");
const testDir = path.join(root, "test");
const known = new Map();
for (const [suite, files] of Object.entries(suites)) {
  for (const file of files) known.set(file, suite);
}

const rows = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => {
    const file = `test/${name}`;
    let classification = known.get(file);
    if (!classification) {
      if (/staging/i.test(name)) classification = "staging";
      else if (/production|live|canary/i.test(name)) classification = "canary_productivo";
      else if (/argos/i.test(name)) classification = "manual_or_argos_review";
      else classification = "legacy_pending_classification";
    }
    return { file, classification };
  });

const output = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  review_owner: "F2 test owner (assign before merge)",
  review_due: "2026-08-15",
  rows,
};
const reportDir = path.join(root, ".artifacts/test-reports");
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, "suite-classification.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(output, null, 2));
