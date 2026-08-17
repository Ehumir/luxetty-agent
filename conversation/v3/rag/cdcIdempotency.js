"use strict";

const crypto = require("node:crypto");

const CDC_STATES = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  CHUNKS_SAVED: "chunks_saved",
  EMBEDDING_SAVED: "embedding_saved",
  COMPLETED: "completed",
  INACTIVE: "inactive",
  RETRYABLE: "retryable",
});

const TRANSITIONS = Object.freeze({
  pending: new Set(["claimed", "inactive"]),
  // A recovered claim may resume after a durable chunks/embedding checkpoint.
  claimed: new Set(["chunks_saved", "embedding_saved", "completed", "retryable", "inactive"]),
  chunks_saved: new Set(["embedding_saved", "retryable", "inactive"]),
  embedding_saved: new Set(["completed", "retryable", "inactive"]),
  retryable: new Set(["claimed", "inactive"]),
  completed: new Set(["inactive"]),
  inactive: new Set(["pending"]),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceVersion(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function buildCdcKey({ entityType, entityId, version }) {
  for (const value of [entityType, entityId, version]) {
    if (!value || !String(value).trim()) throw new Error("CDC_KEY_PART_REQUIRED");
  }
  return `${encodeURIComponent(entityType)}:${encodeURIComponent(entityId)}:${encodeURIComponent(version)}`;
}

function transition(record, next, patch = {}) {
  const allowed = TRANSITIONS[record.state];
  if (!allowed || !allowed.has(next)) {
    throw new Error(`CDC_TRANSITION_INVALID:${record.state}:${next}`);
  }
  return { ...record, ...patch, state: next };
}

class InMemoryCdcLedger {
  constructor() {
    this.jobs = new Map();
  }

  enqueue({ entityType, entityId, payload, active = true }) {
    const version = sourceVersion(payload);
    const key = buildCdcKey({ entityType, entityId, version });
    const existing = this.jobs.get(key);
    if (existing) return { created: false, unchanged: true, job: existing };

    const job = {
      key,
      entity_type: entityType,
      entity_id: entityId,
      source_version: version,
      state: active ? CDC_STATES.PENDING : CDC_STATES.INACTIVE,
      attempts: 0,
      worker_id: null,
      chunk_ids: [],
      embedding_ids: [],
      error_code: null,
    };
    this.jobs.set(key, job);
    return { created: true, unchanged: false, job };
  }

  claim(key, workerId) {
    const job = this.jobs.get(key);
    if (!job) return { claimed: false, reason: "missing" };
    if ([CDC_STATES.COMPLETED, CDC_STATES.INACTIVE].includes(job.state)) {
      return { claimed: false, reason: job.state };
    }
    if (job.state === CDC_STATES.CLAIMED) return { claimed: false, reason: "locked" };
    const next = transition(job, CDC_STATES.CLAIMED, {
      worker_id: workerId,
      attempts: job.attempts + 1,
      error_code: null,
    });
    this.jobs.set(key, next);
    return { claimed: true, job: next };
  }

  markChunksSaved(key, chunkIds) {
    return this.#set(key, CDC_STATES.CHUNKS_SAVED, { chunk_ids: [...new Set(chunkIds)] });
  }

  markEmbeddingSaved(key, embeddingIds) {
    return this.#set(key, CDC_STATES.EMBEDDING_SAVED, {
      embedding_ids: [...new Set(embeddingIds)],
    });
  }

  complete(key) {
    return this.#set(key, CDC_STATES.COMPLETED, { worker_id: null });
  }

  fail(key, errorCode) {
    const job = this.jobs.get(key);
    if (!job) throw new Error("CDC_JOB_MISSING");
    const next = transition(job, CDC_STATES.RETRYABLE, {
      error_code: errorCode,
      worker_id: null,
    });
    this.jobs.set(key, next);
    return next;
  }

  deactivate(key) {
    const job = this.jobs.get(key);
    if (!job) throw new Error("CDC_JOB_MISSING");
    if (job.state === CDC_STATES.INACTIVE) return job;
    const next = transition(job, CDC_STATES.INACTIVE, { worker_id: null });
    this.jobs.set(key, next);
    return next;
  }

  reactivate(key) {
    return this.#set(key, CDC_STATES.PENDING, { worker_id: null, error_code: null });
  }

  read(key) {
    return this.jobs.get(key) || null;
  }

  #set(key, state, patch) {
    const job = this.jobs.get(key);
    if (!job) throw new Error("CDC_JOB_MISSING");
    const next = transition(job, state, patch);
    this.jobs.set(key, next);
    return next;
  }
}

async function processCdcJob({ ledger, key, workerId, writeChunks, writeEmbedding }) {
  const claim = ledger.claim(key, workerId);
  if (!claim.claimed) return { processed: false, reason: claim.reason, job: ledger.read(key) };

  try {
    let job = ledger.read(key);
    if (!job.chunk_ids.length) {
      job = ledger.markChunksSaved(key, await writeChunks());
    }
    if (!job.embedding_ids.length) {
      job = ledger.markEmbeddingSaved(key, await writeEmbedding(job.chunk_ids));
    }
    return { processed: true, job: ledger.complete(key) };
  } catch (error) {
    ledger.fail(key, error.code || "CDC_PROCESSING_FAILED");
    throw error;
  }
}

module.exports = {
  CDC_STATES,
  InMemoryCdcLedger,
  buildCdcKey,
  canonicalJson,
  processCdcJob,
  sourceVersion,
};
