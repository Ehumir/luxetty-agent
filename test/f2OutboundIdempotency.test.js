"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OUTBOUND_STATES,
  InMemoryOutboundLedger,
  buildOutboundKey,
  sendOutbound,
} = require("../conversation/v3/runtime/outboundIdempotency");

function setup() {
  const ledger = new InMemoryOutboundLedger();
  const key = buildOutboundKey({
    conversationId: "conversation-1",
    inboundMessageId: "wamid-1",
  });
  ledger.recordIntent({ key, conversationId: "conversation-1", payloadHash: "payload-1" });
  return { ledger, key };
}

test("outbound records one intent and two workers cannot send concurrently", async () => {
  const { ledger, key } = setup();
  assert.equal(ledger.recordIntent({ key, conversationId: "conversation-1", payloadHash: "payload-1" }).created, false);
  assert.equal(ledger.claim(key, "worker-a").claimed, true);
  assert.equal(ledger.claim(key, "worker-b").reason, "locked");
});

test("lost HTTP response requires reconciliation and blocks blind retry", async () => {
  const { ledger, key } = setup();
  let providerCalls = 0;
  const first = await sendOutbound({
    ledger,
    key,
    workerId: "worker-a",
    providerSend: async ({ idempotencyKey }) => {
      providerCalls += 1;
      assert.equal(idempotencyKey, key);
      const error = new Error("response lost");
      error.code = "HTTP_RESPONSE_LOST";
      error.deliveryUnknown = true;
      throw error;
    },
  });
  assert.equal(first.record.state, OUTBOUND_STATES.PROVIDER_UNKNOWN);

  const retry = await sendOutbound({
    ledger,
    key,
    workerId: "worker-b",
    providerSend: async () => {
      providerCalls += 1;
      return { providerMessageId: "duplicate" };
    },
  });
  assert.equal(retry.reason, "reconciliation_required");
  assert.equal(providerCalls, 1);
  ledger.reconcile(key, { status: "sent", providerMessageId: "provider-1" });
  assert.equal(ledger.read(key).state, OUTBOUND_STATES.SENT);
});

test("provider not-found reconciliation permits retry with the same key", async () => {
  const { ledger, key } = setup();
  ledger.claim(key, "worker-a");
  ledger.markProviderUnknown(key, "HTTP_RESPONSE_LOST");
  ledger.reconcile(key, { status: "not_found" });
  let observedKey;
  const result = await sendOutbound({
    ledger,
    key,
    workerId: "worker-b",
    providerSend: async ({ idempotencyKey }) => {
      observedKey = idempotencyKey;
      return { providerMessageId: "provider-2" };
    },
  });
  assert.equal(observedKey, key);
  assert.equal(result.record.state, OUTBOUND_STATES.SENT);
});

test("duplicate and out-of-order confirmation webhooks converge", () => {
  const { ledger, key } = setup();
  ledger.claim(key, "worker-a");
  ledger.markSent(key, "provider-1");
  assert.equal(ledger.confirm({ key, providerMessageId: "provider-1", sequence: 2 }).applied, true);
  assert.equal(ledger.confirm({ key, providerMessageId: "provider-1", sequence: 2 }).applied, false);
  assert.equal(ledger.confirm({ key, providerMessageId: "provider-1", sequence: 1 }).applied, false);
  assert.equal(ledger.read(key).state, OUTBOUND_STATES.CONFIRMED);
});

test("notification, task and event side effects execute once", () => {
  const { ledger, key } = setup();
  for (const effect of ["notification", "task", "event", "commercial_effect"]) {
    let writes = 0;
    const first = ledger.applyEffect({ key, effect, execute: () => ++writes });
    const duplicate = ledger.applyEffect({ key, effect, execute: () => ++writes });
    assert.equal(first.executed, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.result, first.result);
    assert.equal(writes, 1);
  }
});

test("partial failure after intent is recoverable without a duplicate message", async () => {
  const { ledger, key } = setup();
  let calls = 0;
  await assert.rejects(
    sendOutbound({
      ledger,
      key,
      workerId: "worker-a",
      providerSend: async () => {
        calls += 1;
        const error = new Error("provider 500 before acceptance");
        error.code = "HTTP_500_PRE_ACCEPT";
        throw error;
      },
    }),
    /provider 500/,
  );
  const recovered = await sendOutbound({
    ledger,
    key,
    workerId: "worker-b",
    providerSend: async () => {
      calls += 1;
      return { providerMessageId: "provider-3" };
    },
  });
  assert.equal(recovered.record.state, OUTBOUND_STATES.SENT);
  assert.equal(calls, 2);
  assert.equal(ledger.messages.size, 1);
});
