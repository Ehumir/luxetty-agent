"use strict";

const crypto = require("node:crypto");

const OUTBOUND_STATES = Object.freeze({
  INTENT_RECORDED: "intent_recorded",
  CLAIMED: "claimed",
  PROVIDER_UNKNOWN: "provider_unknown",
  SENT: "sent",
  CONFIRMED: "confirmed",
  FAILED_RETRYABLE: "failed_retryable",
  CANCELLED: "cancelled",
});

function buildOutboundKey({ conversationId, inboundMessageId, replyKind = "ai_reply" }) {
  const raw = [conversationId, inboundMessageId, replyKind].map((value) => String(value || "").trim());
  if (raw.some((value) => !value)) throw new Error("OUTBOUND_KEY_PART_REQUIRED");
  return crypto.createHash("sha256").update(raw.join(":")).digest("hex");
}

class InMemoryOutboundLedger {
  constructor() {
    this.messages = new Map();
    this.effects = new Map();
  }

  recordIntent({ key, conversationId, payloadHash }) {
    const existing = this.messages.get(key);
    if (existing) return { created: false, record: existing };
    const record = {
      key,
      conversation_id: conversationId,
      payload_hash: payloadHash,
      state: OUTBOUND_STATES.INTENT_RECORDED,
      worker_id: null,
      provider_message_id: null,
      attempts: 0,
      error_code: null,
      last_sequence: 0,
    };
    this.messages.set(key, record);
    return { created: true, record };
  }

  claim(key, workerId) {
    const current = this.#required(key);
    if ([OUTBOUND_STATES.SENT, OUTBOUND_STATES.CONFIRMED, OUTBOUND_STATES.CANCELLED].includes(current.state)) {
      return { claimed: false, reason: current.state, record: current };
    }
    if (current.state === OUTBOUND_STATES.PROVIDER_UNKNOWN) {
      return { claimed: false, reason: "reconciliation_required", record: current };
    }
    if (current.state === OUTBOUND_STATES.CLAIMED) {
      return { claimed: false, reason: "locked", record: current };
    }
    const next = {
      ...current,
      state: OUTBOUND_STATES.CLAIMED,
      worker_id: workerId,
      attempts: current.attempts + 1,
      error_code: null,
    };
    this.messages.set(key, next);
    return { claimed: true, record: next };
  }

  markProviderUnknown(key, errorCode) {
    return this.#patch(key, {
      state: OUTBOUND_STATES.PROVIDER_UNKNOWN,
      worker_id: null,
      error_code: errorCode,
    });
  }

  markRetryable(key, errorCode) {
    return this.#patch(key, {
      state: OUTBOUND_STATES.FAILED_RETRYABLE,
      worker_id: null,
      error_code: errorCode,
    });
  }

  markSent(key, providerMessageId) {
    if (!providerMessageId) throw new Error("PROVIDER_MESSAGE_ID_REQUIRED");
    return this.#patch(key, {
      state: OUTBOUND_STATES.SENT,
      worker_id: null,
      provider_message_id: providerMessageId,
      error_code: null,
    });
  }

  reconcile(key, result) {
    const current = this.#required(key);
    if (current.state !== OUTBOUND_STATES.PROVIDER_UNKNOWN) {
      throw new Error("OUTBOUND_RECONCILIATION_NOT_REQUIRED");
    }
    if (result.status === "sent") return this.markSent(key, result.providerMessageId);
    if (result.status === "not_found") return this.markRetryable(key, "PROVIDER_NOT_FOUND");
    return current;
  }

  confirm({ key, providerMessageId, sequence }) {
    const current = this.#required(key);
    if (sequence <= current.last_sequence) return { applied: false, reason: "out_of_order_or_duplicate", record: current };
    if (current.provider_message_id && current.provider_message_id !== providerMessageId) {
      return { applied: false, reason: "provider_id_mismatch", record: current };
    }
    const next = {
      ...current,
      state: OUTBOUND_STATES.CONFIRMED,
      provider_message_id: providerMessageId,
      last_sequence: sequence,
    };
    this.messages.set(key, next);
    return { applied: true, record: next };
  }

  applyEffect({ key, effect, execute }) {
    const effectKey = `${key}:${effect}`;
    if (this.effects.has(effectKey)) {
      return { executed: false, duplicate: true, result: this.effects.get(effectKey) };
    }
    const result = execute();
    this.effects.set(effectKey, result);
    return { executed: true, duplicate: false, result };
  }

  read(key) {
    return this.messages.get(key) || null;
  }

  #required(key) {
    const current = this.messages.get(key);
    if (!current) throw new Error("OUTBOUND_INTENT_MISSING");
    return current;
  }

  #patch(key, patch) {
    const next = { ...this.#required(key), ...patch };
    this.messages.set(key, next);
    return next;
  }
}

async function sendOutbound({ ledger, key, workerId, providerSend }) {
  const claim = ledger.claim(key, workerId);
  if (!claim.claimed) return { sent: false, reason: claim.reason, record: claim.record };

  try {
    const response = await providerSend({ idempotencyKey: key });
    return { sent: true, record: ledger.markSent(key, response.providerMessageId) };
  } catch (error) {
    if (error.deliveryUnknown) {
      return {
        sent: false,
        reason: "provider_unknown",
        record: ledger.markProviderUnknown(key, error.code || "PROVIDER_RESPONSE_LOST"),
      };
    }
    ledger.markRetryable(key, error.code || "PROVIDER_SEND_FAILED");
    throw error;
  }
}

module.exports = {
  OUTBOUND_STATES,
  InMemoryOutboundLedger,
  buildOutboundKey,
  sendOutbound,
};
