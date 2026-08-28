# Deploy a Render

## 0. Antes que nada: correr esta migración en Supabase

Dos funciones guardan un dato nuevo por Curis que la tabla `curis` de
Supabase todavía no tiene: la música de fondo (elegís una canción al subir
un Curis) y el país de origen (de dónde viene el Curis / quién lo sube,
selector de Latinoamérica en subir.html). Sin este paso, subir un Curis
con música o país va a fallar. Correr una sola vez en el SQL Editor del
dashboard de Supabase:

```sql
ALTER TABLE curis ADD COLUMN IF NOT EXISTS music_track text;
ALTER TABLE curis ADD COLUMN IF NOT EXISTS country text;
```

No hace falta ninguna otra migración: el resto de los cambios (límite de
estrellas, XP/rango, easter egg, botón de Patreon, y el paso a Cloudflare
R2 para las imágenes) no tocan el esquema de la base de datos.

## 0b. Crear el bucket de Cloudflare R2 (imágenes y música)

Las imágenes de los Curis y los .mp3 de la música **ya no van a Supabase
Storage**, van a Cloudflare R2 (plan free: 10 GB). Sin estas variables el
servidor no arranca.

1. En el dashboard de Cloudflare → **R2** → "Create bucket" (ej. nombre
   `curisfandom`). Anotar el nombre → `R2_BUCKET`.
2. **Acceso público**: en el bucket → "Settings" → "Public access" →
   habilitar el subdominio `r2.dev` gestionado (o conectar un dominio
   propio). Te da una URL tipo `https://pub-xxxxxxxx.r2.dev` → esa es
   `R2_PUBLIC_BASE_URL` (sin barra final).
3. **API Token**: R2 → "Manage R2 API Tokens" → "Create API Token" →
   permiso **Object Read & Write**, alcance ese bucket. Te da:
   - "Account ID" (arriba a la derecha en R2) → `R2_ACCOUNT_ID`
   - "Access Key ID" → `R2_ACCESS_KEY_ID`
   - "Secret Access Key" → `R2_SECRET_ACCESS_KEY` (**secreta**, se muestra
     una sola vez)
4. Guardar las 5 en `.env.production.local` para local y cargarlas en
   Render (paso 3, están en `render.yaml` con `sync: false`).
5. **Música**: subir los `.mp3` a mano al bucket, dentro de la carpeta
   `music/`, y agregar una línea en `web/music-library.js` con la URL
   pública completa (`R2_PUBLIC_BASE_URL/music/archivo.mp3`). Instrucciones
   en el comentario de ese archivo.

> Las imágenes que hubiera de pruebas viejas en Supabase Storage quedan
> huérfanas (el sitio ya no las mira). Si la tabla `curis` tiene solo
> restos de prueba, borrá esas filas; si hay Curis reales que conservar,
> hay que migrar los archivos a R2 con un script aparte.

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
   como start command, con las variables de entorno vacías para completar.
   - Si preferís no usar el Blueprint, "New" → "Web Service" a mano
     también funciona: mismo build/start command, hay que cargar las
     mismas variables manualmente (paso 3).
3. Completar esas variables de entorno cuando Render las pida:
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
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_BUCKET`, `R2_PUBLIC_BASE_URL` — del paso 0b. `R2_SECRET_ACCESS_KEY`
     es **secreta**.
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

Al subir un Curis, en el dashboard de R2 tiene que aparecer el objeto
`uploads/<id>.webp` (unos pocos KB o decenas de KB, ya recomprimido); al
rechazarlo o borrar la cuenta, el objeto tiene que desaparecer.

## Nota sobre el plan gratis de Render

El plan gratis "duerme" el servicio tras ~15 minutos sin tráfico (la
primera visita después de eso tarda 30s-1min en responder mientras
arranca de nuevo). El plan pago (~$7/mes) lo evita, si en algún momento
molesta para hacer una demo en vivo.
