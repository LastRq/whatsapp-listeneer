import fs from 'fs';
import path from 'path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';

const FIRESTORE_BASE_URL = (projectId) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings`;

function toDocId(fileName) {
  return 'whatsapp_session_' + fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Descarga las credenciales guardadas en Firestore y las restaura en la carpeta local de sesiones.
 */
export async function restoreSessionFromFirestore(folder, projectId = 'test-addss') {
  try {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    const localCreds = path.join(folder, 'creds.json');
    if (fs.existsSync(localCreds)) {
      console.log('[Firestore Auth] ℹ️ Sesión local detectada en disco.');
      return true;
    }

    console.log(`[Firestore Auth] 🔄 Buscando sesión previa en Firestore (proyecto: ${projectId})...`);
    const res = await fetch(`${FIRESTORE_BASE_URL(projectId)}?pageSize=300`);
    if (!res.ok) {
      console.log(`[Firestore Auth] ⚠️ No se pudo consultar Firestore (HTTP ${res.status}).`);
      return false;
    }

    const data = await res.json();
    const docs = (data.documents || []).filter((d) =>
      d.name.split('/').pop().startsWith('whatsapp_session_')
    );

    if (docs.length === 0) {
      console.log('[Firestore Auth] ℹ️ No hay sesión previa guardada en Firestore. Se generará un nuevo QR.');
      return false;
    }

    let restoredCount = 0;
    for (const doc of docs) {
      const fileName = doc.fields?.fileName?.stringValue;
      const rawData = doc.fields?.data?.stringValue;
      if (fileName && rawData) {
        fs.writeFileSync(path.join(folder, fileName), rawData, 'utf8');
        restoredCount++;
      }
    }

    console.log(`[Firestore Auth] ✅ ${restoredCount} archivos de sesión restaurados desde Firestore.`);
    return restoredCount > 0;
  } catch (error) {
    console.error('[Firestore Auth] ❌ Error al restaurar sesión:', error.message);
    return false;
  }
}

/**
 * Guarda o actualiza un archivo de sesión en Firestore de forma asíncrona.
 */
export async function saveFileToFirestore(fileName, rawData, projectId = 'test-addss') {
  try {
    const docId = toDocId(fileName);
    const url = `${FIRESTORE_BASE_URL(projectId)}/${docId}`;

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          fileName: { stringValue: fileName },
          data: { stringValue: rawData },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      })
    });
  } catch (err) {
    console.error(`[Firestore Auth] ❌ Error sincronizando ${fileName} en Firestore:`, err.message);
  }
}

/**
 * Elimina un archivo de sesión en Firestore cuando Baileys lo borra (ej. al desloguearse).
 */
export async function removeFileFromFirestore(fileName, projectId = 'test-addss') {
  try {
    const docId = toDocId(fileName);
    const url = `${FIRESTORE_BASE_URL(projectId)}/${docId}`;
    await fetch(url, { method: 'DELETE' });
  } catch (err) {
    console.error(`[Firestore Auth] ❌ Error eliminando ${fileName} de Firestore:`, err.message);
  }
}

/**
 * Borra toda la sesión almacenada en Firestore (útil para desvincular o reescanear QR).
 */
export async function clearFirestoreSession(projectId = 'test-addss') {
  try {
    const res = await fetch(`${FIRESTORE_BASE_URL(projectId)}?pageSize=300`);
    if (!res.ok) return;
    const data = await res.json();
    const docs = (data.documents || []).filter((d) =>
      d.name.split('/').pop().startsWith('whatsapp_session_')
    );
    await Promise.all(
      docs.map((doc) => fetch(`https://firestore.googleapis.com/v1/${doc.name}`, { method: 'DELETE' }))
    );
    console.log(`[Firestore Auth] 🗑️ Sesión eliminada de Firestore.`);
  } catch (err) {
    console.error('[Firestore Auth] ❌ Error al limpiar sesión de Firestore:', err.message);
  }
}

/**
 * Adaptador híbrido de Baileys con persistencia automática en Firestore + caché local.
 */
export async function useFirestoreAuthState(folder, projectId = 'test-addss') {
  // 1. Restaurar desde Firestore si la carpeta local no tiene credenciales
  await restoreSessionFromFirestore(folder, projectId);

  // 2. Usar multi-file auth state local
  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(folder);

  // 3. Extender saveCreds para sincronizar en segundo plano con Firestore
  const saveCreds = async () => {
    await originalSaveCreds();
    const credsPath = path.join(folder, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const content = fs.readFileSync(credsPath, 'utf8');
      saveFileToFirestore('creds.json', content, projectId);
    }
  };

  // 4. Interceptar keys.set para sincronizar keys con Firestore
  const originalKeysSet = state.keys.set;
  state.keys.set = async (data) => {
    await originalKeysSet(data);
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id];
        const fileName = `${category}-${id}.json`;
        if (value) {
          const filePath = path.join(folder, fileName.replace(/\//g, '__').replace(/:/g, '-'));
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            saveFileToFirestore(fileName, content, projectId);
          }
        } else {
          removeFileFromFirestore(fileName, projectId);
        }
      }
    }
  };

  return { state, saveCreds };
}
