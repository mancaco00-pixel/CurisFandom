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
 * Variables de entorno: ADMIN_PASSWORD, SESSION_SECRET, GOOGLE_CLIENT_ID
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
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

const CONFIG = {
    adSeconds: 30,
    extraAdChance: 0.10,
    // Bajado de 50/120 para que el límite diario se sienta antes: 15
    // alcanza para calificar al menos 3 Curis con la nota máxima (5.0 x 3 =
    // 15) antes de tener que ver el anuncio de 30s que sube el cap a 40.
    starsCapBase: 15,
    starsCapExtended: 40,
    googleClientId: GOOGLE_CLIENT_ID
};

const CURIS_COLORS = [['#ff3d7f', '#ff7a18'], ['#6c5ce7', '#a29bfe'], ['#00d4ff', '#6c5ce7'], ['#00b894', '#00d4ff'], ['#fdcb6e', '#e17055']];

// País de origen del Curis -- mismos códigos que el <select> de web/subir.html.
// Whitelist explícita (no solo forma) para no guardar cualquier string.
const LATAM_COUNTRIES = new Set(['ar', 'bo', 'br', 'cl', 'co', 'cr', 'cu', 'ec', 'sv', 'gt', 'hn', 'mx', 'ni', 'pa', 'py', 'pe', 'do', 'uy', 've']);

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(WEB_DIR));

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
function setCookie(res, name, value, maxAgeSeconds) {
    res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`);
}
function clearCookie(res, name) {
    res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
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

function toPublicCuris(c) {
    return {
        id: c.id,
        creator: c.creator_name,
        creatorId: c.creator_id,
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
app.post('/api/auth/dev-login', asyncRoute(async (req, res) => {
    if (GOOGLE_CLIENT_ID) return res.status(404).json({ ok: false, error: 'Login de desarrollo deshabilitado: ya hay login de Google real configurado.' });
    const userId = 'dev_' + crypto.randomBytes(8).toString('hex');
    await db.upsertUser(userId, null);
    setCookie(res, 'user_session', signSession({ userId }, USER_SESSION_TTL_MS), USER_SESSION_TTL_MS / 1000);
    res.json({ ok: true, userId });
}));

// Login real de Google: el frontend manda el "credential" (un JWT) que le
// dio Google Identity Services. Se verifica la firma/audiencia/vencimiento
// contra los servidores de Google -- recién ahí se confía en el email/
// nombre/id que dice tener.
app.post('/api/auth/google', asyncRoute(async (req, res) => {
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
    res.json({ authenticated: true, user: { id: user.id, name: user.name } });
}));

app.post('/api/auth/set-name', requireUser, asyncRoute(async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Falta el nombre.' });
    await db.setUserName(req.userId, name);
    res.json({ ok: true });
}));

// ---------------------------- rutas de datos (requieren sesión) ----------------------------

app.post('/api/curis', requireUser, asyncRoute(async (req, res) => {
    const user = await db.getUserById(req.userId);
    const imageData = req.body.imageData;
    if (!user || !user.name || !imageData) return res.status(400).json({ ok: false, error: 'Datos inválidos.' });

    // musicTrack es solo el "id" de una canción de web/music-library.js, no
    // una URL ni un archivo -- el frontend resuelve ese id a un src real al
    // reproducir. Acá solo se valida forma (evitar basura), nunca se
    // interpreta como ruta de archivo.
    let musicTrack = req.body.musicTrack;
    if (typeof musicTrack !== 'string' || !/^[a-z0-9-]{1,60}$/.test(musicTrack)) musicTrack = null;

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
    res.json({ pool: poolRows.map(toPublicCuris), total, rated, starsToday: { total: ds.total, cap } });
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

app.post('/api/ratings/extend', requireUser, asyncRoute(async (req, res) => {
    const ds = await db.setDailyStarsExtended(req.userId, todayStr());
    res.json({ ok: true, starsToday: { total: ds.total, cap: CONFIG.starsCapExtended } });
}));

app.get('/api/curis/ranking', asyncRoute(async (req, res) => {
    res.json((await db.listApprovedForRanking()).map(toPublicCuris));
}));

app.get('/api/curis/mine', requireUser, asyncRoute(async (req, res) => {
    const [curis, ratedCount] = await Promise.all([
        db.listByCreator(req.userId),
        db.countRatingsByUser(req.userId)
    ]);
    res.json({ curis: curis.map(toPublicCuris), ratedCount });
}));

app.post('/api/account/delete-curis', requireUser, asyncRoute(async (req, res) => {
    const rows = await db.deleteCurisByCreator(req.userId);
    await Promise.all(rows.map(r => storage.deleteFiles(r.image_file)));
    res.json({ ok: true, deleted: rows.length });
}));

// ---------------------------- admin ----------------------------

app.post('/api/admin/login', (req, res) => {
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
    res.json({ items: items.map(toPublicCuris), counts });
}));

app.post('/api/admin/curis/:id/status', requireAdmin, asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Estado inválido.' });
    }
    const c = await db.getCurisById(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No encontrado.' });
    await db.setCurisStatus(c.id, status);
    await storage.syncApprovedCopy(c.image_file, status === 'approved');
    res.json({ ok: true });
}));

app.listen(PORT, () => {
    console.log(`CurisFandom corriendo en http://localhost:${PORT}`);
    console.log(`Base de datos: Supabase (${require('./supabaseRest').SUPABASE_URL})`);
    console.log(GOOGLE_CLIENT_ID ? '✓ Login de Google real configurado.' : '⚠ Login de Google simulado (modo desarrollo).');
});
