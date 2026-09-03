'use strict';

const baseline = require('../release/baseline.json');

const SAFE_FLAG_KEYS = [
  'PERSEO_POLICY_V2_ENABLED',
  'PERSEO_V3_ENABLED',
  'PERSEO_V3_GLOBAL_MODE',
  'PERSEO_V3_SHADOW_MODE',
  'PERSEO_V3_HANDOFF_ENABLED',
  'PERSEO_V3_CRM_DRY_RUN',
  'PERSEO_V3_CRM_EXECUTE',
  'PERSEO_INBOUND_MEDIA_STORAGE_ENABLED',
  'PERSEO_RUNTIME_SAFETY_ENABLED',
  'PERSEO_ARGOS_ENABLED',
  'RAG_P0_ENABLED',
  'RAG_INVENTORY_ENABLED',
  'RAG_RULES_ENABLED',
];

function clean(value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized || null;
}

function parseBooleanFlag(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toLowerCase() === 'true';
}

function resolveGitSha(env) {
  return (
    clean(env.PERSEO_RELEASE_GIT_SHA) ||
    clean(env.RAILWAY_GIT_COMMIT_SHA) ||
    clean(env.GITHUB_SHA) ||
    clean(env.VERCEL_GIT_COMMIT_SHA)
  );
}

function resolveBranch(env) {
  return (
    clean(env.PERSEO_RELEASE_BRANCH) ||
    clean(env.RAILWAY_GIT_BRANCH) ||
    clean(env.GITHUB_HEAD_REF) ||
    clean(env.GITHUB_REF_NAME)
  );
}

function resolveSupabaseProjectRef(env) {
  const raw = clean(env.SUPABASE_URL);
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match ? match[1] : null;
  } catch (_error) {
    return null;
  }
}

function collectFeatureFlags(env) {
  return Object.fromEntries(
    SAFE_FLAG_KEYS.map((key) => [key, parseBooleanFlag(env[key])])
  );
}

function buildReleaseManifest(env = process.env) {
  const gitSha = resolveGitSha(env);
  const deploymentId = clean(env.RAILWAY_DEPLOYMENT_ID) || clean(env.PERSEO_RELEASE_DEPLOYMENT_ID);
  const serviceId = clean(env.RAILWAY_SERVICE_ID);
  const environmentName = clean(env.RAILWAY_ENVIRONMENT_NAME) || clean(env.PERSEO_ENV);

  const manifest = {
    schema_version: 'perseo-runtime-release-manifest/v1',
    release_id:
      clean(env.PERSEO_RELEASE_ID) ||
      (gitSha ? `perseo-${gitSha.slice(0, 12)}` : null),
    generated_at: new Date().toISOString(),
    runtime: {
      git_sha: gitSha,
      branch: resolveBranch(env),
      deployment_id: deploymentId,
      railway_service_id: serviceId,
      railway_service_name: clean(env.RAILWAY_SERVICE_NAME),
      railway_environment: environmentName,
      node: process.version,
      node_env: clean(env.NODE_ENV),
      supabase_project_ref: resolveSupabaseProjectRef(env),
    },
    models: {
      llm: clean(env.OPENAI_MODEL) || baseline.models.perseo_llm_default,
      image_vision: clean(env.IMAGE_VISION_MODEL) || 'gpt-4o-mini',
      rag_embedding:
        clean(env.OPENAI_EMBEDDING_MODEL) || baseline.models.rag_embedding_model_observed,
    },
    feature_flags: collectFeatureFlags(env),
    baseline: {
      id: baseline.baseline_id,
      captured_at: baseline.captured_at,
      perseo_source_sha_before_sprint0: baseline.perseo.source_sha_before_sprint0,
      atena_production_git_sha: baseline.atena.production_git_sha,
      atena_vercel_production_deployment_id: baseline.atena.vercel_production_deployment_id,
      supabase_project_id: baseline.supabase.project_id,
      shared_supabase_required: baseline.supabase.perseo_must_use_same_project,
      separate_perseo_supabase_allowed: baseline.supabase.separate_perseo_supabase_allowed,
      knowledge_base_owner: baseline.supabase.knowledge_base_owner,
      supabase_latest_migration_version: baseline.supabase.latest_migration_version,
      supabase_latest_migration_name: baseline.supabase.latest_migration_name,
      solicitud_source_of_truth: baseline.crm_contract.solicitud_source_of_truth,
      non_real_estate_requests_table: baseline.crm_contract.non_real_estate_requests_table,
      public_requests_domain: baseline.crm_contract.public_requests_domain,
      perseo_real_estate_usage_of_public_requests_allowed:
        baseline.crm_contract.perseo_real_estate_usage_of_public_requests_allowed,
    },
  };

  manifest.certification = validateReleaseManifest(manifest, {
    mode: environmentName && environmentName.toLowerCase() === 'production' ? 'runtime' : 'ci',
  });

  return manifest;
}

function validateReleaseManifest(manifest, options = {}) {
  const mode = options.mode || 'ci';
  const errors = [];
  const canonicalSupabase = 'pjoxytwsvbeoivppczdx';

  if (!clean(manifest?.runtime?.git_sha)) errors.push('runtime.git_sha_missing');
  if (!clean(manifest?.baseline?.supabase_latest_migration_version)) {
    errors.push('baseline.supabase_latest_migration_missing');
  }
  if (manifest?.baseline?.supabase_project_id !== canonicalSupabase) {
    errors.push('baseline.shared_supabase_project_invalid');
  }
  if (manifest?.baseline?.shared_supabase_required !== true) {
    errors.push('baseline.shared_supabase_requirement_missing');
  }
  if (manifest?.baseline?.separate_perseo_supabase_allowed !== false) {
    errors.push('baseline.separate_perseo_supabase_forbidden');
  }
  if (manifest?.baseline?.solicitud_source_of_truth !== 'public.leads') {
    errors.push('baseline.crm_source_of_truth_invalid');
  }
  if (manifest?.baseline?.non_real_estate_requests_table !== 'public.requests') {
    errors.push('baseline.requests_domain_table_invalid');
  }
  if (manifest?.baseline?.perseo_real_estate_usage_of_public_requests_allowed !== false) {
    errors.push('baseline.requests_real_estate_boundary_invalid');
  }

  if (mode === 'runtime') {
    if (!clean(manifest?.runtime?.deployment_id)) errors.push('runtime.deployment_id_missing');
    if (!clean(manifest?.runtime?.railway_service_id)) errors.push('runtime.railway_service_id_missing');
    if (!clean(manifest?.runtime?.railway_environment)) errors.push('runtime.railway_environment_missing');
    if (!clean(manifest?.runtime?.supabase_project_ref)) errors.push('runtime.supabase_project_ref_missing');
    else if (manifest.runtime.supabase_project_ref !== canonicalSupabase) {
      errors.push('runtime.shared_supabase_project_mismatch');
    }
  }

  return {
    mode,
    ok: errors.length === 0,
    errors,
  };
}

module.exports = {
  SAFE_FLAG_KEYS,
  buildReleaseManifest,
  collectFeatureFlags,
  resolveGitSha,
  resolveSupabaseProjectRef,
  validateReleaseManifest,
};
