import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';

const FIRESTORE_BASE_URL = (projectId) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings`;

function toDocId(fileName) {
  // Prefijo 'whatsapp_status_session_' compatible nativamente con las reglas de Firestore de Kindev Meta Ads
  return 'whatsapp_status_session_' + fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Cifra un texto en AES-256-GCM para proteger credenciales en reposo en la nube.
 */
function encryptPayload(text, secret) {
  try {
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('[Crypto] Error al cifrar sesión:', err.message);
    return text;
  }
}

/**
 * Descifra el texto cifrado en AES-256-GCM.
 * Si el dato no está cifrado (legacy), lo retorna intacto para retrocompatibilidad.
 */
function decryptPayload(cipherText, secret) {
  if (!cipherText || !cipherText.startsWith('enc:')) {
    return cipherText;
  }
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 4) return cipherText;
    const [, ivHex, authTagHex, encryptedHex] = parts;
    const key = crypto.createHash('sha256').update(secret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Crypto] Error al descifrar sesión de Firestore:', err.message);
    return null;
  }
}

function getEncryptionKey(explicitKey) {
  return (
    explicitKey ||
    process.env.SESSION_ENCRYPTION_KEY ||
    process.env.WEBHOOK_SECRET ||
    'kindev_session_vault_secure_key_2026'
  );
}

/**
 * Descarga las credenciales guardadas en Firestore, las descifra y las restaura en disco local.
 */
export async function restoreSessionFromFirestore(
  folder,
  projectId = process.env.FIREBASE_PROJECT_ID,
  encryptionKey = null
) {
  if (!projectId) {
    console.log('[Firestore Auth] ℹ️ FIREBASE_PROJECT_ID no configurado. Operando con almacenamiento local.');
    return false;
  }

  try {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    const localCreds = path.join(folder, 'creds.json');
    if (fs.existsSync(localCreds)) {
      console.log('[Firestore Auth] ℹ️ Sesión local detectada en disco.');
      return true;
    }

    const secret = getEncryptionKey(encryptionKey);
    console.log(`[Firestore Auth] 🔄 Buscando sesión previa en Firestore (proyecto: ${projectId})...`);
    const res = await fetch(`${FIRESTORE_BASE_URL(projectId)}?pageSize=300`);
    if (!res.ok) {
      console.log(`[Firestore Auth] ⚠️ No se pudo consultar Firestore (HTTP ${res.status}).`);
      return false;
    }

    const data = await res.json();
    const docs = (data.documents || []).filter((d) => {
      const docName = d.name.split('/').pop();
      return docName.startsWith('whatsapp_status_session_') || docName.startsWith('whatsapp_session_');
    });

    if (docs.length === 0) {
      console.log('[Firestore Auth] ℹ️ No hay sesión previa guardada en Firestore. Se generará un nuevo QR.');
      return false;
    }

    let restoredCount = 0;
    for (const doc of docs) {
      const fileName = doc.fields?.fileName?.stringValue;
      const rawData = doc.fields?.data?.stringValue;
      if (fileName && rawData) {
        const decryptedData = decryptPayload(rawData, secret);
        if (decryptedData) {
          fs.writeFileSync(path.join(folder, fileName), decryptedData, 'utf8');
          restoredCount++;
        }
      }
    }

    console.log(`[Firestore Auth] 🔒 ${restoredCount} archivos de sesión restaurados y descifrados desde Firestore.`);
    return restoredCount > 0;
  } catch (error) {
    console.error('[Firestore Auth] ❌ Error al restaurar sesión:', error.message);
    return false;
  }
}

/**
 * Cifra y guarda un archivo de sesión en Firestore de forma asíncrona.
 */
export async function saveFileToFirestore(
  fileName,
  rawData,
  projectId = process.env.FIREBASE_PROJECT_ID,
  encryptionKey = null
) {
  if (!projectId) return;

  try {
    const docId = toDocId(fileName);
    const url = `${FIRESTORE_BASE_URL(projectId)}/${docId}`;
    const secret = getEncryptionKey(encryptionKey);
    const encryptedData = encryptPayload(rawData, secret);

    let response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          fileName: { stringValue: fileName },
          data: { stringValue: encryptedData },
          encrypted: { booleanValue: true },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      })
    });

    if (!response.ok) {
      // Reintento único si el servidor o Firestore responde con error temporal
      await new Promise((r) => setTimeout(r, 500));
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            fileName: { stringValue: fileName },
            data: { stringValue: encryptedData },
            encrypted: { booleanValue: true },
            updatedAt: { stringValue: new Date().toISOString() }
          }
        })
      });
    }
  } catch (err) {
    const detail = err.cause?.message || err.message;
    console.error(`[Firestore Auth] ❌ Error sincronizando ${fileName} en Firestore:`, detail);
  }
}

/**
 * Elimina un archivo de sesión en Firestore cuando Baileys lo borra.
 */
export async function removeFileFromFirestore(
  fileName,
  projectId = process.env.FIREBASE_PROJECT_ID
) {
  if (!projectId) return;

  try {
    const docId = toDocId(fileName);
    const url = `${FIRESTORE_BASE_URL(projectId)}/${docId}`;
    await fetch(url, { method: 'DELETE' });
  } catch (err) {
    console.error(`[Firestore Auth] ❌ Error eliminando ${fileName} de Firestore:`, err.message);
  }
}

/**
 * Borra toda la sesión almacenada en Firestore.
 */
export async function clearFirestoreSession(
  projectId = process.env.FIREBASE_PROJECT_ID
) {
  if (!projectId) return;

  try {
    const res = await fetch(`${FIRESTORE_BASE_URL(projectId)}?pageSize=300`);
    if (!res.ok) return;
    const data = await res.json();
    const docs = (data.documents || []).filter((d) => {
      const docName = d.name.split('/').pop();
      return docName.startsWith('whatsapp_status_session_') || docName.startsWith('whatsapp_session_');
    });
    await Promise.all(
      docs.map((doc) => fetch(`https://firestore.googleapis.com/v1/${doc.name}`, { method: 'DELETE' }))
    );
    console.log(`[Firestore Auth] 🗑️ Sesión eliminada de Firestore.`);
  } catch (err) {
    console.error('[Firestore Auth] ❌ Error al limpiar sesión de Firestore:', err.message);
  }
}

// Cola de sincronización secuencial con espaciado para evitar saturación de red en Render
const syncQueue = [];
let isQueueRunning = false;

function enqueueSync(task) {
  syncQueue.push(task);
  runQueue();
}

async function runQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  while (syncQueue.length > 0) {
    const task = syncQueue.shift();
    try {
      await task();
    } catch {
      // Ignorar errores individuales no capturados
    }
    if (syncQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  isQueueRunning = false;
}

/**
 * Adaptador híbrido de Baileys con persistencia cifrada en Firestore + caché local.
 */
export async function useFirestoreAuthState(
  folder,
  projectId = process.env.FIREBASE_PROJECT_ID,
  encryptionKey = null
) {
  // 1. Restaurar y descifrar desde Firestore si está configurado y no hay archivos locales
  if (projectId) {
    await restoreSessionFromFirestore(folder, projectId, encryptionKey);
  }

  // 2. Usar multi-file auth state local
  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(folder);

  // 3. Extender saveCreds para cifrar y sincronizar en Firestore si hay projectId
  const saveCreds = async () => {
    await originalSaveCreds();
    if (!projectId) return;
    const credsPath = path.join(folder, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const content = fs.readFileSync(credsPath, 'utf8');
      enqueueSync(() => saveFileToFirestore('creds.json', content, projectId, encryptionKey));
    }
  };

  // 4. Interceptar keys.set para cifrar y sincronizar keys en Firestore si hay projectId
  const originalKeysSet = state.keys.set;
  state.keys.set = async (data) => {
    await originalKeysSet(data);
    if (!projectId) return;
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id];
        const fileName = `${category}-${id}.json`;
        if (value) {
          const filePath = path.join(folder, fileName.replace(/\//g, '__').replace(/:/g, '-'));
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            enqueueSync(() => saveFileToFirestore(fileName, content, projectId, encryptionKey));
          }
        } else {
          enqueueSync(() => removeFileFromFirestore(fileName, projectId));
        }
      }
    }
  };

  return { state, saveCreds };
}
