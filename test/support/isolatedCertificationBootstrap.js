"use strict";

const dotenv = require("dotenv");

const requiredSafeValues = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-valid",
  OPENAI_API_KEY: "test-openai-key-not-valid",
};

for (const [name, expected] of Object.entries(requiredSafeValues)) {
  if (process.env[name] !== expected) {
    throw new Error(`unsafe_or_missing_isolated_value:${name}`);
  }
}

for (const name of [
  "SUPABASE_KEY",
  "WHATSAPP_TOKEN",
  "META_ACCESS_TOKEN",
  "ARGOS_SERVICE_SECRET",
  "VERIFY_TOKEN",
]) delete process.env[name];

dotenv.config = () => ({ parsed: {} });

globalThis.fetch = async () => {
  throw new Error("network_disabled_in_isolated_certification");
};

process.env.PERSEO_TEST_ISOLATED = "true";
