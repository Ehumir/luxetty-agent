'use strict';

// Process-local interlock used only to prevent the current webhook turn from
// continuing normal PERSEO orchestration after an ICF follow-up response was
// already resolved transactionally in Supabase.
const locks = new Map();
const TTL_MS = 60 * 1000;

function cleanup(now = Date.now()) {
  for (const [key, expiresAt] of locks.entries()) {
    if (expiresAt <= now) locks.delete(key);
  }
}

function markIcfInboundHandled(conversationId, now = Date.now()) {
  if (!conversationId) return;
  cleanup(now);
  locks.set(String(conversationId), now + TTL_MS);
}

function isIcfInboundHandled(conversationId, now = Date.now()) {
  if (!conversationId) return false;
  cleanup(now);
  return (locks.get(String(conversationId)) || 0) > now;
}

function clearIcfInboundHandled(conversationId) {
  if (conversationId) locks.delete(String(conversationId));
}

module.exports = {
  TTL_MS,
  markIcfInboundHandled,
  isIcfInboundHandled,
  clearIcfInboundHandled,
};
