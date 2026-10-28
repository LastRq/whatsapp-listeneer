import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import fs from 'fs';
import { useFirestoreAuthState, clearFirestoreSession } from './firestore-auth.js';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://test-ads-one.vercel.app/api/webhook/whatsapp';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test-addss';

// Estado en memoria
let currentQR = null;
let connectionStatus = 'iniciando';
let connectedUser = null;
let reconnectAttempts = 0;

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Iniciar conexión Baileys
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
      browser: ['Kindev Listener', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionStatus = 'esperando_qr';
        console.log('\n================ QR DISPONIBLE ================');
        console.log('Escanea desde WhatsApp o entra a http://localhost:' + PORT + '/qr\n');
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
          console.log(`[WA] Reintentando en ${delay / 1000}s...`);
          setTimeout(connectToWhatsApp, delay);
        } else {
          connectionStatus = 'desconectado_logout';
          await clearFirestoreSession(FIREBASE_PROJECT_ID);
          if (fs.existsSync(SESSIONS_DIR)) { fs.rmSync(SESSIONS_DIR, { recursive: true, force: true }); }
          console.log('[WA] Sesión cerrada permanentemente (logout). Limpia la carpeta sessions para reintentar.');
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        currentQR = null;
        connectionStatus = 'conectado';
        connectedUser = sock.user;
        console.log(`\n🎉 [WA] ¡Conexión establecida con éxito!`);
        console.log(`[WA] Número vinculado: ${sock.user?.id || 'Desconocido'}\n`);
      }
    });

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Ignorar mensajes enviados por nosotros mismos o de estado
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

        const senderJid = msg.key.remoteJid;
        const isGroup = senderJid?.endsWith('@g.us');
        if (isGroup) continue; // Por ahora solo chats directos (leads)

        const pushName = msg.pushName || 'Desconocido';
        const senderPhone = senderJid?.replace('@s.whatsapp.net', '') || '';

        // Extraer texto del mensaje
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '[Mensaje multimedia o sin texto directo]';

        const leadPayload = {
          name: pushName,
          phone: senderPhone,
          message: text,
          event: 'whatsapp_lead_received',
          sender: {
            phone: senderPhone,
            name: pushName,
            jid: senderJid
          },
          message: {
            text: text,
            timestamp: msg.messageTimestamp,
            id: msg.key.id
          },
          receivedAt: new Date().toISOString()
        };

        console.log(`\n📩 [NUEVO LEAD WA] De: ${pushName} (+${senderPhone})`);
        console.log(`💬 Mensaje: "${text}"`);

        // Despachar webhook si está configurado
        if (WEBHOOK_URL) {
          try {
            console.log(`🚀 [WEBHOOK] Enviando a: ${WEBHOOK_URL}`);
            const response = await fetch(WEBHOOK_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': WEBHOOK_SECRET ? `Bearer ${WEBHOOK_SECRET}` : ''
              },
              body: JSON.stringify(leadPayload)
            });
            console.log(`✅ [WEBHOOK] Respuesta servidor: ${response.status} ${response.statusText}`);
          } catch (err) {
            console.error(`❌ [WEBHOOK] Error al enviar a ${WEBHOOK_URL}:`, err.message);
          }
        } else {
          console.log(`ℹ️ [WEBHOOK] No se ha configurado WEBHOOK_URL en las variables de entorno.`);
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

// ================= RUTAS HTTP =================

// Estado general
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Kindev WhatsApp Listener</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #0f172a; color: #f8fafc; }
          .card { background: #1e293b; border-radius: 12px; padding: 24px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
          .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-weight: bold; font-size: 14px; }
          .conectado { background: #166534; color: #86efac; }
          .esperando_qr { background: #854d0e; color: #fef08a; }
          .otro { background: #991b1b; color: #fca5a5; }
          a { color: #38bdf8; text-decoration: none; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Kindev WhatsApp Listener</h2>
          <p>Estado actual: 
            <span class="badge ${connectionStatus === 'conectado' ? 'conectado' : connectionStatus === 'esperando_qr' ? 'esperando_qr' : 'otro'}">
              ${connectionStatus.toUpperCase()}
            </span>
          </p>
          ${connectedUser ? `<p>📱 Conectado con: <strong>${connectedUser.id}</strong></p>` : ''}
          ${currentQR ? `<p>👉 <a href="/qr">Haz clic aquí para ver y escanear el código QR</a></p>` : ''}
          <hr style="border: 0; border-top: 1px solid #334155; margin: 20px 0;" />
          <p style="font-size: 13px; color: #94a3b8;">Webhook configurado: <code>${WEBHOOK_URL || 'No definido'}</code></p>
        </div>
      </body>
    </html>
  `);
});

// Ver QR en navegador
app.get('/qr', async (req, res) => {
  if (connectionStatus === 'conectado') {
    return res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
          <h2>✅ WhatsApp ya está vinculado y en línea.</h2>
          <p><a href="/" style="color: #38bdf8;">Volver al panel</a></p>
        </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
          <h2>Generando código QR...</h2>
          <p>La página se actualizará automáticamente en unos segundos.</p>
        </body>
      </html>
    `);
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <html>
        <head>
          <title>Escanear WhatsApp</title>
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc; }
            .box { background: white; padding: 20px; border-radius: 16px; display: inline-block; margin-top: 20px; }
            img { width: 280px; height: 280px; }
          </style>
        </head>
        <body>
          <h2>Escanea con tu WhatsApp</h2>
          <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
          <div class="box">
            <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
          </div>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">El QR se actualiza automáticamente.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generando imagen QR');
  }
});

// JSON Status para que Kindev Meta Ads consulte si está online
app.post('/api/session/reset', async (req, res) => {
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

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    user: connectedUser,
    hasQR: Boolean(currentQR)
  });
});

app.listen(PORT, () => {
  console.log(`🚀 [SERVER] Servidor corriendo en puerto ${PORT}`);
  connectToWhatsApp();
});
