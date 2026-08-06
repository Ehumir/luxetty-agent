const { createClient } = require('@supabase/supabase-js');

let client = null;

function createHermeticSupabaseMock() {
  const result = { data: null, error: null, count: 0 };
  const builder = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return (resolve) => resolve(result);
      if (property === 'single' || property === 'maybeSingle') return async () => result;
      return () => builder;
    },
  });
  return {
    from() { return builder; },
    rpc: async () => result,
    storage: { from: () => builder },
  };
}

function getSupabaseClient() {
  if (process.env.PERSEO_TEST_HERMETIC === 'true') {
    if (!client) client = createHermeticSupabaseMock();
    return client;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

// Compatibilidad con imports existentes, sin cliente ni conexión global.
const supabase = new Proxy({}, {
  get(_target, property) {
    return getSupabaseClient()[property];
  },
});

module.exports = {
  supabase,
  getSupabaseClient,
  createHermeticSupabaseMock,
};
