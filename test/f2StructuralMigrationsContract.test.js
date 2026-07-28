"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "../supabase/migrations");
const read = (suffix) => {
  const name = fs.readdirSync(dir).find((item) => item.endsWith(suffix));
  assert.ok(name, suffix);
  return fs.readFileSync(path.join(dir, name), "utf8");
};

const topics = read("_f2_05_topics_and_events.sql");
const batches = read("_f2_05_show_batches.sql");
const ledgers = read("_f2_05_effect_ledgers.sql");
const all = `${topics}\n${batches}\n${ledgers}`;

test("topics migration enforces one OPEN and idempotent append-only events", () => {
  assert.match(topics, /one_open_per_conversation[\s\S]*where status = 'OPEN'/i);
  assert.match(topics, /unique \(topic_id, idempotency_key\)/i);
  assert.match(topics, /grant select, insert on table public\.conversation_topic_events to service_role/i);
  const eventGrant = topics
    .split("\n")
    .find((line) => /grant .*conversation_topic_events to service_role/i.test(line));
  assert.doesNotMatch(eventGrant, /\bupdate\b/i);
  assert.doesNotMatch(eventGrant, /\bdelete\b/i);
});

test("show batch has immutable identity, rank and property constraints", () => {
  assert.match(batches, /unique \(topic_id, outbound_message_id\)/i);
  assert.match(batches, /unique \(show_batch_id, property_id\)/i);
  assert.match(batches, /unique \(show_batch_id, rank\)/i);
  assert.match(batches, /never authoritative for live price/i);
});

test("CDC and outbound ledgers carry required durable unique keys", () => {
  assert.match(ledgers, /unique \(entity_type, entity_id, source_version\)/i);
  assert.match(ledgers, /idempotency_key text not null unique/i);
  assert.match(ledgers, /provider_unknown/);
  assert.match(ledgers, /unique \(outbound_effect_id, effect_type\)/i);
});

test("new public tables enable RLS and expose no anon mutations", () => {
  for (const table of [
    "conversation_topics",
    "conversation_topic_events",
    "conversation_show_batches",
    "conversation_show_batch_items",
    "f2_effect_ledger",
    "knowledge_reindex_effects",
    "outbound_effect_ledger",
    "outbound_effect_side_effects",
  ]) {
    assert.match(all, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.doesNotMatch(all, /grant\s+(select|insert|update|delete)[\s\S]*\bto anon\b/i);
});

test("migrations are additive and bounded", () => {
  assert.doesNotMatch(all, /drop\s+(table|schema|column)[\s\S]*cascade/i);
  assert.doesNotMatch(all, /\btruncate\b/i);
  assert.match(all, /set lock_timeout = '5s'/i);
  assert.match(all, /set statement_timeout = '90s'/i);
});
