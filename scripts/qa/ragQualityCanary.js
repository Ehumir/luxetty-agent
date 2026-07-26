#!/usr/bin/env node
'use strict';

/**
 * Sprint 5 — Canary QA calidad RAG (≥100 conversaciones simuladas vía webhook).
 * Usage: PERSEO_BASE_URL=... node scripts/qa/ragQualityCanary.js [--json] [--limit=100]
 *
 * Requiere flags RAG ON en QA + allowlist. No activa prod.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { buildWebhookEnvelope, textMessage } = require('../../test/helpers/whatsappFixtures');
const { buildRagQualityReport } = require('../../argos/ragKpiReport');

const BASE_URL = (process.env.PERSEO_BASE_URL || 'https://luxetty-perseo-qa.up.railway.app').replace(/\/$/, '');
const QA_PHONE = String(process.env.RAG_SMOKE_PHONE || '5218181877351').replace(/\D/g, '');
const NON_ALLOWLIST = String(process.env.RAG_SMOKE_NON_ALLOWLIST || '5299912345678').replace(/\D/g, '');
const RUN_ID = `s5-quality-${Date.now()}`;
const jsonOut = process.argv.includes('--json');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const TARGET = limitArg ? Number(limitArg.split('=')[1]) : 100;

const BASE_SCENARIOS = [
  { id: 'S5-Q02', text: 'Busco casa con jardín en Cumbres' },
  { id: 'S5-Q03', text: '¿Cuánto cuesta?' },
  { id: 'S5-Q05', text: '¿En qué zona queda?' },
  { id: 'S5-Q06', text: '¿Tiene alberca y roof garden?' },
  { id: 'S5-Q11', text: 'Me parece mucho la comisión que cobran' },
  { id: 'S5-Q12', text: 'No quiero firmar exclusiva' },
  { id: 'S5-Q10', text: 'Quiero vender mi casa en San Pedro' },
  { id: 'S5-Q15', text: 'Busco casa en venta en Monterrey' },
  { id: 'S5-Q16', text: 'Departamento en renta cerca del Tec' },
  { id: 'S5-Q17', text: 'castillo en la luna con helipuerto' },
  { id: 'S5-Q18', text: 'esa casa bonita' },
  { id: 'S5-H01', text: '¿Cuánto cuesta LUX-FAKE-999?' },
  { id: 'S5-H02', text: 'Info de propiedad que no existe en inventario' },
  { id: 'S5-H03', text: '¿Tiene campo de golf privado?' },
  { id: 'S5-Q14', text: '¿Quién es el dueño del contacto?' },
  { id: 'S5-Q07', text: 'Compara LUX-A0453 con LUX-A0470' },
  { id: 'S5-Q08', text: '¿Sigue disponible?' },
  { id: 'S5-Q13', text: '¿Cuánto vale mi casa?' },
  { id: 'S5-Q01', text: 'Info LUX-A0453' },
  { id: 'S5-Q04', text: 'precio exacto sin contexto' },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uniqueWamid(tag) {
  return `wamid.${RUN_ID}.${tag}.${Math.random().toString(36).slice(2, 8)}`;
}

function expandScenarios(target) {
  const out = [];
  let i = 0;
  while (out.length < target) {
    for (const s of BASE_SCENARIOS) {
      out.push({
        ...s,
        run: i,
        phone: out.length % 10 === 9 ? NON_ALLOWLIST : QA_PHONE,
        waitMs: 4000,
      });
      if (out.length >= target) break;
    }
    i += 1;
  }
  return out;
}

async function postInbound({ phone, text, wamid }) {
  const msg = textMessage(text, { from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)) });
  const envelope = buildWebhookEnvelope([msg], { waId: phone, profileName: 'S5 RAG Quality' });
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return { ok: res.status === 200, status: res.status, latency_ms: Date.now() - t0 };
}

async function main() {
  const scenarios = expandScenarios(TARGET);
  const since = new Date().toISOString();
  const results = [];

  for (const s of scenarios) {
    const wamid = uniqueWamid(`${s.id}-${s.run}`);
    const res = await postInbound({ phone: s.phone, text: `${s.text} [${RUN_ID}]`, wamid });
    results.push({ ...s, ...res });
    await sleep(s.waitMs);
  }

  await sleep(3000);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  let report = null;
  if (url && key) {
    const supabase = createClient(url, key);
    const [eventsRes, logsRes, leadsRes] = await Promise.all([
      supabase
        .from('conversation_events')
        .select('id, type, payload, created_at')
        .eq('type', 'rag_retrieval')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from('rag_query_logs')
        .select('id, fallback_used, result_count, latency_ms, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('leads').select('id').gte('created_at', since).limit(5),
    ]);
    report = buildRagQualityReport({
      events: eventsRes.data || [],
      ragQueryLogs: logsRes.data || [],
      since,
    });
    report.safety = {
      new_leads_count: (leadsRes.data || []).length,
      crm_writes_forbidden: (leadsRes.data || []).length === 0,
    };
  }

  const summary = {
    run_id: RUN_ID,
    target_conversations: TARGET,
    webhook_ok: results.filter((r) => r.ok).length,
    webhook_fail: results.filter((r) => !r.ok).length,
    avg_webhook_latency_ms: results.length
      ? Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length)
      : 0,
    since,
    report,
    certified: Boolean(report?.kpi?.sample_size > 0 && report?.safety?.crm_writes_forbidden),
  };

  if (jsonOut) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Sprint 5 RAG Quality Canary');
    console.log('conversations:', TARGET);
    console.log('webhook_ok:', summary.webhook_ok);
    console.log('rag_events:', report?.kpi?.sample_size ?? 0);
    console.log('grounded_rate:', report?.kpi?.grounded_response_rate?.toFixed(3) ?? 'n/a');
    console.log('certified:', summary.certified);
  }

  process.exit(summary.certified ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
