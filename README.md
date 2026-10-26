# Kindev WhatsApp Listener (Microservicio de Prueba)

Microservicio ligero e independiente para mantener una sesión de WhatsApp conectada 24/7, escuchar mensajes entrantes (leads) y despacharlos mediante un Webhook HTTP POST a **Kindev Meta Ads**.

---

## 🚀 Despliegue en Render

1. Ve a tu panel de [Render](https://dashboard.render.com).
2. Haz clic en **New +** > **Web Service**.
3. Conecta este repositorio: `https://github.com/LastRq/whatsapp-listeneer`.
4. Configura los campos:
   - **Name**: `kindev-wa-listener`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Starter` (para que no entre en suspensión y mantenga el WebSocket 24/7).
5. En la sección **Environment Variables**, añade:
   - `PORT`: `3000`
   - `WEBHOOK_URL`: La URL de tu endpoint en Kindev Meta Ads (ej. `https://kindevmetaads.web.app/api/webhooks/whatsapp`).
   - `WEBHOOK_SECRET`: Clave secreta compartida (opcional).
6. *(Recomendado)* En **Disks**, añade un disco persistente montado en `/sessions` para que las sesiones de WhatsApp no se cierren en cada nuevo deploy.
7. Haz clic en **Create Web Service**.

Una vez desplegado:
- Entra a `https://tu-servicio.onrender.com/qr` desde tu navegador para escanear el código QR con tu WhatsApp.
- Entra a `https://tu-servicio.onrender.com/api/status` para ver el estado JSON.

---

## 💻 Prueba Local

1. Clona el repositorio e instala las dependencias:
   ```bash
   npm install
   ```
2. Inicia el servidor:
   ```bash
   npm start
   ```
3. Verás el código QR directamente en la consola (o abriendo `http://localhost:3000/qr` en tu navegador).
4. Cuando envíes un mensaje de prueba a ese número, verás el log en consola y se despachará al webhook configurado.
