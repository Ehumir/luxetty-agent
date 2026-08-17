'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONVERSATION_CLASSES,
  LEAD_CLASSES,
  classifyContactlessConversation,
  classifyActiveLeadGroup,
} = require('../scripts/audit/f2IntegrityClassification');

test('closed contactless conversations without a lead are classified as tolerable legacy', () => {
  assert.equal(
    classifyContactlessConversation({ status: 'closed', hasLead: false }),
    CONVERSATION_CLASSES.LEGACY_TOLERABLE,
  );
});

test('a contactless conversation linked to a lead is only a correctable candidate', () => {
  assert.equal(
    classifyContactlessConversation({ status: 'closed', hasLead: true }),
    CONVERSATION_CLASSES.CORRECTABLE_CANDIDATE,
  );
});

test('open contactless conversations require review and high-volume cases are escalated', () => {
  assert.equal(
    classifyContactlessConversation({
      status: 'open',
      hasLead: false,
      inboundMessageCount: 6,
    }),
    CONVERSATION_CLASSES.INCOMPLETE_REVIEW,
  );
  assert.equal(
    classifyContactlessConversation({
      status: 'open',
      hasLead: false,
      inboundMessageCount: 67,
    }),
    CONVERSATION_CLASSES.HIGH_RISK_REVIEW,
  );
});

test('distinct business signatures remain valid multiple intents', () => {
  assert.equal(
    classifyActiveLeadGroup({
      activeCount: 3,
      businessSignatureCount: 3,
      ownerCount: 1,
    }),
    LEAD_CLASSES.VALID_MULTIPLE_INTENTS,
  );
});

test('repeated signatures are review candidates and never auto-closed', () => {
  assert.equal(
    classifyActiveLeadGroup({
      activeCount: 2,
      businessSignatureCount: 1,
      ownerCount: 1,
    }),
    LEAD_CLASSES.DUPLICATE_CANDIDATE,
  );
  assert.equal(
    classifyActiveLeadGroup({
      activeCount: 3,
      businessSignatureCount: 1,
      ownerCount: 2,
    }),
    LEAD_CLASSES.OWNERSHIP_CONFLICT_REVIEW,
  );
});

test('the dry-run artifact contains SELECT statements only', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sql', 'f2-integrity-dry-run.sql'),
    'utf8',
  );
  const forbidden = /\b(update|insert|delete|merge|truncate|alter|drop)\b/i;
  assert.doesNotMatch(
    sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n'),
    forbidden,
  );
  assert.match(sql, /\bselect\b/i);
});
