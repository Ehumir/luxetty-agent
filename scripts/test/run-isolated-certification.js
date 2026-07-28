#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const bootstrap = path.join(root, "test/support/isolatedCertificationBootstrap.js");
const tests = [
  "test/isolatedEnvironment.test.js",
  "test/domainIntentClassifier.test.js",
  "test/domainRetrievalOrchestrator.test.js",
  "test/inventoryOptionsAndBuySide.test.js",
  "test/propertyInventoryEndToEnd.test.js",
  "test/propertyInventoryService.test.js",
  "test/ragAccP0.test.js",
  "test/ragCanaryP0.test.js",
  "test/ragDomainThresholdLoader.test.js",
  "test/ragInventoryService.test.js",
  "test/ragPremiumConsultivo.test.js",
  "test/ragPrimerMundoP2P5.test.js",
  "test/ragQualityP0.test.js",
  "test/ragRetrievalMetrics.test.js",
  "test/ragRulesService.test.js",
  "test/ragRuntimeIntegration.test.js",
  "test/ragService.test.js",
  "test/retrievalTurnClassification.test.js",
];

const cleanEnv = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  CI: "true",
  NODE_ENV: "test",
  TZ: "UTC",
  PERSEO_TEST_ISOLATED: "true",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-valid",
  OPENAI_API_KEY: "test-openai-key-not-valid",
};

const result = spawnSync(
  process.execPath,
  ["--require", bootstrap, "--test", ...tests],
  {
    cwd: root,
    env: cleanEnv,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`isolated_certification_spawn_failed:${result.error.name}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
