# Deploy a Render

## 0. Antes que nada: correr esta migración en Supabase

La función de música de fondo (elegís una canción al subir un Curis)
guarda un dato nuevo por Curis que la tabla `curis` de Supabase todavía no
tiene. Sin este paso, subir un Curis con música va a fallar. Correr una
sola vez en el SQL Editor del dashboard de Supabase:

```sql
ALTER TABLE curis ADD COLUMN IF NOT EXISTS music_track text;
```

No hace falta ninguna otra migración: el resto de los cambios de esta
ronda (límite de estrellas, XP/rango, easter egg, botón de Patreon) no
tocan el esquema de la base de datos.

## 1. Subir el código a GitHub

```
git remote add origin https://github.com/<tu-usuario>/curisfandom.git
git branch -M main
git push -u origin main
```

(Si preferís, creá el repo vacío en GitHub primero desde la web y pegá la
URL que te den ahí en el `git remote add`.)

## 2. Crear el servicio en Render

1. Entrar a [render.com](https://render.com/) y crear una cuenta (podés
   usar la misma cuenta de GitHub para loguearte, simplifica el paso
   siguiente).
2. "New" → "Blueprint" → elegir el repo `curisfandom` recién subido.
   Render va a detectar `render.yaml` (ya incluido en este repo) y
   proponer un servicio web con `npm install` como build y `npm start`
   como start command, con 5 variables de entorno vacías para completar.
   - Si preferís no usar el Blueprint, "New" → "Web Service" a mano
     también funciona: mismo build/start command, hay que cargar las
     mismas 5 variables manualmente (paso 3).
3. Completar esas 5 variables de entorno cuando Render las pida:
   - `ADMIN_PASSWORD` y `SESSION_SECRET` — los valores ya generados están
     en `.env.production.local` (no se subió a git a propósito, es un
     archivo local con secretos).
   - `GOOGLE_CLIENT_ID` — el mismo que ya se usa en local
     (`386050144925-firsc29gmjoddehouactjof4em71ii0l.apps.googleusercontent.com`,
     ver `handoff.md`). No es secreto (los Client ID de Google son
     públicos por diseño), pero igual se carga como variable de entorno
     porque así lo espera `server.js`.
   - `SUPABASE_URL` — `https://ynpoohrcoyumbtfyjphq.supabase.co` (ver
     `handoff.md`).
   - `SUPABASE_SERVICE_ROLE_KEY` — **esta sí es secreta**, no está
     guardada en ningún archivo de este proyecto por seguridad. La tenés
     vos de cuando se creó el proyecto de Supabase (o se puede volver a
     copiar desde el dashboard de Supabase → Project Settings → API →
     "service_role" key).
4. Deploy. Render va a dar una URL del tipo
   `https://curisfandom.onrender.com` (o el nombre que hayas elegido).

## 3. Conectar esa URL a Google Cloud Console

El Client ID de Google solo acepta pedidos de login desde los orígenes
que tenga autorizados (hoy solo `http://localhost:8934`):

1. [Google Cloud Console](https://console.cloud.google.com/) → el
   proyecto ya creado → "APIs y servicios" → "Credenciales" → el Client
   ID de OAuth existente.
2. En "Orígenes de JavaScript autorizados" agregar la URL real que dio
   Render (`https://curisfandom.onrender.com` o la que corresponda).
3. Mientras la pantalla de consentimiento OAuth siga en modo "Testing",
   **solo las cuentas de Google agregadas a mano como "usuarios de
   prueba" van a poder loguearse** — cualquier visitante nuevo todavía
   no. Publicar la app (sacarla de "Testing") es el punto 1b pendiente en
   `handoff.md`.

## 4. Confirmar que funciona

Repetir en la URL pública el mismo checklist que ya se probó en local:
login → subir un Curis → aprobar desde `/admin.html` (con el
`ADMIN_PASSWORD` nuevo) → que aparezca en el ranking → calificarlo →
límite diario de estrellas → rechazar un Curis.

## Nota sobre el plan gratis de Render

El plan gratis "duerme" el servicio tras ~15 minutos sin tráfico (la
primera visita después de eso tarda 30s-1min en responder mientras
arranca de nuevo). El plan pago (~$7/mes) lo evita, si en algún momento
molesta para hacer una demo en vivo.
