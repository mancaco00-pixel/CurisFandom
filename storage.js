'use strict';

/*
 * Guarda las imágenes de los Curis en Supabase Storage (bucket público
 * "curis-images" por defecto) en vez de como archivos locales en /web --
 * reemplaza a la versión anterior sobre el sistema de archivos.
 *
 * Misma convención de antes, ahora como prefijos dentro del bucket en vez
 * de carpetas en disco:
 * - uploads/<id>.<ext>   -- copia canónica, existe siempre mientras el
 *   Curis exista, sin importar su estado (pending/approved/rejected). Es
 *   la que se sirve siempre en el sitio (toPublicCuris en server.js).
 * - aprobados/<id>.<ext> -- copia que existe SOLO mientras el Curis está
 *   aprobado (se crea al aprobar, se borra al pasar a otro estado). Sigue
 *   siendo la "carpeta de prueba" para verificar a simple vista desde el
 *   dashboard de Supabase (Storage) que la aprobación se sincronizó bien.
 */

const { SUPABASE_URL } = require('./supabaseRest');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'curis-images';
const STORAGE_URL = SUPABASE_URL.replace(/\/$/, '') + '/storage/v1';

function authHeaders(extra) {
    return Object.assign({
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
    }, extra || {});
}

const EXT_FROM_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
};

async function storageRequest(path, options) {
    const opts = options || {};
    const res = await fetch(STORAGE_URL + path, {
        method: opts.method || 'GET',
        headers: authHeaders(opts.headers),
        body: opts.body
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Error de Supabase Storage (${res.status}): ${text || res.statusText}`);
    }
    return res;
}

// Guarda la copia canónica (uploads/<id>.<ext>) y devuelve la "key" interna
// del bucket -- eso es lo que se guarda en curis.image_file, no la URL
// completa (publicUrl() arma la URL a partir de la key cuando hace falta
// mostrarla, ver toPublicCuris() en server.js).
async function saveIncoming(id, dataUrl) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
    if (!match) throw new Error('Formato de imagen inválido.');
    const ext = EXT_FROM_MIME[match[1].toLowerCase()] || '.jpg';
    const buffer = Buffer.from(match[2], 'base64');
    const key = 'uploads/' + id + ext;
    await storageRequest('/object/' + BUCKET + '/' + key, {
        method: 'POST',
        headers: { 'Content-Type': match[1] },
        body: buffer
    });
    return key;
}

function publicUrl(key) {
    if (!key) return null;
    return `${STORAGE_URL}/object/public/${BUCKET}/${key}`;
}

// Mantiene sincronizada la copia en aprobados/ según el estado actual.
async function syncApprovedCopy(imageFile, isApproved) {
    const fileName = imageFile.split('/').pop();
    const source = 'uploads/' + fileName;
    const target = 'aprobados/' + fileName;
    if (isApproved) {
        await storageRequest('/object/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucketId: BUCKET, sourceKey: source, destinationKey: target })
        });
    } else {
        await storageRequest('/object/' + BUCKET, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefixes: [target] })
        });
    }
}

async function deleteFiles(imageFile) {
    const fileName = imageFile.split('/').pop();
    await storageRequest('/object/' + BUCKET, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: ['uploads/' + fileName, 'aprobados/' + fileName] })
    });
}

module.exports = { saveIncoming, syncApprovedCopy, deleteFiles, publicUrl };
