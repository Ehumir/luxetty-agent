'use strict';

const { normalizePhoneNumber } = require('../utils/helpers');
const { cleanSpaces } = require('../utils/text');
const leadEntryPointRouter = require('../conversation/leadEntryPointRouter');

const DEFAULT_WINDOW_HOURS = Number(process.env.PERSEO_PROPERTY_SOLICITUD_WINDOW_HOURS || 48);
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || process.env.LUXETTY_PUBLIC_URL || 'https://luxetty.com').replace(/\/$/, '');

function isPropertyAdContext({ parsedSignals = {}, aiState = {}, propertyId = null, text = '' }) {
  const entryType = parsedSignals.__entry_point_meta?.entry_type || aiState.entry_type || null;
  if (entryType === 'property_ad') return true;
  if (propertyId && (aiState.property_specific_intent || aiState.direct_property_reference)) return true;
  return leadEntryPointRouter.isPropertyAdEntry(text || '');
}

function isCompletedSellerCapture({ parsedSignals = {}, aiState = {} }) {
  const sellerFlow =
    aiState.lead_flow === 'offer' ||
    aiState.intent_lock_sale_owner === true ||
    parsedSignals.lead_flow === 'offer' ||
    parsedSignals.intent_lock_sale_owner === true;
  const completedForm =
    aiState.meta_lead_form_flow === true &&
    (aiState.meta_lead_form_ack_sent === true ||
      aiState.qualification_complete === true ||
      aiState.crm_payload_ready === true);

  return sellerFlow && completedForm;
}

async function findRecentPropertySolicitudWithIntake(supabase, { normalizedPhone, propertyId }) {
  try {
    const intakeHydration = require('./intake/intakeHydration');
    if (intakeHydration.isApaIntakeHydrationEnabledForPhone(normalizedPhone)) {
      const intake = await intakeHydration.findRecentIntakeSubmission(supabase, {
        normalizedPhone,
        landingKey: 'property_demand',
        propertyId,
      });
      if (intake && !intake.expired && intake.context?.lead_id) {
        return {
          id: intake.context.lead_id,
          intake_id: intake.row.id,
          source: 'intake_submissions',
          campaign_metadata: { intake_answers: intake.context.answers || {} },
        };
      }
    }
  } catch (err) {
    console.error('PROPERTY_SOLICITUD_INTAKE_DELEGATE_ERROR', {
      error: String(err && err.message ? err.message : err),
    });
  }

  return findRecentPropertySolicitud(supabase, { normalizedPhone, propertyId });
}

async function findRecentPropertySolicitud(supabase, { normalizedPhone, propertyId }) {
  if (!supabase || !normalizedPhone || !propertyId) return null;

  const since = new Date(Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select('id, created_at, campaign_metadata, source')
    .or(`phone.eq.${normalizedPhone},whatsapp.eq.${normalizedPhone}`)
    .eq('interested_property_id', propertyId)
    .eq('is_active', true)
    .eq('is_archived', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('PROPERTY_SOLICITUD_GATE_QUERY_ERROR', { error: error.message });
    return null;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function buildCaptureUrl(property) {
  const slug = cleanSpaces(String(property?.slug || property?.raw?.slug || ''));
  if (!slug) return `${PUBLIC_SITE_URL}/propiedades`;
  return `${PUBLIC_SITE_URL}/propiedad/${slug}?captura=1`;
}

function buildGateMessages(captureUrl) {
  return [
    'Antes de continuar necesito registrar tu solicitud para esta propiedad.',
    `Completa el formulario aquí:\n${captureUrl}`,
    'Cuando la envíes, escríbeme de nuevo y seguimos con gusto.',
  ];
}

/**
 * Gate elegante: property_ad sin Solicitud previa → mensaje + URL de captura.
 * Con Solicitud reciente → continúa flujo normal.
 */
async function evaluatePropertySolicitudGate({
  supabase,
  phone,
  parsedSignals = {},
  aiState = {},
  property = null,
  propertyId = null,
  conversationRow = null,
  text = '',
}) {
  const normalizedPhone = normalizePhoneNumber(phone) || phone;
  const resolvedPropertyId = propertyId || aiState.interested_property_id || null;

  // A completed owner/seller form is already the intake. A campaign property
  // accidentally resolved on the same turn must never replace it with a
  // property-demand capture gate.
  if (isCompletedSellerCapture({ parsedSignals, aiState })) {
    return {
      requiresCapture: false,
      leadId: conversationRow?.lead_id || aiState.lead_id || null,
      statePatch: {
        property_solicitud_pending: false,
        property_solicitud_capture_url: null,
      },
      bypassReason: 'completed_seller_capture',
    };
  }

  if (!isPropertyAdContext({ parsedSignals, aiState, propertyId: resolvedPropertyId, text })) {
    return { requiresCapture: false, leadId: conversationRow?.lead_id || aiState.lead_id || null };
  }

  if (!resolvedPropertyId) {
    return { requiresCapture: false, leadId: null };
  }

  const existingLeadId = conversationRow?.lead_id || aiState.lead_id || null;
  if (existingLeadId) {
    return { requiresCapture: false, leadId: existingLeadId };
  }

  const solicitud = await findRecentPropertySolicitudWithIntake(supabase, {
    normalizedPhone,
    propertyId: resolvedPropertyId,
  });

  if (solicitud?.id) {
    const statePatch = {
      lead_id: solicitud.id,
      property_solicitud_verified: true,
    };
    if (solicitud.intake_id) {
      statePatch.intake_id = solicitud.intake_id;
      statePatch.intake_source = 'property_demand';
      statePatch.apa_intake_hydrated = true;
    }
    return {
      requiresCapture: false,
      leadId: solicitud.id,
      solicitud,
      statePatch,
    };
  }

  const captureUrl = buildCaptureUrl(property);
  return {
    requiresCapture: true,
    messages: buildGateMessages(captureUrl),
    captureUrl,
    statePatch: {
      property_solicitud_pending: true,
      property_solicitud_capture_url: captureUrl,
    },
  };
}

module.exports = {
  evaluatePropertySolicitudGate,
  isCompletedSellerCapture,
  buildCaptureUrl,
  buildGateMessages,
  findRecentPropertySolicitud,
  findRecentPropertySolicitudWithIntake,
};
