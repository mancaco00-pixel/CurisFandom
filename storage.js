'use strict';

/*
 * Guarda las imágenes de los Curis en Cloudflare R2 (ver r2.js) en vez de
 * en Supabase Storage -- reemplaza a la versión anterior. Los datos siguen
 * en Postgres de Supabase.
 *
 * Una sola copia por imagen: uploads/<id>.webp, existe mientras el Curis
 * exista sin importar su estado (pending/approved/rejected). Es la que se
 * sirve siempre en el sitio (toPublicCuris en server.js). Ya no se hace la
 * copia extra en aprobados/ (el estado vive en la base, y duplicar los
 * archivos gastaba el doble de espacio del bucket).
 *
 * Toda imagen que entra se recomprime a WebP con sharp: se redimensiona a
 * 900px máx, se recomprime con calidad 78 y se descarta la metadata (EXIF).
 * Así el peso no depende del navegador de quien sube y los 10 GB del plan
 * free de R2 rinden mucho más.
 */

const sharp = require('sharp');
const r2 = require('./r2');

const MAX_DIM = 900;
const WEBP_QUALITY = 78;

// Recibe el data URL que manda el navegador (cualquier image/*), lo
// recomprime y sube la copia canónica a R2. Devuelve la "key" del objeto
// (uploads/<id>.webp) -- eso es lo que se guarda en curis.image_file, no la
// URL completa (publicUrl() la arma cuando hace falta mostrarla).
async function saveIncoming(id, dataUrl) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
    if (!match) throw new Error('Formato de imagen inválido.');

    const input = Buffer.from(match[2], 'base64');
    // Tope de tamaño del bitmap descomprimido: frena "decompression bombs"
    // (una imagen chica en bytes que descomprime a cientos de megapíxeles y
    // hace que libvips consuma toda la memoria/CPU). 40 MP alcanza de sobra
    // para cualquier foto real; lo que se sube se reescala a 900 px igual.
    let output;
    try {
        output = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' })
            .rotate() // respeta la orientación EXIF antes de descartarla
            .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer();
    } catch (e) {
        throw new Error('No se pudo procesar la imagen.');
    }

    const key = 'uploads/' + id + '.webp';
    await r2.putObject(key, output, 'image/webp');
    return key;
}

function publicUrl(key) {
    return r2.publicUrl(key);
}

async function deleteFiles(imageFile) {
    if (!imageFile) return;
    await r2.deleteObject(imageFile);
}

module.exports = { saveIncoming, deleteFiles, publicUrl };
