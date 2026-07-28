'use strict';

const CONVERSATION_CLASSES = Object.freeze({
  LEGACY_TOLERABLE: 'legacy_tolerable',
  CORRECTABLE_CANDIDATE: 'correctable_candidate',
  INCOMPLETE_REVIEW: 'incomplete_review',
  HIGH_RISK_REVIEW: 'high_risk_review',
});

const LEAD_CLASSES = Object.freeze({
  VALID_MULTIPLE_INTENTS: 'valid_multiple_intents',
  DUPLICATE_CANDIDATE: 'duplicate_candidate',
  OWNERSHIP_CONFLICT_REVIEW: 'ownership_conflict_review',
});

function classifyContactlessConversation({
  status,
  hasLead,
  inboundMessageCount = 0,
}) {
  if (status === 'closed' && hasLead) {
    return CONVERSATION_CLASSES.CORRECTABLE_CANDIDATE;
  }
  if (status === 'closed') {
    return CONVERSATION_CLASSES.LEGACY_TOLERABLE;
  }
  if (inboundMessageCount >= 50) {
    return CONVERSATION_CLASSES.HIGH_RISK_REVIEW;
  }
  return CONVERSATION_CLASSES.INCOMPLETE_REVIEW;
}

function classifyActiveLeadGroup({
  activeCount,
  businessSignatureCount,
  ownerCount = 1,
}) {
  if (businessSignatureCount < activeCount && ownerCount > 1) {
    return LEAD_CLASSES.OWNERSHIP_CONFLICT_REVIEW;
  }
  if (businessSignatureCount < activeCount) {
    return LEAD_CLASSES.DUPLICATE_CANDIDATE;
  }
  return LEAD_CLASSES.VALID_MULTIPLE_INTENTS;
}

module.exports = {
  CONVERSATION_CLASSES,
  LEAD_CLASSES,
  classifyContactlessConversation,
  classifyActiveLeadGroup,
};
