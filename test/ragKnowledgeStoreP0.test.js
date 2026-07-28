'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ATENA_ROOT = process.env.ATENA_ROOT
  ? path.resolve(process.env.ATENA_ROOT)
  : path.join(ROOT, '..', 'luxetty-atena');
const RAG_MIGRATION = path.join(ATENA_ROOT, 'supabase/migrations/20260706140000_rag_knowledge_store.sql');
const PII_AUDIT_SQL = path.join(ATENA_ROOT, 'supabase/validation/rag_p0_no_pii_audit.sql');
const CONTEXT_PACK_SCHEMA = path.join(ROOT, 'conversation/v3/rag/contextPackV1.schema.json');
const BACKFILL_SCRIPT = path.join(ATENA_ROOT, 'scripts/rag-backfill-knowledge.mjs');
const EDGE_FUNCTION = path.join(ATENA_ROOT, 'supabase/functions/index-knowledge/index.ts');

describe('ragKnowledgeStoreP0 — Sprint 2', () => {
  it('S2-T01 — extensión pgvector en migración', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
    assert.match(sql, /COMMENT ON EXTENSION vector/);
  });

  it('S2-T02 — tablas knowledge store (7 tablas + registry)', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    const tables = [
      'knowledge_registry',
      'knowledge_sources',
      'knowledge_documents',
      'knowledge_chunks',
      'knowledge_embeddings',
      'retrieval_citations',
      'rag_query_logs',
    ];
    for (const t of tables) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}`));
    }
    assert.match(sql, /idx_knowledge_embeddings_hnsw/);
  });

  it('S2-T03 — RLS embeddings no expuestos a authenticated', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    assert.match(sql, /knowledge_embeddings ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /knowledge_embeddings_deny_authenticated/);
    assert.match(sql, /FOR SELECT TO authenticated USING \(false\)/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.match_knowledge_chunks/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.match_knowledge_chunks[\s\S]*TO service_role/);
  });

  it('S2-T04 — RPC match_knowledge_chunks única implementación', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.match_knowledge_chunks/);
    assert.match(sql, /SECURITY DEFINER/);
    assert.match(sql, /filter_source_type/);
    assert.match(sql, /filter_visibility_scope/);
    assert.match(sql, /filter_is_active/);
    assert.match(sql, /filter_property_id/);
    assert.match(sql, /ORDER BY ke\.embedding <=> query_embedding/);
  });

  it('S2-T05 — RPC match_property_chunks es wrapper sin lógica duplicada', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.match_property_chunks');
    const fnEnd = sql.indexOf('COMMENT ON FUNCTION public.match_property_chunks');
    const wrapper = sql.slice(fnStart, fnEnd);
    assert.match(wrapper, /FROM public\.match_knowledge_chunks/);
    assert.match(wrapper, /'property'/);
    assert.doesNotMatch(wrapper, /knowledge_embeddings ke/);
  });

  it('S2-T06 — retrieval_citations + rag_query_logs estructura', () => {
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.retrieval_citations/);
    assert.match(sql, /rag_query_log_id uuid REFERENCES public\.rag_query_logs/);
    assert.match(sql, /chunk_id uuid NOT NULL REFERENCES public\.knowledge_chunks/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.rag_query_logs/);
    assert.match(sql, /query_text_hash text/);
  });

  it('S2-T07 — ContextPackV1 schema (confidence, fallback sin integración PERSEO)', () => {
    assert.ok(fs.existsSync(CONTEXT_PACK_SCHEMA), `missing ${CONTEXT_PACK_SCHEMA}`);
    const schema = JSON.parse(fs.readFileSync(CONTEXT_PACK_SCHEMA, 'utf8'));
    assert.equal(schema.title, 'ContextPackV1');
    assert.deepEqual(schema.required, [
      'context_pack_version',
      'sources',
      'citations',
      'scores',
      'confidence',
      'context_tokens_estimated',
      'chunks_selected',
      'chunks_dropped',
    ]);
    assert.equal(schema.properties.confidence.minimum, 0);
    const perseoIndex = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    assert.doesNotMatch(perseoIndex, /ragService|match_knowledge_chunks|buildContextPack/);
    const flags = require('../config/accP0Flags');
    const snap = flags.getAccRagP0FlagSnapshot();
    assert.equal(snap.RAG_P0_ENABLED, false);
    assert.equal(snap.RAG_P0_EFFECTIVE_INVENTORY, false);
  });

  it('S2-T08 — sin PII audit SQL + knowledge_registry dominios P0', () => {
    assert.ok(fs.existsSync(PII_AUDIT_SQL));
    const audit = fs.readFileSync(PII_AUDIT_SQL, 'utf8');
    assert.match(audit, /knowledge_chunks/);
    assert.match(audit, /@/);
    const sql = fs.readFileSync(RAG_MIGRATION, 'utf8');
    const activeDomains = [
      'properties',
      'rules_perseo',
      'rules_atena',
      'assignment_rules',
      'commercial_objections',
      'campaigns',
      'zones',
      'scripts',
    ];
    for (const d of activeDomains) {
      assert.match(sql, new RegExp(`'${d}'`));
    }
    assert.match(sql, /'conversation_memory'[\s\S]*false, false/);
  });

  it('infra — Edge index-knowledge + backfill script presentes', () => {
    assert.ok(fs.existsSync(EDGE_FUNCTION));
    const edge = fs.readFileSync(EDGE_FUNCTION, 'utf8');
    assert.match(edge, /index_property/);
    assert.match(edge, /index_rules_seed/);
    assert.doesNotMatch(edge, /match_knowledge_chunks|retrieval|respond/);
    assert.ok(fs.existsSync(BACKFILL_SCRIPT));
    const backfill = fs.readFileSync(BACKFILL_SCRIPT, 'utf8');
    assert.match(backfill, /--dry-run/);
    assert.match(backfill, /--resume/);
    assert.match(backfill, /content_hash/);
    assert.match(backfill, /RAG_RULE_SEEDS/);
  });

  it('regresión Sprint 1 — acc-foundation-p0 10/10', () => {
    process.env.PERSEO_ARGOS_ENABLED = 'true';
    process.env.PERSEO_V3_ENABLED = 'true';
    process.env.PERSEO_V3_CRM_EXECUTE = 'false';
    const out = execFileSync('node', ['scripts/argos-run-suite.js', '--suite', 'acc-foundation-p0'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    });
    assert.match(out, /pass=10\/10/);
  });
});
