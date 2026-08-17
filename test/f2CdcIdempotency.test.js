"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CDC_STATES,
  InMemoryCdcLedger,
  processCdcJob,
  sourceVersion,
} = require("../conversation/v3/rag/cdcIdempotency");

function enqueue(ledger, payload = { title: "Casa", price: 10 }) {
  return ledger.enqueue({
    entityType: "property",
    entityId: "property-1",
    payload,
  }).job;
}

test("CDC same content is one source version regardless of key order", () => {
  assert.equal(sourceVersion({ title: "Casa", price: 10 }), sourceVersion({ price: 10, title: "Casa" }));
  const ledger = new InMemoryCdcLedger();
  const first = ledger.enqueue({ entityType: "property", entityId: "p1", payload: { a: 1, b: 2 } });
  const second = ledger.enqueue({ entityType: "property", entityId: "p1", payload: { b: 2, a: 1 } });
  assert.equal(first.created, true);
  assert.equal(second.unchanged, true);
  assert.equal(ledger.jobs.size, 1);
});

test("CDC update with change creates a new version; update without change does not", () => {
  const ledger = new InMemoryCdcLedger();
  const first = enqueue(ledger);
  const unchanged = enqueue(ledger);
  const changed = enqueue(ledger, { title: "Casa", price: 11 });
  assert.equal(unchanged.key, first.key);
  assert.notEqual(changed.key, first.key);
  assert.equal(ledger.jobs.size, 2);
});

test("CDC two workers and duplicate execution yield one chunks/embedding set", async () => {
  const ledger = new InMemoryCdcLedger();
  const job = enqueue(ledger);
  assert.equal(ledger.claim(job.key, "worker-a").claimed, true);
  assert.deepEqual(ledger.claim(job.key, "worker-b"), { claimed: false, reason: "locked" });
  ledger.markChunksSaved(job.key, ["chunk-1", "chunk-1"]);
  ledger.markEmbeddingSaved(job.key, ["embedding-1", "embedding-1"]);
  ledger.complete(job.key);
  assert.equal(ledger.claim(job.key, "worker-b").reason, "completed");
  assert.deepEqual(ledger.read(job.key).chunk_ids, ["chunk-1"]);
  assert.deepEqual(ledger.read(job.key).embedding_ids, ["embedding-1"]);
});

test("CDC timeout after chunks recovers without duplicating chunks", async () => {
  const ledger = new InMemoryCdcLedger();
  const job = enqueue(ledger);
  let chunkWrites = 0;
  let embeddingWrites = 0;
  await assert.rejects(
    processCdcJob({
      ledger,
      key: job.key,
      workerId: "worker-a",
      writeChunks: async () => {
        chunkWrites += 1;
        return ["chunk-1"];
      },
      writeEmbedding: async () => {
        const error = new Error("timeout");
        error.code = "EMBEDDING_TIMEOUT";
        throw error;
      },
    }),
    /timeout/,
  );
  const recovered = await processCdcJob({
    ledger,
    key: job.key,
    workerId: "worker-b",
    writeChunks: async () => {
      chunkWrites += 1;
      return ["chunk-duplicate"];
    },
    writeEmbedding: async (chunks) => {
      embeddingWrites += 1;
      assert.deepEqual(chunks, ["chunk-1"]);
      return ["embedding-1"];
    },
  });
  assert.equal(recovered.job.state, CDC_STATES.COMPLETED);
  assert.equal(chunkWrites, 1);
  assert.equal(embeddingWrites, 1);
});

test("CDC timeout after embedding recovers by closing the existing job", async () => {
  const ledger = new InMemoryCdcLedger();
  const job = enqueue(ledger);
  ledger.claim(job.key, "worker-a");
  ledger.markChunksSaved(job.key, ["chunk-1"]);
  ledger.markEmbeddingSaved(job.key, ["embedding-1"]);
  ledger.fail(job.key, "CLOSE_TIMEOUT");
  let writes = 0;
  const recovered = await processCdcJob({
    ledger,
    key: job.key,
    workerId: "worker-b",
    writeChunks: async () => {
      writes += 1;
      return [];
    },
    writeEmbedding: async () => {
      writes += 1;
      return [];
    },
  });
  assert.equal(recovered.job.state, CDC_STATES.COMPLETED);
  assert.equal(writes, 0);
});

test("CDC deactivation is idempotent and reactivation returns to pending", () => {
  const ledger = new InMemoryCdcLedger();
  const job = enqueue(ledger);
  assert.equal(ledger.deactivate(job.key).state, CDC_STATES.INACTIVE);
  assert.equal(ledger.deactivate(job.key).state, CDC_STATES.INACTIVE);
  assert.equal(ledger.claim(job.key, "worker-a").reason, "inactive");
  assert.equal(ledger.reactivate(job.key).state, CDC_STATES.PENDING);
  assert.equal(ledger.claim(job.key, "worker-a").claimed, true);
});
