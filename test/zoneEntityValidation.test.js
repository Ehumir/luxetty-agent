'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractZoneEntityTokens,
  validateZoneEntityMatch,
} = require('../conversation/v3/rag/zoneEntityValidation');

describe('zoneEntityValidation — RC-1.1', () => {
  it('RC11-ZE-01 — extrae entidad de colonia inexistente', () => {
    const tokens = extractZoneEntityTokens('zona ColoniaInexistenteXYZ-999');
    assert.ok(tokens.some((t) => t.includes('coloniainexistente')));
  });

  it('RC11-ZE-02 — NEG-03 rechaza chunks sin entidad', () => {
    const chunks = [
      { content: 'Colonia Cumbres en Monterrey zona residencial', similarity: 0.49 },
      { content: 'San Pedro Garza García ubicación premium', similarity: 0.48 },
    ];
    const result = validateZoneEntityMatch('zona ColoniaInexistenteXYZ-999', chunks);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'entity_not_in_citations');
  });

  it('RC11-ZE-03 — zona real con match válido', () => {
    const chunks = [{ content: 'Colonia Cumbres sector residencial Monterrey', similarity: 0.72 }];
    const result = validateZoneEntityMatch('zona Cumbres ubicación', chunks);
    assert.equal(result.valid, true);
    assert.equal(result.reason, 'entity_matched');
  });

  it('RC11-ZE-04 — query genérico sin entidad específica pasa', () => {
    const result = validateZoneEntityMatch('¿dónde queda?', []);
    assert.equal(result.valid, true);
    assert.equal(result.reason, 'no_specific_entity');
  });
});
