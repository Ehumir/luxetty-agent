'use strict';

const { randomUUID } = require('crypto');
const base = require('../icfDailyFollowup');
const { normalizePhoneNumber } = require('../../utils/helpers');
const { graphPostWhatsAppText, graphPostWhatsAppTemplate, requireGraphWamid } = require('../perseoAutomatedWhatsApp');
const { buildConfirmTemplate, classifyIcfFollowupReply } = require('./helpers');
const { ensureConversation, recheckEligibility } = require('./conversation');

async function listCandidates(supabase,now,limit) {
  const {data,error}=await supabase.rpc('perseo_icf_daily_followup_candidates',{p_now:now.toISOString(),p_limit:limit});
  if(error) throw error;
  return Array.isArray(data)?data:[];
}
async function claim(supabase,leadId,conversationId,attemptId) {
  const {data,error}=await supabase.rpc('perseo_icf_claim_followup',{p_lead_id:leadId,p_conversation_id:conversationId,p_attempt_id:attemptId});
  if(error) throw error;
  return data || {claimed:false,reason:'claim_failed'};
}
async function unclaim(supabase,leadId,attemptId,reason) {
  if(!attemptId) return;
  const {error}=await supabase.rpc('perseo_icf_unclaim_followup',{p_lead_id:leadId,p_attempt_id:attemptId,p_reason:String(reason||'pre_graph_blocked').slice(0,1000)});
  if(error) throw error;
}
async function authorize(supabase,candidate,conversationId) {
  const {data,error}=await supabase.rpc('authorize_perseo_icf_followup_delivery',{p_lead_id:candidate.lead_id,p_conversation_id:conversationId});
  if(error) return {authorized:false,reason:error.message||'authorization_error'};
  return data || {authorized:false,reason:'authorization_missing'};
}
async function recordFailure(supabase,{leadId,conversationId,attemptId,error,deliveryKind}) {
  const {error:rpcError}=await supabase.rpc('perseo_icf_record_followup_failed',{p_lead_id:leadId,p_conversation_id:conversationId,p_attempt_id:attemptId,p_error:String(error||'graph_failure').slice(0,1000),p_delivery_kind:deliveryKind||'text'});
  if(rpcError) throw rpcError;
}
async function lastInboundAt(supabase,conversationId) {
  const {data}=await supabase.from('conversation_messages').select('created_at').eq('conversation_id',conversationId).eq('direction','inbound').order('created_at',{ascending:false}).limit(1).maybeSingle();
  return data?.created_at || null;
}

async function runIcfDailyFollowups({supabase,now=new Date(),dryRun=false,ignoreEnabled=false,limit=null,logger=console}={}) {
  if(!supabase) throw new Error('SUPABASE_CLIENT_REQUIRED');
  const settings=await base.loadIcfFollowupSettings(supabase);
  if(settings.unavailable) return {ok:false,skipped:true,reason:settings.reason,settings_unavailable:true};
  if(!settings.enabled && !ignoreEnabled) return {ok:true,skipped:true,reason:'icf_followup_disabled'};
  const candidates=await listCandidates(supabase,now,Math.max(1,Math.min(Number(limit||settings.batch_limit||50),500)));
  const summary={ok:true,dry_run:!!dryRun,candidates:candidates.length,sent:0,blocked:0,template:0,text:0,errors:0,decisions:[]};
  const persist=base.buildPersistenceAdapter(supabase);

  for(const candidate of candidates) {
    let attemptId=null, conversationId=candidate.conversation_id||null, persisted={rows:[]};
    let deliveryKind=base.isWithinCustomerServiceWindow(candidate.last_customer_message_at,now)?'text':'template';
    try {
      const to=normalizePhoneNumber(candidate.whatsapp)||candidate.whatsapp;
      const template=buildConfirmTemplate(candidate);
      if(deliveryKind==='template' && !settings.template_name) {
        summary.blocked++; summary.decisions.push({lead_id:candidate.lead_id,folio_code:candidate.folio_code,action:dryRun?'would_block':'blocked',reason:'template_not_configured'}); continue;
      }
      if(dryRun) {
        summary.decisions.push({lead_id:candidate.lead_id,folio_code:candidate.folio_code,action:'would_send',delivery_kind:deliveryKind,recipient:to,preview:deliveryKind==='template'?template.body:settings.free_text_body,template_name:deliveryKind==='template'?settings.template_name:null,template_parameters:deliveryKind==='template'?[template.name,template.description]:[],would_materialize_conversation:!candidate.conversation_id});
        continue;
      }

      const ensured=await ensureConversation(supabase,candidate);
      const conversation=ensured.conversation; conversationId=conversation?.id||null;
      if(!conversation||ensured.blocked) {summary.blocked++;summary.decisions.push({lead_id:candidate.lead_id,action:'blocked',reason:ensured.reason||'conversation_unavailable'});continue;}
      const eligible=await recheckEligibility(supabase,candidate,conversation);
      if(!eligible.allowed) {summary.blocked++;summary.decisions.push({lead_id:candidate.lead_id,action:'blocked',reason:eligible.reason});continue;}
      deliveryKind=base.isWithinCustomerServiceWindow(await lastInboundAt(supabase,conversation.id),now)?'text':'template';
      attemptId=randomUUID();
      const claimed=await claim(supabase,candidate.lead_id,conversation.id,attemptId);
      if(!claimed?.claimed) {attemptId=null;summary.blocked++;summary.decisions.push({lead_id:candidate.lead_id,action:'blocked',reason:claimed?.reason||'claim_denied',next_due_at:claimed?.next_due_at||null});continue;}

      const text=deliveryKind==='template'?template.body:String(settings.free_text_body||'').trim();
      if(!text) {await unclaim(supabase,candidate.lead_id,attemptId,'outbound_empty');attemptId=null;summary.blocked++;continue;}
      persisted=await persist({conversationId:conversation.id,messages:[text],rawPayload:{perseo_metadata:{automation:'perseo_icf_daily',lead_id:candidate.lead_id,validation_id:candidate.validation_id,folio_code:candidate.folio_code||null,attempt_id:attemptId},whatsapp_message_type:deliveryKind,whatsapp_template_name:deliveryKind==='template'?settings.template_name:null}});

      const authz=await authorize(supabase,candidate,conversation.id);
      if(!authz?.authorized) {await unclaim(supabase,candidate.lead_id,attemptId,authz?.reason||'authorization_denied');attemptId=null;summary.blocked++;summary.decisions.push({lead_id:candidate.lead_id,action:'blocked',reason:authz?.reason||'authorization_denied',followup_action_id:authz?.followup_action_id||null});continue;}

      const response=deliveryKind==='template'
        ? await graphPostWhatsAppTemplate(to,{name:settings.template_name,language:settings.template_language||'es_MX',components:template.components})
        : await graphPostWhatsAppText(to,text);
      const wamid=requireGraphWamid(response)[0];
      await base.attachWamidToPersistedRows(supabase,persisted.rows,wamid,{automation:'perseo_icf_daily',lead_id:candidate.lead_id,attempt_id:attemptId,delivery_kind:deliveryKind,followup_action_id:authz.followup_action_id||null});
      const {data:recorded,error:recordError}=await supabase.rpc('perseo_icf_record_followup_sent',{p_lead_id:candidate.lead_id,p_conversation_id:conversation.id,p_wamid:wamid,p_delivery_kind:deliveryKind,p_attempt_id:attemptId});
      if(recordError||recorded?.ok===false) throw recordError||new Error(recorded?.code||'followup_record_failed');
      summary.sent++;summary[deliveryKind]++;summary.decisions.push({lead_id:candidate.lead_id,folio_code:candidate.folio_code,conversation_id:conversation.id,action:'sent',delivery_kind:deliveryKind,wamid,followup_action_id:authz.followup_action_id||null});
      attemptId=null;
    } catch(err) {
      const errorText=String(err?.message||err);
      if(attemptId) {
        try {await base.markPersistedRowsFailed(supabase,persisted.rows||[],errorText,{automation:'perseo_icf_daily',lead_id:candidate.lead_id,attempt_id:attemptId,delivery_kind:deliveryKind});await recordFailure(supabase,{leadId:candidate.lead_id,conversationId,attemptId,error:errorText,deliveryKind});} catch(_e) {}
      }
      summary.errors++; summary.decisions.push({lead_id:candidate.lead_id,action:'error',reason:errorText});
      if(logger?.warn) logger.warn('icf_daily_followup_error',{lead_id:candidate.lead_id,error:errorText});
    }
  }
  return summary;
}

async function handleIcfFollowupInbound({supabase,conversationId,text,logger=console}={}) {
  if(!supabase||!conversationId) return {handled:false,reason:'missing_context'};
  const classification=classifyIcfFollowupReply(text);
  if(classification.kind==='unknown') return {handled:false,reason:'not_followup_answer'};
  const {data:conversation,error}=await supabase.from('conversations').select('id,lead_id,contact_id,ai_state').eq('id',conversationId).maybeSingle();
  if(error||!conversation?.lead_id) return {handled:false,reason:'conversation_without_lead'};
  const {data:state}=await supabase.from('followup_reminder_state').select('last_sent_at').eq('dedupe_key',`perseo_icf_daily:${conversation.lead_id}`).maybeSingle();
  if(!state?.last_sent_at) return {handled:false,reason:'no_icf_daily_followup'};
  const {data:validation}=await supabase.from('entity_validations').select('id,resolved_at').eq('validation_kind','intent_confirmation').eq('entity_type','lead').eq('entity_id',conversation.lead_id).maybeSingle();
  if(!validation||validation.resolved_at) return {handled:false,reason:'validation_not_open'};
  if(classification.kind==='confirm') {
    const {data,error:rpcError}=await supabase.rpc('perseo_icf_confirm_from_whatsapp',{p_lead_id:conversation.lead_id,p_conversation_id:conversationId,p_verbatim:text,p_interest_level:'high'});
    if(rpcError) throw rpcError;
    if(logger?.info) logger.info('icf_followup_confirmed',{conversation_id:conversationId,lead_id:conversation.lead_id});
    return {handled:true,outcome:'confirmed',suppressAutomatedReply:true,data};
  }
  const {data,error:rpcError}=await supabase.rpc('perseo_icf_decline_from_whatsapp',{p_lead_id:conversation.lead_id,p_conversation_id:conversationId,p_verbatim:text,p_global_opt_out:classification.globalOptOut===true});
  if(rpcError) throw rpcError;
  return {handled:true,outcome:classification.globalOptOut?'global_opt_out':'service_declined',suppressAutomatedReply:true,data};
}

module.exports={runIcfDailyFollowups,handleIcfFollowupInbound,classifyIcfFollowupReply,buildConfirmTemplate};
