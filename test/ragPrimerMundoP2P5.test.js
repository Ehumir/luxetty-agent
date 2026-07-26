'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  criteriaFromActiveProperty,
  formatComparablesReply,
} = require('../services/comparablesService');
const { expandZoneSearchTerms } = require('../services/zoneContextService');
const { planConsultiveTools } = require('../conversation/v3/planner/consultiveToolsPlanner');
const { parseMoneyAmount } = require('../conversation/v3/interpreter/moneyParser');

describe('comparablesService', () => {
  it('criteriaFromActiveProperty builds band and zone', () => {
    const c = criteriaFromActiveProperty({
      id: '1',
      price: 5_000_000,
      operation_type: 'sale',
      neighborhood: 'Cumbres',
      property_type: 'casa',
    });
    assert.equal(c.operation, 'sale');
    assert.equal(c.zone, 'Cumbres');
    assert.equal(c.budgetMax, 6_000_000);
  });

  it('formatComparablesReply never invents without options', () => {
    const t = formatComparablesReply([], { greet: '', ref: 'LUX-A0453' });
    assert.match(t, /No tengo aún otras fichas/);
  });

  it('formatComparablesReply cites SoT urls', () => {
    const t = formatComparablesReply(
      [{ code: 'LUX-A1', price_label: '$1 MXN', location_label: 'Cumbres', public_url: 'https://luxetty.com/x' }],
      { greet: '', ref: 'ref' }
    );
    assert.match(t, /https:\/\/luxetty\.com\/x/);
    assert.match(t, /LUX-A1/);
  });
});

describe('zoneContextService', () => {
  it('expandZoneSearchTerms dedupes', () => {
    const terms = expandZoneSearchTerms({
      input: 'Cumbres',
      canonical: 'Cumbres Elite',
      colonyName: 'Cumbres Elite',
      zoneName: 'Cumbres',
      aliases: ['Cumbres', 'cumbres elite'],
    });
    assert.ok(terms.includes('Cumbres Elite'));
    assert.equal(new Set(terms).size, terms.length);
  });
});

describe('consultiveToolsPlanner', () => {
  it('plans at most 2 tools', () => {
    const tools = planConsultiveTools({
      text: 'Compara similares en Cumbres, ¿cuánto cuesta y qué opciones hay?',
      state: { activeProperty: { id: 'x' }, locationText: 'Cumbres' },
    });
    assert.ok(tools.length <= 2);
    assert.ok(tools.length >= 1);
  });
});

describe('moneyParser primer mundo', () => {
  it('menos de 50 mil = 50000', () => {
    assert.equal(parseMoneyAmount('Busco casa en renta menor a 50 mil'), 50_000);
  });
});
