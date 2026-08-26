'use strict';

/*
 * Helper mínimo para hablar con la API REST de Supabase (PostgREST) usando
 * fetch nativo -- sin el paquete @supabase/supabase-js, que en su versión
 * actual exige Node 22+ (esta máquina tiene Node 18) y falla al crear el
 * cliente por el WebSocket de Realtime, algo que este proyecto ni usa.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. Ver handoff.md.');
}

const REST_URL = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';

function authHeaders(extra) {
    return Object.assign({
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
    }, extra || {});
}

// Arma un query string a partir de filtros/params estilo PostgREST, ej:
// qs({ status: 'eq.approved', select: '*', order: 'avg.desc,count.desc' })
function qs(params) {
    const parts = [];
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== undefined) parts.push(`${k}=${encodeURIComponent(v)}`);
    });
    return parts.length ? '?' + parts.join('&') : '';
}

async function request(path, options) {
    const opts = options || {};
    const res = await fetch(REST_URL + path, {
        method: opts.method || 'GET',
        headers: authHeaders(opts.headers),
        body: opts.body
    });
    const text = await res.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!res.ok) {
        const err = new Error((data && (data.message || data.error_message)) || `Error de Supabase (${res.status}).`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

module.exports = { request, qs, SUPABASE_URL };
