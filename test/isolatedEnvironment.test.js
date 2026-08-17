"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("certification suite cannot load production credentials", () => {
  assert.equal(process.env.PERSEO_TEST_ISOLATED, "true");
  assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, "test-service-role-key-not-valid");
  assert.equal(process.env.OPENAI_API_KEY, "test-openai-key-not-valid");
  assert.equal(process.env.WHATSAPP_TOKEN, undefined);
  assert.equal(process.env.META_ACCESS_TOKEN, undefined);

  const env = require("../config/env");
  assert.equal(env.SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "test-service-role-key-not-valid");
  assert.equal(env.OPENAI_API_KEY, "test-openai-key-not-valid");
});
