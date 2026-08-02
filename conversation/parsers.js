const { normalizeText, cleanSpaces } = require('../utils/text');
const {
  isPhoneLikeText,
  hasMoneyContext,
  isPhoneLikeBudgetDigits,
  stripPhoneLabeledSegments,
} = require('../utils/phoneMoneyGuard');
const { isUsefulContactName, isInvalidContactName } = require('../utils/helpers');
const { detectIntent } = require('./intent');
const { getDefaultAiState } = require('./aiState');
const { classifySellerScenarios } = require('./sellerScenarioClassifier');
const { normalizePropertyCode, extractPropertyCode: extractPropertyCodeResolved } = require('./propertyIntentResolver');

/**
 * V3-F0 LEGACY FREEZE — Parser de señales e intención.
 * Sin nuevas heurísticas salvo hotfix P0; migración a V3 Intent & Context Interpreter.
 */

function normalizePropertyCodeFromText(rawValue) {
  return normalizePropertyCode(rawValue);
}

function extractPropertyType(message) {
  const text = normalizeText(message);

  if (text.includes('quinta')) return 'land';
  if (text.includes('terreno')) return 'land';
  if (text.includes('casa') || text.includes('residencia')) return 'house';
  if (text.includes('depa') || text.includes('departamento')) return 'apartment';
  if (text.includes('oficina')) return 'office';
  if (text.includes('local')) return 'commercial';
  if (text.includes('nave')) return 'warehouse';

  return null;
}

function extractLocation(message, prevState = null) {
  const text = normalizeText(message);
  const raw = cleanSpaces(message || '');
  const hasPropertyCode = !!normalizePropertyCodeFromText(raw);

  const looksLikeDirectPropertyIntent =
    text.includes('me interesa la propiedad') ||
    text.includes('me interesa esta propiedad') ||
    text.includes('quiero esta propiedad') ||
    text.includes('quiero la propiedad') ||
    text.includes('me interesa el id') ||
    text.includes('me interesa el codigo') ||
    text.includes('me interesa el código') ||
    text.includes(' id ') ||
    text.includes(' codigo ') ||
    text.includes(' código ');

  const knownPatterns = [
    /\ben\s+([a-záéíóúñ\s]+)$/i,
    /\bpor\s+([a-záéíóúñ\s]+)$/i,
    /\bzona\s+([a-záéíóúñ\s]+)$/i,
    /\bcolonia\s+([a-záéíóúñ\s]+)$/i,
    /\bmunicipio\s+([a-záéíóúñ\s]+)$/i,
  ];

  for (const pattern of knownPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const candidate = cleanSpaces(match[1]).replace(/[.,!?]+$/g, '');
      const normalizedCandidate = normalizeText(candidate);
      const invalidLocationValues = new Set([
        'renta',
        'venta',
        'compra',
        'comprar',
        'rentar',
        'vender',
        'su pagina',
        'su página',
        'la pagina',
        'la página',
        'su sitio',
        'internet',
      ]);
      if (!invalidLocationValues.has(normalizedCandidate)) {
        return candidate;
      }
    }
  }

  const directLocations = [
    'cumbres',
    'san pedro',
    'monterrey',
    'garcia',
    'garcía',
    'carretera nacional',
    'guadalupe',
    'san nicolas',
    'san nicolás',
    'apodaca',
    'santa catarina',
  ];

  for (const loc of directLocations) {
    if (text.includes(loc)) return loc;
  }

  if (prevState?.awaiting_field === 'location_text') {
    if (hasPropertyCode || looksLikeDirectPropertyIntent) return null;
    const raw = cleanSpaces(message);
    const { sanitizeLocationText, extractKnownZoneFromText } = require('./locationSanitizer');
    const zone = extractKnownZoneFromText(raw);
    if (zone) return zone;
    if (raw.length > 80) return null;
    return sanitizeLocationText(raw);
  }

  return null;
}

function extractBudgetCurrency(message) {
  const text = normalizeText(message);
  const raw = cleanSpaces(message || '');
  const hasPropertyCode = !!normalizePropertyCodeFromText(raw);

  if (
    text.includes('usd') ||
    text.includes('dolares') ||
    text.includes('dólares') ||
    text.includes('dlls') ||
    text.includes('us dollars')
  ) {
    return 'USD';
  }

  if (text.includes('mxn') || text.includes('pesos')) {
    return 'MXN';
  }

  if (hasPropertyCode) {
    return null;
  }

  if (
    text.includes('millon') ||
    text.includes('millón') ||
    text.includes('millones') ||
    text.includes('$') ||
    /\b\d{4,8}\b/.test(text)
  ) {
    return 'MXN';
  }

  return null;
}

function extractMaxPrice(message) {
  if (isPhoneLikeText(message)) return null;

  const strippedMessage = stripPhoneLabeledSegments(message);
  const text = normalizeText(strippedMessage);
  const raw = cleanSpaces(strippedMessage || '');
  const hasPropertyCode = !!normalizePropertyCodeFromText(raw);

  if (hasPropertyCode) {
    return null;
  }

  const decimalMillionsMatch = text.match(/\b(\d+(?:[\.,]\d+)?)\s*(millones?|millon|millón)\b/i);
  if (decimalMillionsMatch?.[1]) {
    const value = Number(decimalMillionsMatch[1].replace(',', '.'));
    if (Number.isFinite(value)) return Math.round(value * 1000000);
  }

  const thousandsMatch = text.match(/\b(\d+(?:[\.,]\d+)?)\s*mil\b/i);
  if (thousandsMatch?.[1]) {
    const value = Number(thousandsMatch[1].replace(',', '.'));
    if (Number.isFinite(value) && value > 0) return Math.round(value * 1000);
  }

  const shorthand = [
    ['20 millones', 20000000],
    ['15 millones', 15000000],
    ['12 millones', 12000000],
    ['10 millones', 10000000],
    ['9 millones', 9000000],
    ['8 millones', 8000000],
    ['7 millones', 7000000],
    ['6 millones', 6000000],
    ['5 millones', 5000000],
    ['4 millones', 4000000],
    ['3 millones', 3000000],
    ['2 millones', 2000000],
    ['1 millon', 1000000],
    ['1 millón', 1000000],
    ['10m', 10000000],
    ['9m', 9000000],
    ['8m', 8000000],
    ['7m', 7000000],
    ['6m', 6000000],
    ['5m', 5000000],
    ['4m', 4000000],
    ['3m', 3000000],
    ['2m', 2000000],
    ['1m', 1000000],
  ];

  for (const [needle, value] of shorthand) {
    if (text.includes(needle)) return value;
  }

  const numberMatch = text.match(/\$?\s*([\d,]{4,10})\s*(mxn|pesos|usd|dolares|dólares)?/i);
  if (numberMatch) {
    const candidateDigits = numberMatch[1].replace(/,/g, '');
    const matchIndex = text.indexOf(numberMatch[0]);
    const contextWindow = text.slice(Math.max(0, matchIndex - 24), matchIndex + numberMatch[0].length + 24);
    if (isPhoneLikeText(candidateDigits) || isPhoneLikeBudgetDigits(candidateDigits)) {
      return null;
    }
    if (!hasMoneyContext(contextWindow) && candidateDigits.length >= 10) {
      return null;
    }
    return Number(candidateDigits);
  }

  return null;
}

function extractBedrooms(message) {
  const text = normalizeText(message);

  let match = text.match(/(\d+)\s*(recamaras?|habitaciones?)/i);
  if (match) return Number(match[1]);

  match = text.match(/\b(\d+)\b/);
  if (match && text.length <= 10) {
    if (
      text.includes('millon') ||
      text.includes('mdp') ||
      text.includes('peso') ||
      text.includes('mxn') ||
      text.includes('usd')
    ) {
      return null;
    }
    return Number(match[1]);
  }
}

function extractBathrooms(message) {
  const text = normalizeText(message);
  const match = text.match(/(\d+)\s*(banos?|baños?)/i);
  if (match) return Number(match[1]);
  return null;
}

function extractAreaMetric(message, keyword) {
  const text = normalizeText(message);
  const patterns = [
    new RegExp(`(?:${keyword})\\s*(?:de)?\\s*(\\d{2,5}(?:[\\.,]\\d+)?)\\s*(?:m2|m²|metros?)`, 'i'),
    new RegExp(`(\\d{2,5}(?:[\\.,]\\d+)?)\\s*(?:m2|m²|metros?)\\s*(?:de)?\\s*${keyword}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }

  return null;
}

function extractTerrainM2(message) {
  return extractAreaMetric(message, 'terreno|lote');
}

function extractConstructionM2(message) {
  return extractAreaMetric(message, 'construccion|construcción');
}

function extractFloorsCount(message) {
  const text = normalizeText(message);
  const match = text.match(/(\d+)\s*(pisos?|plantas?|niveles?)/i);
  if (match?.[1]) return Number(match[1]);
  if (text.includes('una planta')) return 1;
  if (text.includes('dos plantas')) return 2;
  if (text.includes('tres plantas')) return 3;
  return null;
}

function extractGarageSpaces(message) {
  const text = normalizeText(message);
  const match = text.match(/(\d+)\s*(cocheras?|autos?|carros?|vehiculos?|vehículos?)/i);
  if (match?.[1]) return Number(match[1]);
  if (text.includes('sin cochera')) return 0;
  return null;
}

function detectTerracePatio(message) {
  const text = normalizeText(message);
  if (text.includes('terraza') || text.includes('patio')) return true;
  if (text.includes('sin terraza') || text.includes('sin patio')) return false;
  return null;
}

function detectOccupancyStatus(message) {
  const text = normalizeText(message);
  if (
    text.includes('habitada') ||
    text.includes('la habito') ||
    text.includes('la habitamos') ||
    text.includes('actualmente vivo') ||
    text.includes('vivimos aqui') ||
    text.includes('vivimos aquí')
  ) {
    return 'occupied';
  }

  if (
    text.includes('desocupada') ||
    text.includes('vacia') ||
    text.includes('vacía') ||
    text.includes('sin habitar')
  ) {
    return 'vacant';
  }

  return null;
}

function extractOccupancyDurationText(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(message);
  if (!text.includes('ocupad') && !text.includes('inquilin') && !text.includes('invad')) return null;
  const years = raw.match(/(\d{1,2})\s*años?/i);
  if (years?.[0]) return cleanSpaces(years[0]);
  const months = raw.match(/(\d{1,2})\s*mes(?:es)?/i);
  if (months?.[0]) return cleanSpaces(months[0]);
  return null;
}

function detectOccupancyEntryMode(message) {
  const text = normalizeText(message);
  if (text.includes('arreglo verbal') || text.includes('con permiso') || text.includes('le dieron chance') || text.includes('autorizado')) {
    return 'with_permission';
  }
  if (text.includes('despojo') || text.includes('invasion') || text.includes('invasión') || text.includes('sin permiso')) {
    return 'without_permission';
  }
  return null;
}

function detectHeirsRelation(message) {
  const text = normalizeText(message);
  if (text.includes('soy heredero') || text.includes('somos herederos')) return 'heir';
  if (text.includes('tengo poder') || text.includes('apoderado')) return 'attorney_in_fact';
  if (text.includes('familiar')) return 'family_representative';
  return null;
}

function detectCanShareDocuments(message) {
  const text = normalizeText(message);
  if (text.includes('te comparto documentos') || text.includes('tengo documentos') || text.includes('puedo anexar')) return true;
  if (text.includes('no tengo documentos') || text.includes('sin documentos')) return false;
  return null;
}

function detectLegalDeeded(message) {
  const text = normalizeText(message);
  if (text.includes('escriturada') || text.includes('con escritura') || text.includes('si esta escriturada') || text.includes('sí está escriturada')) {
    return true;
  }
  if (text.includes('sin escritura') || text.includes('no esta escriturada') || text.includes('no está escriturada')) {
    return false;
  }
  return null;
}

function detectMortgage(message) {
  const text = normalizeText(message);
  if (
    text.includes('credito hipotecario') ||
    text.includes('crédito hipotecario') ||
    text.includes('hipoteca') ||
    text.includes('sigo pagando') ||
    text.includes('debo al banco') ||
    text.includes('todavia debo') ||
    text.includes('todavía debo') ||
    text.includes('tiene adeudo')
  ) {
    return true;
  }
  if (text.includes('sin hipoteca') || text.includes('libre de gravamen') || text.includes('ya esta pagada') || text.includes('ya está pagada')) {
    return false;
  }
  return null;
}

function extractMortgageBalanceText(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(message);
  if (!text.includes('saldo') && !text.includes('debo') && !text.includes('restan')) return null;
  if (raw.length < 8) return null;
  return raw.slice(0, 160);
}

function detectWorksWithRealtor(message) {
  const text = normalizeText(message);
  if (text.includes('ya me apoya una inmobiliaria') || text.includes('ya trabajo con inmobiliaria') || text.includes('ya tengo inmobiliaria') || text.includes('ya tengo asesor')) {
    return true;
  }
  if (text.includes('no trabajo con inmobiliaria') || text.includes('apenas estoy revisando') || text.includes('no tengo inmobiliaria')) {
    return false;
  }
  return null;
}

function detectExclusivityType(message) {
  const text = normalizeText(message);
  if (text.includes('no quiero exclusiva') || text.includes('no quiero exclusividad')) return 'open';
  if (text.includes('exclusiva') || text.includes('exclusividad')) return 'exclusive';
  if (text.includes('abierta') || text.includes('sin exclusividad') || text.includes('no quiero exclusividad')) return 'open';
  return null;
}

function detectSaleMotivation(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(message);

  const triggers = [
    'porque',
    'por que',
    'cambiarme',
    'invertir',
    'liquidez',
    'herencia',
    'necesito vender',
    'quiero vender por',
  ];

  if (!triggers.some((token) => text.includes(token))) return null;

  if (raw.length < 12) return null;
  return raw.slice(0, 220);
}

function detectUrgencyLevel(message) {
  const text = normalizeText(message);
  if (text.includes('urgente') || text.includes('lo antes posible') || text.includes('este mes')) return 'high';
  if (text.includes('en 1') || text.includes('en 2') || text.includes('en 3') || text.includes('proximos meses') || text.includes('próximos meses')) return 'medium';
  if (text.includes('sin prisa') || text.includes('explorando') || text.includes('apenas revisando')) return 'low';
  return null;
}

function detectIsExploringSale(message) {
  const text = normalizeText(message);
  if (text.includes('apenas revisando') || text.includes('solo explorando') || text.includes('solo quiero saber')) return true;
  return null;
}

function detectAcceptedVisit(message) {
  const text = normalizeText(message);
  if (text.includes('si acepto visita') || text.includes('sí acepto visita') || text.includes('agendamos visita') || text.includes('me parece bien la visita') || text.includes('si me queda entre semana') || text.includes('fin de semana me queda')) {
    return true;
  }
  if (text.includes('no quiero visita') || text.includes('sin visita')) return false;
  return null;
}

function detectCommissionQuestion(message) {
  const text = normalizeText(message);
  return (
    text.includes('cuanto cobras') ||
    text.includes('cuánto cobras') ||
    text.includes('comision') ||
    text.includes('comisión') ||
    text.includes('porcentaje')
  );
}

function detectOnlyValuationQuestion(message) {
  const text = normalizeText(message);
  return text.includes('solo quiero saber cuanto vale') || text.includes('solo quiero saber cuánto vale') || text.includes('cuanto vale mi casa') || text.includes('cuánto vale mi casa');
}

function detectValuationIntent(message) {
  const text = normalizeText(message);
  return (
    text.includes('valuar') ||
    text.includes('valuacion') ||
    text.includes('valuación') ||
    text.includes('cuanto vale mi propiedad') ||
    text.includes('cuánto vale mi propiedad') ||
    text.includes('cuanto vale mi casa') ||
    text.includes('cuánto vale mi casa') ||
    text.includes('en cuanto puedo vender') ||
    text.includes('en cuánto puedo vender') ||
    text.includes('valor de mi casa') ||
    text.includes('valor de mi propiedad')
  );
}

function detectHigherOtherAgencyObjection(message) {
  const text = normalizeText(message);
  return text.includes('otra inmobiliaria me dijo mas') || text.includes('otra inmobiliaria me dijo más') || text.includes('me ofrecieron mas') || text.includes('me ofrecieron más');
}

function detectNoExclusivityObjection(message) {
  const text = normalizeText(message);
  return text.includes('no quiero exclusividad') || text.includes('no quiero exclusiva') || text.includes('sin exclusividad');
}

function detectExistingRealtorObjection(message) {
  const text = normalizeText(message);
  return text.includes('ya me apoya una inmobiliaria') || text.includes('ya tengo inmobiliaria') || text.includes('ya trabajo con un asesor');
}

function detectDirectPurchaseQuestion(message) {
  const text = normalizeText(message);
  return text.includes('compran terrenos') || text.includes('compras terrenos') || text.includes('compran casas') || text.includes('compran propiedad');
}

function detectUrgentSaleSignal(message) {
  const text = normalizeText(message);
  return (
    text.includes('me urge vender') ||
    text.includes('necesito vender rapido') ||
    text.includes('necesito vender rápido') ||
    text.includes('necesito liquidez') ||
    text.includes('me voy de la ciudad')
  );
}

function detectSellBuyBridge(message) {
  const text = normalizeText(message);
  return (
    text.includes('vender mi casa y comprar otra') ||
    text.includes('comprar otra casa') ||
    text.includes('comprar otra propiedad') ||
    text.includes('tambien quiero comprar') ||
    text.includes('también quiero comprar') ||
    text.includes('tambien busco comprar') ||
    text.includes('también busco comprar') ||
    text.includes('tambien quiero comprar una') ||
    text.includes('también quiero comprar una') ||
    text.includes('vender para comprar') ||
    text.includes('quiero vender y comprar') ||
    text.includes('quiero cambiarme de casa') ||
    text.includes('necesito vender para comprar')
  );
}

function detectInvestorProfile(message) {
  const text = normalizeText(message);
  return (
    text.includes('invertir') ||
    text.includes('rentabilidad') ||
    text.includes('comprar para rentar') ||
    text.includes('oportunidad de inversion') ||
    text.includes('oportunidad de inversión')
  );
}

function detectRemoteClient(message) {
  const text = normalizeText(message);
  return (
    text.includes('vivo fuera de monterrey') ||
    text.includes('vivo en estados unidos') ||
    text.includes('estoy en estados unidos') ||
    text.includes('estoy en usa') ||
    text.includes('no puedo ir') ||
    text.includes('videollamada') ||
    text.includes('video llamada')
  );
}

function detectComplaintFollowup(message) {
  const text = normalizeText(message);
  return (
    text.includes('no me han contestado') ||
    text.includes('ya deje mis datos') ||
    text.includes('ya dejé mis datos') ||
    text.includes('nadie me llamo') ||
    text.includes('nadie me llamó') ||
    text.includes('me dejaron en visto') ||
    text.includes('no entendiste') ||
    text.includes('no me entendiste') ||
    text.includes('no entendio') ||
    text.includes('no entendió') ||
    text.includes('no captaste') ||
    text.includes('ya te lo di') ||
    text.includes('ya te lo dije') ||
    text.includes('ya te respondi') ||
    text.includes('ya te respondí') ||
    text.includes('ya conteste') ||
    text.includes('ya contesté') ||
    text.includes('te lo acabo de decir')
  );
}

function detectLowInfoCampaignMessage(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(message);

  if (!text) return false;

  const lowInfoSet = new Set([
    'info',
    'me interesa',
    'vi su anuncio',
    'quiero informes',
    'hola',
  ]);

  if (lowInfoSet.has(text)) return true;

  const words = raw.split(/\s+/).filter(Boolean);
  const hasRealEstateDetail =
    text.includes('casa') ||
    text.includes('departamento') ||
    text.includes('depa') ||
    text.includes('terreno') ||
    text.includes('renta') ||
    text.includes('venta') ||
    text.includes('comprar') ||
    text.includes('vender') ||
    text.includes('m2') ||
    text.includes('metros');

  return words.length <= 3 && !hasRealEstateDetail && (text.includes('info') || text.includes('informes'));
}

function detectNonRealEstateOrProvider(message) {
  const text = normalizeText(message);
  const terms = [
    'soy proveedor',
    'ofrezco servicio',
    'factura pendiente',
    'cotizacion de servicio',
    'cotización de servicio',
    'bolsa de trabajo',
    'vacante',
    'reclutamiento',
  ];
  return terms.some((term) => text.includes(term));
}

function detectExternalBroker(message) {
  const text = normalizeText(message);
  const terms = [
    'broker',
    'bróker',
    'comision para brokers',
    'comisión para brokers',
    'soy asesor inmobiliario',
    'soy agente inmobiliario',
    'tengo desarrollo para comercializar',
    'invitacion a evento broker',
    'invitación a evento broker',
  ];
  return terms.some((term) => text.includes(term));
}

function detectProvider(message) {
  const text = normalizeText(message);
  const terms = [
    'soy proveedor',
    'ofrezco servicio',
    'servicio de marketing',
    'servicio de fotografia',
    'servicio de fotografía',
    'cotizacion de servicio',
    'cotización de servicio',
    'venta de leads',
  ];
  return terms.some((term) => text.includes(term));
}

function detectSuspiciousSpam(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(raw);
  if (!text) return false;

  const hasSuspiciousLink = /(bit\.ly|tinyurl|t\.me|wa\.me\/join|http:\/\/)/i.test(raw);
  const spamTerms = [
    'gana dinero rapido',
    'gana dinero rápido',
    'multiplica tus ingresos',
    'cripto',
    'apuesta',
    'casino',
  ];

  return hasSuspiciousLink || spamTerms.some((term) => text.includes(term));
}

function detectWrongContext(message) {
  const text = normalizeText(message);
  const terms = [
    'como consigo el zapatero',
    'cómo consigo el zapatero',
    'plomero',
    'dentista',
    'receta de cocina',
    'soporte de computadora',
  ];
  return terms.some((term) => text.includes(term));
}

function classifyInboundBusinessCategory(message, intent = {}, prevState = {}) {
  const rawTrim = cleanSpaces(message || '');
  if (/^!(reset|close|case)\b/i.test(rawTrim)) {
    return 'real_estate_client';
  }

  const text = normalizeText(message);
  const hasRealEstateKeywords =
    text === 'hola' ||
    text === 'buenas' ||
    text === 'buenos dias' ||
    text === 'buenos días' ||
    text === 'info' ||
    text.includes('casa') ||
    text.includes('depa') ||
    text.includes('departamento') ||
    text.includes('terreno') ||
    text.includes('propiedad') ||
    text.includes('renta') ||
    text.includes('venta') ||
    text.includes('valu') ||
    text.includes('comprar') ||
    text.includes('vender') ||
    text.includes('precio') ||
    text.includes('disponible') ||
    text.includes('disponibilidad') ||
    text.includes('ubicacion') ||
    text.includes('ubicación') ||
    text.includes('informacion') ||
    text.includes('información') ||
    text.includes('me interesa') ||
    text.includes('agendar') ||
    text.includes('visita') ||
    text.includes('asesor') ||
    text.includes('agente') ||
    (text.includes('humano') && (text.includes('asesor') || text.includes('hablar') || text.includes('persona')));

  const isBroker = detectExternalBroker(message);
  const isProvider = detectProvider(message) || detectNonRealEstateOrProvider(message);
  const isSpam = detectSuspiciousSpam(message);
  const isWrongContext = detectWrongContext(message);

  if (isSpam) return 'spam';
  if (isBroker) return 'external_broker';
  if (isProvider) return 'provider';
  if (isWrongContext) return 'wrong_context';

  if (!intent?.leadType && !hasRealEstateKeywords) {
    const prevFlow = prevState?.lead_flow;
    if ((prevFlow === 'offer' || prevFlow === 'demand') && !isSpam && !isBroker && !isProvider) {
      return 'real_estate_client';
    }
    return text ? 'unclear_non_real_estate' : 'wrong_context';
  }

  return 'real_estate_client';
}

function extractRentalMoveInDate(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(raw);
  if (!text) return null;

  const monthMatch = raw.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
  if (monthMatch) return cleanSpaces(monthMatch[0]);

  if (text.includes('inmediato') || text.includes('de inmediato')) return 'inmediato';
  if (text.includes('proximo mes') || text.includes('próximo mes')) return 'próximo mes';
  if (text.includes('en dos meses')) return 'en dos meses';

  return null;
}

function extractRentalPeopleCount(message) {
  const text = normalizeText(message);
  const match = text.match(/(\d+)\s*(personas|adultos|integrantes)/i);
  if (match?.[1]) return Number(match[1]);
  return null;
}

function detectRentalPets(message) {
  const text = normalizeText(message);
  if (text.includes('con mascota') || text.includes('tenemos mascota') || text.includes('aceptan mascotas')) {
    return true;
  }
  if (text.includes('sin mascota') || text.includes('no tenemos mascota')) {
    return false;
  }
  return null;
}

function extractRentalSpecialRequirements(message) {
  const raw = cleanSpaces(message || '');
  const text = normalizeText(raw);
  const tokens = ['amueblado', 'amueblada', 'planta baja', 'cerca de', 'con cochera', 'pet friendly'];
  if (tokens.some((token) => text.includes(token))) {
    return raw.slice(0, 180);
  }
  return null;
}

function detectLegalSensitive(message) {
  const text = normalizeText(message);
  const terms = [
    'ocupada',
    'ocupado',
    'invadida',
    'invadido',
    'sin contrato',
    'sucesion',
    'sucesión',
    'intestado',
    'heredero',
    'herederos',
    'poder notarial',
    'registro publico',
    'registro público',
    'infonavit',
    'desalojo',
    'sentencia',
    'albacea',
    'usucapion',
    'usucapión',
    'arrendatario',
    'arrendatarios',
    'juicio',
    'embargo',
  ];
  return terms.some((term) => text.includes(term));
}

function extractMunicipality(message) {
  const text = normalizeText(message);
  const municipalities = [
    'monterrey',
    'san pedro garza garcia',
    'san pedro garza garcía',
    'garcia',
    'garcía',
    'guadalupe',
    'apodaca',
    'san nicolas',
    'san nicolás',
    'santa catarina',
  ];

  for (const municipality of municipalities) {
    if (text.includes(municipality)) return municipality;
  }

  return null;
}

function extractNeighborhood(message) {
  const raw = cleanSpaces(message || '');
  const patterns = [
    /colonia\s+([a-záéíóúñ0-9\s]+)/i,
    /fraccionamiento\s+([a-záéíóúñ0-9\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return cleanSpaces(match[1]).replace(/[.,!?]+$/g, '');
  }

  return null;
}

function detectContactPreference(message) {
  const text = normalizeText(message);

  if (text === 'wa' || text === 'wp' || text === 'wpp') return 'whatsapp';
  if (text === 'w.a.' || text === 'w.a') return 'whatsapp';
  if (
    text.includes('whatsapp') ||
    text.includes('whats app') ||
    text.includes('whats') ||
    text.includes('por wa') ||
    text.includes('por whatsapp') ||
    text.includes('por whats') ||
    text.includes('via whatsapp') ||
    text.includes('vía whatsapp')
  ) {
    return 'whatsapp';
  }
  if (text.includes('llamada') || text.includes('marquen') || text.includes('llamar')) return 'call';
  if (
    text.includes('no importa') ||
    text.includes('da igual') ||
    text.includes('cualquiera')
  ) {
    return 'any';
  }

  return null;
}

function stateLacksUsefulHumanName(prevState) {
  const n = prevState?.full_name;
  if (!n) return true;
  return !isUsefulContactName(n) || isInvalidContactName(n);
}

function extractPossibleName(message, prevState = null, ownerRelationHint = null) {
  const raw = cleanSpaces(message);
  const text = normalizeText(message);

  const patterns = [
    /me llamo\s+([a-záéíóúñ\s]+)/i,
    /soy\s+([a-záéíóúñ\s]+)/i,
    /mi nombre es\s+([a-záéíóúñ\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const candidate = cleanSpaces(match[1]).replace(/[.,!?]+$/g, '');
      if (!isUsefulContactName(candidate) || isInvalidContactName(candidate)) return null;
      return candidate;
    }
  }

  if (ownerRelationHint === 'owner' || ownerRelationHint === 'representative') {
    return null;
  }

  if (prevState?.awaiting_field === 'location_text') {
    const locGuess = extractLocation(message, prevState);
    if (locGuess && cleanSpaces(String(locGuess)).length > 0) return null;
  }

  const notANameReply = new Set([
    'info',
    'informacion',
    'información',
    'hola',
    'buenas',
    'ok',
    'listo',
    'gracias',
    'no',
    'cancelar',
  ]);
  if (notANameReply.has(text)) return null;

  const captureNameFromShortReply =
    prevState?.awaiting_field === 'full_name' ||
    !!prevState?.pending_name_capture ||
    (stateLacksUsefulHumanName(prevState) &&
      ['budget_max', 'location_text', 'property_type', 'bedrooms', 'rental_move_in_date', 'owner_relation'].includes(
        prevState?.awaiting_field || ''
      ));

  if (captureNameFromShortReply) {
    if (text === 'si' || text === 'sí') return null;
    if (prevState?.lead_flow === 'offer' && prevState?.owner_relation == null) {
      if (text === 'mia' || text === 'mía' || text === 'yo') return null;
    }

    if (
      raw.length >= 3 &&
      raw.length <= 80 &&
      !/\d/.test(raw) &&
      !text.includes('comprar') &&
      !text.includes('rentar') &&
      !text.includes('vender') &&
      !text.includes('whatsapp') &&
      !text.includes('llamada')
    ) {
      const candidate = raw.replace(/[.,!?]+$/g, '');
      if (!isUsefulContactName(candidate) || isInvalidContactName(candidate)) return null;
      return candidate;
    }
  }

  return null;
}

function detectOwnerRelation(message, prevState = null) {
  const text = normalizeText(message);
  const raw = cleanSpaces(message || '');

  const ownershipContext =
    prevState?.awaiting_field === 'owner_relation' ||
    (prevState?.lead_flow === 'offer' && prevState?.owner_relation == null);

  if (
    text.includes('es mia') ||
    text.includes('es mía') ||
    text.includes('es mi propiedad') ||
    text.includes('es propia') ||
    text.includes('soy el propietario') ||
    text.includes('soy la propietaria') ||
    text === 'mia' ||
    text === 'mía' ||
    text === 'yo' ||
    text === 'soy yo' ||
    raw.toLowerCase() === 'mía' ||
    raw.toLowerCase() === 'mia'
  ) {
    return 'owner';
  }

  if (ownershipContext && (text === 'si' || text === 'sí' || text === 'sip' || text === 'ok')) {
    return 'owner';
  }

  if (
    text.includes('es de mi esposa') ||
    text.includes('es de mi esposo') ||
    text.includes('es de mi familia') ||
    text.includes('es de un familiar') ||
    text.includes('ayudo a alguien') ||
    text.includes('de un familiar') ||
    text.includes('de mi mama') ||
    text.includes('de mi mamá') ||
    text.includes('de mi papa') ||
    text.includes('de mi papá') ||
    text.includes('de un amigo') ||
    text.includes('de un cliente')
  ) {
    return 'representative';
  }

  return null;
}

/** Follow-up sobre una propiedad ya referida (evita return temprano programado en index). */
function isPropertyConversationFollowUp(message) {
  const t = normalizeText(message);
  if (!t) return false;

  return (
    t.includes('precio') ||
    t.includes('cuanto') ||
    t.includes('cuánto') ||
    t.includes('cuesta') ||
    t.includes('vale') ||
    t.includes('disponib') ||
    t.includes('sigue en venta') ||
    t.includes('sigue en renta') ||
    t.includes('todavia') ||
    t.includes('todavía') ||
    t.includes('visita') ||
    t.includes('verla') ||
    t.includes('ver la') ||
    t.includes('quiero ver') ||
    t.includes('puedo ver') ||
    t.includes('la puedo') ||
    t.includes('agendar') ||
    t.includes('link') ||
    t.includes('liga') ||
    t.includes('publicacion') ||
    t.includes('publicación') ||
    t.includes('pdf') ||
    t.includes('ficha') ||
    t.includes('fotos') ||
    t.includes('video') ||
    t.includes('mandame') ||
    t.includes('mándame') ||
    t.includes('pasame') ||
    t.includes('pásame')
  );
}

function extractPhoneNumber(message) {
  const match = (message || '').replace(/[^\d+]/g, '').match(/(\+?\d{10,15})/);
  return match ? match[1] : null;
}

function normalizeListingId(rawValue) {
  return normalizePropertyCodeFromText(rawValue);
}

function extractPropertyCode(message) {
  return extractPropertyCodeResolved(message);
}

function detectDirectPropertyReference(message) {
  return !!extractPropertyCode(message);
}

function detectVisitIntent(message) {
  const text = normalizeText(message);

  const phrases = [
    'quiero verla',
    'quiero verlo',
    'quiero ver la propiedad',
    'quiero ver el departamento',
    'quiero ver la casa',
    'quiero visitarla',
    'quiero visitarlo',
    'quiero agendar visita',
    'agendar visita',
    'agendar una visita',
    'agendar cita',
    'agendar una cita',
    'hacer cita',
    'quiero una cita',
    'cuando la puedo ver',
    'cuando lo puedo ver',
    'cómo la puedo ver',
    'como la puedo ver',
    'como lo puedo ver',
    'cómo lo puedo ver',
    'me gustaria verla',
    'me gustaría verla',
    'me gustaria verlo',
    'me gustaría verlo',
    'la quiero ver',
    'lo quiero ver',
    'quiero ir a verla',
    'quiero ir a verlo',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectHighInterest(message) {
  const text = normalizeText(message);

  const phrases = [
    'me interesa',
    'si me interesa',
    'sí me interesa',
    'me gusto',
    'me gustó',
    'me encanto',
    'me encantó',
    'me agrada',
    'me llama la atencion',
    'me llama la atención',
    'suena bien',
    'se ve bien',
    'se escucha bien',
    'la quiero',
    'lo quiero',
    'me interesa esa',
    'me interesa esa opcion',
    'me interesa esa opción',
    'me interesa esta',
    'me interesa esta opcion',
    'me interesa esta opción',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectPropertyDetailsIntent(message) {
  const text = normalizeText(message);

  const phrases = [
    'quiero mas informacion',
    'quiero más información',
    'mas informacion',
    'más información',
    'mas info',
    'más info',
    'dame mas info',
    'dame más info',
    'dame informacion',
    'dame información',
    'tienes mas info',
    'tienes más info',
    'mandame info',
    'mándame info',
    'mandame mas informacion',
    'mándame más información',
    'quiero detalles',
    'dame detalles',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectAvailabilityQuestion(message) {
  const text = normalizeText(message);

  const phrases = [
    'sigue disponible',
    'sigue en venta',
    'sigue en renta',
    'todavia disponible',
    'todavía disponible',
    'aun disponible',
    'aún disponible',
    'todavia esta disponible',
    'todavía está disponible',
    'aun esta disponible',
    'aún está disponible',
    'esta disponible',
    'está disponible',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectLocationDetailQuestion(message) {
  const text = normalizeText(message);

  const phrases = [
    'donde esta',
    'dónde está',
    'donde queda',
    'dónde queda',
    'cual es la direccion',
    'cuál es la dirección',
    'direccion exacta',
    'dirección exacta',
    'en que colonia esta',
    'en qué colonia está',
    'que zona es',
    'qué zona es',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectPriceDetailQuestion(message) {
  const text = normalizeText(message);

  const phrases = [
    'precio final',
    'precio negociable',
    'se puede negociar',
    'es negociable',
    'cuanto es lo menos',
    'cuánto es lo menos',
    'cuál es el ultimo precio',
    'cual es el ultimo precio',
    'último precio',
    'ultimo precio',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function detectCommercialSignals(message) {
  const wantsVisit = detectVisitIntent(message);
  const showsHighInterest = detectHighInterest(message);
  const asksPropertyDetails =
    detectPropertyDetailsIntent(message) ||
    detectAvailabilityQuestion(message) ||
    detectLocationDetailQuestion(message) ||
    detectPriceDetailQuestion(message);

  const wantsHumanByCommercialIntent =
    wantsVisit ||
    asksPropertyDetails;

  return {
    wants_visit: wantsVisit,
    shows_high_interest: showsHighInterest,
    asks_property_details: asksPropertyDetails,
    wants_human_by_commercial_intent: wantsHumanByCommercialIntent,
  };
}

function detectContextualSignals(message, prevState) {
  const text = normalizeText(message);
  const awaitingField = prevState?.awaiting_field || null;

  const shortAffirmatives = new Set([
    'si',
    'sí',
    'ok',
    'va',
    'me parece',
    'perfecto',
    'claro',
    'dale',
    '👍',
    '👌',
  ]);

  const isAffirmative =
    shortAffirmatives.has(text) ||
    text.startsWith('si,') ||
    text.startsWith('sí,') ||
    text === 'correcto';

  const signals = {
    answer_affirmative: isAffirmative,
    answer_negative: text === 'no',
    answer_any:
      text.includes('no importa') ||
      text.includes('da igual') ||
      text.includes('sin importar') ||
      text.includes('cualquiera'),
    location_any: false,
    bedrooms_any: false,
    contact_number_confirmed: null,
  };

  if (awaitingField === 'bedrooms' && signals.answer_any) {
    signals.bedrooms = null;
    signals.bedrooms_any = true;
  }

  if (awaitingField === 'location_text' && signals.answer_any) {
    signals.location_text = null;
    signals.location_any = true;
  }

  if (awaitingField === 'contact_preference' && signals.answer_any) {
    signals.contact_preference = 'any';
  }

  if (awaitingField === 'contact_number_confirmed') {
    if (signals.answer_affirmative) signals.contact_number_confirmed = true;
    if (signals.answer_negative) signals.contact_number_confirmed = false;
  }

  return signals;
}

function inferUserGoal(leadFlow) {
  if (leadFlow === 'demand') return 'search_property';
  if (leadFlow === 'offer') return 'capture_property';
  return null;
}

function parseMessageSignals(message, prevState = getDefaultAiState(), messageContext = {}) {
  const intent = detectIntent(message, prevState);
  const contextual = detectContextualSignals(message, prevState);
  const commercial = detectCommercialSignals(message);

  const propertyType = extractPropertyType(message);
  const locationText = extractLocation(message, prevState);
  const budgetMax = extractMaxPrice(message);
  const budgetCurrency = extractBudgetCurrency(message);
  const bedrooms = extractBedrooms(message);
  const bathrooms = extractBathrooms(message);
  const terrainM2 = extractTerrainM2(message);
  const constructionM2 = extractConstructionM2(message);
  const floorsCount = extractFloorsCount(message);
  const garageSpaces = extractGarageSpaces(message);
  const hasTerracePatio = detectTerracePatio(message);
  const occupancyStatus = detectOccupancyStatus(message);
  const occupancyDurationText = extractOccupancyDurationText(message);
  const occupancyEntryMode = detectOccupancyEntryMode(message);
  const heirsRelation = detectHeirsRelation(message);
  const canShareDocuments = detectCanShareDocuments(message);
  const legalDeeded = detectLegalDeeded(message);
  const hasMortgage = detectMortgage(message);
  const mortgageBalanceText = extractMortgageBalanceText(message);
  const worksWithRealtor = detectWorksWithRealtor(message);
  const exclusivityType = detectExclusivityType(message);
  const saleMotivation = detectSaleMotivation(message);
  const urgencyLevel = detectUrgencyLevel(message);
  const isExploringSale = detectIsExploringSale(message);
  const acceptedVisit = detectAcceptedVisit(message);
  const asksCommission = detectCommissionQuestion(message);
  const asksOnlyValuation = detectOnlyValuationQuestion(message);
  const asksValuation = detectValuationIntent(message);
  const objectionHigherAgency = detectHigherOtherAgencyObjection(message);
  const objectionNoExclusivity = detectNoExclusivityObjection(message);
  const objectionExistingRealtor = detectExistingRealtorObjection(message);
  const asksDirectPurchase = detectDirectPurchaseQuestion(message);
  const urgentSaleSignal = detectUrgentSaleSignal(message);
  const sellBuyBridge = detectSellBuyBridge(message);
  const investorProfile = detectInvestorProfile(message);
  const remoteClient = detectRemoteClient(message);
  const complaintFollowup = detectComplaintFollowup(message);
  const lowInfoCampaignMessage = detectLowInfoCampaignMessage(message);
  const nonRealEstateOrProvider = detectNonRealEstateOrProvider(message);
  const legalSensitive = detectLegalSensitive(message);
  const municipalityText = extractMunicipality(message);
  const neighborhoodText = extractNeighborhood(message);

  const rentalMoveInDate = extractRentalMoveInDate(message);
  const rentalPeopleCount = extractRentalPeopleCount(message);
  const rentalPets = detectRentalPets(message);
  const rentalSpecialRequirements = extractRentalSpecialRequirements(message);

  const sellerScenario = classifySellerScenarios({
    messageText: message,
    aiState: {
      ...prevState,
      lead_flow: intent.leadType || prevState.lead_flow,
      intent_type: intent.type || prevState.intent_type,
      location_text: locationText || prevState.location_text,
      works_with_realtor: worksWithRealtor ?? prevState.works_with_realtor,
      occupancy_status: occupancyStatus || prevState.occupancy_status,
      urgency_level: urgencyLevel || prevState.urgency_level,
    },
    media: messageContext?.media || null,
  });
  const inboundBusinessCategory = classifyInboundBusinessCategory(message, intent, prevState);
  const externalBroker = inboundBusinessCategory === 'external_broker';
  const provider = inboundBusinessCategory === 'provider';
  const spamDetected = inboundBusinessCategory === 'spam';
  const wrongContext = inboundBusinessCategory === 'wrong_context';
  const unclearNonRealEstate = inboundBusinessCategory === 'unclear_non_real_estate';
  const contactPreference = detectContactPreference(message);
  const ownerRelation = detectOwnerRelation(message, prevState);
  let fullName = extractPossibleName(message, prevState, ownerRelation);
  const propertyCode = extractPropertyCode(message);
  const betterPhone =
    prevState?.awaiting_field === 'contact_number'
      ? extractPhoneNumber(message)
      : null;

  let confidence = 'low';
  const filledCount = [
    intent.leadType,
    intent.operationType,
    propertyType,
    locationText,
    budgetMax,
    budgetCurrency,
    bedrooms,
    fullName,
    ownerRelation,
    propertyCode,
  ].filter((v) => v !== null && v !== undefined).length;

  if (filledCount >= 5) confidence = 'high';
  else if (filledCount >= 3) confidence = 'medium';

  if (!fullName) {
    const raw = cleanSpaces(message);
    const namePatterns = [
      /me llamo\s+([a-záéíóúñ\s]+)/i,
      /soy\s+([a-záéíóúñ\s]+)/i,
      /mi nombre es\s+([a-záéíóúñ\s]+)/i,
    ];

    for (const pattern of namePatterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        const captured = cleanSpaces(match[1]).replace(/[.,!?]+$/g, '');
        fullName = captured
          .split(/\s+/)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
        break;
      }
    }
  }

  return {
    lead_flow: intent.leadType || (propertyCode ? 'demand' : null),
    operation_type: intent.operationType || null,
    property_type: propertyType,
    location_text: locationText,
    budget_max: budgetMax,
    budget_currency: budgetCurrency,
    bedrooms,
    bathrooms,
    terrain_m2: terrainM2,
    construction_m2: constructionM2,
    floors_count: floorsCount,
    garage_spaces: garageSpaces,
    has_terrace_patio: hasTerracePatio,
    occupancy_status: occupancyStatus,
    occupancy_duration_text: occupancyDurationText,
    occupancy_entry_mode: occupancyEntryMode,
    heirs_relation: heirsRelation,
    can_share_documents: canShareDocuments,
    legal_deeded: legalDeeded,
    has_mortgage: hasMortgage,
    mortgage_balance_text: mortgageBalanceText,
    works_with_realtor: worksWithRealtor,
    exclusivity_type: exclusivityType,
    expected_price: budgetMax,
    sale_motivation: saleMotivation,
    urgency_level: urgencyLevel,
    is_exploring_sale: isExploringSale,
    accepted_visit: acceptedVisit,
    asks_commission: asksCommission,
    asks_only_valuation: asksOnlyValuation,
    asks_valuation: asksValuation,
    objection_higher_other_agency: objectionHigherAgency,
    objection_no_exclusivity: objectionNoExclusivity,
    objection_existing_realtor: objectionExistingRealtor,
    asks_direct_purchase: asksDirectPurchase,
    urgent_sale_signal: urgentSaleSignal,
    sell_buy_bridge: sellBuyBridge,
    investor_profile: investorProfile,
    remote_client: remoteClient,
    complaint_followup: complaintFollowup,
    low_info_campaign_message: lowInfoCampaignMessage,
    non_real_estate_or_provider: nonRealEstateOrProvider,
    inbound_business_category: inboundBusinessCategory,
    external_broker: externalBroker,
    provider,
    spam_detected: spamDetected,
    wrong_context: wrongContext,
    unclear_non_real_estate: unclearNonRealEstate,
    legal_sensitive: legalSensitive || sellerScenario.legalSensitive,
    seller_scenarios: sellerScenario.scenarios,
    primary_seller_scenario: sellerScenario.primaryScenario,
    already_listed:
      sellerScenario.alreadyListed === true
        ? true
        : sellerScenario.alreadyListed === false
        ? false
        : null,
    listing_duration_days: sellerScenario.listingDurationDays,
    has_documents:
      sellerScenario.hasDocuments === true
        ? true
        : sellerScenario.hasDocuments === false
        ? false
        : null,
    municipality_text: municipalityText,
    neighborhood_text: neighborhoodText,
    rental_move_in_date: rentalMoveInDate,
    rental_people_count: rentalPeopleCount,
    rental_pets: rentalPets,
    rental_special_requirements: rentalSpecialRequirements,
    needs_specialized_review: legalSensitive || sellerScenario.legalSensitive,
    risk_flags: Object.entries(sellerScenario.sellerSummaryFlags || {})
      .filter(([, enabled]) => !!enabled)
      .map(([key]) => key),
    contact_preference: contactPreference,
    full_name: fullName,
    owner_relation: ownerRelation,
    better_phone: betterPhone,
    property_code: propertyCode,
    direct_property_reference: !!propertyCode,
    wants_human: !!intent.wantsHuman || commercial.wants_human_by_commercial_intent,
    wants_visit: commercial.wants_visit,
    shows_high_interest: commercial.shows_high_interest,
    asks_property_details: commercial.asks_property_details,
    intent_type: intent.type,
    intent_changed: intent.intent_changed,
    next_step: intent.next_step,
    playbook_type: intent.type,
    playbook: intent.playbook,
    user_goal: inferUserGoal(intent.leadType || (propertyCode ? 'demand' : null)),
    confidence,
    matched_location_from_catalog: locationText || null,
    ...contextual,
  };
}

module.exports = {
  extractPropertyType,
  extractLocation,
  extractBudgetCurrency,
  extractMaxPrice,
  extractBedrooms,
  extractBathrooms,
  extractTerrainM2,
  extractConstructionM2,
  extractFloorsCount,
  extractGarageSpaces,
  detectTerracePatio,
  detectOccupancyStatus,
  extractOccupancyDurationText,
  detectOccupancyEntryMode,
  detectHeirsRelation,
  detectCanShareDocuments,
  detectLegalDeeded,
  detectMortgage,
  extractMortgageBalanceText,
  detectWorksWithRealtor,
  detectExclusivityType,
  detectSaleMotivation,
  detectUrgencyLevel,
  detectIsExploringSale,
  detectAcceptedVisit,
  detectCommissionQuestion,
  detectOnlyValuationQuestion,
  detectValuationIntent,
  detectHigherOtherAgencyObjection,
  detectNoExclusivityObjection,
  detectExistingRealtorObjection,
  detectDirectPurchaseQuestion,
  detectUrgentSaleSignal,
  detectSellBuyBridge,
  detectInvestorProfile,
  detectRemoteClient,
  detectComplaintFollowup,
  detectLowInfoCampaignMessage,
  detectNonRealEstateOrProvider,
  detectLegalSensitive,
  extractMunicipality,
  extractNeighborhood,
  detectContactPreference,
  extractPossibleName,
  detectOwnerRelation,
  extractPhoneNumber,
  normalizeListingId,
  extractPropertyCode,
  isPropertyConversationFollowUp,
  detectDirectPropertyReference,
  detectVisitIntent,
  detectHighInterest,
  detectPropertyDetailsIntent,
  detectAvailabilityQuestion,
  detectLocationDetailQuestion,
  detectPriceDetailQuestion,
  detectCommercialSignals,
  detectContextualSignals,
  parseMessageSignals,
  inferUserGoal,
};
