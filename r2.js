'use strict';

/*
 * Capa de acceso a Cloudflare R2 (API compatible con S3) para los blobs del
 * proyecto: las imágenes de los Curis y los .mp3 de la música. Los datos
 * (usuarios, Curis como metadata, ratings) siguen en Postgres de Supabase
 * (ver db.js / supabaseRest.js) -- R2 guarda solo archivos.
 *
 * Se firma con SigV4 vía aws4fetch (paquete mínimo, sin dependencias
 * propias) en vez del SDK de AWS, que es enorme para lo poco que se usa acá
 * (PUT / DELETE de un objeto).
 *
 * En curis.image_file se guarda solo la "key" dentro del bucket
 * (ej. uploads/c_ab12.webp), nunca la URL completa: publicUrl() la arma a
 * partir de R2_PUBLIC_BASE_URL cuando hay que mostrarla (toPublicCuris en
 * server.js).
 */

// aws4fetch firma con la Web Crypto API global (globalThis.crypto). Node la
// expone como global recién en v20+; en v18 hay que asignarla a mano desde el
// módulo 'crypto' o aws4fetch tira "ReferenceError: crypto is not defined" al
// firmar. En Node 20+ esto es un no-op.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

const { AwsClient } = require('aws4fetch');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET || !PUBLIC_BASE_URL) {
    throw new Error(
        'Faltan variables de entorno de Cloudflare R2 (R2_ACCOUNT_ID, ' +
        'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL). ' +
        'Ver DEPLOY.md.'
    );
}

const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

const client = new AwsClient({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: 'auto',
    service: 's3'
});

function objectUrl(key) {
    return `${ENDPOINT}/${BUCKET}/${encodeURI(key)}`;
}

async function putObject(key, buffer, contentType) {
    const res = await client.fetch(objectUrl(key), {
        method: 'PUT',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body: buffer
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Error al subir a R2 (${res.status}): ${text || res.statusText}`);
    }
    return key;
}

async function deleteObject(key) {
    const res = await client.fetch(objectUrl(key), { method: 'DELETE' });
    // S3/R2 devuelve 204 aunque el objeto no exista -- solo un 4xx/5xx real
    // es un problema.
    if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        throw new Error(`Error al borrar en R2 (${res.status}): ${text || res.statusText}`);
    }
}

function publicUrl(key) {
    if (!key) return null;
    return `${PUBLIC_BASE_URL}/${key}`;
}

module.exports = { putObject, deleteObject, publicUrl };
