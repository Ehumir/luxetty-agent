'use strict';

const REQUIRED = 'PERSEO_P0_CANARY_AUTHORIZED';

function main() {
  if (process.env[REQUIRED] !== 'true') {
    console.error(`NO_GO: ${REQUIRED}=true y autorización humana explícita son obligatorios.`);
    process.exitCode = 2;
    return;
  }
  if (process.env.PERSEO_AUTOMATED_RESPONSES_ENABLED !== 'false') {
    console.error('NO_GO: el canary debe iniciar con el kill switch global apagando respuestas.');
    process.exitCode = 2;
    return;
  }
  console.error('NO_GO: este comando sólo valida la autorización; el supervisor humano debe iniciar el canary desde el runbook.');
  process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { main };
