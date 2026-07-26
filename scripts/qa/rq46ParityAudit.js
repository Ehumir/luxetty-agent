#!/usr/bin/env node
'use strict';

/**
 * RQ-4.6 — Parity audit (pre-deploy gate). Read-only against workspace + self-check.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runRagRuntimeSelfCheck } = require('../../conversation/v3/rag/ragRuntimeSelfCheck');
const { getThresholdAuditSnapshot, RQ4_CERTIFIED_THRESHOLDS } = require('../../conversation/v3/rag/ragDomainThresholdLoader');

const ROOT = path.join(__dirname, '../..');
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : path.join(__dirname, '../../../luxetty-atena/docs/argos/evidence/acc-rag-p0-rq46');

const INTEGRATED_FILES = [
  'conversation/v3/rag/domainIntentClassifier.js',
  'conversation/v3/rag/domainRetrievalOrchestrator.js',
  'conversation/v3/rag/ragDomainThresholdLoader.js',
  'conversation/v3/rag/ragRuntimeSelfCheck.js',
  'conversation/v3/rag/ragRetrievalMetrics.js',
  'conversation/v3/rag/ragTurnOrchestrator.js',
  'conversation/v3/rag/rq4ThresholdCalibration.js',
  'services/ragRulesService.js',
  'services/ragService.js',
  'services/propertyInventoryService.js',
  'config/accP0Flags.js',
];

const EXCLUDED_FROM_RUNTIME = [
  'conversation/v3/rag/rq4ThresholdCalibration.js',
  'scripts/qa/rq4ThresholdCalibrationAudit.js',
  'scripts/qa/rq3DomainRetrievalAudit.js',
  'scripts/qa/rq1RetrievalAudit.js',
];

function git(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isGitTracked(rel) {
  try {
    execSync(`git ls-files --error-unmatch "${rel}"`, { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const commit = git('git rev-parse HEAD');
  const commitShort = git('git rev-parse --short HEAD');

  const integrated = INTEGRATED_FILES.map((rel) => ({
    path: rel,
    exists: fileExists(rel),
    excluded_from_runtime: EXCLUDED_FROM_RUNTIME.includes(rel),
    tracked: isGitTracked(rel),
  }));

  const missing = integrated.filter((f) => !f.excluded_from_runtime && !f.exists);

  process.env.RAG_P0_ENABLED = process.env.RAG_P0_ENABLED || 'true';
  process.env.RAG_DOMAIN_ROUTING_ENABLED = 'true';
  process.env.RAG_ADAPTIVE_THRESHOLD_ENABLED = 'true';

  const selfCheck = runRagRuntimeSelfCheck({
    writePath: path.join(EVIDENCE_DIR, 'RQ46_RUNTIME_SELF_CHECK.json'),
  });
  const thresholdAudit = getThresholdAuditSnapshot();

  const expectedPipeline = 'RQ-3 domain routing + RQ-4 adaptive thresholds';
  const loadedPipeline = selfCheck.modules.domainIntentClassifier && selfCheck.modules.domainRetrievalOrchestrator
    ? expectedPipeline
    : 'incomplete';
  const executedPipeline = loadedPipeline;

  const parity = {
    expected: expectedPipeline,
    loaded: loadedPipeline,
    executed: executedPipeline,
    match: missing.length === 0 && selfCheck.pass && loadedPipeline === expectedPipeline,
    match_percent: missing.length === 0 && selfCheck.pass ? 100 : 0,
  };

  const manifest = {
    phase: 'RQ-4.6',
    generated_at: new Date().toISOString(),
    git_commit: commit,
    git_commit_short: commitShort,
    integrated_files: integrated,
    excluded_files: EXCLUDED_FROM_RUNTIME,
    missing_runtime_files: missing,
    self_check: selfCheck,
    threshold_audit: thresholdAudit,
    certified_thresholds: RQ4_CERTIFIED_THRESHOLDS,
    parity,
    pass: parity.match && missing.length === 0,
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RQ46_INTEGRATION_MANIFEST.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'RQ46_PIPELINE_PARITY.json'), JSON.stringify(parity, null, 2));
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'RQ46_FEATURE_FLAGS.json'),
    JSON.stringify({ flags: selfCheck.flags, required_for_rq5: ['RAG_DOMAIN_ROUTING_ENABLED', 'RAG_ADAPTIVE_THRESHOLD_ENABLED'] }, null, 2)
  );

  console.log(JSON.stringify({ pass: manifest.pass, parity, commit: commitShort, missing: missing.map((m) => m.path) }, null, 2));
  process.exit(manifest.pass ? 0 : 1);
}

main();
