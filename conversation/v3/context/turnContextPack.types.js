'use strict';

/**
 * TurnContextPackV1 — scaffolding types / shape constants (F3 design).
 * NOT WIRED into index.js or conversation/v3/index.js.
 *
 * @typedef {Object} TurnContextPackConversation
 * @property {string|null} conversationId
 * @property {string|null} contactId
 * @property {string|null} channel
 * @property {string|null} currentTurnId
 *
 * @typedef {Object} TurnContextPackTopic
 * @property {string|null} activeTopicId
 * @property {'OPEN'|'PAUSED'|'CLOSED'|'ARCHIVED'|null} lifecycle
 * @property {'AI'|'HUMAN'|'MIXED'|null} controlMode
 * @property {string|null} handoffState
 * @property {string|null} leadId
 *
 * @typedef {Object} TurnContextPackIntent
 * @property {string|null} primary
 *
 * @typedef {Object} TurnContextPackSlots
 * @property {Object} confirmed
 * @property {string[]} missing
 *
 * @typedef {Object} TurnContextPackPropertyContext
 * @property {Object|null} activeProperty
 *
 * @typedef {Object} TurnContextPackInventory
 * @property {boolean} searched
 * @property {number|null} count
 * @property {Object[]} options
 *
 * @typedef {Object} TurnContextPackPolicy
 * @property {string[]} mustNot
 *
 * @typedef {Object} TurnContextPackOrchestration
 * @property {string|null} nextBestAction
 *
 * @typedef {Object} TurnContextPackHistory
 * @property {Object|null} activeTopicSummary
 *
 * @typedef {Object} TurnContextPackDegrade
 * @property {boolean} [rag]
 * @property {boolean} [comparables]
 * @property {boolean} [zone]
 * @property {boolean} [media]
 * @property {boolean} [journey]
 * @property {boolean} [topic]
 *
 * @typedef {Object} TurnContextPackV1
 * @property {'TurnContextPackV1'} version
 * @property {TurnContextPackConversation} conversation
 * @property {TurnContextPackTopic} topic
 * @property {TurnContextPackIntent} intent
 * @property {TurnContextPackSlots} slots
 * @property {TurnContextPackPolicy} policy
 * @property {TurnContextPackInventory|null} inventory
 * @property {TurnContextPackPropertyContext|null} propertyContext
 * @property {TurnContextPackOrchestration} orchestration
 * @property {TurnContextPackHistory} history
 * @property {Object[]} topicProperties
 * @property {TurnContextPackDegrade} degrade
 * @property {string[]} decisionCodes
 * @property {boolean} valid
 * @property {string[]} validationErrors
 */

const TURN_CONTEXT_PACK_VERSION = 'TurnContextPackV1';

const TOPIC_LIFECYCLES = Object.freeze(['OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED']);
const CONTROL_MODES = Object.freeze(['AI', 'HUMAN', 'MIXED']);

const EMPTY_PACK_SHAPE = Object.freeze({
  version: TURN_CONTEXT_PACK_VERSION,
  conversation: Object.freeze({
    conversationId: null,
    contactId: null,
    channel: null,
    currentTurnId: null,
  }),
  topic: Object.freeze({
    activeTopicId: null,
    lifecycle: null,
    controlMode: null,
    handoffState: null,
    leadId: null,
  }),
  intent: Object.freeze({ primary: null }),
  slots: Object.freeze({ confirmed: Object.freeze({}), missing: Object.freeze([]) }),
  policy: Object.freeze({ mustNot: Object.freeze([]) }),
  inventory: null,
  propertyContext: null,
  orchestration: Object.freeze({ nextBestAction: null }),
  history: Object.freeze({ activeTopicSummary: null }),
  topicProperties: Object.freeze([]),
  degrade: Object.freeze({}),
  decisionCodes: Object.freeze([]),
  valid: false,
  validationErrors: Object.freeze([]),
});

/**
 * Minimal fail-closed validator (pure; no DB).
 * @param {Partial<TurnContextPackV1>|null|undefined} pack
 * @returns {{ ok: boolean, errors: string[], decisionCodes: string[] }}
 */
function validateTurnContextPackMinimal(pack) {
  const errors = [];
  const decisionCodes = [];

  if (!pack || typeof pack !== 'object') {
    return { ok: false, errors: ['PACK_MISSING'], decisionCodes: ['FAIL_CLOSED'] };
  }

  if (pack.version !== TURN_CONTEXT_PACK_VERSION) {
    errors.push('PACK_VERSION_INVALID');
  }

  const intentPrimary = pack.intent && pack.intent.primary != null
    ? String(pack.intent.primary)
    : '';

  const activeProperty = pack.propertyContext && pack.propertyContext.activeProperty
    ? pack.propertyContext.activeProperty
    : null;
  const hasPropertyId = !!(activeProperty && (activeProperty.id || activeProperty.property_id || activeProperty.code));

  const isPropertyQa =
    /PROPERTY_QA|PROPERTY_INQUIRY|PROPERTY_FACTS/i.test(intentPrimary) ||
    pack.decisionCodes && pack.decisionCodes.includes('INTENT_PROPERTY_QA');

  if (isPropertyQa && !hasPropertyId) {
    errors.push('PROPERTY_QA_WITHOUT_PROPERTY');
    decisionCodes.push('FAIL_CLOSED_PROPERTY_QA');
  }

  const ambiguousLead =
    (pack.decisionCodes && pack.decisionCodes.includes('LEAD_ASK_WHICH')) ||
    pack.topic && pack.topic.leadId === 'AMBIGUOUS' ||
    pack.slots && pack.slots.confirmed && pack.slots.confirmed.leadAmbiguous === true;

  if (ambiguousLead) {
    errors.push('AMBIGUOUS_LEAD');
    decisionCodes.push('FAIL_CLOSED_AMBIGUOUS_LEAD');
    if (pack.topic && pack.topic.leadId && pack.topic.leadId !== 'AMBIGUOUS') {
      errors.push('AMBIGUOUS_LEAD_WITH_BOUND_ID');
    }
  }

  const mustNot = (pack.policy && Array.isArray(pack.policy.mustNot)) ? pack.policy.mustNot : [];
  if (mustNot.includes('invent_price') === false && intentPrimary && /CLAIM_PRICE/i.test(intentPrimary) && !hasPropertyId) {
    errors.push('PRICE_CLAIM_WITHOUT_SOT');
    decisionCodes.push('FAIL_CLOSED_PRICE');
  }

  if (pack.inventory && activeProperty && pack.inventory.searched && hasPropertyId) {
    // XOR soft-warning: commercial paths should prefer one primary fact source
    decisionCodes.push('WARN_INVENTORY_AND_PROPERTY_BOTH_SET');
  }

  const ok = errors.length === 0;
  if (!ok && decisionCodes.length === 0) decisionCodes.push('FAIL_CLOSED');

  return { ok, errors, decisionCodes };
}

/**
 * @returns {TurnContextPackV1}
 */
function createEmptyTurnContextPack() {
  return {
    version: TURN_CONTEXT_PACK_VERSION,
    conversation: {
      conversationId: null,
      contactId: null,
      channel: null,
      currentTurnId: null,
    },
    topic: {
      activeTopicId: null,
      lifecycle: null,
      controlMode: null,
      handoffState: null,
      leadId: null,
    },
    intent: { primary: null },
    slots: { confirmed: {}, missing: [] },
    policy: { mustNot: [] },
    inventory: null,
    propertyContext: null,
    orchestration: { nextBestAction: null },
    history: { activeTopicSummary: null },
    topicProperties: [],
    degrade: {},
    decisionCodes: [],
    valid: false,
    validationErrors: [],
  };
}

module.exports = {
  TURN_CONTEXT_PACK_VERSION,
  TOPIC_LIFECYCLES,
  CONTROL_MODES,
  EMPTY_PACK_SHAPE,
  createEmptyTurnContextPack,
  validateTurnContextPackMinimal,
};
