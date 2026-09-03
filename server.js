#!/usr/bin/env node
'use strict';

/*
 * Backend real de CurisFandom.
 *
 * La identidad del usuario ahora viene de una cookie de sesión firmada por
 * el servidor (ver signSession/verifySession), no de un userId que manda
 * el navegador en cada request -- eso era el hueco de seguridad que
 * quedaba documentado en handoff.md ("cualquiera podía mandar el id de
 * otra persona"). Mientras no está configurado GOOGLE_CLIENT_ID, el login
 * sigue siendo uno simulado (POST /api/auth/dev-login), pero ya pasa por
 * el mismo mecanismo de sesión real que va a usar el login de Google de
 * verdad -- el día que se configure el Client ID, alcanza con que el
 * frontend llame a /api/auth/google en vez de /api/auth/dev-login, el
 * resto (sesión, endpoints protegidos) no cambia.
 *
 * Uso: node server.js [puerto]   (por defecto 8934)
 * Variables de entorno: ADMIN_PASSWORD, SESSION_SECRET, GOOGLE_CLIENT_ID,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (datos), y R2_ACCOUNT_ID /
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE_URL
 * (imágenes y música en Cloudflare R2). Ver DEPLOY.md.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const storage = require('./storage');

// Render (y la mayoría de los hosts) asignan el puerto vía la variable de
// entorno PORT y esperan que el servicio escuche exactamente ahí -- por eso
// tiene prioridad sobre el argumento de línea de comandos, que sigue
// sirviendo para elegir un puerto a mano en local (`node server.js 9000`).
const PORT = process.env.PORT ? Number(process.env.PORT) : (process.argv[2] ? Number(process.argv[2]) : 8934);
const WEB_DIR = path.join(__dirname, 'web');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-cambiar-antes-de-publicar';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'curis-admin-2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠ ADMIN_PASSWORD no está seteada por variable de entorno: usando la contraseña de desarrollo por defecto. Cambiarla antes de publicar la URL (ver handoff.md).');
}
if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠ GOOGLE_CLIENT_ID no está seteada: el login usa el modo de desarrollo simulado (POST /api/auth/dev-login), no el de Google real. Ver handoff.md para conectarlo.');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// true en Render / producción (Render setea la variable de entorno RENDER).
// Se usa para exigir cookies Secure y para abortar el arranque si faltan los
// secretos reales (SESSION_SECRET / ADMIN_PASSWORD), en vez de correr en prod
// con los valores de desarrollo por defecto (todas las sesiones serían
// forjables si SESSION_SECRET quedara en el default).
const PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
if (PROD && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-cambiar-antes-de-publicar')) {
    throw new Error('SESSION_SECRET no está configurada en producción — abortando el arranque.');
}
if (PROD && !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD no está configurada en producción — abortando el arranque.');
}

// Login de desarrollo simulado. Siempre disponible si no hay GOOGLE_CLIENT_ID.
// Si SÍ lo hay (prod), queda deshabilitado salvo que ALLOW_DEV_LOGIN=1, que
// solo lo setea dev.js al correr `npm run dev` -- Render corre `npm start`
// (server.js directo) y nunca lo tiene, así que en producción no existe.
const ALLOW_DEV_LOGIN = !GOOGLE_CLIENT_ID || process.env.ALLOW_DEV_LOGIN === '1';
if (GOOGLE_CLIENT_ID && ALLOW_DEV_LOGIN) {
    console.warn('⚠ ALLOW_DEV_LOGIN=1: el login simulado (POST /api/auth/dev-login) está habilitado ADEMÁS del de Google. Solo para desarrollo local.');
}

const CONFIG = {
    adSeconds: 30,
    extraAdChance: 0.10,
    // Bajado de 50/120 para que el límite diario se sienta antes: 15
    // alcanza para calificar al menos 3 Curis con la nota máxima (5.0 x 3 =
    // 15) antes de tener que ver el anuncio de 30s que sube el cap a 40.
    starsCapBase: 15,
    starsCapExtended: 40,
    googleClientId: GOOGLE_CLIENT_ID,
    // true -> el frontend usa el login simulado (desarrollo local) en vez
    // del botón de Google, que no funciona en localhost (origen no permitido).
    devLogin: ALLOW_DEV_LOGIN
};

const CURIS_COLORS = [['#ff3d7f', '#ff7a18'], ['#6c5ce7', '#a29bfe'], ['#00d4ff', '#6c5ce7'], ['#00b894', '#00d4ff'], ['#fdcb6e', '#e17055']];

// País de origen del Curis -- mismos códigos que el <select> de web/subir.html.
// Whitelist explícita (no solo forma) para no guardar cualquier string.
const LATAM_COUNTRIES = new Set(['ar', 'bo', 'br', 'cl', 'co', 'cr', 'cu', 'ec', 'sv', 'gt', 'hn', 'mx', 'ni', 'pa', 'py', 'pe', 'do', 'uy', 've']);

const app = express();

// Render sirve detrás de Cloudflare. Los rate limiters usan el header
// CF-Connecting-IP (la IP real del cliente que pone Cloudflare) con fallback
// a req.ip, así que se confía en la cadena de proxies para armar req.ip.
app.set('trust proxy', true);
app.disable('x-powered-by');

// ---------- redirección al dominio canónico ----------
// Se activa recién cuando se setea CANONICAL_HOST (ej. "curisfandom.com") en
// las variables de entorno de Render, una vez que el dominio propio ya
// resuelve y tiene HTTPS. Manda todo lo que llegue por otro host (el viejo
// *.onrender.com, www., etc.) al dominio final con un 301. Sin la variable
// seteada no hace nada, así que es seguro deployar esto antes del cambio.
const CANONICAL_HOST = process.env.CANONICAL_HOST || null;
if (PROD && CANONICAL_HOST) {
    app.use((req, res, next) => {
        if (req.headers.host && req.headers.host !== CANONICAL_HOST) {
            return res.redirect(301, 'https://' + CANONICAL_HOST + req.originalUrl);
        }
        next();
    });
}

// ---------- cabeceras de seguridad ----------
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), browsing-topics=()');
    if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    // Empieza en Report-Only: no rompe nada, solo reporta en la consola del
    // navegador. Cuando se confirme que no hay violaciones legítimas, cambiar
    // el nombre de la cabecera a 'Content-Security-Policy' (sin -Report-Only).
    // Nota: 'unsafe-inline' en script-src es necesario por los <script> inline
    // de admin.html / calcador.html / ruleta.html; por eso el XSS se corrige
    // además con validación + escape, no solo con CSP.
    res.setHeader('Content-Security-Policy-Report-Only', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://accounts.google.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.google.com",
        "frame-src https://accounts.google.com https://*.doubleclick.net https://*.googlesyndication.com",
        "img-src 'self' data: blob: https://*.r2.dev https://img.curisfandom.com https://*.gstatic.com https://*.googlesyndication.com https://*.google.com https://*.doubleclick.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://pagead2.googlesyndication.com https://*.google.com https://*.doubleclick.net",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'"
    ].join('; '));
    next();
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(WEB_DIR));

// ---------- rate limiting ----------
// Límite en memoria: alcanza con 1 instancia (plan free de Render). Si algún
// día se escala a varias, hace falta un store compartido (Redis).
const mkLimiter = (windowMin, max) => rateLimit({
    windowMs: windowMin * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Cloudflare pone la IP real del visitante en CF-Connecting-IP; sin ese
    // header (local) se cae a req.ip.
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip || 'unknown',
    // Se usa CF-Connecting-IP a propósito -> se silencia la validación de
    // "trust proxy permisivo" de express-rate-limit.
    validate: { trustProxy: false, xForwardedForHeader: false },
    message: { ok: false, error: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' }
});
const limiterAdminLogin = mkLimiter(15, 8);
const limiterAuth = mkLimiter(15, 30);
const limiterUpload = mkLimiter(60, 20);

// ---------- hashing de contraseña de admin (sin dependencias externas) ----------
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
    const [saltHex, hashHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
const ADMIN_PASSWORD_HASH = hashPassword(ADMIN_PASSWORD);

// ---------- cookies de sesión firmadas (genérico: admin y usuarios) ----------
// Formato: base64url(JSON de payload+exp) + "." + firma HMAC de esa parte.
// No hay estado de sesión guardado en el servidor (sin tabla de sesiones):
// toda la validación es criptográfica, igual que un JWT casero.
function signSession(payload, ttlMs) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    return body + '.' + sig;
}
function verifySession(token) {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (!payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch (e) {
        return null;
    }
}
function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
}
// El flag Secure solo en producción: en local el server corre sobre
// http://localhost y una cookie Secure no se enviaría nunca.
function setCookie(res, name, value, maxAgeSeconds) {
    res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly;${PROD ? ' Secure;' : ''} Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
}
function clearCookie(res, name) {
    res.setHeader('Set-Cookie', `${name}=;${PROD ? ' Secure;' : ''} HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días: "mantener la sesión iniciada"
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function requireAdmin(req, res, next) {
    const session = verifySession(parseCookies(req).admin_session);
    if (!session || !session.admin) return res.status(401).json({ ok: false, error: 'No autorizado.' });
    next();
}

// Middleware: exige una sesión de usuario válida y deja el id verificado en
// req.userId. Reemplaza a la vieja currentUserId(req), que confiaba en lo
// que mandara el navegador -- ahora el id sale de una cookie firmada por
// el servidor, imposible de fabricar sin conocer SESSION_SECRET.
function requireUser(req, res, next) {
    const session = verifySession(parseCookies(req).user_session);
    if (!session || !session.userId) return res.status(401).json({ ok: false, error: 'Necesitás iniciar sesión.' });
    req.userId = session.userId;
    next();
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// viewerId (opcional): id del usuario que hace el pedido. Solo se devuelve un
// booleano "mine" -- el creator_id real (derivado del sub de Google) nunca
// sale al cliente, para no exponer identificadores de cuenta.
function toPublicCuris(c, viewerId) {
    return {
        id: c.id,
        creator: c.creator_name,
        mine: viewerId ? c.creator_id === viewerId : false,
        imageFile: storage.publicUrl(c.image_file),
        color1: c.color1,
        color2: c.color2,
        status: c.status,
        avg: c.avg,
        count: c.count,
        publishedAt: c.published_at,
        musicTrack: c.music_track || null,
        country: c.country || null
    };
}

// Handler async genérico: cualquier error de red/Supabase que no haya sido
// atrapado explícitamente cae acá en vez de tumbar el servidor (Express 4
// no atrapa rechazos de promesas en handlers async por sí solo).
function asyncRoute(fn) {
    return (req, res) => {
        Promise.resolve(fn(req, res)).catch(err => {
            console.error(err);
            res.status(500).json({ ok: false, error: 'Error de servidor.' });
        });
    };
}

// ---------------------------- autenticación ----------------------------

app.get('/api/config', (req, res) => res.json(CONFIG));

// Login de desarrollo: solo existe mientras no hay GOOGLE_CLIENT_ID
// configurado. Genera un usuario nuevo y le da una sesión real (misma
// cookie/mecanismo que va a usar el login de Google) para poder seguir
// probando todo el resto del sitio sin depender de tener credenciales de
// Google a mano.
app.post('/api/auth/dev-login', limiterAuth, asyncRoute(async (req, res) => {
    if (!ALLOW_DEV_LOGIN) return res.status(404).json({ ok: false, error: 'Login de desarrollo deshabilitado: ya hay login de Google real configurado.' });
    const userId = 'dev_' + crypto.randomBytes(8).toString('hex');
    await db.upsertUser(userId, null);
    setCookie(res, 'user_session', signSession({ userId }, USER_SESSION_TTL_MS), USER_SESSION_TTL_MS / 1000);
    res.json({ ok: true, userId });
}));

// Login real de Google: el frontend manda el "credential" (un JWT) que le
// dio Google Identity Services. Se verifica la firma/audiencia/vencimiento
// contra los servidores de Google -- recién ahí se confía en el email/
// nombre/id que dice tener.
app.post('/api/auth/google', limiterAuth, asyncRoute(async (req, res) => {
    if (!googleClient) return res.status(501).json({ ok: false, error: 'Login de Google no está configurado en el servidor (falta GOOGLE_CLIENT_ID).' });
    const credential = req.body.credential;
    if (!credential) return res.status(400).json({ ok: false, error: 'Falta el token de Google.' });
    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
    } catch (e) {
        return res.status(401).json({ ok: false, error: 'Token de Google inválido.' });
    }
    const userId = 'g_' + payload.sub;
    const existing = await db.getUserById(userId);
    // Si ya eligió un nombre de usuario antes, no lo pisamos con el nombre
    // de la cuenta de Google en cada login.
    if (!existing) await db.upsertUser(userId, null);
    setCookie(res, 'user_session', signSession({ userId }, USER_SESSION_TTL_MS), USER_SESSION_TTL_MS / 1000);
    res.json({ ok: true, userId, googleName: payload.name || null, googlePicture: payload.picture || null });
}));

app.post('/api/auth/logout', (req, res) => {
    clearCookie(res, 'user_session');
    res.json({ ok: true });
});

app.get('/api/auth/me', asyncRoute(async (req, res) => {
    const session = verifySession(parseCookies(req).user_session);
    if (!session) return res.json({ authenticated: false });
    const user = await db.getUserById(session.userId);
    if (!user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: { id: user.id, name: user.name, hasPassword: !!user.password_hash } });
}));

app.post('/api/auth/set-name', requireUser, asyncRoute(async (req, res) => {
    const name = (req.body.name || '').trim();
    // Validación server-side (el cliente ya la hace, pero un pedido directo la
    // saltea): 3-20 caracteres, solo letras/números/guion bajo. Sin esto, un
    // nombre con HTML se guardaba y se renderizaba con innerHTML en el ranking
    // y en el panel de admin -> XSS almacenado.
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
        return res.status(400).json({ ok: false, error: 'El nombre debe tener entre 3 y 20 caracteres: solo letras, números y guion bajo.' });
    }
    try {
        await db.setUserName(req.userId, name);
    } catch (e) {
        // 409 / 23505 = índice único sobre lower(name) (ver plan de remediación).
        if (e.status === 409 || (e.data && String(e.data.code) === '23505')) {
            return res.status(409).json({ ok: false, error: 'Ese nombre ya está en uso.' });
        }
        throw e;
    }
    res.json({ ok: true });
}));

// Contraseña propia del usuario (se pide una vez al registrarse, además del
// login de Google). Validación mínima: 8 a 20 caracteres, sin más reglas.
app.post('/api/auth/set-password', requireUser, asyncRoute(async (req, res) => {
    const password = String(req.body.password || '');
    if (password.length < 8 || password.length > 20) {
        return res.status(400).json({ ok: false, error: 'La contraseña debe tener entre 8 y 20 caracteres.' });
    }
    await db.setUserPassword(req.userId, hashPassword(password));
    res.json({ ok: true });
}));

// ---------------------------- rutas de datos (requieren sesión) ----------------------------

const MAX_PENDING_PER_USER = 5;

app.post('/api/curis', limiterUpload, requireUser, asyncRoute(async (req, res) => {
    const user = await db.getUserById(req.userId);
    const imageData = req.body.imageData;
    if (!user || !user.name || !imageData) return res.status(400).json({ ok: false, error: 'Datos inválidos.' });

    // Tope de Curis en cola de revisión por usuario: evita que uno solo llene
    // la cola de moderación y el bucket de imágenes.
    if (await db.countPendingByCreator(req.userId) >= MAX_PENDING_PER_USER) {
        return res.status(429).json({ ok: false, error: `Ya tenés ${MAX_PENDING_PER_USER} Curis esperando revisión. Esperá a que se aprueben antes de subir más.` });
    }

    // musicTrack es el "id" de una canción de web/music-library.js, no una
    // URL ni un archivo, con un "@<segundo>" opcional al final (el punto de
    // arranque que eligió quien sube el Curi, p.ej. "judas@37"). El frontend
    // resuelve ese id a un src real al reproducir. Acá solo se valida forma
    // (evitar basura), nunca se interpreta como ruta de archivo.
    let musicTrack = req.body.musicTrack;
    if (typeof musicTrack !== 'string' || !/^[a-z0-9-]{1,60}(@\d{1,4})?$/.test(musicTrack)) musicTrack = null;

    // country: de dónde viene el Curis / quién lo sube -- opcional, se
    // valida contra la whitelist de LATAM_COUNTRIES, nunca se guarda texto libre.
    let country = req.body.country;
    if (typeof country !== 'string' || !LATAM_COUNTRIES.has(country)) country = null;

    const id = 'c_' + crypto.randomBytes(6).toString('hex');
    let imageFile;
    try {
        imageFile = await storage.saveIncoming(id, imageData);
    } catch (e) {
        return res.status(400).json({ ok: false, error: e.message });
    }
    const [color1, color2] = CURIS_COLORS[Math.floor(Math.random() * CURIS_COLORS.length)];
    await db.createCuris({ id, creatorId: req.userId, creatorName: user.name, imageFile, color1, color2, musicTrack, country });
    res.json({ ok: true, id });
}));

app.get('/api/curis/rate-state', requireUser, asyncRoute(async (req, res) => {
    const userId = req.userId;
    const [poolRows, total, rated, ds] = await Promise.all([
        db.listRatingPool(userId),
        db.countApprovedExcluding(userId),
        db.countRatingsByUser(userId),
        db.ensureDailyStars(userId, todayStr())
    ]);
    const cap = ds.extended ? CONFIG.starsCapExtended : CONFIG.starsCapBase;
    res.json({ pool: poolRows.map(c => toPublicCuris(c, userId)), total, rated, starsToday: { total: ds.total, cap } });
}));

app.post('/api/ratings', requireUser, asyncRoute(async (req, res) => {
    const userId = req.userId;
    const curisId = req.body.curisId;
    const stars = Number(req.body.stars);
    if (!curisId || !(stars >= 0 && stars <= 5)) {
        return res.status(400).json({ ok: false, error: 'Datos inválidos.' });
    }
    try {
        const result = await db.submitRating(userId, curisId, stars, todayStr(), CONFIG.starsCapBase, CONFIG.starsCapExtended);
        res.json({ ok: true, dailyTotal: result.dailyTotal, cap: result.cap });
    } catch (e) {
        if (e instanceof db.RatingError) return res.status(409).json({ ok: false, code: e.code, error: e.message, ...e.data });
        throw e;
    }
}));

app.post('/api/ratings/extend', limiterAuth, requireUser, asyncRoute(async (req, res) => {
    const ds = await db.setDailyStarsExtended(req.userId, todayStr());
    res.json({ ok: true, starsToday: { total: ds.total, cap: CONFIG.starsCapExtended } });
}));

app.get('/api/curis/ranking', asyncRoute(async (req, res) => {
    // Endpoint público: se lee la sesión solo si viene, para marcar "mine".
    const session = verifySession(parseCookies(req).user_session);
    const viewerId = session && session.userId;
    res.json((await db.listApprovedForRanking()).map(c => toPublicCuris(c, viewerId)));
}));

app.get('/api/curis/mine', requireUser, asyncRoute(async (req, res) => {
    const [curis, ratedCount] = await Promise.all([
        db.listByCreator(req.userId),
        db.countRatingsByUser(req.userId)
    ]);
    res.json({ curis: curis.map(c => toPublicCuris(c, req.userId)), ratedCount });
}));

app.post('/api/account/delete-curis', requireUser, asyncRoute(async (req, res) => {
    const rows = await db.deleteCurisByCreator(req.userId);
    await Promise.all(rows.map(r => storage.deleteFiles(r.image_file)));
    res.json({ ok: true, deleted: rows.length });
}));

// ---------------------------- admin ----------------------------

app.post('/api/admin/login', limiterAdminLogin, (req, res) => {
    const password = req.body.password || '';
    if (!verifyPassword(password, ADMIN_PASSWORD_HASH)) {
        return res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
    }
    setCookie(res, 'admin_session', signSession({ admin: true }, ADMIN_SESSION_TTL_MS), ADMIN_SESSION_TTL_MS / 1000);
    res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
    clearCookie(res, 'admin_session');
    res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
    const session = verifySession(parseCookies(req).admin_session);
    res.json({ authed: !!(session && session.admin) });
});

app.get('/api/admin/queue', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [items, counts] = await Promise.all([db.listByStatus(status), db.statusCounts()]);
    res.json({ items: items.map(c => toPublicCuris(c)), counts });
}));

app.post('/api/admin/curis/:id/status', requireAdmin, asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Estado inválido.' });
    }
    const c = await db.getCurisById(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No encontrado.' });
    await db.setCurisStatus(c.id, status);
    // Al rechazar, la imagen no se muestra más en ningún lado -> se borra de
    // R2 para no gastar espacio del bucket. El registro queda (status
    // 'rejected', con su degradado de color como fallback visual). Borrar el
    // objeto de R2 es lo importante; limpiar la key en la base es best-effort
    // (si falla, queda una key colgada pero el espacio ya se liberó).
    if (status === 'rejected' && c.image_file) {
        await storage.deleteFiles(c.image_file);
        try {
            // Cadena vacía, no null: la columna image_file es NOT NULL. Tanto
            // r2.publicUrl() como el frontend tratan '' como "sin imagen" y
            // caen al degradado de color.
            await db.setCurisImage(c.id, '');
        } catch (e) {
            console.error('No se pudo limpiar image_file tras rechazar', c.id, e);
        }
    }
    res.json({ ok: true });
}));

// Borrado masivo -- borra primero los objetos de R2 (best-effort: un fallo
// suelto no aborta la operación) y después las filas de curis + sus ratings.
async function purgeCuris(statuses) {
    const rows = await db.listCurisForPurge(statuses);
    await Promise.all(rows.map(r =>
        storage.deleteFiles(r.image_file).catch(e => console.error('R2 delete fallo', r.id, e))
    ));
    return db.purgeCurisByIds(rows.map(r => r.id));
}

// "Vaciar rechazados": limpia la pestaña Rechazados del panel. Las imágenes
// de esos Curis normalmente ya se borraron al rechazarlos; esto saca las
// filas (y cubre cualquier imagen que haya quedado colgada de antes de que
// el rechazo borrara en R2).
app.post('/api/admin/purge-rejected', requireAdmin, asyncRoute(async (req, res) => {
    const deleted = await purgeCuris(['rejected']);
    res.json({ ok: true, deleted });
}));

// "Borrar TODOS los Curis": pendientes + aprobados + rechazados, sus
// imágenes y sus calificaciones. NO toca las cuentas de usuario. El frontend
// pide 3 confirmaciones antes de llamar acá.
app.post('/api/admin/purge-all-curis', requireAdmin, asyncRoute(async (req, res) => {
    const deleted = await purgeCuris(['pending', 'approved', 'rejected']);
    res.json({ ok: true, deleted });
}));

app.listen(PORT, () => {
    console.log(`CurisFandom corriendo en http://localhost:${PORT}`);
    console.log(`Base de datos: Supabase (${require('./supabaseRest').SUPABASE_URL})`);
    console.log(GOOGLE_CLIENT_ID ? '✓ Login de Google real configurado.' : '⚠ Login de Google simulado (modo desarrollo).');
});
