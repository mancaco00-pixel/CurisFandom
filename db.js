'use strict';

/*
 * Capa de base de datos -- Postgres en Supabase, hablado por su API REST
 * (PostgREST) vía supabaseRest.js. Reemplaza a la versión anterior sobre
 * SQLite local (better-sqlite3); server.js sigue llamando a las mismas
 * funciones con las mismas firmas, pero ahora todas son async (better-
 * sqlite3 era síncrono, hablarle a Supabase por HTTP no puede serlo).
 *
 * El esquema (tablas + las funciones submit_rating/delete_curis_by_creator
 * que dan atomicidad del lado de la base) vive en Supabase, no acá -- ver
 * el script SQL que se corrió una vez en el SQL Editor del proyecto
 * (handoff.md tiene el detalle de esa migración).
 */

const { request, qs } = require('./supabaseRest');

class RatingError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data || {};
    }
}

async function upsertUser(id, name) {
    await request('/users' + qs({ on_conflict: 'id' }), {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ id, name })
    });
}

async function getUserById(id) {
    const rows = await request('/users' + qs({ id: `eq.${id}`, select: '*' }));
    return rows[0] || null;
}

async function setUserName(id, name) {
    await request('/users' + qs({ id: `eq.${id}` }), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ name })
    });
}

async function createCuris({ id, creatorId, creatorName, imageFile, color1, color2, musicTrack, country }) {
    await request('/curis', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
            id, creator_id: creatorId, creator_name: creatorName, image_file: imageFile,
            color1, color2, status: 'pending', avg: 0, count: 0, music_track: musicTrack || null,
            country: country || null
        })
    });
}

async function getCurisById(id) {
    const rows = await request('/curis' + qs({ id: `eq.${id}`, select: '*' }));
    return rows[0] || null;
}

// Pool para calificar: aprobados, que no sean del propio usuario, y que
// todavía no haya calificado. El "NOT IN (calificados)" de la versión
// SQLite se resuelve acá con dos pedidos + un filtro en JS (más simple y
// robusto que armar un filtro "not.in" de PostgREST a mano, y el volumen
// de datos de este proyecto no lo justifica).
async function listRatingPool(userId) {
    const [approved, rated] = await Promise.all([
        request('/curis' + qs({ status: 'eq.approved', creator_id: `neq.${userId}`, select: '*', order: 'published_at.asc' })),
        request('/ratings' + qs({ user_id: `eq.${userId}`, select: 'curis_id' }))
    ]);
    const ratedIds = new Set(rated.map(r => r.curis_id));
    return approved.filter(c => !ratedIds.has(c.id));
}

async function countApprovedExcluding(userId) {
    const rows = await request('/curis' + qs({ status: 'eq.approved', creator_id: `neq.${userId}`, select: 'id' }));
    return rows.length;
}

async function countRatingsByUser(userId) {
    const rows = await request('/ratings' + qs({ user_id: `eq.${userId}`, select: 'curis_id' }));
    return rows.length;
}

async function listApprovedForRanking() {
    return request('/curis' + qs({ status: 'eq.approved', select: '*', order: 'avg.desc,count.desc' }));
}

async function listByCreator(creatorId) {
    return request('/curis' + qs({ creator_id: `eq.${creatorId}`, select: '*', order: 'published_at.desc' }));
}

async function listByStatus(status) {
    return request('/curis' + qs({ status: `eq.${status}`, select: '*', order: 'published_at.desc' }));
}

async function statusCounts() {
    const rows = await request('/curis' + qs({ select: 'status' }));
    const out = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach(r => { if (out[r.status] !== undefined) out[r.status]++; });
    return out;
}

async function setCurisStatus(id, status) {
    await request('/curis' + qs({ id: `eq.${id}` }), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status })
    });
}

// Usado al rechazar un Curis: la imagen ya no se muestra en ningún lado, se
// borra de R2 (server.js) y acá se limpia la referencia para no dejar una
// key colgada apuntando a un objeto que ya no existe. Se pasa '' (no null):
// la columna image_file es NOT NULL.
async function setCurisImage(id, imageFile) {
    await request('/curis' + qs({ id: `eq.${id}` }), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ image_file: imageFile })
    });
}

async function getDailyStars(userId, date) {
    const rows = await request('/daily_stars' + qs({ user_id: `eq.${userId}`, date: `eq.${date}`, select: '*' }));
    return rows[0] || null;
}

async function ensureDailyStars(userId, date) {
    let row = await getDailyStars(userId, date);
    if (!row) {
        await request('/daily_stars' + qs({ on_conflict: 'user_id,date' }), {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify({ user_id: userId, date, total: 0, extended: false })
        });
        row = await getDailyStars(userId, date);
    }
    return row;
}

async function setDailyStarsExtended(userId, date) {
    await ensureDailyStars(userId, date);
    await request('/daily_stars' + qs({ user_id: `eq.${userId}`, date: `eq.${date}` }), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ extended: true })
    });
    return getDailyStars(userId, date);
}

// Calificar sigue siendo atómico -- ya no vía db.transaction() de
// better-sqlite3, sino delegado a la función submit_rating() de Postgres
// (ejecuta como una sola transacción del lado de la base, con "for update"
// para las filas en juego). Ver el SQL de esa función para el detalle de
// validación (Curis aprobado / no propio / no calificado antes / no supera
// el límite diario).
async function submitRating(userId, curisId, stars, today, capBase, capExtended) {
    const result = await request('/rpc/submit_rating', {
        method: 'POST',
        body: JSON.stringify({
            p_user_id: userId,
            p_curis_id: curisId,
            p_stars: stars,
            p_today: today,
            p_cap_base: capBase,
            p_cap_extended: capExtended
        })
    });
    if (result.error_code) throw new RatingError(result.error_code, result.error_message, { cap: result.cap });
    return { dailyTotal: result.dailyTotal, cap: result.cap };
}

// Usado por "Eliminar cuenta": borra los Curis del usuario (y las
// calificaciones que recibieron) de forma atómica del lado de la base vía
// delete_curis_by_creator(), que además devuelve las filas borradas para
// poder limpiar sus archivos en Cloudflare R2 desde acá.
async function deleteCurisByCreator(creatorId) {
    return request('/rpc/delete_curis_by_creator', {
        method: 'POST',
        body: JSON.stringify({ p_creator_id: creatorId })
    });
}

module.exports = {
    RatingError,
    upsertUser,
    getUserById,
    setUserName,
    createCuris,
    getCurisById,
    listRatingPool,
    countApprovedExcluding,
    countRatingsByUser,
    listApprovedForRanking,
    listByCreator,
    listByStatus,
    statusCounts,
    setCurisStatus,
    setCurisImage,
    getDailyStars,
    ensureDailyStars,
    setDailyStarsExtended,
    submitRating,
    deleteCurisByCreator
};
