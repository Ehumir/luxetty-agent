const OpenAI = require('openai');

let client = null;

function createHermeticOpenAiMock() {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } },
    embeddings: { create: async () => ({ data: [{ embedding: [0, 0, 0] }] }) },
    responses: { create: async () => ({ output_text: '' }) },
    audio: { transcriptions: { create: async () => ({ text: '' }) } },
  };
}

function getOpenAiClient() {
  if (process.env.PERSEO_TEST_HERMETIC === 'true') {
    if (!client) client = createHermeticOpenAiMock();
    return client;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

// Compatibilidad con imports existentes, sin construir un cliente global.
const openai = new Proxy({}, {
  get(_target, property) {
    return getOpenAiClient()[property];
  },
});

module.exports = {
  openai,
  getOpenAiClient,
  createHermeticOpenAiMock,
};
