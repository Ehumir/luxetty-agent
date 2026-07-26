'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCampaignEntityTokens,
  validateCampaignEntityMatch,
} = require('../conversation/v3/rag/campaignEntityValidation');

describe('campaignEntityValidation — RC-1.2', () => {
  it('RC12-CE-01 — extrae entidad de campaña inexistente', () => {
    const tokens = extractCampaignEntityTokens('campaña CampaniaInexistenteXYZ-999');
    assert.ok(tokens.some((t) => t.includes('campaniainexistente')));
  });

  it('RC12-CE-02 — NEG-C01 rechaza chunks sin entidad', () => {
    const chunks = [
      { content: 'Campaña de captación Meta Ads para propiedades en venta', similarity: 0.51 },
      { content: 'Pauta Facebook Instagram anuncios inmobiliarios', similarity: 0.48 },
    ];
    const result = validateCampaignEntityMatch('campaña CampaniaInexistenteXYZ-999', chunks);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'entity_not_in_citations');
  });

  it('RC12-CE-03 — campaña real con match válido', () => {
    const chunks = [
      {
        content: 'Campaña BlackFriday2025 promoción propiedades',
        metadata: { campaign_name: 'BlackFriday2025' },
        similarity: 0.72,
      },
    ];
    const result = validateCampaignEntityMatch('campaña BlackFriday2025', chunks);
    assert.equal(result.valid, true);
    assert.equal(result.reason, 'entity_matched');
  });

  it('RC12-CE-04 — menciones genéricas sin entidad específica pasan', () => {
    for (const q of ['Vi su anuncio', 'Me interesa la publicación', 'Vi una campaña de captación']) {
      const result = validateCampaignEntityMatch(q, []);
      assert.equal(result.valid, true, q);
      assert.equal(result.reason, 'no_specific_entity', q);
    }
  });

  it('RC12-CE-05 — flag OFF no aplica (orquestador test separado)', () => {
    const tokens = extractCampaignEntityTokens('campaña TestCampaign-ABC');
    assert.ok(tokens.length >= 1);
  });
});
