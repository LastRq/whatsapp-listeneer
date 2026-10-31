# Kindev Ads — escuchador de WhatsApp en Render

Servicio independiente por cuenta. La plataforma oficial es https://kindevads.com y el único proyecto de datos utilizado en ejecución es `kindevads`.

## Una instancia por cuenta

En cada servicio de Render configura:
- `TENANT_ID`: identificador exacto de la cuenta en Kindev Ads. La instancia principal usa `kindev`.
- `SESSION_ENCRYPTION_KEY`: clave privada de cifrado, distinta para cada instancia. Conserva su valor al actualizar una instancia existente para restaurar la sesión vinculada.
- `ADMIN_KEY`: clave privada del administrador para vincular QR y administrar esa sesión.
- `KINDEVADS_FIREBASE_API_KEY`: configuración pública de Firebase del proyecto oficial. Se incluye el valor público oficial por defecto.
- `ONLY_META_ADS`: conserva el filtro actual de anuncios.
- `KINDEVADS_WEBHOOK_URL`: opcional. Solo se acepta el dominio oficial; sin configurar, los contactos se guardan directamente en Firestore.

No se utiliza el antiguo FIREBASE_PROJECT_ID ni el antiguo WEBHOOK_URL como destino. No se necesita un servidor en una computadora.

El proceso obtiene una sesión autenticada de Firebase y renueva su token en memoria. No se incluyeron credenciales administrativas de Google ni claves privadas en el repositorio.

## Separación

Cada instancia:
- Publica su estado en `settings/whatsapp_status_cloud_TENANT_ID`.
- Guarda contactos con su propio `tenantId`.
- Restaura y elimina únicamente los archivos de sesión de su cuenta.
- Conserva las credenciales de WhatsApp cifradas en Firestore y utiliza una caché efímera propia.
- Expone `GET /api/status` con cuenta, proyecto, estado real y fecha de comprobación.
- Permite leer ese estado desde los dominios oficiales mediante CORS; esa autorización no se aplica al QR ni al reinicio de sesión.
- No ejecuta envíos automáticos de mensajes desde la plataforma para comprobar la conexión.

En Kindev Ads abre Configuración > WhatsApp en la cuenta correspondiente y asigna la URL HTTPS de esa instancia. La plataforma rechaza reutilizar una URL de otra cuenta o aceptar un estado de otro tenant/proyecto.

## Actualización de una sesión existente

Antes de desplegar el nuevo código puede importarse la sesión cifrada, conservando el valor actual de SESSION_ENCRYPTION_KEY en Render:

```sh
node scripts/import-encrypted-session.mjs --from PROYECTO_ORIGEN --tenant kindev
node scripts/import-encrypted-session.mjs --from PROYECTO_ORIGEN --tenant kindev --apply
```

La primera orden solo informa. La segunda crea los documentos cifrados faltantes en kindevads. No modifica el origen, no sobrescribe documentos existentes ni escribe credenciales descifradas en disco.

## Verificación

```sh
npm ci
npm test
node --check src/index.js
```

El despliegue se comprueba con /api/status: debe indicar `projectId: kindevads`, el tenant esperado y la versión `kindevads-tenants-1`. Un servidor que responde HTTP 200 no implica por sí solo que WhatsApp esté conectado.

## Integraciones oficiales de Meta

El servicio incluye una pasarela CAPI/Insights para la plataforma kindevads.com. Cada ruta /api/meta/TENANT utiliza exclusivamente la configuración de ese tenant en Firebase kindevads; requiere X-Meta-Token igual a su credencial registrada. Kindev separa capiToken de userToken/marketingToken. No hay credenciales globales de cliente ni fallback a otro tenant.

Los nuevos leads de la instancia se guardan antes de enviarse a CAPI. Los envíos pendientes conservan event_id y event_time y se reintentan cada 30 minutos; el histórico sin marca pending no se reenvía. CTWA se conserva si Baileys entrega externalAdReply.ctwaClid. Page ID/WABA se configuran en la plataforma. Nunca se inventan identificadores del visitante ni se incluyen notas clínicas en custom_data.

Seguimiento observa únicamente contactos existentes en el CRM del tenant de esta instancia y persiste fechas/respuestas en sus leads. GET /api/whatsapp/outbound-tracker-full está protegido por su credencial de cuenta. No habilita envíos automáticos ni expone chats personales.

Los tokens permanecen en el registro Firebase ya existente y se leen desde el frontend autenticado para probar posesión ante la pasarela. Esto no sustituye una futura autorización de Firestore por membresías; las reglas y el login de la plataforma requieren su propia migración de seguridad.
