'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConfirmTemplate, classifyIcfFollowupReply } = require('../services/icfFollowupProduction');
const { ensureConversation } = require('../services/icfFollowupProduction/conversation');

describe('ICF production confirmation template', () => {
  it('uses only the first token of the name and sends both Meta body parameters', () => {
    const out = buildConfirmTemplate({ contact_name:'Juan Jose de Jesus Salazar', lead_type:'demand', operation:'rent' });
    assert.equal(out.name,'Juan');
    assert.equal(out.description,'renta de una propiedad');
    assert.equal(out.body,'Hola Juan. Tu solicitud de renta de una propiedad con Luxetty sigue pendiente de confirmaci\u00f3n.');
    assert.deepEqual(out.components,[{type:'body',parameters:[{type:'text',text:'Juan'},{type:'text',text:'renta de una propiedad'}]}]);
  });

  it('recognizes the exact Meta buttons', () => {
    assert.deepEqual(classifyIcfFollowupReply('Continuar solicitud'),{kind:'confirm',globalOptOut:false});
    assert.deepEqual(classifyIcfFollowupReply('Cerrar solicitud'),{kind:'decline',globalOptOut:false});
  });
});

describe('ICF conversation ownership', () => {
  it('creates the PERSEO conversation without assigning the human owner', async () => {
    let inserted=null;
    const empty={select(){return this;},eq(){return this;},in(){return this;},order(){return this;},limit(){return this;},async maybeSingle(){return {data:null,error:null};}};
    const insertChain={select(){return this;},async single(){return {data:{id:'conv-1',...inserted},error:null};}};
    const supabase={
      from(table){
        if(table!=='conversations') throw new Error(`unexpected table ${table}`);
        return {
          ...empty,
          insert(payload){inserted=payload;return insertChain;},
        };
      },
    };
    const result=await ensureConversation(supabase,{lead_id:'lead-1',contact_id:'contact-1',contact_name:'Laura Munoz',whatsapp:'528111111111',folio_code:'SOL-X'});
    assert.equal(result.created,true);
    assert.equal(inserted.assigned_agent_profile_id,null);
    assert.equal(inserted.lead_id,'lead-1');
  });
});
