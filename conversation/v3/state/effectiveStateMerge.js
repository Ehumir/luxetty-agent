'use strict';

const { mergeConversationState } = require('../types/conversationState');

const PROTECTED_FIELDS = Object.freeze([
  'operationType',
  'activeProperty',
  'propertyListingCode',
  'requestId',
  'crmRequestId',
  'contactId',
  'crmContactId',
  'leadId',
  'crmLeadId',
  'locationText',
  'budget',
  'bedrooms',
  'propertyType',
  'collectedFields.fullName',
  'activeTopic',
  'showBatch',
  'mode',
  'handoffStage',
]);

const SOURCE_PRIORITY = Object.freeze({
  customer_current_turn: 1,
  structured_conversation_state: 2,
  linked_crm_request: 3,
  authorized_turn_inventory: 4,
  validated_campaign: 5,
  classifier_inference: 6,
  legacy_fallback: 7,
});

function getAt(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function deleteAt(value, path) {
  const parts = path.split('.');
  if (parts.length === 1) {
    delete value[path];
    return;
  }
  const [head, tail] = parts;
  if (!value[head] || typeof value[head] !== 'object') return;
  value[head] = { ...value[head] };
  delete value[head][tail];
  if (Object.keys(value[head]).length === 0) delete value[head];
}

function isEmpty(value) {
  return (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function propertyCode(property) {
  return String(property?.code || property?.property_code || property?.listing_code || '').trim() || null;
}

/**
 * Único merge de datos efectivos del runtime. Los merges técnicos que sólo
 * avanzan stage/telemetría pueden seguir usando mergeConversationState.
 */
function mergeEffectiveRuntimeState(base, candidate, options = {}) {
  const source = options.source || 'classifier_inference';
  const confidence = Number.isFinite(Number(options.confidence)) ? Number(options.confidence) : 0;
  const reason = String(options.reason || 'runtime_merge');
  const explicit = new Set(options.explicitFields || []);
  const allowClear = new Set(options.allowClearFields || []);
  const patch = { ...(candidate || {}) };
  if (patch.collectedFields && typeof patch.collectedFields === 'object') {
    patch.collectedFields = { ...patch.collectedFields };
  }

  const accepted = [];
  const rejected = [];
  const previousProvenance = base.fieldProvenance || {};

  for (const field of PROTECTED_FIELDS) {
    const nextValue = getAt(patch, field);
    if (nextValue === undefined) continue;
    const previousValue = getAt(base, field);
    if (sameValue(previousValue, nextValue)) continue;

    const previousSource = previousProvenance[field]?.source ||
      (!isEmpty(previousValue) ? 'structured_conversation_state' : null);
    const previousPriority = previousSource ? (SOURCE_PRIORITY[previousSource] || 99) : 99;
    const nextPriority = SOURCE_PRIORITY[source] || 99;
    const isExplicit = explicit.has(field);
    let blockedReason = null;

    if (!isEmpty(previousValue) && isEmpty(nextValue) && !allowClear.has(field)) {
      blockedReason = 'empty_value_cannot_erase_confirmed_state';
    } else if (!isEmpty(previousValue) && !isExplicit && confidence < 0.75) {
      blockedReason = 'weak_inference_cannot_replace_confirmed_state';
    } else if (!isEmpty(previousValue) && nextPriority > previousPriority && !isExplicit) {
      blockedReason = 'lower_authority_cannot_replace_confirmed_state';
    }

    if (field === 'activeProperty' && nextValue) {
      const nextCode = propertyCode(nextValue);
      const requestedCode = String(patch.propertyListingCode || base.propertyListingCode || '').trim() || null;
      if (nextCode && requestedCode && nextCode !== requestedCode) {
        blockedReason = 'active_property_code_mismatch';
      }
    }

    const mutation = {
      field,
      previous_value: previousValue ?? null,
      new_value: nextValue ?? null,
      source,
      confidence,
      reason: blockedReason || reason,
      accepted: !blockedReason,
      at: new Date().toISOString(),
    };
    if (blockedReason) {
      deleteAt(patch, field);
      rejected.push(mutation);
    } else {
      accepted.push(mutation);
    }
  }

  const nextCode = patch.propertyListingCode;
  const basePropertyCode = propertyCode(base.activeProperty);
  if (nextCode && base.activeProperty && !basePropertyCode && patch.activeProperty === undefined) {
    patch.activeProperty = { ...base.activeProperty, code: String(nextCode).trim() };
    accepted.push({
      field: 'activeProperty',
      previous_value: base.activeProperty,
      new_value: patch.activeProperty,
      source,
      confidence,
      reason: 'active_property_code_completed_from_effective_state',
      accepted: true,
      at: new Date().toISOString(),
    });
  } else if (nextCode && base.activeProperty && basePropertyCode !== String(nextCode).trim() && patch.activeProperty === undefined) {
    patch.activeProperty = null;
    accepted.push({
      field: 'activeProperty',
      previous_value: base.activeProperty,
      new_value: null,
      source,
      confidence,
      reason: 'property_code_changed_without_matching_authorized_property',
      accepted: true,
      at: new Date().toISOString(),
    });
  }

  const next = mergeConversationState(base, patch);
  const provenance = { ...previousProvenance };
  for (const mutation of accepted) {
    provenance[mutation.field] = {
      source: mutation.source,
      confidence: mutation.confidence,
      reason: mutation.reason,
      changed_at: mutation.at,
    };
  }
  return {
    ...next,
    fieldProvenance: provenance,
    lastStateMutation: accepted[accepted.length - 1] || base.lastStateMutation || null,
    stateMutationLog: [...(base.stateMutationLog || []), ...accepted].slice(-100),
    rejectedStateMutations: [...(base.rejectedStateMutations || []), ...rejected].slice(-100),
  };
}

module.exports = {
  PROTECTED_FIELDS,
  SOURCE_PRIORITY,
  mergeEffectiveRuntimeState,
};
