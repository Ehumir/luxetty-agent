'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { processInboundForArgos } = require('../processInboundForArgos');
const { buildConversationSnapshot } = require('../conversationSnapshot');
const { isReplayEngineEnabled } = require('../../config/perseoM403Flags');

/**
 * Load replay pack JSON from docs/replay-packs/.
 * @param {string} packId
 */
function loadReplayPack(packId) {
  const file = path.join(__dirname, '../../docs/replay-packs', `${packId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`replay_pack_not_found:${packId}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Run a replay pack deterministically (production-safe: no CRM writes).
 * @param {object} pack
 * @param {{ phone_sim?: string }} opts
 */
async function runReplayPack(pack, opts = {}) {
  if (!isReplayEngineEnabled() && !opts.force) {
    return { skipped: true, reason: 'replay_disabled' };
  }

  const phone = opts.phone_sim || pack.phone_sim || '+5200000000001';
  const flags = {
    deterministic_mode: true,
    crm_dry_run: true,
    replay_mode: true,
    ...(pack.flags || {}),
  };

  const turns = [];
  let session_id = null;
  let lastSnapshot = null;
  const violations = [];
  const previousV3Enabled = process.env.PERSEO_V3_ENABLED;
  const previousArgosEnabled = process.env.PERSEO_ARGOS_ENABLED;
  process.env.PERSEO_V3_ENABLED = 'true';
  process.env.PERSEO_ARGOS_ENABLED = 'true';

  try {
    for (let i = 0; i < (pack.turns || []).length; i += 1) {
      const turn = pack.turns[i];
      const result = await processInboundForArgos({
        session_id,
        phone_sim: phone,
        text: turn.text || '',
        media: turn.media || null,
        flags,
      });
      session_id = result.session_id;
      lastSnapshot = result.conversation_snapshot;
      turns.push({
        index: i + 1,
        user: turn.text,
        reply: result.reply,
        snapshot: lastSnapshot,
        ok: !result.error_code,
      });

      if (turn.expected) {
        for (const [key, val] of Object.entries(turn.expected)) {
          if (lastSnapshot?.[key] !== val && lastSnapshot?.[key] != val) {
            violations.push({ turn: i + 1, key, expected: val, actual: lastSnapshot?.[key] });
          }
        }
      }
    }
  } finally {
    if (previousV3Enabled === undefined) delete process.env.PERSEO_V3_ENABLED;
    else process.env.PERSEO_V3_ENABLED = previousV3Enabled;
    if (previousArgosEnabled === undefined) delete process.env.PERSEO_ARGOS_ENABLED;
    else process.env.PERSEO_ARGOS_ENABLED = previousArgosEnabled;
  }

  return {
    pack_id: pack.pack_id,
    turns: turns.length,
    session_id,
    last_snapshot: lastSnapshot,
    violations,
    ok: violations.length === 0,
  };
}

async function runReplayPackById(packId, opts = {}) {
  const pack = loadReplayPack(packId);
  return runReplayPack(pack, opts);
}

module.exports = {
  loadReplayPack,
  runReplayPack,
  runReplayPackById,
};
