'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { processV3Turn, clearV3Session, CONVERSATION_STAGES } = require('../conversation/v3');
const { parseOccupancyStatus } = require('../conversation/v3/interpreter/occupancyParser');
const { mapV3StateToLegacyAiState } = require('../conversation/v3/state/v3ToLegacyAiState');
const { formatStateSummary } = require('../conversation/qaSprint1Commands');

describe('V3-F2.3 location variants (regresión)', () => {
  it('No en San Pedro / en San Pedro / ya te dije que en San Pedro', () => {
    const cid = 'f23-loc-variants';
    clearV3Session(cid);
    processV3Turn({ conversationId: cid, phone: '521', text: 'Quiero vender mi casa' });
    processV3Turn({ conversationId: cid, phone: '521', text: 'Jorge' });

    let r1 = processV3Turn({ conversationId: cid, phone: '521', text: 'No, en San Pedro' });
    assert.equal(r1.state.locationText, 'San Pedro', r1.reply);

    clearV3Session('f23-loc-2');
    processV3Turn({ conversationId: 'f23-loc-2', phone: '521', text: 'Quiero vender mi casa' });
    processV3Turn({ conversationId: 'f23-loc-2', phone: '521', text: 'Jorge' });
    let r2 = processV3Turn({ conversationId: 'f23-loc-2', phone: '521', text: 'en San Pedro' });
    assert.equal(r2.state.locationText, 'San Pedro');

    clearV3Session('f23-loc-3');
    processV3Turn({ conversationId: 'f23-loc-3', phone: '521', text: 'Quiero vender mi casa' });
    processV3Turn({ conversationId: 'f23-loc-3', phone: '521', text: 'Jorge' });
    let r3 = processV3Turn({ conversationId: 'f23-loc-3', phone: '521', text: 'Ya te dije que en San Pedro' });
    assert.equal(r3.state.locationText, 'San Pedro');
    assert.doesNotMatch(String(r3.reply), /cuéntame en pocas palabras/i);
  });
});

describe('V3-F2.3 occupancy parser', () => {
  it('detecta libre, habitada, rentada, ocupada', () => {
    assert.equal(parseOccupancyStatus('Libre'), 'libre');
    assert.equal(parseOccupancyStatus('está habitada'), 'habitada');
    assert.equal(parseOccupancyStatus('rentada'), 'rentada');
    assert.equal(parseOccupancyStatus('ocupada'), 'ocupada');
  });
});

describe('V3-F2.3 QA script occupancy anti-loop', () => {
  it('guion completo hasta Libre sin repetir pregunta', () => {
    const cid = 'f23-qa-1';
    clearV3Session(cid);
    const script = [
      'Hola',
      'Quiero vender mi casa',
      'Jorge',
      'No, está en San Pedro',
      '15 millones',
      'Libre',
    ];
    let last;
    for (const text of script) {
      last = processV3Turn({ conversationId: cid, phone: '5218119086196', text });
      assert.ok(last.ok, text);
    }

    const legacy = mapV3StateToLegacyAiState(last.state);
    assert.equal(legacy.full_name, 'Jorge');
    assert.equal(legacy.lead_flow, 'offer');
    assert.equal(legacy.operation_type, 'sale');
    assert.equal(legacy.location_text, 'San Pedro');
    assert.equal(legacy.property_type, 'house');
    assert.equal(legacy.expected_price, 15_000_000);
    assert.equal(legacy.occupancy_status, 'libre');
    assert.equal(last.state.conversationStage, CONVERSATION_STAGES.READY_FOR_CRM);

    const reply = String(last.reply);
    // Contract is semantic, not frozen copy. Both the legacy acknowledgement
    // and the current consultive close must explicitly confirm "libre".
    assert.match(reply, /(?:Tomé que |la )propiedad está libre/i);
    assert.doesNotMatch(reply, /habitada, rentada o libre/i);

    const summary = formatStateSummary({}, legacy);
    assert.match(summary, /occupancy_status: libre/);

    const again = processV3Turn({ conversationId: cid, phone: '521', text: 'Libre' });
    assert.doesNotMatch(String(again.reply), /habitada, rentada o libre/i);
  });
});
