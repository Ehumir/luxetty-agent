'use strict';

/**
 * RQ-4.6 — Self-check interno al boot (sin secretos).
 */

const fs = require('fs');
const path = require('path');
const { isRagDomainRoutingEnabled, isRagAdaptiveThresholdEnabled, getAccRagP0FlagSnapshot } = require('../../../config/accP0Flags');
const { getThresholdAuditSnapshot } = require('./ragDomainThresholdLoader');

function moduleLoadOk(relPath) {
  try {
    require.resolve(relPath);
    require(relPath);
    return true;
  } catch {
    return false;
  }
}

function runRagRuntimeSelfCheck({ writePath = null } = {}) {
  const classifierOk = moduleLoadOk('./domainIntentClassifier');
  const orchestratorOk = moduleLoadOk('./domainRetrievalOrchestrator');
  const loaderOk = moduleLoadOk('./ragDomainThresholdLoader');
  const thresholdAudit = getThresholdAuditSnapshot();

  const report = {
    generated_at: new Date().toISOString(),
    phase: 'RQ-4.6',
    flags: {
      ...getAccRagP0FlagSnapshot(),
      RAG_DOMAIN_ROUTING_ENABLED: isRagDomainRoutingEnabled(),
      RAG_ADAPTIVE_THRESHOLD_ENABLED: isRagAdaptiveThresholdEnabled(),
    },
    modules: {
      domainIntentClassifier: classifierOk,
      domainRetrievalOrchestrator: orchestratorOk,
      ragDomainThresholdLoader: loaderOk,
    },
    thresholds: thresholdAudit,
    domain_routing_active: isRagDomainRoutingEnabled() && classifierOk && orchestratorOk,
    adaptive_threshold_active: isRagAdaptiveThresholdEnabled() && loaderOk && thresholdAudit.domain_count > 0,
    telemetry_active: isRagDomainRoutingEnabled(),
    checks: {
      classifier_loaded: classifierOk,
      orchestrator_loaded: orchestratorOk,
      thresholds_loaded: loaderOk && (thresholdAudit.domain_count > 0 || !isRagAdaptiveThresholdEnabled()),
      domain_routing_active: isRagDomainRoutingEnabled() ? classifierOk && orchestratorOk : true,
      loader_correct: loaderOk,
    },
    pass: classifierOk && orchestratorOk && loaderOk,
  };

  if (writePath) {
    try {
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, JSON.stringify(report, null, 2));
    } catch {
      /* non-fatal */
    }
  }

  return report;
}

module.exports = {
  runRagRuntimeSelfCheck,
};
