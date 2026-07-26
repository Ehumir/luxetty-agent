'use strict';

const MAX_CONTEXT_TOKENS = 2500;

/** Prioridad de dominios para poda de presupuesto (1 = más alto). */
const DOMAIN_PRIORITY = [
  { key: 'property', match: (c) => c.source_type === 'property' },
  { key: 'rules_perseo', match: (c) => c.registry_domain_code === 'rules_perseo' },
  { key: 'rules_atena', match: (c) => c.registry_domain_code === 'rules_atena' },
  { key: 'assignment_rules', match: (c) => c.registry_domain_code === 'assignment_rules' },
  { key: 'commercial_objections', match: (c) => c.registry_domain_code === 'commercial_objections' || c.source_type === 'objection' },
  { key: 'campaigns', match: (c) => c.registry_domain_code === 'campaigns' },
  { key: 'zones', match: (c) => c.registry_domain_code === 'zones' },
  { key: 'scripts', match: (c) => c.registry_domain_code === 'scripts' },
];

const CRITICAL_DOMAINS = new Set(['rules_perseo', 'rules_atena', 'assignment_rules']);

function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function chunkTokens(chunk) {
  return estimateTokens(chunk?.content || chunk?.excerpt || '');
}

/**
 * Elimina chunks duplicados por chunk_id o prefijo de contenido (Sprint 5).
 */
function deduplicateChunks(chunks = []) {
  const list = Array.isArray(chunks) ? chunks : [];
  const seenIds = new Set();
  const seenContent = new Set();
  const out = [];
  for (const chunk of list) {
    const id = chunk?.chunk_id || chunk?.id;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push(chunk);
      continue;
    }
    const prefix = String(chunk?.content || '').slice(0, 120).trim().toLowerCase();
    if (!prefix) {
      out.push(chunk);
      continue;
    }
    if (seenContent.has(prefix)) continue;
    seenContent.add(prefix);
    out.push(chunk);
  }
  return out;
}

/**
 * Aplica presupuesto de contexto. Nunca elimina reglas críticas si caben.
 * @param {Array<object>} chunks
 * @returns {{ selected: object[], dropped: object[], context_tokens_estimated: number, chunks_selected: number, chunks_dropped: number }}
 */
function applyContextBudget(chunks = []) {
  const list = deduplicateChunks(Array.isArray(chunks) ? chunks : []);
  const sorted = list.sort((a, b) => {
    const pa = DOMAIN_PRIORITY.findIndex((d) => d.match(a));
    const pb = DOMAIN_PRIORITY.findIndex((d) => d.match(b));
    const ia = pa === -1 ? 999 : pa;
    const ib = pb === -1 ? 999 : pb;
    if (ia !== ib) return ia - ib;
    return (b.similarity ?? b.score ?? 0) - (a.similarity ?? a.score ?? 0);
  });

  const selected = [];
  const dropped = [];
  let tokens = 0;

  for (const chunk of sorted) {
    const t = chunkTokens(chunk);
    const domain = chunk.registry_domain_code || chunk.source_type || '';
    const isCritical = CRITICAL_DOMAINS.has(domain) || chunk.chunk_type === 'rule';

    if (tokens + t <= MAX_CONTEXT_TOKENS) {
      selected.push(chunk);
      tokens += t;
      continue;
    }
    if (isCritical && t <= MAX_CONTEXT_TOKENS) {
      selected.push(chunk);
      tokens += t;
      continue;
    }
    dropped.push(chunk);
  }

  return {
    selected,
    dropped,
    context_tokens_estimated: tokens,
    chunks_selected: selected.length,
    chunks_dropped: dropped.length,
  };
}

module.exports = {
  MAX_CONTEXT_TOKENS,
  DOMAIN_PRIORITY,
  estimateTokens,
  deduplicateChunks,
  applyContextBudget,
};
