'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SAFE_FLAG_KEYS,
  buildReleaseManifest,
  collectFeatureFlags,
  resolveGitSha,
  validateReleaseManifest,
} = require('../services/releaseManifest');

test('resolveGitSha prioritizes explicit release SHA and Railway SHA', () => {
  assert.equal(
    resolveGitSha({
      PERSEO_RELEASE_GIT_SHA: 'explicit-sha',
      RAILWAY_GIT_COMMIT_SHA: 'railway-sha',
      GITHUB_SHA: 'github-sha',
    }),
    'explicit-sha'
  );

  assert.equal(
    resolveGitSha({
      RAILWAY_GIT_COMMIT_SHA: 'railway-sha',
      GITHUB_SHA: 'github-sha',
    }),
    'railway-sha'
  );
});

test('CI manifest is certifiable when SHA and shared backend contract are present', () => {
  const manifest = buildReleaseManifest({
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_REF_NAME: 'pcr1-shared-backend-contract',
    OPENAI_MODEL: 'gpt-5-mini',
  });

  const result = validateReleaseManifest(manifest, { mode: 'ci' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(manifest.runtime.git_sha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(manifest.baseline.supabase_project_id, 'pjoxytwsvbeoivppczdx');
  assert.equal(manifest.baseline.shared_supabase_required, true);
  assert.equal(manifest.baseline.separate_perseo_supabase_allowed, false);
  assert.equal(manifest.baseline.knowledge_base_owner, 'ATENA backend');
  assert.equal(manifest.baseline.solicitud_source_of_truth, 'public.leads');
  assert.equal(manifest.baseline.non_real_estate_requests_table, 'public.requests');
  assert.equal(manifest.baseline.public_requests_domain, 'provider_vendor_requirements');
  assert.equal(manifest.baseline.perseo_real_estate_usage_of_public_requests_allowed, false);
});

test('runtime certification fails closed without Railway deployment identity', () => {
  const manifest = buildReleaseManifest({
    RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    RAILWAY_GIT_BRANCH: 'main',
    RAILWAY_ENVIRONMENT_NAME: 'production',
  });

  const result = validateReleaseManifest(manifest, { mode: 'runtime' });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('runtime.deployment_id_missing'));
  assert.ok(result.errors.includes('runtime.railway_service_id_missing'));
});

test('Railway runtime manifest is certifiable with deployment identity', () => {
  const manifest = buildReleaseManifest({
    RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    RAILWAY_GIT_BRANCH: 'main',
    RAILWAY_DEPLOYMENT_ID: 'deployment-123',
    RAILWAY_SERVICE_ID: 'service-123',
    RAILWAY_SERVICE_NAME: 'perseo',
    RAILWAY_ENVIRONMENT_NAME: 'production',
  });

  const result = validateReleaseManifest(manifest, { mode: 'runtime' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('feature flag manifest exposes only an explicit safe boolean allowlist', () => {
  const flags = collectFeatureFlags({
    PERSEO_V3_ENABLED: 'true',
    PERSEO_V3_CRM_DRY_RUN: 'false',
    QA_ALLOWED_WHATSAPP_NUMBERS: '5218112345678',
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
  });

  assert.equal(flags.PERSEO_V3_ENABLED, true);
  assert.equal(flags.PERSEO_V3_CRM_DRY_RUN, false);
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'QA_ALLOWED_WHATSAPP_NUMBERS'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'SUPABASE_SERVICE_ROLE_KEY'), false);
  assert.deepEqual(Object.keys(flags), SAFE_FLAG_KEYS);
});
