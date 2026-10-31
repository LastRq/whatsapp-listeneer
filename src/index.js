import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { FIREBASE_PROJECT_ID, TENANT_ID, firestoreFetch } from './firebase-client.js';
import { statusCors, publicListenerStatus } from './http-status.js';
import { installMetaRoutes } from './meta-integration.js';
import { extractMetaAdInfo } from './meta-ad-info.js';
import { installOutboundRoutes, observeCrmConversation } from './outbound-tracker.js';
import { saveWhatsAppLead, retryPendingWhatsAppLeads } from './whatsapp-leads.js';
import { useFirestoreAuthState, clearFirestoreSession } from './firestore-auth.js';

dotenv.config();

const app = express();

// 1. Blindaje HTTP contra Clickjacking, MIME-Sniffing y XSS
app.use(
  helmet({
    contentSecurityPolicy: false // Permite renderizar imágenes Data URL para el QR en navegadores
  })
);

// Only public status is readable cross-origin. QR/session actions keep their existing protection.
app.use(statusCors);
app.use(express.json());
app.use(express.static('public'));

// 2. Rate Limiting en memoria para mitigar saturación y DoS
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > rec.resetAt) {
    rec.count = 1;
    rec.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    rec.count++;
  }

  rateLimitMap.set(ip, rec);

  if (rateLimitMap.size > 2000) {
    for (const [k, v] of rateLimitMap) {
      if (now > v.resetAt) rateLimitMap.delete(k);
    }
  }

  if (rec.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un minuto.' });
  }

  next();
});

installMetaRoutes(app);
installOutboundRoutes(app);
setInterval(retryPendingWhatsAppLeads, 30 * 60 * 1000).unref();
retryPendingWhatsAppLeads();

// Variables de entorno y configuración (Defaults optimizados para Kindev Meta Ads)
const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(process.env.SESSIONS_DIR || './sessions', TENANT_ID);
const WEBHOOK_URL = process.env.KINDEVADS_WEBHOOK_URL || '';
if (WEBHOOK_URL && new URL(WEBHOOK_URL).hostname !== 'kindevads.com') throw new Error('Webhooks must target kindevads.com.');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || process.env['ADMIN-KEY'] || '';
const VALID_ADMIN_KEYS = new Set([ADMIN_KEY].filter(Boolean));
const ONLY_META_ADS = process.env.ONLY_META_ADS !== 'false';
const IS_DEBUG = process.env.DEBUG === 'true';

// Estado en memoria
let currentQR = null;
let connectionStatus = 'iniciando';
let connectedUser = null;
let reconnectAttempts = 0;
const savedContacts = new Set();

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ================= UTILIDADES DE SEGURIDAD =================

/**
 * Enmascara números de teléfono para proteger PII en logs y respuestas públicas
 */
function maskPhone(phone) {
  if (!phone) return 'Desconocido';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 7) return '***';
  return `+${clean.slice(0, 3)} *** *** ${clean.slice(-3)}`;
}

function extractCandidateKey(req) {
  const cookieMatch = (req.headers.cookie || '').match(/(?:^|; )admin_key=([^;]*)/);
  const cookieKey = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  return (
    req.headers['x-admin-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.key ||
    cookieKey
  );
}

function isValidAdminKey(key) {
  if (!key || typeof key !== 'string') return false;
  return VALID_ADMIN_KEYS.has(key.trim());
}

/**
 * Middleware para exigir clave administrativa en endpoints sensibles
 */
function requireAdminAuth(req, res, next) {
  const candidateKey = extractCandidateKey(req);

  if (!isValidAdminKey(candidateKey)) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>🔒 Acceso Administrativo Protegido</title>
          <link rel="icon" type="image/png" href="/favicon.png">
          <link rel="shortcut icon" href="/favicon.ico">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding: 60px 20px; margin: 0; }
            .card { background: #1e293b; max-width: 420px; margin: 0 auto; padding: 32px; border-radius: 14px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4); border: 1px solid #334155; }
            input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 14px; margin-top: 16px; margin-bottom: 12px; }
            input:focus { outline: none; border-color: #38bdf8; }
            button { width: 100%; padding: 12px; background: #0284c7; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
            button:hover { background: #0369a1; }
          </style>
        </head>
        <body>
          <div class="card">
            <img src="/logo.png" alt="Kindev Logo" style="width: 60px; height: auto; margin-bottom: 12px; border-radius: 8px;" />
            <h2 style="margin-top: 0;">🔒 Acceso Administrativo</h2>
            <p style="color: #94a3b8; font-size: 14px;">Ingresa la clave de administración para acceder al código QR de WhatsApp.</p>
            <form method="GET" action="/qr">
              <input type="password" name="key" placeholder="Introduce la clave administrativa..." autofocus required />
              <button type="submit">Ingresar y Vincular</button>
            </form>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">Sesión protegida por clave de autorización.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (req.query.key && isValidAdminKey(req.query.key)) {
    res.setHeader('Set-Cookie', `admin_key=${encodeURIComponent(req.query.key)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
  }

  next();
}

/**
 * Extrae y valida metadatos nativos de anuncios de Meta (Click-to-WhatsApp Ads / CTWA)
 * Soporta de manera recursiva mensajes de texto, audios/notas de voz, imágenes, videos y documentos.
 */

/**
 * Guarda el lead de Meta Ads directamente en Cloud Firestore (Kindev Meta Ads)
 */
async function saveLeadDirectToFirestore(projectId, payload) {
  if (projectId !== FIREBASE_PROJECT_ID) throw new Error('Proyecto no oficial.');
  try { await saveWhatsAppLead(payload); return true; }
  catch (e) { console.error('[FIRESTORE SYNC]', e.message); return false; }
}

/**
 * Reporta el estado de conexión y heartbeat a Cloud Firestore para Kindev Meta Ads
 */
const FIRESTORE_STATUS_URL = (projectId) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings/whatsapp_status_cloud_${TENANT_ID}`;

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
let lastStatusWritten = '';
let lastStatusWriteTime = 0;
let statusQueue = Promise.resolve();
const INSTANCE_ID = crypto.randomUUID();
function updateFirestoreStatus(...args) {
  statusQueue = statusQueue.then(() => writeFirestoreStatus(...args)).catch(error => console.error('[Status]', error.message));
  return statusQueue;
}

async function writeFirestoreStatus(status, user = '', note = '', force = false) {
  if (!FIREBASE_PROJECT_ID) return;
  const now = Date.now();
  const statusKey = `${status}|${user}|${note}`;

  if (!force && statusKey === lastStatusWritten && now - lastStatusWriteTime < HEARTBEAT_INTERVAL_MS) {
    return;
  }

  try {
    const payload = {
      fields: {
        tenantId: { stringValue: TENANT_ID },
        projectId: { stringValue: FIREBASE_PROJECT_ID },
        instanceId: { stringValue: INSTANCE_ID },
        status: { stringValue: status },
        user: { stringValue: user || '' },
        note: { stringValue: note || '' },
        isListening: { booleanValue: status === 'connected' },
        updatedAt: { stringValue: new Date().toISOString() }
      }
    };
    const response = await firestoreFetch(FIRESTORE_STATUS_URL(FIREBASE_PROJECT_ID), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('Firestore status HTTP ' + response.status);
    lastStatusWritten = statusKey;
    lastStatusWriteTime = now;
  } catch (err) {
    console.error('[Status] No se pudo actualizar el estado de la cuenta:', err.message);
  }
}

// Latido inteligente cada 4 minutos para mantener el estado vivo en el panel de Kindev Ads
setInterval(() => {
  if (connectionStatus === 'conectado' && connectedUser) {
    const rawPhone = connectedUser?.id ? `+${connectedUser.id.split(':')[0].replace(/\D/g, '')}` : '';
    updateFirestoreStatus('connected', rawPhone, 'Escuchador activo en Render (Kindev Meta Ads)', true);
  }
}, HEARTBEAT_INTERVAL_MS);

// ================= MOTOR BAILEYS =================

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useFirestoreAuthState(SESSIONS_DIR, FIREBASE_PROJECT_ID);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WA] Usando Baileys v${version.join('.')}, última versión: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Kindev Meta Ads', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // Sincronizar libreta de contactos para excluir familia y amigos
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id) {
          const clean = c.id.replace('@s.whatsapp.net', '').replace(/:\d+/, '');
          savedContacts.add(clean);
        }
      }
      console.log(`[Contactos] Agenda sincronizada: ${savedContacts.size} contactos personales identificados.`);
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const u of updates) {
        if (u.id) {
          const clean = u.id.replace('@s.whatsapp.net', '').replace(/:\d+/, '');
          savedContacts.add(clean);
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = 'esperando_qr';
        updateFirestoreStatus('qr_ready', '', 'Código QR disponible para escanear');
        console.log('\n================ QR DISPONIBLE ================');
        console.log(`Escanea desde WhatsApp ingresando con tu clave a: /qr?key=...`);
        qrcodeTerminal.generate(qr, { small: true });
        console.log('===============================================\n');
      }

      if (connection === 'close') {
        currentQR = null;
        connectedUser = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WA] Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          connectionStatus = `reconectando (intento ${reconnectAttempts})`;
          updateFirestoreStatus('reconnecting', '', `Reconectando intento ${reconnectAttempts}`);
          console.log(`[WA] Reintentando en ${delay / 1000}s...`);
          setTimeout(connectToWhatsApp, delay);
        } else {
          connectionStatus = 'desconectado_logout';
          updateFirestoreStatus('disconnected', '', 'Sesión cerrada (logout)');
          await clearFirestoreSession(FIREBASE_PROJECT_ID);
          if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
          }
          console.log('[WA] Sesión cerrada permanentemente (logout). Firestore limpiado.');
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        currentQR = null;
        connectionStatus = 'conectado';
        connectedUser = sock.user;
        const masked = maskPhone(sock.user?.id?.split(':')[0]);
        const rawPhone = sock.user?.id ? `+${sock.user.id.split(':')[0].replace(/\D/g, '')}` : '';
        console.log(`\n🎉 [WA] ¡Conexión establecida con éxito!`);
        console.log(`[WA] Número vinculado: ${masked}\n`);
        updateFirestoreStatus('connected', rawPhone, 'Escuchador activo en Render (Kindev Meta Ads)', true);
      }
    });

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
        await observeCrmConversation(msg);
        if (msg.key.fromMe) continue;

        const senderJid = msg.key.remoteJid;
        const isGroup = senderJid?.endsWith('@g.us');
        if (isGroup) continue;

        const pushName = msg.pushName || 'Desconocido';
        const senderPhone = senderJid?.replace('@s.whatsapp.net', '').replace(/:\d+/, '') || '';

        // Extraer texto o identificar audios/notas de voz y multimedia
        let text = '';
        let mediaType = 'text';

        if (msg.message?.conversation) {
          text = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          text = msg.message.extendedTextMessage.text;
        } else if (msg.message?.audioMessage) {
          mediaType = 'audio';
          const isPtt = Boolean(msg.message.audioMessage.ptt);
          const seconds = msg.message.audioMessage.seconds || 0;
          text = isPtt ? `[🎤 Nota de voz (${seconds}s)]` : `[🎵 Audio (${seconds}s)]`;
        } else if (msg.message?.imageMessage) {
          mediaType = 'image';
          text = msg.message.imageMessage.caption
            ? `[📷 Imagen]: ${msg.message.imageMessage.caption}`
            : '[📷 Imagen recibida]';
        } else if (msg.message?.videoMessage) {
          mediaType = 'video';
          text = msg.message.videoMessage.caption
            ? `[🎥 Video]: ${msg.message.videoMessage.caption}`
            : '[🎥 Video recibido]';
        } else if (msg.message?.documentMessage) {
          mediaType = 'document';
          text = `[📄 Documento: ${msg.message.documentMessage.fileName || 'archivo'}]`;
        } else {
          text = '[Mensaje multimedia o sin texto directo]';
        }

        // FILTRO 1: Descartar contactos de agenda personal
        if (savedContacts.has(senderPhone)) {
          console.log(`\n⛔ [FILTRO AGENDA] Contacto personal descartado (${maskPhone(senderPhone)} - "${pushName}").`);
          continue;
        }

        // FILTRO 2: Detectar metadatos nativos de anuncios de Meta (CTWA)
        const adInfo = extractMetaAdInfo(msg);

        if (ONLY_META_ADS && !adInfo) {
          console.log(`\n⛔ [FILTRO NO-PUBLICIDAD] Mensaje de ${maskPhone(senderPhone)} ("${pushName}") no proviene de anuncio de Meta. Descartado.`);
          continue;
        }

        console.log(`\n🎯 [LEAD META ADS CONFIRMADO]`);
        console.log(`👤 Prospecto: ${pushName} (${maskPhone(senderPhone)})`);
        if (adInfo) {
          console.log(`📢 Fuente: ${adInfo.source} | App: ${adInfo.app}`);
          if (adInfo.adTitle) console.log(`📌 Anuncio: "${adInfo.adTitle}"`);
          if (adInfo.campaignId) console.log(`🆔 Campaña: ${adInfo.campaignId}`);
        }
        if (IS_DEBUG) {
          console.log(`💬 Mensaje (DEBUG): "${text}"`);
        } else {
          console.log(`💬 Contenido: ${mediaType === 'audio' ? text : `[${text.length} caracteres - Protegido por privacidad]`}`);
        }

        const leadPayload = {
          name: pushName,
          phone: senderPhone,
          message: text,
          event: 'whatsapp_lead_received',
          adInfo: adInfo || null,
          mediaType,
          source: 'meta_ads_ctwa',
          service: adInfo?.adTitle ? `Meta Ad: ${adInfo.adTitle}` : 'Meta Ads WhatsApp Lead',
          sender: {
            phone: senderPhone,
            name: pushName,
            jid: senderJid
          },
          receivedAt: new Date().toISOString()
        };

        // 1. Inserción directa en Cloud Firestore (Kindev Meta Ads) para sincronización en tiempo real
        await saveLeadDirectToFirestore(FIREBASE_PROJECT_ID, leadPayload);

        // 2. Despachar webhook HTTP firmado con HMAC-SHA256
        if (WEBHOOK_URL) {
          try {
            const rawBody = JSON.stringify(leadPayload);
            const signature = crypto
              .createHmac('sha256', WEBHOOK_SECRET || 'kindev_default_hmac_secret')
              .update(rawBody)
              .digest('hex');

            console.log(`🚀 [WEBHOOK] Despachando a plataforma con firma HMAC-SHA256...`);
            const response = await fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': WEBHOOK_SECRET ? `Bearer ${WEBHOOK_SECRET}` : '',
                'X-Hub-Signature-256': `sha256=${signature}`,
                'X-Timestamp': Date.now().toString()
              },
              body: rawBody
            });
            console.log(`✅ [WEBHOOK] Respuesta servidor: ${response.status} ${response.statusText}`);
          } catch (err) {
            console.error(`❌ [WEBHOOK] Error al enviar a ${WEBHOOK_URL}:`, err.message);
          }
        }
      }
    });

    return sock;
  } catch (error) {
    console.error('[WA] Error al inicializar socket:', error);
    connectionStatus = 'error_inicializacion';
    setTimeout(connectToWhatsApp, 5000);
  }
}

// ================= RUTAS HTTP SEGURAS =================

// Estado general (Información pública ofuscada para proteger infraestructura)
app.get('/', (req, res) => {
  const candidateKey = extractCandidateKey(req);
  const isAdmin = isValidAdminKey(candidateKey);
  const activeKey = isAdmin ? (candidateKey || ADMIN_KEY) : '';
  const maskedPhone = connectedUser ? maskPhone(connectedUser.id?.split(':')[0]) : null;

  if (req.query.key && isAdmin) {
    res.setHeader('Set-Cookie', `admin_key=${encodeURIComponent(req.query.key)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Kindev WhatsApp Listener</title>
        <link rel="icon" type="image/png" href="/favicon.png">
        <link rel="shortcut icon" href="/favicon.ico">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px 20px; background: #0f172a; color: #f8fafc; }
          .card { background: #1e293b; border-radius: 12px; padding: 24px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); border: 1px solid #334155; }
          .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-weight: bold; font-size: 14px; }
          .conectado { background: #166534; color: #86efac; }
          .esperando_qr { background: #854d0e; color: #fef08a; }
          .otro { background: #991b1b; color: #fca5a5; }
          a { color: #38bdf8; text-decoration: none; font-weight: 500; }
          a:hover { text-decoration: underline; }
          code { background: #334155; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <img src="/logo.png" alt="Kindev Logo" style="width: 38px; height: 38px; object-fit: contain; border-radius: 6px;" />
            <h2 style="margin: 0;">Kindev WhatsApp Gateway</h2>
          </div>
          <p>Estado del servicio: 
            <span class="badge ${connectionStatus === 'conectado' ? 'conectado' : connectionStatus === 'esperando_qr' ? 'esperando_qr' : 'otro'}">
              ${connectionStatus.toUpperCase()}
            </span>
          </p>
          ${connectedUser ? `<p>📱 Teléfono vinculado: <strong>${isAdmin ? connectedUser.id : maskedPhone}</strong></p>` : ''}
          ${currentQR ? `<p>👉 <a href="/qr${isAdmin ? `?key=${activeKey}` : ''}">Acceder a vinculación por código QR</a></p>` : ''}
          <hr style="border: 0; border-top: 1px solid #334155; margin: 20px 0;" />
          <p style="font-size: 13px; color: #94a3b8;">
            Destino Webhook: <code>${isAdmin ? WEBHOOK_URL : 'https://[Protegido en Producción]'}</code>
          </p>
          <p style="font-size: 12px; color: #64748b;">
            Filtro publicitario: <strong>${ONLY_META_ADS ? 'Meta Ads Exclusivo (CTWA + Audios)' : 'Todos los chats'}</strong>
          </p>
        </div>
      </body>
    </html>
  `);
});

// Ver QR en navegador (Protegido por requireAdminAuth)
app.get('/qr', requireAdminAuth, async (req, res) => {
  if (connectionStatus === 'conectado') {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhatsApp Conectado | Kindev</title>
          <link rel="icon" type="image/png" href="/favicon.png">
          <link rel="shortcut icon" href="/favicon.ico">
        </head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
          <img src="/logo.png" alt="Kindev Logo" style="width: 70px; height: auto; margin-bottom: 16px; border-radius: 8px;" />
          <h2>✅ WhatsApp ya está vinculado y en línea.</h2>
          <p><a href="/" style="color: #38bdf8;">Volver al panel</a></p>
        </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Generando QR WhatsApp | Kindev</title>
          <link rel="icon" type="image/png" href="/favicon.png">
          <link rel="shortcut icon" href="/favicon.ico">
          <meta http-equiv="refresh" content="3">
        </head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
          <img src="/logo.png" alt="Kindev Logo" style="width: 70px; height: auto; margin-bottom: 16px; border-radius: 8px;" />
          <h2>Generando código QR seguro...</h2>
          <p>La página se actualizará automáticamente en unos segundos.</p>
        </body>
      </html>
    `);
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Escanear WhatsApp Seguro | Kindev</title>
          <link rel="icon" type="image/png" href="/favicon.png">
          <link rel="shortcut icon" href="/favicon.ico">
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc; }
            .box { background: white; padding: 20px; border-radius: 16px; display: inline-block; margin-top: 20px; }
            img.qr-img { width: 280px; height: 280px; }
          </style>
        </head>
        <body>
          <img src="/logo.png" alt="Kindev Logo" style="width: 70px; height: auto; margin-bottom: 12px; border-radius: 8px;" />
          <h2 style="margin: 0 0 8px 0;">Escanea con tu WhatsApp</h2>
          <p style="margin: 0; color: #94a3b8;">Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
          <div class="box">
            <img class="qr-img" src="${qrDataUrl}" alt="WhatsApp QR Code" />
          </div>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">Sesión protegida con cifrado AES-256 en Firestore (kindevads).</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generando imagen QR');
  }
});

// Reset de sesión (Protegido por requireAdminAuth)
app.post('/api/session/reset', requireAdminAuth, async (req, res) => {
  try {
    await clearFirestoreSession(FIREBASE_PROJECT_ID);
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
    }
    connectionStatus = 'reiniciando_sesion';
    setTimeout(connectToWhatsApp, 1500);
    res.json({ success: true, message: 'Sesión eliminada de Firestore y reiniciando...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON Status (Endpoint seguro que oculta PII a menos que se autentique con key)
app.get('/api/status', (req, res) => {
  const isAdmin = isValidAdminKey(extractCandidateKey(req));
  res.json(publicListenerStatus({
    status: connectionStatus,
    phone: isAdmin ? connectedUser?.id : (connectedUser ? maskPhone(connectedUser.id?.split(':')[0]) : null),
    tenantId: TENANT_ID,
    instanceId: INSTANCE_ID,
    projectId: FIREBASE_PROJECT_ID,
    hasQR: Boolean(currentQR),
    filterActive: ONLY_META_ADS
  }));
});

app.listen(PORT, () => {
  console.log(`🚀 [SERVER] Servidor blindado corriendo en puerto ${PORT} para Kindev Meta Ads`);
  connectToWhatsApp();
});
