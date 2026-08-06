'use strict';

const PROD_REF = 'pjoxytwsvbeoivppczdx';

function projectRef(url) {
  const match = String(url || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match?.[1] || null;
}

async function main() {
  const ref = process.env.PERSEO_STAGING_PROJECT_REF || projectRef(process.env.SUPABASE_URL);
  if (!ref || ref === PROD_REF || process.env.PERSEO_STAGING_CONFIRMED !== 'true') {
    console.error('NO_GO: se requiere un proyecto staging explícito y distinto de producción.');
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ staging_ref: ref, production_ref_blocked: true, replay_fixture_count: 20 }));
}

if (require.main === module) main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

module.exports = { projectRef, main };
