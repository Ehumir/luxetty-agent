"use strict";

const suites = Object.freeze({
  unit: [
    "test/moneyParserPhoneGuard.test.js",
    "test/domainIntentClassifier.test.js",
    "test/retrievalTurnClassification.test.js",
    "test/ragRetrievalMetrics.test.js",
    "test/ragDomainThresholdLoader.test.js",
    "test/zoneEntityValidation.test.js",
  ],
  contracts: [
    "test/conversationOpeningContract.test.js",
    "test/minimumConversationContract.test.js",
    "test/v3F1Contracts.test.js",
    "conversation/v3/context/turnContextPack.contract.test.js",
  ],
  integration: [
    "test/domainRetrievalOrchestrator.test.js",
    "test/inventoryOptionsAndBuySide.test.js",
    "test/propertyInventoryEndToEnd.test.js",
    "test/propertyInventoryService.test.js",
    "test/ragRuntimeIntegration.test.js",
  ],
  "rag-p0": [
    "test/ragAccP0.test.js",
    "test/ragCanaryP0.test.js",
    "test/ragQualityP0.test.js",
    "test/ragRulesService.test.js",
    "test/ragService.test.js",
  ],
  f2: [
    "test/v3F21StateComposer.test.js",
    "test/v3F22Robustness.test.js",
    "test/v3F23Occupancy.test.js",
    "test/v3F2Conversation.test.js",
  ],
  "argos-offline": [
    "test/argosAntiLoop.test.js",
    "test/argosCorpusGovernance.test.js",
    "test/argosDryRunNoWrites.test.js",
    "test/argosMustNotValidator.test.js",
    "test/argosOwnershipRules.test.js",
    "test/argosPreviewParity.test.js",
  ],
});

module.exports = { suites };
