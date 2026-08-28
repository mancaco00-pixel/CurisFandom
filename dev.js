#!/usr/bin/env node
'use strict';

/*
 * Arranque para desarrollo local: carga las variables de
 * .env.production.local en process.env y después levanta el servidor
 * normal (server.js). Así no hay que pegar 8 variables en la línea de
 * comandos cada vez.
 *
 *   npm run dev
 *
 * NO se usa en producción (Render carga las variables por su dashboard y
 * corre `npm start`). No agrega ninguna dependencia: es un parser mínimo
 * de KEY=VALUE, no dotenv.
 *
 * Las variables ya presentes en el entorno tienen prioridad, así que
 * `PORT=9000 npm run dev` sigue funcionando.
 */

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env.production.local');

let loaded = 0;
const skipped = [];
try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!key || value === '') continue;
        if (process.env[key] === undefined || process.env[key] === '') {
            process.env[key] = value;
            loaded++;
        } else if (process.env[key] !== value) {
            skipped.push(key);
        }
    }
    console.log(`✓ ${loaded} variables cargadas de .env.production.local`);
    if (skipped.length) {
        console.warn(`⚠ ${skipped.length} ya venían del entorno y NO se pisaron: ${skipped.join(', ')}`);
        console.warn('  (si alguna está mal, abrí una terminal nueva o "unset" esas variables antes de "npm run dev")');
    }
} catch (e) {
    if (e.code === 'ENOENT') {
        console.warn('⚠ No se encontró .env.production.local — arrancando solo con las variables del entorno.');
    } else {
        throw e;
    }
}

// Chequeo rápido de las que server.js necesita sí o sí, con un mensaje
// claro antes de que tire el throw genérico de supabaseRest.js.
const REQUIRED = ['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`\n✗ Faltan variables: ${missing.join(', ')}`);
    console.error('  Completalas en .env.production.local y volvé a correr "npm run dev".\n');
    process.exit(1);
}

require('./server.js');
