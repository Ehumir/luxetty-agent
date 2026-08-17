const { OPENAI_API_KEY } = require('../config/env');
const OpenAI = require('openai');

const isolatedTest = process.env.PERSEO_TEST_ISOLATED === 'true';
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  maxRetries: isolatedTest ? 0 : 2,
  timeout: isolatedTest ? 250 : 600_000,
});

module.exports = {
  openai,
};
