#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { buildReleaseManifest, validateReleaseManifest } = require('../services/releaseManifest');

const mode = String(process.env.PERSEO_RELEASE_VERIFY_MODE || 'ci').trim().toLowerCase();
const manifest = buildReleaseManifest(process.env);
const validation = validateReleaseManifest(manifest, { mode });

const output = {
  ok: validation.ok,
  mode,
  release_id: manifest.release_id,
  runtime: manifest.runtime,
  models: manifest.models,
  feature_flags: manifest.feature_flags,
  baseline: manifest.baseline,
  errors: validation.errors,
};

console.log(JSON.stringify(output, null, 2));

if (!validation.ok) {
  process.exitCode = 1;
}
