'use strict';

// Loaded before every offline test. Product .env files and all network are forbidden.
process.env.NODE_ENV = 'test';
process.env.PERSEO_TEST_HERMETIC = 'true';

// Child Node processes spawned by suite runners inherit the same isolation.
const preloadOption = `--require=${__filename}`;
if (!String(process.env.NODE_OPTIONS || '').includes(preloadOption)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(' ');
}

for (const name of [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'META_ACCESS_TOKEN',
  'WHATSAPP_TOKEN',
]) {
  delete process.env[name];
}

try {
  const dotenv = require('dotenv');
  dotenv.config = () => ({ parsed: {} });
} catch (_err) {
  // dotenv is optional to the harness.
}

function blocked(protocol) {
  return function hermeticNetworkBlocked() {
    throw new Error(`hermetic_test_blocked_network:${protocol}`);
  };
}

const originalFetch = global.fetch;

const http = require('node:http');
const https = require('node:https');
const originalHttpRequest = http.request;
const originalHttpGet = http.get;

function loopback(options) {
  const host = typeof options === 'string' || options instanceof URL
    ? new URL(options).hostname
    : String(options?.hostname || options?.host || '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

global.fetch = function hermeticFetch(input, ...args) {
  if (!loopback(input)) throw new Error('hermetic_test_blocked_network:fetch');
  return originalFetch.call(global, input, ...args);
};

http.request = function hermeticHttpRequest(options, ...args) {
  if (!loopback(options)) throw new Error('hermetic_test_blocked_network:http.request');
  return originalHttpRequest.call(http, options, ...args);
};
http.get = function hermeticHttpGet(options, ...args) {
  if (!loopback(options)) throw new Error('hermetic_test_blocked_network:http.get');
  return originalHttpGet.call(http, options, ...args);
};
https.request = blocked('https.request');
https.get = blocked('https.get');
