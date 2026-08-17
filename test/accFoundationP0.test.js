'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const ATENA_ROOT = process.env.ATENA_ROOT
  ? path.resolve(process.env.ATENA_ROOT)
  : path.join(ROOT, '..', 'luxetty-atena');
const MIGRATION_PATH = path.join(
  ATENA_ROOT,
  'supabase/migrations/20260706120000_acc_connector_registry.sql',
);

function requestJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('accFoundationP0 — Sprint 1', () => {
  /** @type {import('http').Server | null} */
  let server = null;
  /** @type {string} */
  let baseUrl = '';

  before(async () => {
    delete process.env.ACC_P0_ENABLED;
    delete process.env.ACC_FACEBOOK_ENABLED;
    delete process.env.ACC_INSTAGRAM_ENABLED;

    const app = express();
    app.use(express.json());
    const { registerAccChannelRoutes } = require('../channelGatewayP0/registerAccChannelRoutes');
    registerAccChannelRoutes(app);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('S1-T01 — conectores registrados en migración (whatsapp activo, fb/ig seed)', () => {
    assert.ok(fs.existsSync(MIGRATION_PATH), `migration missing: ${MIGRATION_PATH}`);
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.connector_registry/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.connector_accounts/);
    assert.match(sql, /'whatsapp'/);
    assert.match(sql, /'facebook'/);
    assert.match(sql, /'instagram'/);
    assert.match(sql, /is_active,\s*sort_order,\s*notes\)[\s\S]*'whatsapp'[\s\S]*true/);
    assert.match(sql, /'facebook'[\s\S]*false/);
    assert.match(sql, /'instagram'[\s\S]*false/);
  });

  it('S1-T02 — flags ACC+RAG detectadas (defaults OFF, jerarquía efectiva)', () => {
    const flags = require('../config/accP0Flags');
    const snap = flags.getAccRagP0FlagSnapshot();

    assert.equal(snap.ACC_P0_ENABLED, false);
    assert.equal(snap.ACC_WHATSAPP_GATEWAY_ENABLED, false);
    assert.equal(snap.ACC_FACEBOOK_ENABLED, false);
    assert.equal(snap.ACC_INSTAGRAM_ENABLED, false);
    assert.equal(snap.RAG_P0_ENABLED, false);
    assert.equal(snap.RAG_INVENTORY_ENABLED, false);
    assert.equal(snap.RAG_RULES_ENABLED, false);
    assert.equal(snap.ACC_P0_EFFECTIVE_WHATSAPP_GATEWAY, false);
    assert.equal(snap.ACC_P0_EFFECTIVE_FACEBOOK, false);
    assert.equal(snap.ACC_P0_EFFECTIVE_INSTAGRAM, false);
    assert.equal(snap.RAG_P0_EFFECTIVE_INVENTORY, false);
    assert.equal(snap.RAG_P0_EFFECTIVE_RULES, false);

    process.env.ACC_P0_ENABLED = 'true';
    process.env.ACC_FACEBOOK_ENABLED = 'true';
    const snap2 = flags.getAccRagP0FlagSnapshot();
    assert.equal(snap2.ACC_P0_EFFECTIVE_FACEBOOK, true);
    delete process.env.ACC_P0_ENABLED;
    delete process.env.ACC_FACEBOOK_ENABLED;
    const snap3 = flags.getAccRagP0FlagSnapshot();
    assert.equal(snap3.ACC_P0_EFFECTIVE_FACEBOOK, false);
  });

  it('S1-T03 — WhatsApp legacy baseline 10/10 (acc-foundation-p0)', () => {
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

  it('S1-T04 — FB/IG inactivos con flags OFF (404 channel_not_enabled)', async () => {
    const fb = await requestJson('POST', `${baseUrl}/webhook/facebook`, { object: 'page', entry: [] });
    assert.equal(fb.status, 404);
    assert.equal(fb.json?.error, 'channel_not_enabled');
    assert.equal(fb.json?.channel, 'facebook');

    const ig = await requestJson('POST', `${baseUrl}/webhook/instagram`, { object: 'instagram', entry: [] });
    assert.equal(ig.status, 404);
    assert.equal(ig.json?.error, 'channel_not_enabled');
    assert.equal(ig.json?.channel, 'instagram');
  });

  it('S1-T05 — RLS connector_accounts admin-only INSERT en migración', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    assert.match(sql, /connector_accounts_admin_insert/);
    assert.match(sql, /WITH CHECK \(public\.is_admin\(\)\)/);
    assert.match(sql, /connector_accounts ENABLE ROW LEVEL SECURITY/);
  });

  it('contrato NormalizedInboundEnvelope válido', () => {
    const {
      buildNormalizedInboundEnvelope,
      isNormalizedInboundEnvelope,
      toNormalizedConversationTurn,
    } = require('../channelGatewayP0/contracts/normalizedInboundEnvelope');

    const env = buildNormalizedInboundEnvelope({
      connector_code: 'whatsapp',
      external_message_id: 'wamid.TEST',
      external_sender_id: '5218110000001',
      text: 'hola',
    });
    assert.equal(env.envelope_version, '1');
    assert.ok(isNormalizedInboundEnvelope(env));
    const turn = toNormalizedConversationTurn(env);
    assert.equal(turn.channel, 'whatsapp');
  });
});
