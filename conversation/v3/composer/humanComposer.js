'use strict';

const { cleanSpaces, normalizeText } = require('../../../utils/text');
const {
  CONVERSATION_GOALS,
  V3_INTENT,
  FORBIDDEN_COMPOSER_PATTERNS,
} = require('../types/constants');
const { occupancyStatusLabel } = require('../interpreter/occupancyParser');
const {
  acknowledgedZone,
  acknowledgedPrice,
  askExpectedPrice,
  SLOT_COPY,
} = require('./humanCopyV1');
const { composeLandingCaptureReply, isLandingCaptureActive } = require('../interpreter/landingCaptureFlow');

function formatMoneyMx(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${Math.round(n).toLocaleString('es-MX')}`;
  }
}

function assertComposerQuality(text) {
  const s = String(text || '');
  for (const p of FORBIDDEN_COMPOSER_PATTERNS) {
    if (p.test(s)) return false;
  }
  return s.length > 0;
}

function firstName(state) {
  const full = cleanSpaces(String(state.collectedFields?.fullName || ''));
  if (!full) return null;
  return full.split(/\s+/)[0];
}

function getPropertyType(state) {
  return state.propertyType || state.collectedFields?.propertyType || null;
}

function getOccupancyStatus(state) {
  return state.occupancyStatus || state.collectedFields?.occupancyStatus || null;
}

function sellContextReady(state) {
  const nm = firstName(state);
  return !!(
    nm &&
    state.locationText &&
    state.expectedPrice != null &&
    getPropertyType(state)
  );
}

function sellNeedsOccupancy(state) {
  return sellContextReady(state) && !getOccupancyStatus(state);
}

function composeSellOccupancyQuestion(state) {
  const nm = firstName(state);
  const zone = state.locationText || 'esa zona';
  const pres = formatMoneyMx(state.expectedPrice);
  const tipo = getPropertyType(state) === 'house' ? 'casa' : 'inmueble';
  return {
    responseText: `Perfecto, ${nm}. Tengo tu ${tipo} en ${zone} con precio esperado de ${pres}. ¿Está habitada, rentada o libre?`,
    followUpQuestion: null,
    awaitingField: 'occupancy_status',
    toneFlags: { consultive: true },
  };
}

function composeSellQualificationComplete(state) {
  const nm = firstName(state);
  const zone = state.locationText || 'esa zona';
  const occ = occupancyStatusLabel(getOccupancyStatus(state));
  return {
    responseText: `Perfecto, ${nm}. Tomé que la propiedad está ${occ}. Con lo que tengo de tu venta en ${zone}, un asesor puede continuar contigo.`,
    followUpQuestion: null,
    awaitingField: null,
    toneFlags: { consultive: true },
  };
}

/**
 * @param {{ state: object, decision: object, context?: object }} input
 */
function composeHumanResponse(input) {
  const state = input.state || {};
  const decision = input.decision || {};
  const intent = decision.detectedIntent;
  const nm = firstName(state);
  const sell = state.conversationGoal === CONVERSATION_GOALS.SELL_PROPERTY || state.leadFlow === 'offer';
  const buy = state.conversationGoal === CONVERSATION_GOALS.BUY_PROPERTY || state.leadFlow === 'demand';

  if (
    intent === V3_INTENT.LANDING_CAPTURE ||
    isLandingCaptureActive(state) ||
    decision.landingCaptureReply
  ) {
    const landingReply = composeLandingCaptureReply(state, decision);
    if (landingReply) {
      return {
        responseText: landingReply,
        followUpQuestion: null,
        awaitingField: state.awaitingField ?? null,
        toneFlags: { consultive: true, mexicanSpanish: true },
      };
    }
  }

  if (intent === V3_INTENT.OCCUPANCY_CAPTURE && sell && nm) {
    return composeSellQualificationComplete(state);
  }

  if (intent === V3_INTENT.FRUSTRATION) {
    if (sell && sellNeedsOccupancy(state)) {
      return composeSellOccupancyQuestion(state);
    }
    if (sell && sellContextReady(state) && getOccupancyStatus(state)) {
      return composeSellQualificationComplete(state);
    }
    return {
      responseText:
        'Tienes razón, déjame hacerlo más claro. Cuéntame en pocas palabras qué quieres lograr y seguimos paso a paso.',
      followUpQuestion: null,
      toneFlags: { empathetic: true, mexicanSpanish: true },
    };
  }

  if (intent === V3_INTENT.GREETING) {
    return {
      responseText: 'Hola, con gusto te ayudo. ¿Buscas vender, comprar o rentar una propiedad?',
      followUpQuestion: null,
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.SELL_PROPERTY) {
    if (!nm) {
      return {
        responseText: 'Claro, te apoyo con la venta de tu casa. Para orientarte mejor, ¿me compartes tu nombre?',
        followUpQuestion: '¿Me compartes tu nombre?',
        toneFlags: { consultive: true },
      };
    }
    return {
      responseText: `Perfecto, ${nm}. Te apoyo con la venta. ¿En qué zona está la propiedad?`,
      followUpQuestion: '¿En qué zona está la propiedad?',
      awaitingField: 'location_text',
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.IDENTITY_CAPTURE && nm) {
    if (sell) {
      if (state.locationText) {
        return {
          responseText: `Claro, ${nm}. ${acknowledgedZone(state.locationText)} ¿Qué precio tienes pensado manejar?`,
          followUpQuestion: '¿Tienes un precio esperado de venta?',
          toneFlags: { consultive: true },
        };
      }
      return {
        responseText: `Perfecto, ${nm}. Te apoyo con la venta. ¿En qué zona está la propiedad?`,
        followUpQuestion: '¿En qué zona está la propiedad?',
        awaitingField: 'location_text',
        toneFlags: { consultive: true },
      };
    }
    if (buy) {
      return {
        responseText: `Gracias, ${nm}. Sigo con tu búsqueda. ¿Qué presupuesto aproximado manejas?`,
        followUpQuestion: '¿Qué presupuesto aproximado manejas?',
        toneFlags: { consultive: true },
      };
    }
  }

  if (intent === V3_INTENT.LOCATION_CAPTURE && sell) {
    const zone = state.locationText || 'esa zona';
    if (nm) {
      if (state.expectedPrice != null && sellNeedsOccupancy(state)) {
        return composeSellOccupancyQuestion(state);
      }
      if (state.expectedPrice != null && getOccupancyStatus(state)) {
        return composeSellQualificationComplete(state);
      }
      return {
        responseText: `Perfecto, ${nm}. Tomé la zona (${zone}). ¿Tienes un precio esperado de venta?`,
        followUpQuestion: null,
        awaitingField: 'expected_price',
        toneFlags: { consultive: true },
      };
    }
    return {
      responseText: `${acknowledgedZone(zone)} ${SLOT_COPY.sell_capture_name[0]}`,
      followUpQuestion: '¿Me compartes tu nombre?',
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.PROPERTY_TYPE_CAPTURE && sell && nm) {
    if (state.locationText && state.expectedPrice != null && sellNeedsOccupancy(state)) {
      return composeSellOccupancyQuestion(state);
    }
    if (state.locationText && state.expectedPrice != null && getOccupancyStatus(state)) {
      return composeSellQualificationComplete(state);
    }
    return {
      responseText: `Perfecto, ${nm}. Es casa. ¿En qué zona está la propiedad?`,
      followUpQuestion: null,
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.SELLER_PRICE && sell) {
    const pres = formatMoneyMx(state.expectedPrice);
    const zone = state.locationText ? ` en ${state.locationText}` : '';
    if (nm && getPropertyType(state) && sellNeedsOccupancy(state)) {
      return composeSellOccupancyQuestion(state);
    }
    if (nm && getPropertyType(state) && getOccupancyStatus(state)) {
      return composeSellQualificationComplete(state);
    }
    if (nm) {
      return {
        responseText: `Entendido, ${nm}. Con un precio esperado de ${pres}${zone}, ¿es casa, departamento o terreno?`,
        followUpQuestion: null,
        toneFlags: { consultive: true },
      };
    }
    return {
      responseText: `${acknowledgedPrice(pres)} ¿Me compartes tu nombre?`,
      followUpQuestion: '¿Me compartes tu nombre?',
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.BUY_PROPERTY || (buy && intent === V3_INTENT.LOCATION_CAPTURE)) {
    const zone = state.locationText || 'esa zona';
    if (!nm) {
      return {
        responseText: `Te ayudo a buscar en ${zone}. ¿Me compartes tu nombre?`,
        followUpQuestion: '¿Me compartes tu nombre?',
        toneFlags: { consultive: true },
      };
    }
    if (state.budget == null) {
      return {
        responseText: `Perfecto, ${nm}. Busco opciones en ${zone}. ¿Qué presupuesto aproximado manejas?`,
        followUpQuestion: '¿Qué presupuesto aproximado manejas?',
        toneFlags: { consultive: true },
      };
    }
    if (state.bedrooms == null) {
      return {
        responseText: `Con ${formatMoneyMx(state.budget)} en ${zone}, ¿cuántas recámaras necesitas?`,
        followUpQuestion: '¿Cuántas recámaras necesitas?',
        toneFlags: { consultive: true },
      };
    }
    return {
      responseText: `Gracias, ${nm}. Con ${state.bedrooms} recámaras y ${formatMoneyMx(state.budget)} en ${zone}, ¿prefieres que un asesor valide inventario contigo?`,
      followUpQuestion: '¿Validamos inventario con un asesor?',
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.BUYER_BUDGET && buy) {
    const zone = state.locationText || 'esa zona';
    if (nm) {
      return {
        responseText: `Gracias, ${nm}. Con ${formatMoneyMx(state.budget)} en ${zone}, ¿cuántas recámaras buscas?`,
        followUpQuestion: '¿Cuántas recámaras buscas?',
        toneFlags: { consultive: true },
      };
    }
    return {
      responseText: `${acknowledgedZone(zone)} ¿Me compartes tu nombre?`,
      followUpQuestion: '¿Me compartes tu nombre?',
      toneFlags: { consultive: true },
    };
  }

  if (intent === V3_INTENT.BEDROOMS_CAPTURE && buy && nm) {
    return {
      responseText: `Perfecto, ${nm}. Con ${state.bedrooms} recámaras en ${state.locationText || 'esa zona'}, ¿quieres que un asesor te confirme opciones reales?`,
      followUpQuestion: '¿Te conecto con un asesor?',
      toneFlags: { consultive: true },
    };
  }

  if (sell && nm && sellNeedsOccupancy(state)) {
    return composeSellOccupancyQuestion(state);
  }

  if (sell && nm && sellContextReady(state) && getOccupancyStatus(state)) {
    return composeSellQualificationComplete(state);
  }

  if (sell && nm) {
    if (!state.locationText) {
      return {
        responseText: `Perfecto, ${nm}. Te apoyo con la venta. ¿En qué zona está la propiedad?`,
        followUpQuestion: null,
        awaitingField: 'location_text',
        toneFlags: { consultive: true },
      };
    }
    if (state.expectedPrice == null) {
      return {
        responseText: `Perfecto, ${nm}. ${acknowledgedZone(state.locationText)} ¿Qué precio tienes pensado manejar?`,
        followUpQuestion: null,
        toneFlags: { consultive: true },
      };
    }
    if (!getPropertyType(state)) {
      return {
        responseText: `Entendido, ${nm}. ¿Es casa, departamento o terreno?`,
        followUpQuestion: null,
        toneFlags: { consultive: true },
      };
    }
    if (sellNeedsOccupancy(state)) {
      return composeSellOccupancyQuestion(state);
    }
    return composeSellQualificationComplete(state);
  }

  return {
    responseText: 'Te escucho. ¿Me cuentas si buscas vender, comprar o rentar?',
    followUpQuestion: null,
    toneFlags: { consultive: true },
  };
}

function normalizeQuestionForDedupe(text) {
  return normalizeText(String(text || ''))
    .replace(/[¿?]/g, '')
    .trim();
}

function composeHumanReplyText(input) {
  const out = composeHumanResponse(input);
  let merged = cleanSpaces(out.responseText || '');
  const followUp = cleanSpaces(out.followUpQuestion || '');
  const bodyHasQuestion = /¿/.test(merged);
  if (followUp && !bodyHasQuestion) {
    const bodyNorm = normalizeQuestionForDedupe(merged);
    const fuNorm = normalizeQuestionForDedupe(followUp);
    if (!fuNorm || !bodyNorm.includes(fuNorm)) {
      merged = cleanSpaces(`${merged} ${followUp}`);
    }
  }
  merged = merged.replace(/\s+/g, ' ').trim();
  if (!assertComposerQuality(merged)) {
    return 'Con gusto te ayudo. Cuéntame si buscas vender, comprar o rentar una propiedad.';
  }
  return merged;
}

module.exports = {
  composeHumanResponse,
  composeHumanReplyText,
  assertComposerQuality,
};
