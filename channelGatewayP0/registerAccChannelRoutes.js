'use strict';

const {
  isAccFacebookEnabled,
  isAccInstagramEnabled,
} = require('../config/accP0Flags');
const { supabase } = require('../services/supabaseService');
const { persistWhatsappDeliveryStatuses } = require('../services/whatsappDeliveryStatus');

/**
 * Rutas base del gateway ACC y middleware transversal de estados WhatsApp.
 * Los callbacks de `statuses` no son mensajes inbound y deben consumirse antes
 * del orquestador conversacional para no perder Enviado/Entregado/Leído/Error.
 * @param {import('express').Express} app
 */
function registerAccChannelRoutes(app) {
  const inactive = (channel) => (_req, res) => {
    res.status(404).json({
      ok: false,
      error: 'channel_not_enabled',
      channel,
      hint: 'ACC_*_ENABLED flags are OFF (Sprint 1 foundation).',
    });
  };

  app.get('/webhook/facebook', (req, res) => {
    if (!isAccFacebookEnabled()) {
      inactive('facebook')(req, res);
      return;
    }
    res.sendStatus(404);
  });

  app.post('/webhook/facebook', (req, res) => {
    if (!isAccFacebookEnabled()) {
      inactive('facebook')(req, res);
      return;
    }
    res.sendStatus(404);
  });

  app.get('/webhook/instagram', (req, res) => {
    if (!isAccInstagramEnabled()) {
      inactive('instagram')(req, res);
      return;
    }
    res.sendStatus(404);
  });

  app.post('/webhook/instagram', (req, res) => {
    if (!isAccInstagramEnabled()) {
      inactive('instagram')(req, res);
      return;
    }
    res.sendStatus(404);
  });

  // Se registra antes del POST /webhook principal. Si el callback contiene
  // mensajes reales, cedemos al orquestador con next(); si solo contiene
  // estados de entrega, los persistimos y cerramos 200.
  app.post('/webhook', async (req, res, next) => {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    if (statuses.length === 0) {
      next();
      return;
    }

    try {
      await persistWhatsappDeliveryStatuses({
        supabase,
        value,
        logEvent: (type, payload) => console.info(type, JSON.stringify(payload || {})),
      });
    } catch (error) {
      console.error('whatsapp_delivery_status_fatal', error);
      // Meta no debe reintentar indefinidamente por una falla interna de
      // persistencia; el evento queda en logs para recuperación operativa.
    }

    res.sendStatus(200);
  });
}

module.exports = { registerAccChannelRoutes };
