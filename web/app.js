(function () {
    'use strict';

    const API = '/api';
    // El perfil (bio/avatar) sigue guardado local por usuario -- la
    // identidad y el nombre de cuenta ya son reales del lado del servidor
    // (cookie de sesión), esto es solo "decoración" que todavía no tiene
    // dónde vivir en el servidor.
    const PROFILE_KEY = 'curisfandom_profile_v1';

    const LIMITS = {
        nameMin: 3,
        nameMax: 20,
        bioMax: 150,
        maxImageSize: 4 * 1024 * 1024
    };

    // XP que da cada calificación completada -- ver rankForXp() para los
    // rangos que se arman con este XP acumulado.
    const RATING_XP = 10;

    // Link real de Patreon -- página "Curis Fandom" (verificada activa y
    // pública el 2026-08-27). El botón de index.html abre esta URL.
    const PATREON_URL = 'https://www.patreon.com/cw/CurisFandom355';

    // Config de negocio que vive en el servidor. Valores de arranque por
    // si /api/config todavía no respondió -- se reemplazan apenas carga
    // la página, ver loadConfig().
    let CONFIG = {
        adSeconds: 30,
        extraAdChance: 0.10,
        starsCapBase: 15,
        starsCapExtended: 40,
        googleClientId: null,
        devLogin: false
    };

    // state.user: null (sin sesión) o { id, name, registeredAt, bio, avatarData }.
    // La fuente de verdad de id/name/registeredAt es el servidor (cookie de
    // sesión, ver refreshAuthState()); bio/avatarData siguen siendo locales.
    let state = { user: null };
    let currentRating = 1;
    let adInterval = null;
    let currentAdminFilter = 'pending';
    let ratePool = [];
    let starsToday = { total: 0, cap: CONFIG.starsCapBase };
    let lastRankingCuris = [];
    let googleInitialized = false;
    let dustClickCount = 0;
    let dustClickResetTimer = null;
    let dustRevertTimer = null;

    function loadProfileExtras(userId) {
        try {
            const all = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
            return all[userId] || { bio: '', avatarData: null };
        } catch (e) { return { bio: '', avatarData: null }; }
    }
    function saveProfileExtras(userId, extras) {
        try {
            const all = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
            all[userId] = extras;
            localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
        } catch (e) {}
    }

    function api(path, options) {
        const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
        return fetch(API + path, opts).then(async (r) => {
            let data = null;
            try { data = await r.json(); } catch (e) {}
            if (!r.ok) {
                const err = new Error((data && data.error) || 'Error de red.');
                err.code = data && data.code;
                err.data = data;
                throw err;
            }
            return data;
        });
    }

    function loadConfig() {
        return api('/config').then(cfg => { CONFIG = cfg; }).catch(() => {
            console.warn('No se pudo cargar la configuración del servidor, usando valores por defecto. ¿Está corriendo "node server.js"?');
        });
    }

    // Le pregunta al servidor quién está logueado (según la cookie de
    // sesión) y arma state.user con eso + los datos locales de perfil.
    function refreshAuthState() {
        return api('/auth/me').then(res => {
            if (res.authenticated) {
                const extras = loadProfileExtras(res.user.id);
                state.user = {
                    id: res.user.id,
                    name: res.user.name,
                    hasPassword: !!res.user.hasPassword,
                    registeredAt: res.user.registeredAt,
                    bio: extras.bio,
                    avatarData: extras.avatarData
                };
            } else {
                state.user = null;
            }
        }).catch(() => { state.user = null; });
    }

    // Redimensiona/comprime una imagen antes de mandarla al servidor.
    function fileToCompressedDataURL(file, maxDim, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = (e) => {
                const img = new Image();
                img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxDim || height > maxDim) {
                        if (width >= height) {
                            height = Math.round(height * (maxDim / width));
                            width = maxDim;
                        } else {
                            width = Math.round(width * (maxDim / height));
                            height = maxDim;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    // WebP: ~25-35% menos peso que JPEG a calidad equivalente.
                    // El servidor igual recomprime con sharp, pero esto ya
                    // achica el payload del upload. Fallback a JPEG si el
                    // navegador (muy viejo) no soporta encodear WebP.
                    let out = canvas.toDataURL('image/webp', quality);
                    if (out.indexOf('data:image/webp') !== 0) {
                        out = canvas.toDataURL('image/jpeg', quality);
                    }
                    resolve(out);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    const $ = (id) => document.getElementById(id);
    function openModal(id) {
        if (!$(id)) return;
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
        $(id).classList.add('active');
        if ($('modalOverlay')) $('modalOverlay').classList.add('active');
        // El botón de Google del modal de login está oculto (display:none)
        // hasta que el modal se abre, así que recién ahí tiene un ancho
        // real para renderizar el botón oficial de Google encima (ver
        // renderRealGoogleButton).
        if (id === 'loginModal' && CONFIG.googleClientId && !CONFIG.devLogin) renderRealGoogleButton($('modalGoogleBtn'));
    }
    function closeAll() {
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
        if ($('modalOverlay')) $('modalOverlay').classList.remove('active');
        if (adInterval) { clearInterval(adInterval); adInterval = null; }
    }
    function closeOnOverlay(e) {
        if (e.target.id !== 'modalOverlay') return;
        if (adInterval) return;
        closeAll();
    }

    function isAuthenticated() { return !!state.user; }
    function isFullyRegistered() { return state.user && !!state.user.name; }
    // El usuario ya eligió nombre pero todavía no definió su contraseña
    // (login de Google + contraseña propia; la contraseña se crea una vez).
    function needsPassword() { return isFullyRegistered() && !state.user.hasPassword; }

    // Encadena los pasos de registro: primero el nombre, después la
    // contraseña. Se llama al loguearse y al cargar cualquier página, por si
    // el registro quedó a medias.
    function promptRegistrationStep() {
        if (!isAuthenticated()) return;
        if (!isFullyRegistered()) { setTimeout(() => openModal('chooseNameModal'), 200); return; }
        if (needsPassword()) setTimeout(() => openModal('choosePasswordModal'), 200);
    }

    function savePassword() {
        const input = $('passwordInput');
        if (!input) return;
        const pw = input.value || '';
        if (pw.length < 8 || pw.length > 20) {
            alert('La contraseña debe tener entre 8 y 20 caracteres.');
            input.focus();
            return;
        }
        api('/auth/set-password', { method: 'POST', body: JSON.stringify({ password: pw }) })
            .then(() => refreshAuthState())
            .then(() => {
                input.value = '';
                refreshUserUI();
                closeAll();
                rerunPageInit(document.body.dataset.page);
            })
            .catch(err => alert('No se pudo guardar la contraseña: ' + err.message));
    }

    function formatName(name) {
        if (!name) return '';
        if (name.length > 15) return name.slice(0, 12) + '...';
        return name;
    }

    function refreshUserUI() {
        const nameEl = $('userName');
        const btn = $('googleBtn');
        const menu = $('userMenu');
        if (!nameEl) return;

        const av = $('userAvatar');
        if (av && state.user && state.user.avatarData) {
            av.innerHTML = `<img src="${state.user.avatarData}" alt="">`;
        } else if (av) {
            av.innerHTML = '👤';
        }

        if (!isAuthenticated()) {
            nameEl.textContent = 'Invitado';
            nameEl.classList.remove('authenticated');
            if (btn) btn.style.display = 'flex';
            if (menu) menu.style.display = 'none';
        } else if (!isFullyRegistered()) {
            nameEl.textContent = 'Configurando...';
            nameEl.classList.add('authenticated');
            if (btn) btn.style.display = 'none';
            if (menu) menu.style.display = 'none';
        } else {
            nameEl.textContent = formatName(state.user.name);
            nameEl.title = state.user.name;
            nameEl.classList.add('authenticated');
            if (btn) btn.style.display = 'none';
            if (menu) menu.style.display = 'none';
        }
    }

    function rerunPageInit(page) {
        if (page === 'upload') initUploadPage();
        else if (page === 'rate') initRatePage();
        else if (page === 'profile') initProfilePage();
    }

    // Arranca Google Identity Services una sola vez. Devuelve false si el
    // script de Google (accounts.google.com/gsi/client) todavía no cargó.
    function ensureGoogleInitialized(callback) {
        if (googleInitialized) return true;
        if (!window.google || !window.google.accounts || !window.google.accounts.id) return false;
        window.google.accounts.id.initialize({ client_id: CONFIG.googleClientId, callback });
        googleInitialized = true;
        return true;
    }

    function onGoogleCredential(response) {
        api('/auth/google', { method: 'POST', body: JSON.stringify({ credential: response.credential }) })
            .then(() => refreshAuthState())
            .then(() => {
                refreshUserUI();
                closeAll();
                if (!isFullyRegistered() || needsPassword()) {
                    promptRegistrationStep();
                } else {
                    rerunPageInit(document.body.dataset.page);
                }
            })
            .catch(err => alert('No se pudo iniciar sesión con Google: ' + err.message));
    }

    // El prompt() de Google (One Tap) puede quedar suprimido en silencio por
    // el navegador sin avisar -- confirmado en pruebas reales contra un
    // Client ID real. Por eso, apenas Google Identity Services está listo,
    // se superpone el botón oficial de Google (invisible, mismo tamaño que
    // el nuestro) encima de nuestro botón con estilo propio: el usuario ve
    // nuestro diseño pero el clic cae sobre el botón real de Google, que sí
    // abre el selector de cuenta de forma confiable.
    function renderRealGoogleButton(btn) {
        if (!btn || !window.google || !window.google.accounts || !window.google.accounts.id) return;
        const width = btn.offsetWidth;
        if (!width) return; // todavía no está visible (ej. modal cerrado); se reintenta cuando se muestre
        if (btn.dataset.googleRenderedWidth === String(width)) return;
        let overlay = btn.querySelector('.google-btn-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'google-btn-overlay';
            if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
            btn.style.overflow = 'hidden';
            btn.appendChild(overlay);
        }
        overlay.innerHTML = '';
        try {
            window.google.accounts.id.renderButton(overlay, { type: 'standard', theme: 'outline', size: 'large', width });
            btn.dataset.googleRenderedWidth = String(width);
        } catch (e) {
            console.warn('No se pudo renderizar el botón oficial de Google, queda como respaldo el prompt().', e);
        }
    }

    function setupRealGoogleButtons(attempt) {
        if (!CONFIG.googleClientId || CONFIG.devLogin) return;
        if (!ensureGoogleInitialized(onGoogleCredential)) {
            if ((attempt || 0) < 25) setTimeout(() => setupRealGoogleButtons((attempt || 0) + 1), 200);
            return;
        }
        renderRealGoogleButton($('googleBtn'));
        renderRealGoogleButton($('modalGoogleBtn'));
    }

    function signInWithGoogle() {
        // Modo desarrollo local (CONFIG.devLogin): el botón de Google no
        // funciona en localhost (origen no permitido), así que se entra con
        // un usuario simulado. Igual pasa por una sesión real firmada por el
        // servidor, no por datos inventados en el cliente.
        if (CONFIG.googleClientId && !CONFIG.devLogin) {
            if (!ensureGoogleInitialized(onGoogleCredential)) {
                alert('El login de Google todavía se está cargando, probá de nuevo en un segundo.');
                return;
            }
            window.google.accounts.id.prompt();
            return;
        }
        api('/auth/dev-login', { method: 'POST' })
            .then(() => refreshAuthState())
            .then(() => {
                refreshUserUI();
                closeAll();
                promptRegistrationStep();
            })
            .catch(() => alert('No se pudo iniciar sesión. ¿Está corriendo el servidor?'));
    }

    function saveUsername() {
        const input = $('usernameInput');
        if (!input) return;
        const name = (input.value || '').trim();
        if (!name) { input.focus(); return; }
        if (name.length < LIMITS.nameMin) { alert(`El nombre debe tener al menos ${LIMITS.nameMin} caracteres.`); input.focus(); return; }
        if (name.length > LIMITS.nameMax) { alert(`El nombre debe tener máximo ${LIMITS.nameMax} caracteres.`); input.focus(); return; }
        if (!/^[A-Za-z0-9_]+$/.test(name)) { alert('El nombre solo puede tener letras, números y guion bajo (sin espacios).'); input.focus(); return; }
        api('/auth/set-name', { method: 'POST', body: JSON.stringify({ name }) })
            .then(() => refreshAuthState())
            .then(() => {
                refreshUserUI();
                closeAll();
                if (needsPassword()) { promptRegistrationStep(); return; }
                rerunPageInit(document.body.dataset.page);
            })
            .catch(err => alert('No se pudo guardar el nombre: ' + err.message));
    }

    function logout() {
        if (!confirm('¿Cerrar sesión?')) return;
        state.user = null;
        // Cortar el auto-login de Google: sin esto, al volver a la home
        // Google Identity Services vuelve a firmar la sesión en silencio
        // (One Tap / FedCM) y parece que "no se cerró sesión".
        try {
            if (window.google && window.google.accounts && window.google.accounts.id) {
                window.google.accounts.id.disableAutoSelect();
            }
        } catch (e) {}
        // Redirige a la home siempre: varias páginas (perfil, subir,
        // calificar) muestran contenido que depende de la sesión, y solo
        // limpiar el estado en memoria dejaba ese contenido "pegado" en
        // pantalla hasta recargar. Un redirect fuerza el estado limpio en
        // cualquier página. Espera a que el servidor confirme el borrado de
        // la cookie antes de navegar.
        api('/auth/logout', { method: 'POST' }).catch(() => {}).then(() => {
            window.location.href = 'index.html';
        });
    }

    function openAccount() {
        if (!state.user) return;
        if (isFullyRegistered()) {
            window.location.href = 'perfil.html';
            return;
        }
        // Este modal solo se muestra a cuentas que todavía no eligieron
        // nombre -- a esa altura nunca tienen Curis subidos ni
        // calificaciones, así que mostrar 0 acá es siempre correcto.
        $('accName').textContent = state.user.name || '-';
        $('accId').textContent = state.user.id;
        $('accDate').textContent = new Date(state.user.registeredAt).toLocaleDateString();
        $('accUploads').textContent = '0';
        $('accRated').textContent = '0';
        openModal('accountModal');
    }

    function requireAuth(message) {
        if (!isFullyRegistered()) {
            if ($('loginMessage')) $('loginMessage').textContent = message;
            openModal('loginModal');
            return false;
        }
        return true;
    }

    function updateStarsTodayUI(data) {
        starsToday = data;
        if ($('starsToday')) $('starsToday').textContent = data.total.toFixed(1);
        if ($('starsCapLabel')) $('starsCapLabel').textContent = data.cap;
    }

    // Cuenta regresiva / espera reutilizable (subida y extensión de límite).
    function showWaitCountdown(seconds, hintText, onComplete) {
        let t = seconds;
        if ($('adCountdown')) $('adCountdown').textContent = t;
        if ($('adHint') && hintText) $('adHint').textContent = hintText;
        openModal('adModal');
        adInterval = setInterval(() => {
            t--;
            if ($('adCountdown')) $('adCountdown').textContent = t;
            if (t <= 0) {
                clearInterval(adInterval);
                adInterval = null;
                onComplete();
            }
        }, 1000);
    }

    function showStarLimitModal(cap) {
        if (cap >= CONFIG.starsCapExtended) {
            if ($('starLimitTitle')) $('starLimitTitle').textContent = 'Llegaste al límite diario';
            if ($('starLimitText')) $('starLimitText').textContent = `Ya diste ${CONFIG.starsCapExtended} estrellas hoy, el máximo permitido por ahora. Volvé mañana para seguir calificando.`;
            if ($('starLimitAdBtn')) $('starLimitAdBtn').style.display = 'none';
        } else {
            if ($('starLimitTitle')) $('starLimitTitle').textContent = 'Llegaste al límite de hoy';
            if ($('starLimitText')) $('starLimitText').textContent = `Ya diste ${CONFIG.starsCapBase} estrellas hoy. Esperá ${CONFIG.adSeconds} segundos para ampliar tu límite del día a ${CONFIG.starsCapExtended} estrellas.`;
            if ($('starLimitAdBtn')) $('starLimitAdBtn').style.display = 'block';
        }
        openModal('starLimitModal');
    }

    function extendStarsCap() {
        closeAll();
        showWaitCountdown(CONFIG.adSeconds, `Ampliando tu límite del día a ${CONFIG.starsCapExtended} estrellas...`, () => {
            api('/ratings/extend', { method: 'POST' })
                .then(res => { closeAll(); updateStarsTodayUI(res.starsToday); })
                .catch(() => { closeAll(); alert('No se pudo extender el límite. Probá de nuevo.'); });
        });
    }

    function tierForAvg(avg, count) {
        if (!count || count <= 0) return { code: 'UN', label: 'Sin clasificar' };
        if (avg >= 4.7) return { code: 'S', label: 'S · Legendario' };
        if (avg >= 4.3) return { code: 'A', label: 'A · Épico' };
        if (avg >= 3.8) return { code: 'B', label: 'B · Raro' };
        if (avg >= 3.0) return { code: 'C', label: 'C · Común' };
        if (avg >= 2.0) return { code: 'D', label: 'D · Básico' };
        return { code: 'E', label: 'E · Bajo' };
    }

    // Rango de calificador según el XP acumulado (RATING_XP por cada
    // calificación dada, ver RATING_XP más arriba). Reusa la paleta de
    // .tier-badge (mismos 6 colores que ya existían para los Curis) para no
    // sumar CSS nuevo. Umbrales son un punto de partida razonable, fáciles
    // de ajustar acá si hace falta.
    const RANKS = [
        { min: 1500, code: 'S', label: 'Leyenda' },
        { min: 700, code: 'A', label: 'Maestro' },
        { min: 350, code: 'B', label: 'Experto' },
        { min: 150, code: 'C', label: 'Crítico' },
        { min: 50, code: 'D', label: 'Aficionado' },
        { min: 0, code: 'E', label: 'Novato' }
    ];
    function rankForXp(xp) {
        const current = RANKS.find(r => xp >= r.min);
        const idx = RANKS.indexOf(current);
        const next = idx > 0 ? RANKS[idx - 1] : null;
        return { code: current.code, label: current.label, xp, minXp: current.min, nextXp: next ? next.min : null };
    }

    function renderRankSection(xp) {
        const badge = $('rankBadge');
        const xpLabel = $('rankXpLabel');
        const fill = $('rankProgressFill');
        if (!badge) return;
        const rank = rankForXp(xp);
        badge.innerHTML = `<span class="tier-badge tier-${rank.code}">${rank.label}</span>`;
        if (rank.nextXp === null) {
            if (xpLabel) xpLabel.textContent = `${xp} XP · rango máximo alcanzado`;
            if (fill) fill.style.width = '100%';
        } else {
            const pct = Math.min(100, Math.round(((xp - rank.minXp) / (rank.nextXp - rank.minXp)) * 100));
            if (xpLabel) xpLabel.textContent = `${xp} / ${rank.nextXp} XP para el próximo rango`;
            if (fill) fill.style.width = pct + '%';
        }
    }

    // --- toast de XP estilo "moneda de Mario" al terminar de calificar ---
    function showXpToast(amount) {
        const toast = document.createElement('div');
        toast.className = 'xp-toast';
        toast.innerHTML = `<span class="xp-toast-coin">🪙</span><span>+${amount} XP</span>`;
        document.body.appendChild(toast);
        toast.addEventListener('animationend', (e) => {
            if (e.animationName === 'xpToastOut') toast.remove();
        });
    }

    function initRatePage() {
        if (!requireAuth('Necesitas iniciar sesión para poder calificar Curis.')) return;
        setupDustEasterEgg();
        document.addEventListener('pointerdown', primeCurisAudio, { once: true });
        document.addEventListener('keydown', primeCurisAudio, { once: true });
        renderRate();
    }

    function renderRate() {
        api('/curis/rate-state').then(data => {
            ratePool = data.pool;
            if ($('ratedCount')) $('ratedCount').textContent = data.rated;
            if ($('totalCount')) $('totalCount').textContent = data.total;
            updateStarsTodayUI(data.starsToday);
            if (ratePool.length === 0) {
                showRateFinished(data.total, data.rated);
                return;
            }
            loadCurisIntoStage(ratePool[0]);
        }).catch(() => {
            showRateFinished(0, 0);
        });
    }

    function showRateFinished(total, rated) {
        const stage = $('rateStage');
        const controls = $('rateControlsWrap');
        const value = $('rateValue');
        const actions = $('rateActions');
        const feedback = $('rateFeedback');

        if (stage) stage.style.display = 'none';
        if (controls) controls.style.display = 'none';
        if (value) value.style.display = 'none';
        if (actions) actions.style.display = 'none';
        if (feedback) feedback.style.display = 'none';
        fadeOutCurisAudio();
        const mBtn = $('musicToggleBtn');
        if (mBtn) mBtn.style.display = 'none';

        let finished = $('rateFinished');
        if (!finished) {
            finished = document.createElement('div');
            finished.id = 'rateFinished';
            finished.className = 'rate-finished';
            const stageParent = stage ? stage.parentNode : document.querySelector('.page-content');
            if (stageParent) stageParent.appendChild(finished);
        }
        const msg = total === 0
            ? 'Todavía no hay Curis para calificar. Vuelve cuando alguien suba uno.'
            : '¡Acabaste con todos los Curis! Has calificado todos los disponibles en la plataforma. Vuelve más tarde para ver nuevos.';
        finished.innerHTML = `
            <div class="rate-finished-icon">🎉</div>
            <h2>¡Acabaste con todos los Curis!</h2>
            <p>${msg}</p>
            <p class="hint">Curis calificados: ${rated} de ${total}</p>
            <a href="index.html" class="btn-primary">Volver al inicio</a>
            <a href="ranking.html" class="btn-primary" style="background:var(--bg-3); color:var(--text);">Ver ranking</a>
        `;
        finished.style.display = 'block';
    }

    function loadCurisIntoStage(curis) {
        const finished = $('rateFinished');
        if (finished) finished.style.display = 'none';
        const stage = $('rateStage');
        const controls = $('rateControlsWrap');
        const value = $('rateValue');
        const actions = $('rateActions');
        if (stage) stage.style.display = 'flex';
        if (controls) controls.style.display = 'flex';
        if (value) value.style.display = 'block';
        if (actions) actions.style.display = 'flex';

        const country = findCountry(curis.country);
        $('rateCreator').textContent = (country ? country.flag + ' ' : '') + '@' + curis.creator;
        // La imagen es un <img> real: se muestra al ancho de la tarjeta
        // (styles.css), completa y sin recortar, sin importar su resolución.
        // Si el Curi no tiene imagen, va el degradado de color en el wrap.
        const img = $('curisImage');
        const wrap = $('curisImageWrap');
        if (curis.imageFile) {
            // Tope de agrandado: un Curi de baja resolución no se estira a
            // más de 1.8x su ancho real (si no queda todo borroso). Los
            // grandes igual los achica el CSS (max-width:100%).
            img.style.width = '';
            img.onload = () => {
                const maxW = (wrap ? wrap.clientWidth : 480) || 480;
                img.style.width = Math.min(maxW, Math.round(img.naturalWidth * 1.8)) + 'px';
            };
            img.src = curis.imageFile;
            img.style.display = 'block';
            if (wrap) { wrap.style.background = ''; wrap.style.minHeight = ''; }
        } else {
            img.onload = null;
            img.removeAttribute('src');
            img.style.display = 'none';
            img.style.width = '';
            if (wrap) {
                wrap.style.background = `linear-gradient(135deg, ${curis.color1 || '#4a90e2'}, ${curis.color2 || '#357abd'})`;
                wrap.style.minHeight = '320px';
            }
        }
        const card = $('curisCard');
        card.classList.remove('swap-out');
        card.classList.add('swap-in');
        setTimeout(() => card.classList.remove('swap-in'), 500);
        $('rateFeedback').style.display = 'none';
        $('confirmRate').style.display = 'block';
        $('confirmRate').disabled = false;
        currentRating = 1;
        updateStarsUI();
        updateRateValueLabel();
        setupCurisAudio(curis);
        resetDustEffect();
    }

    // --- música de fondo del Curis que se está calificando ---
    // La música se escucha suave (volumen bajo) y nunca entra de golpe:
    // aparece con un fundido de ~1.2s y, al pasar al siguiente Curis, se
    // va con otro fundido antes de que arranque la próxima canción.
    const MUSIC_VOLUME = 0.35;
    let audioFadeTimer = null;
    let audioPrimed = false; // ¿el usuario ya tocó la página? (autoplay)

    function fadeAudio(audio, to, ms, done) {
        if (audioFadeTimer) { clearInterval(audioFadeTimer); audioFadeTimer = null; }
        const from = audio.volume;
        const steps = Math.max(1, Math.round(ms / 50));
        let i = 0;
        audioFadeTimer = setInterval(() => {
            i++;
            audio.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)));
            if (i >= steps) {
                clearInterval(audioFadeTimer);
                audioFadeTimer = null;
                if (done) done();
            }
        }, 50);
    }

    // Fundido de salida + pausa. Se llama justo antes de pasar al siguiente
    // Curis, así la transición entre canciones no es abrupta.
    function fadeOutCurisAudio(done) {
        const audio = $('curisAudio');
        if (!audio || audio.paused || !audio.currentSrc) { if (done) done(); return; }
        fadeAudio(audio, 0, 650, () => { audio.pause(); if (done) done(); });
    }

    function setupCurisAudio(curis) {
        const audio = $('curisAudio');
        const btn = $('musicToggleBtn');
        if (!audio || !btn) return;
        if (audioFadeTimer) { clearInterval(audioFadeTimer); audioFadeTimer = null; }
        audio.pause();
        audio.ontimeupdate = null;
        const track = findMusicTrack(curis.musicTrack);
        if (!track) {
            btn.style.display = 'none';
            btn.classList.remove('playing');
            audio.removeAttribute('src');
            return;
        }
        btn.style.display = 'flex';
        btn.classList.remove('playing');
        if (audio.currentSrc !== track.src) audio.src = track.src;

        // Salta al segundo elegido por quien subió el Curi. Se intenta ya, y
        // otra vez cuando haya metadata / cuando el loop vuelva al principio.
        const seekToStart = () => {
            if (!track.start) return;
            if (audio.currentTime < track.start - 0.4) {
                try { audio.currentTime = track.start; } catch (e) {}
            }
        };
        audio.ontimeupdate = track.start ? () => { if (!audio.seeking) seekToStart(); } : null;

        // IMPORTANTE: audio.play() tiene que llamarse de forma síncrona
        // dentro del gesto del usuario (si se difiere a un evento tipo
        // loadedmetadata, el navegador ya considera consumido el gesto y
        // bloquea la reproducción). Por eso se llama directo y el seek va
        // después.
        const play = () => {
            audio.volume = 0;
            const p = audio.play();
            if (p && p.then) {
                p.then(() => {
                    btn.classList.add('playing');
                    seekToStart();
                    if (audio.readyState < 1) audio.addEventListener('loadedmetadata', seekToStart, { once: true });
                    fadeAudio(audio, MUSIC_VOLUME, 1200);
                }).catch(() => { btn.classList.remove('playing'); });
            }
        };

        btn.onclick = () => {
            audioPrimed = true;
            if (audio.paused) {
                play();
            } else {
                fadeAudio(audio, 0, 350, () => audio.pause());
                btn.classList.remove('playing');
            }
        };

        // La música arranca en cuanto se ve el Curi (no cuando se califica).
        // Se intenta siempre acá, apenas se carga el Curi en pantalla. Para
        // el 1er Curi el navegador puede bloquear el autoplay (todavía no
        // hubo ningún gesto en la página) -> queda el botón 🎵 y
        // primeCurisAudio() lo dispara en el primer toque en cualquier lado.
        // Del 2º Curi en adelante ya arranca solo con su fundido.
        play();
    }

    // Arranca la música en la primera interacción del usuario con la página
    // de calificar (por la política de autoplay de los navegadores). Tiene
    // que correr de forma síncrona en el handler del gesto.
    function primeCurisAudio() {
        if (audioPrimed) return;
        audioPrimed = true;
        const audio = $('curisAudio');
        const btn = $('musicToggleBtn');
        if (audio && btn && btn.style.display !== 'none' && audio.paused && audio.getAttribute('src')) {
            btn.click();
        }
    }

    // --- easter egg: 4 clics seguidos en el nombre del Curis que está al
    // frente lo hacen "polvo" durante 15s. Los clics tienen que ocurrir
    // dentro de una ventana de 2s entre sí, si no el contador se reinicia. ---
    function setupDustEasterEgg() {
        const el = $('rateCreator');
        if (!el || el.dataset.dustBound) return;
        el.dataset.dustBound = '1';
        el.addEventListener('click', () => {
            if (el.classList.contains('dust-active')) return;
            dustClickCount++;
            clearTimeout(dustClickResetTimer);
            dustClickResetTimer = setTimeout(() => { dustClickCount = 0; }, 2000);
            if (dustClickCount >= 4) {
                dustClickCount = 0;
                triggerDustEffect(el);
            }
        });
    }

    function triggerDustEffect(el) {
        el = el || $('rateCreator');
        if (!el || el.classList.contains('dust-active')) return;
        clearTimeout(dustRevertTimer);
        el.classList.add('dust-active');
        for (let i = 0; i < 14; i++) {
            const p = document.createElement('span');
            p.className = 'dust-particle';
            const angle = Math.random() * Math.PI * 2;
            const dist = 20 + Math.random() * 40;
            p.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(0) + 'px');
            p.style.setProperty('--dy', (Math.sin(angle) * dist - 10).toFixed(0) + 'px');
            p.style.left = (40 + Math.random() * 20) + '%';
            p.style.animationDelay = (Math.random() * 0.15) + 's';
            el.appendChild(p);
        }
        dustRevertTimer = setTimeout(() => revertDustEffect(el), 15000);
    }

    function revertDustEffect(el) {
        el = el || $('rateCreator');
        if (!el) return;
        el.classList.remove('dust-active');
        el.querySelectorAll('.dust-particle').forEach(p => p.remove());
    }

    function resetDustEffect() {
        clearTimeout(dustRevertTimer);
        clearTimeout(dustClickResetTimer);
        dustClickCount = 0;
        revertDustEffect();
    }

    function updateStarsUI() {
        const stars = document.querySelectorAll('.star-icon');
        stars.forEach(s => {
            const pos = parseInt(s.dataset.pos, 10);
            s.classList.remove('active', 'half');
            if (currentRating >= pos) {
                s.classList.add('active');
            } else if (currentRating >= pos - 0.5) {
                s.classList.add('half');
            }
        });
    }

    function updateRateValueLabel() {
        const label = $('rateValueLabel');
        if (!label) return;
        label.textContent = currentRating.toFixed(1);
    }

    function changeRating(delta) {
        const next = +(currentRating + delta).toFixed(1);
        if (next < 0 || next > 5) return;
        currentRating = next;
        updateStarsUI();
        updateRateValueLabel();
    }

    function submitRating() {
        if (ratePool.length === 0) return;
        // Chequeo rápido del lado del cliente para feedback instantáneo --
        // el servidor vuelve a validar esto de todos modos antes de
        // guardar nada.
        if (+(starsToday.total + currentRating).toFixed(1) > starsToday.cap) {
            showStarLimitModal(starsToday.cap);
            return;
        }

        const curis = ratePool[0];
        api('/ratings', { method: 'POST', body: JSON.stringify({ curisId: curis.id, stars: currentRating }) })
            .then(res => {
                updateStarsTodayUI({ total: res.dailyTotal, cap: res.cap });

                $('rateFeedbackText').textContent = `Calificaste este Curis con ${currentRating.toFixed(1)} estrellas.`;
                $('rateFeedback').style.display = 'block';
                $('confirmRate').style.display = 'none';
                $('confirmRate').disabled = true;
                showXpToast(RATING_XP);

                setTimeout(() => {
                    const card = $('curisCard');
                    card.classList.add('swap-out');
                    fadeOutCurisAudio();
                    setTimeout(() => { renderRate(); }, 480);
                }, 1200);
            })
            .catch(err => {
                if (err.code === 'limit_reached') {
                    showStarLimitModal((err.data && err.data.cap) || starsToday.cap);
                } else if (err.code) {
                    alert(err.message);
                    renderRate();
                } else {
                    alert('No se pudo guardar la calificación: ' + err.message);
                }
            });
    }


    function initRankingPage() {
        renderRanking();
    }

    function renderRanking() {
        const list = $('rankingList');
        if (!list) return;

        api('/curis/ranking').then(raw => {
            const myId = state.user ? state.user.id : null;
            const allCuris = raw.map(c => ({
                id: c.id,
                creator: c.creator,
                creatorId: c.creatorId,
                color1: c.color1,
                color2: c.color2,
                avg: c.avg || 0,
                count: c.count || 0,
                imageFile: c.imageFile || null,
                isMine: c.creatorId === myId
            }));
            lastRankingCuris = allCuris;

            const byCreator = {};
            allCuris.forEach(c => {
                const key = c.creator;
                if (!byCreator[key]) byCreator[key] = { creator: c.creator, curis: [], isMine: c.isMine };
                byCreator[key].curis.push(c);
            });

            const players = Object.values(byCreator).map(p => {
                const valid = p.curis.filter(c => c.count > 0);
                const totalCount = p.curis.reduce((s, c) => s + (c.count || 0), 0);
                const weightedAvg = valid.length > 0
                    ? +(valid.reduce((s, c) => s + c.avg * c.count, 0) / totalCount).toFixed(2)
                    : 0;
                const best = p.curis.slice().sort((a, b) => (b.avg || 0) - (a.avg || 0))[0];
                return {
                    creator: p.creator,
                    avg: weightedAvg,
                    count: totalCount,
                    best,
                    curis: p.curis,
                    isMine: p.isMine
                };
            })
            .filter(p => p.count > 0)
            .sort((a, b) => {
                if (b.avg !== a.avg) return b.avg - a.avg;
                return b.count - a.count;
            });

            if (players.length === 0) {
                list.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:var(--text-muted);">Aún no hay Curis calificados. Sé el primero en subir uno.</td></tr>`;
                return;
            }

            list.innerHTML = players.map((p, idx) => {
                const posClass = idx === 0 ? 'top1' : idx === 1 ? 'top2' : idx === 2 ? 'top3' : '';
                const tier = tierForAvg(p.avg, p.count);
                const mineTag = p.isMine ? ' <span class="hint">(tú)</span>' : '';
                return `
                    <tr data-creator="${encodeURIComponent(p.creator)}">
                        <td class="col-pos"><span class="rank-position-badge ${posClass}">${idx + 1}</span></td>
                        <td class="col-name">@${p.creator}${mineTag}</td>
                        <td class="col-tier"><span class="tier-badge tier-${tier.code}">${tier.label}</span></td>
                        <td class="col-avg">★ ${p.avg.toFixed(1)}</td>
                        <td class="col-count">${p.count.toLocaleString()}</td>
                    </tr>
                `;
            }).join('');

            list.querySelectorAll('tr[data-creator]').forEach(el => {
                el.addEventListener('click', () => {
                    const creator = decodeURIComponent(el.dataset.creator);
                    openCreatorViewer(creator);
                });
            });
        }).catch(() => {
            list.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:var(--text-muted);">No se pudo cargar el ranking. ¿Está corriendo el servidor?</td></tr>`;
        });
    }

    function openCreatorViewer(creator) {
        const viewer = $('imageViewer');
        if (!viewer) return;
        const myId = state.user ? state.user.id : null;
        const curis = lastRankingCuris.filter(c => c.creator === creator);
        if (curis.length === 0) return;
        const cards = curis.map(c => {
            const inner = c.imageFile
                ? `<div style="background-image:url('${c.imageFile}'); background-size:cover; background-position:center; width:100%; aspect-ratio:1/1; border-radius:12px;"></div>`
                : `<div style="background: linear-gradient(135deg, ${c.color1}, ${c.color2}); width:100%; aspect-ratio:1/1; border-radius:12px;"></div>`;
            const tier = tierForAvg(c.avg, c.count);
            return `<div style="width:160px;">${inner}<p style="text-align:center; margin-top:.4rem; font-size:.85rem;">★ ${(c.avg||0).toFixed(1)} · ${c.count} calif.</p><p style="text-align:center;"><span class="tier-badge tier-${tier.code}">${tier.label}</span></p></div>`;
        }).join('');
        const isMine = curis.some(c => c.creatorId === myId);
        viewer.innerHTML = `
            <h3 style="text-align:center; margin-bottom:1rem;">@${creator} ${isMine ? '<span class="hint">(tú)</span>' : ''}</h3>
            <div style="display:flex; flex-wrap:wrap; gap:1rem; justify-content:center;">${cards}</div>
        `;
        openModal('imageViewerModal');
    }


    // Librería de música (window.MUSIC_LIBRARY, ver music-library.js) --
    // busca por id, no por src, así que renombrar un archivo no rompe nada.
    // El valor guardado por Curis puede traer un "@<segundo>" de arranque
    // (p.ej. "judas@37"); se devuelve como track.start (número, 0 si no hay).
    function findMusicTrack(value) {
        if (!value || !window.MUSIC_LIBRARY) return null;
        const at = String(value).indexOf('@');
        const id = at === -1 ? value : value.slice(0, at);
        const start = at === -1 ? 0 : (parseInt(value.slice(at + 1), 10) || 0);
        const track = window.MUSIC_LIBRARY.find(t => t.id === id);
        return track ? Object.assign({}, track, { start: Math.max(0, start) }) : null;
    }

    // País de origen del Curis (de dónde viene / quién lo sube) -- lista
    // fija de Latinoamérica, mismos códigos que valida server.js. Solo se
    // guarda el código de 2 letras, nunca la bandera/etiqueta, para poder
    // ajustar el texto sin tocar Curis ya publicados.
    const COUNTRIES = [
        { id: 'ar', flag: '🇦🇷', label: 'Argentina' },
        { id: 'bo', flag: '🇧🇴', label: 'Bolivia' },
        { id: 'br', flag: '🇧🇷', label: 'Brasil' },
        { id: 'cl', flag: '🇨🇱', label: 'Chile' },
        { id: 'co', flag: '🇨🇴', label: 'Colombia' },
        { id: 'cr', flag: '🇨🇷', label: 'Costa Rica' },
        { id: 'cu', flag: '🇨🇺', label: 'Cuba' },
        { id: 'ec', flag: '🇪🇨', label: 'Ecuador' },
        { id: 'sv', flag: '🇸🇻', label: 'El Salvador' },
        { id: 'gt', flag: '🇬🇹', label: 'Guatemala' },
        { id: 'hn', flag: '🇭🇳', label: 'Honduras' },
        { id: 'mx', flag: '🇲🇽', label: 'México' },
        { id: 'ni', flag: '🇳🇮', label: 'Nicaragua' },
        { id: 'pa', flag: '🇵🇦', label: 'Panamá' },
        { id: 'py', flag: '🇵🇾', label: 'Paraguay' },
        { id: 'pe', flag: '🇵🇪', label: 'Perú' },
        { id: 'do', flag: '🇩🇴', label: 'República Dominicana' },
        { id: 'uy', flag: '🇺🇾', label: 'Uruguay' },
        { id: 've', flag: '🇻🇪', label: 'Venezuela' }
    ];

    function findCountry(id) {
        if (!id) return null;
        return COUNTRIES.find(c => c.id === id) || null;
    }

    function populateMusicSelect() {
        const select = $('musicSelect');
        const emptyHint = $('musicEmptyHint');
        if (!select) return;
        const tracks = window.MUSIC_LIBRARY || [];
        select.innerHTML = '<option value="">Sin música</option>' +
            tracks.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
        if (emptyHint) emptyHint.style.display = tracks.length === 0 ? 'block' : 'none';
    }

    function initUploadPage() {
        if (!requireAuth('Necesitas iniciar sesión para subir tu Curis.')) return;
        $('uploadAs').textContent = state.user.name;
        populateMusicSelect();
        initMusicTrim();
        resetUploadView();
    }

    // Mini reproductor de subir.html: al elegir una canción, el creador
    // puede escucharla y marcar desde qué segundo quiere que arranque
    // cuando alguien califique su Curi. Se guarda solo ese número (#musicStart).
    function initMusicTrim() {
        const select = $('musicSelect');
        const trim = $('musicTrim');
        const range = $('musicTrimRange');
        const timeLabel = $('musicTrimTime');
        const startHidden = $('musicStart');
        const playBtn = $('musicTrimPlay');
        const hintStrong = $('musicTrimHint') ? $('musicTrimHint').querySelector('strong') : null;
        const audio = $('musicPreviewAudio');
        if (!select || !trim || !audio || trim.dataset.bound) return;
        trim.dataset.bound = '1';

        const fmt = (s) => {
            s = Math.max(0, Math.round(s));
            return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        };
        const syncFromRange = () => {
            const dur = audio.duration || 0;
            const sec = dur ? (range.value / 1000) * dur : 0;
            startHidden.value = Math.round(sec);
            timeLabel.textContent = fmt(sec);
            if (hintStrong) hintStrong.textContent = fmt(sec);
        };

        select.addEventListener('change', () => {
            audio.pause();
            playBtn.textContent = '▶';
            const track = findMusicTrack(select.value);
            if (!track) { trim.style.display = 'none'; audio.removeAttribute('src'); return; }
            trim.style.display = 'block';
            range.value = 0;
            startHidden.value = 0;
            timeLabel.textContent = '0:00';
            if (hintStrong) hintStrong.textContent = '0:00';
            range.disabled = true;
            audio.src = track.src;
            audio.load();
        });

        audio.addEventListener('loadedmetadata', () => { range.disabled = false; syncFromRange(); });
        audio.addEventListener('error', () => {
            timeLabel.textContent = '—';
            alert('No se pudo cargar esta canción para escucharla. Igual se puede publicar el Curi con ella; probá recargar la página si querés previsualizarla.');
        });
        range.addEventListener('input', () => {
            syncFromRange();
            if (!audio.paused) { try { audio.currentTime = +startHidden.value; } catch (e) {} }
        });
        playBtn.addEventListener('click', () => {
            if (audio.paused) {
                try { audio.currentTime = +startHidden.value || 0; } catch (e) {}
                audio.play().then(() => { playBtn.textContent = '⏸'; }).catch(() => {});
            } else {
                audio.pause();
                playBtn.textContent = '▶';
            }
        });
        audio.addEventListener('ended', () => { playBtn.textContent = '▶'; });
    }

    function resetUploadView() {
        $('uploadZone').style.display = 'block';
        $('uploadPreview').style.display = 'none';
        const fi = $('fileInput');
        if (fi) fi.value = '';
        const img = $('previewImg');
        if (img) { img.removeAttribute('src'); delete img.dataset.dataurl; }
    }

    function handleFileSelect(file) {
        if (!file || !file.type.startsWith('image/')) {
            alert('Por favor selecciona un archivo de imagen válido.');
            return;
        }
        if (file.size > LIMITS.maxImageSize) {
            alert('La imagen es demasiado grande. Máximo 4 MB.');
            return;
        }
        fileToCompressedDataURL(file, 900, 0.80).then(dataUrl => {
            $('previewImg').src = dataUrl;
            $('previewImg').dataset.dataurl = dataUrl;
            $('uploadZone').style.display = 'none';
            $('uploadPreview').style.display = 'block';
        }).catch(() => {
            alert('No se pudo procesar esa imagen. Probá con otra.');
        });
    }

    // Publicar pasa siempre por una espera breve de ~30s (cola de revisión).
    // Hay una chance (no visible para el usuario) del 10% de necesitar unos
    // segundos más; se avisa con un mensaje honesto para no engañar a quien
    // está subiendo el Curis.
    function beginPublish() {
        if (!requireAuth('Necesitas iniciar sesión para subir tu Curis.')) return;
        const img = $('previewImg');
        if (!img || !img.dataset.dataurl) {
            alert('Primero selecciona una imagen.');
            return;
        }
        closeAll();
        runUploadAd();
    }

    function runUploadAd() {
        showWaitCountdown(CONFIG.adSeconds, 'Preparando la publicación de tu Curis...', resolveUploadAd);
    }

    function resolveUploadAd() {
        closeAll();
        if (Math.random() < CONFIG.extraAdChance) {
            setTimeout(() => openModal('extraAdModal'), 200);
            return;
        }
        finishPublish();
    }

    function finishPublish() {
        if (!requireAuth('Necesitas iniciar sesión para subir tu Curis.')) return;
        const img = $('previewImg');
        const dataUrl = img ? img.dataset.dataurl : null;
        if (!dataUrl) return;
        const musicSelect = $('musicSelect');
        let musicTrack = musicSelect ? musicSelect.value : '';
        // punto de arranque elegido en el mini reproductor (segundos)
        const startInput = $('musicStart');
        const startSec = musicTrack && startInput ? Math.max(0, Math.round(+startInput.value || 0)) : 0;
        if (musicTrack && startSec > 0) musicTrack += '@' + startSec;
        const countrySelect = $('countrySelect');
        const country = countrySelect ? countrySelect.value : '';
        api('/curis', { method: 'POST', body: JSON.stringify({ imageData: dataUrl, musicTrack, country }) })
            .then(() => {
                setTimeout(() => openModal('successModal'), 200);
            })
            .catch(err => {
                alert('No se pudo publicar tu Curis: ' + err.message);
            });
    }


    function initProfilePage() {
        if (!requireAuth('Necesitas iniciar sesión para ver tu perfil.')) return;
        renderProfile();
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + (parts[1][0] || '')).toUpperCase();
    }

    function renderProfile() {
        if (!state.user) return;
        const u = state.user;
        const usernameEl = $('profileUsername');
        const initialsEl = $('profileAvatarInitials');
        const avatarImg = $('profileAvatarImg');
        const joinedEl = $('profileJoined');
        const bioEl = $('profileBio');

        if (usernameEl) usernameEl.textContent = '@' + u.name;
        if (initialsEl) initialsEl.textContent = getInitials(u.name);
        if (avatarImg) {
            if (u.avatarData) {
                avatarImg.src = u.avatarData;
                avatarImg.style.display = 'block';
                if (initialsEl) initialsEl.style.display = 'none';
            } else {
                avatarImg.style.display = 'none';
                if (initialsEl) initialsEl.style.display = 'block';
            }
        }
        if (joinedEl) {
            const d = new Date(u.registeredAt);
            joinedEl.textContent = d.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
        }
        if (bioEl) {
            if (u.bio && u.bio.trim()) {
                bioEl.textContent = u.bio;
                bioEl.classList.remove('is-empty');
            } else {
                bioEl.textContent = 'Sin biografía todavía. Haz clic en ✎ para agregar una.';
                bioEl.classList.add('is-empty');
            }
        }

        api('/curis/mine').then(data => {
            const myCuris = data.curis;
            const totalUploads = myCuris.length;
            const totalRated = data.ratedCount;
            let weightedSum = 0, weightedCount = 0;
            myCuris.forEach(c => {
                if (c.count > 0) {
                    weightedSum += c.avg * c.count;
                    weightedCount += c.count;
                }
            });
            const avgReceived = weightedCount > 0 ? +(weightedSum / weightedCount).toFixed(1) : 0;
            const myTier = tierForAvg(avgReceived, weightedCount);

            if ($('statUploads')) $('statUploads').textContent = totalUploads;
            if ($('statRated')) $('statRated').textContent = totalRated;
            if ($('statAvg')) $('statAvg').textContent = avgReceived.toFixed(1);
            if ($('statTier')) $('statTier').innerHTML = `<span class="tier-badge tier-${myTier.code}">${myTier.label}</span>`;
            renderRankSection(totalRated * RATING_XP);

            const gallery = $('profileGallery');
            const empty = $('profileEmpty');
            if (gallery) {
                if (myCuris.length === 0) {
                    gallery.innerHTML = '';
                    gallery.style.display = 'none';
                    if (empty) empty.style.display = 'block';
                } else {
                    if (empty) empty.style.display = 'none';
                    gallery.style.display = 'grid';
                    gallery.innerHTML = myCuris.map((c) => {
                        const bg = c.imageFile
                            ? `style="background-image:url('${c.imageFile}'); background-size:cover; background-position:center;"`
                            : `style="background: linear-gradient(135deg, ${c.color1}, ${c.color2});"`;
                        const t = tierForAvg(c.avg, c.count);
                        const overlay = c.status === 'pending'
                            ? '⏳ En revisión'
                            : c.status === 'rejected'
                                ? '❌ Rechazado'
                                : `★ ${c.avg.toFixed(1)} · ${c.count} calif. · ${t.code}`;
                        return `<div class="profile-gallery-item" data-id="${c.id}" ${bg}>
                            <div class="profile-gallery-overlay">${overlay}</div>
                        </div>`;
                    }).join('');
                    gallery.querySelectorAll('.profile-gallery-item').forEach(el => {
                        el.addEventListener('click', () => {
                            const id = el.dataset.id;
                            const c = myCuris.find(x => x.id === id);
                            if (c) openProfileImage(c);
                        });
                    });
                }
            }
        }).catch(() => {
            if ($('statUploads')) $('statUploads').textContent = '0';
            if ($('statRated')) $('statRated').textContent = '0';
        });
    }

    function openProfileImage(c) {
        const v = $('profileImageViewer');
        if (!v) return;
        const inner = c.imageFile
            ? `<img src="${c.imageFile}" style="max-width:100%; max-height:70vh; border-radius:16px;">`
            : `<div style="background: linear-gradient(135deg, ${c.color1}, ${c.color2}); width:100%; aspect-ratio:1/1; max-width:500px; margin:0 auto; border-radius:24px;"></div>`;
        const t = tierForAvg(c.avg, c.count);
        let statusLine = `<p style="text-align:center;"><span class="tier-badge tier-${t.code}">${t.label}</span></p>
            <p style="text-align:center;">★ ${c.avg.toFixed(1)} · ${c.count.toLocaleString()} calificaciones</p>`;
        if (c.status === 'pending') {
            statusLine = `<p style="text-align:center;" class="hint">⏳ Este Curis está pendiente de revisión por el equipo. Cuando sea aprobado va a poder calificarse y aparecer en el ranking.</p>`;
        } else if (c.status === 'rejected') {
            statusLine = `<p style="text-align:center;" class="hint">❌ Este Curis fue rechazado por el equipo y no aparece en Calificar ni en el Ranking.</p>`;
        }
        v.innerHTML = `
            ${inner}
            <h3 style="margin-top:1rem; text-align:center;">@${c.creator}</h3>
            ${statusLine}
            <p style="text-align:center;" class="hint">${new Date(c.publishedAt).toLocaleDateString()}</p>
        `;
        openModal('profileImageModal');
    }

    function openEditName() {
        if (!state.user) return;
        const input = $('editNameInput');
        if (!input) return;
        input.value = state.user.name || '';
        openModal('editNameModal');
        setTimeout(() => input.focus(), 100);
    }

    function saveProfileName() {
        if (!state.user) return;
        const input = $('editNameInput');
        if (!input) return;
        const name = (input.value || '').trim();
        if (!name || name.length < LIMITS.nameMin) { alert(`El nombre debe tener al menos ${LIMITS.nameMin} caracteres.`); input.focus(); return; }
        if (name.length > LIMITS.nameMax) { alert(`El nombre debe tener máximo ${LIMITS.nameMax} caracteres.`); return; }
        if (!/^[A-Za-z0-9_]+$/.test(name)) { alert('El nombre solo puede tener letras, números y guion bajo (sin espacios).'); input.focus(); return; }
        api('/auth/set-name', { method: 'POST', body: JSON.stringify({ name }) })
            .then(() => refreshAuthState())
            .then(() => {
                refreshUserUI();
                renderProfile();
                closeAll();
            })
            .catch(err => alert('No se pudo guardar el nombre: ' + err.message));
    }

    function openEditBio() {
        if (!state.user) return;
        const input = $('editBioInput');
        if (!input) return;
        input.value = state.user.bio || '';
        updateBioCounter();
        openModal('editBioModal');
        setTimeout(() => input.focus(), 100);
    }

    function updateBioCounter() {
        const input = $('editBioInput');
        const counter = $('bioCharCount');
        if (input && counter) counter.textContent = input.value.length;
    }

    function saveProfileBio() {
        if (!state.user) return;
        const input = $('editBioInput');
        if (!input) return;
        const bio = input.value.trim().slice(0, 150);
        state.user.bio = bio;
        saveProfileExtras(state.user.id, { bio, avatarData: state.user.avatarData });
        renderProfile();
        closeAll();
    }

    function pickAvatar() {
        const input = $('avatarInput');
        if (input) input.click();
    }

    function handleAvatarSelect(file) {
        if (!file || !file.type.startsWith('image/')) {
            alert('Por favor selecciona una imagen válida.');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            alert('La imagen es demasiado grande. Máximo 2 MB.');
            return;
        }
        fileToCompressedDataURL(file, 300, 0.85).then(dataUrl => {
            if (!state.user) return;
            state.user.avatarData = dataUrl;
            saveProfileExtras(state.user.id, { bio: state.user.bio, avatarData: dataUrl });
            refreshUserUI();
            renderProfile();
        }).catch(() => {
            alert('No se pudo procesar esa imagen. Probá con otra.');
        });
    }

    function deleteAccount() {
        if (!state.user) return;
        if (!confirm('¿Estás seguro? Se borrarán tu perfil y todos tus Curis subidos.')) return;
        if (!confirm('Esta acción no se puede deshacer. ¿Continuar?')) return;
        api('/account/delete-curis', { method: 'POST' }).catch(() => {})
            .then(() => api('/auth/logout', { method: 'POST' })).catch(() => {})
            .then(() => {
                state.user = null;
                refreshUserUI();
                closeAll();
                window.location.href = 'index.html';
            });
    }

    function initAdminPage() {
        api('/admin/me').then(res => {
            if (res.authed) showAdminPanel(); else showAdminGate();
        }).catch(() => showAdminGate());
    }

    function showAdminGate() {
        if ($('adminGate')) $('adminGate').style.display = 'block';
        if ($('adminPanel')) $('adminPanel').style.display = 'none';
    }

    function showAdminPanel() {
        if ($('adminGate')) $('adminGate').style.display = 'none';
        if ($('adminPanel')) $('adminPanel').style.display = 'block';
        renderAdminQueue(currentAdminFilter);
    }

    function adminLogin() {
        const input = $('adminPasswordInput');
        if (!input) return;
        api('/admin/login', { method: 'POST', body: JSON.stringify({ password: input.value }) })
            .then(() => {
                if ($('adminLoginError')) $('adminLoginError').style.display = 'none';
                input.value = '';
                showAdminPanel();
            })
            .catch(() => {
                if ($('adminLoginError')) $('adminLoginError').style.display = 'block';
            });
    }

    function adminLogout() {
        api('/admin/logout', { method: 'POST' }).catch(() => {}).then(showAdminGate);
    }

    function renderAdminQueue(filter) {
        currentAdminFilter = filter;
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.status === filter));

        api('/admin/queue?status=' + filter).then(data => {
            if ($('countPending')) $('countPending').textContent = data.counts.pending;
            if ($('countApproved')) $('countApproved').textContent = data.counts.approved;
            if ($('countRejected')) $('countRejected').textContent = data.counts.rejected;

            const list = data.items;
            const queue = $('adminQueue');
            const empty = $('adminEmpty');
            if (!queue) return;

            if (list.length === 0) {
                queue.innerHTML = '';
                if (empty) empty.style.display = 'block';
                return;
            }
            if (empty) empty.style.display = 'none';

            queue.innerHTML = list.map(c => {
                const bg = c.imageFile
                    ? `style="background-image:url('${c.imageFile}'); background-size:cover; background-position:center;"`
                    : `style="background: linear-gradient(135deg, ${c.color1}, ${c.color2});"`;
                const date = new Date(c.publishedAt).toLocaleString();
                let actions;
                if (filter === 'pending') {
                    actions = `
                        <button class="btn-primary btn-admin-approve" data-id="${c.id}" data-action="approved">✓ Aceptar</button>
                        <button class="btn-secondary btn-danger-strong" data-id="${c.id}" data-action="rejected">✕ Rechazar</button>
                    `;
                } else if (filter === 'rejected') {
                    // La imagen ya se borró de R2 al rechazar -- no tiene
                    // sentido "volver a pendiente", el creador tendría que
                    // subir el Curis de nuevo.
                    actions = `<p class="hint">Imagen borrada. Para republicarlo, el creador debe subirlo otra vez.</p>`;
                } else {
                    actions = `<button class="btn-secondary" data-id="${c.id}" data-action="pending">↺ Volver a pendiente</button>`;
                }
                return `
                    <div class="admin-card">
                        <div class="admin-card-img" ${bg}></div>
                        <div class="admin-card-body">
                            <p class="admin-card-creator">@${c.creator}</p>
                            <p class="hint">${date}</p>
                            <p class="hint">★ ${(c.avg || 0).toFixed(1)} · ${c.count || 0} calif.</p>
                            <div class="admin-card-actions">${actions}</div>
                        </div>
                    </div>
                `;
            }).join('');

            queue.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => setCurisStatus(btn.dataset.id, btn.dataset.action));
            });
        }).catch(() => {
            const queue = $('adminQueue');
            if (queue) queue.innerHTML = '<p class="hint">No se pudo cargar la cola de moderación (¿tu sesión de admin venció?).</p>';
        });
    }

    function setCurisStatus(id, status) {
        // Rechazar borra la imagen de R2 y no se puede deshacer -- se avisa.
        if (status === 'rejected' && !confirm('Rechazar este Curis borra su imagen definitivamente. ¿Seguro?')) return;
        api('/admin/curis/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) })
            .then(() => {
                renderAdminQueue(currentAdminFilter);
                const statusEl = $('adminSaveStatus');
                if (status === 'approved' && statusEl) {
                    statusEl.textContent = '✓ Curis aprobado y publicado';
                    statusEl.style.display = 'block';
                    setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
                }
            })
            .catch(err => alert('No se pudo actualizar el estado: ' + err.message));
    }

    function adminFlash(msg) {
        const el = $('adminSaveStatus');
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 6000);
    }

    function purgeRejected() {
        if (!confirm('¿Vaciar la lista de rechazados? Se borran definitivamente todos los Curis rechazados. No se puede deshacer.')) return;
        api('/admin/purge-rejected', { method: 'POST' })
            .then(res => {
                renderAdminQueue(currentAdminFilter);
                adminFlash('🗑️ Rechazados borrados: ' + (res.deleted || 0));
            })
            .catch(err => alert('No se pudo vaciar rechazados: ' + err.message));
    }

    function purgeAllCuris() {
        // Tres advertencias antes de borrar todo, la última pide escribir.
        if (!confirm('⚠️ ADVERTENCIA 1 de 3\n\nEsto borra TODOS los Curis: pendientes, aprobados y rechazados, con sus imágenes y todas sus calificaciones.\n\nLas cuentas de usuario NO se tocan.\n\n¿Continuar?')) return;
        if (!confirm('⚠️ ADVERTENCIA 2 de 3\n\nLa acción NO se puede deshacer y no hay copia de seguridad. El ranking queda vacío.\n\n¿Continuar?')) return;
        const typed = prompt('⚠️ ADVERTENCIA 3 de 3\n\nPara confirmar, escribí exactamente:  BORRAR TODO');
        if (typed !== 'BORRAR TODO') { alert('Cancelado (el texto no coincide).'); return; }
        api('/admin/purge-all-curis', { method: 'POST' })
            .then(res => {
                renderAdminQueue(currentAdminFilter);
                adminFlash('💥 Todos los Curis borrados: ' + (res.deleted || 0));
            })
            .catch(err => alert('No se pudo borrar todo: ' + err.message));
    }

    // Cursor personalizado: una bolita blanca que reemplaza al puntero en
    // pantallas con mouse (no toca celulares / pantallas táctiles). Si algo
    // falla, el navegador sigue mostrando el cursor nativo (la clase
    // cf-cursor-on que oculta el nativo solo se agrega si esto corre bien).
    function initCustomCursor() {
        if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;
        if (document.querySelector('.cf-cursor')) return;

        const dot = document.createElement('div');
        dot.className = 'cf-cursor is-hidden';
        document.body.appendChild(dot);
        document.documentElement.classList.add('cf-cursor-on');

        let x = window.innerWidth / 2, y = window.innerHeight / 2;
        let tx = x, ty = y, running = false;
        const INTERACTIVE = 'a,button,input,textarea,select,label,[role="button"],.main-btn,.star-icon,.menu-btn';

        function loop() {
            x += (tx - x) * 0.35;
            y += (ty - y) * 0.35;
            dot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
            if (Math.abs(tx - x) > 0.1 || Math.abs(ty - y) > 0.1) {
                requestAnimationFrame(loop);
            } else {
                running = false;
            }
        }
        function kick() { if (!running) { running = true; requestAnimationFrame(loop); } }

        document.addEventListener('pointermove', (e) => {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            tx = e.clientX; ty = e.clientY;
            dot.classList.remove('is-hidden');
            const el = e.target && e.target.closest ? e.target.closest(INTERACTIVE) : null;
            dot.classList.toggle('is-link', !!el);
            kick();
        }, { passive: true });
        document.addEventListener('pointerdown', () => dot.classList.add('is-down'));
        document.addEventListener('pointerup', () => dot.classList.remove('is-down'));
        window.addEventListener('blur', () => dot.classList.add('is-hidden'));
        document.addEventListener('mouseleave', () => dot.classList.add('is-hidden'));
        document.addEventListener('mouseenter', () => dot.classList.remove('is-hidden'));
    }

    function bind() {
        const page = document.body.dataset.page;

        if ($('googleBtn')) $('googleBtn').addEventListener('click', signInWithGoogle);
        if ($('modalGoogleBtn')) $('modalGoogleBtn').addEventListener('click', signInWithGoogle);
        if ($('saveNameBtn')) $('saveNameBtn').addEventListener('click', saveUsername);
        if ($('usernameInput')) $('usernameInput').addEventListener('keypress', e => { if (e.key === 'Enter') saveUsername(); });
        if ($('savePasswordBtn')) $('savePasswordBtn').addEventListener('click', savePassword);
        if ($('passwordInput')) $('passwordInput').addEventListener('keypress', e => { if (e.key === 'Enter') savePassword(); });
        if ($('logoutBtn')) $('logoutBtn').addEventListener('click', logout);
        if ($('myAccountBtn')) $('myAccountBtn').addEventListener('click', openAccount);
        const av = $('userAvatar');
        if (av) {
            av.addEventListener('click', () => {
                if (!isAuthenticated()) return;
                const menu = $('userMenu');
                menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'block' : 'none';
            });
        }
        const headerLogo = document.querySelector('.logo-mini');
        if (headerLogo && !headerLogo.getAttribute('href')) {
            headerLogo.addEventListener('click', (e) => { e.preventDefault(); });
        }

        const patreonBtn = $('patreonBtn');
        if (patreonBtn) {
            patreonBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (PATREON_URL) {
                    window.open(PATREON_URL, '_blank', 'noopener');
                } else {
                    alert('¡Muy pronto vas a poder apoyarnos acá! Todavía estamos armando la página de Patreon.');
                }
            });
        }

        document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeAll));
        if ($('modalOverlay')) $('modalOverlay').addEventListener('click', closeOnOverlay);

        if (page === 'rate') {
            if ($('starMinus')) $('starMinus').addEventListener('click', () => changeRating(-0.5));
            if ($('starPlus')) $('starPlus').addEventListener('click', () => changeRating(0.5));
            if ($('confirmRate')) $('confirmRate').addEventListener('click', submitRating);
            if ($('starLimitAdBtn')) $('starLimitAdBtn').addEventListener('click', extendStarsCap);
            document.querySelectorAll('.star-icon').forEach(s => {
                s.addEventListener('click', () => {
                    const pos = parseInt(s.dataset.pos, 10);
                    currentRating = pos;
                    updateStarsUI();
                    updateRateValueLabel();
                });
            });
        }

        if (page === 'upload') {
            if ($('pickFileBtn')) $('pickFileBtn').addEventListener('click', () => $('fileInput').click());
            if ($('fileInput')) $('fileInput').addEventListener('change', e => handleFileSelect(e.target.files[0]));
            if ($('publishBtn')) $('publishBtn').addEventListener('click', beginPublish);
            if ($('cancelPreviewBtn')) $('cancelPreviewBtn').addEventListener('click', resetUploadView);
            if ($('extraAdBtn')) $('extraAdBtn').addEventListener('click', () => { closeAll(); runUploadAd(); });
            if ($('successContinue')) $('successContinue').addEventListener('click', () => { closeAll(); resetUploadView(); });
        }

        if (page === 'admin') {
            if ($('adminLoginBtn')) $('adminLoginBtn').addEventListener('click', adminLogin);
            if ($('adminPasswordInput')) $('adminPasswordInput').addEventListener('keypress', e => { if (e.key === 'Enter') adminLogin(); });
            if ($('adminLogoutBtn')) $('adminLogoutBtn').addEventListener('click', adminLogout);
            if ($('purgeRejectedBtn')) $('purgeRejectedBtn').addEventListener('click', purgeRejected);
            if ($('purgeAllBtn')) $('purgeAllBtn').addEventListener('click', purgeAllCuris);
            document.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => renderAdminQueue(t.dataset.status)));
        }

        if (page === 'profile') {
            if ($('editNameBtn')) $('editNameBtn').addEventListener('click', openEditName);
            if ($('editBioBtn')) $('editBioBtn').addEventListener('click', openEditBio);
            if ($('editAvatarBtn')) $('editAvatarBtn').addEventListener('click', pickAvatar);
            if ($('avatarInput')) $('avatarInput').addEventListener('change', e => handleAvatarSelect(e.target.files[0]));
            if ($('saveNameProfileBtn')) $('saveNameProfileBtn').addEventListener('click', saveProfileName);
            if ($('saveBioBtn')) $('saveBioBtn').addEventListener('click', saveProfileBio);
            if ($('editNameInput')) $('editNameInput').addEventListener('keypress', e => { if (e.key === 'Enter') saveProfileName(); });
            if ($('editBioInput')) $('editBioInput').addEventListener('input', updateBioCounter);
            if ($('settingsLogoutBtn')) $('settingsLogoutBtn').addEventListener('click', () => { closeAll(); logout(); });
            if ($('settingsDeleteBtn')) $('settingsDeleteBtn').addEventListener('click', deleteAccount);
        }
    }

    // Marca el link del menú principal que corresponde a la página actual.
    function markCurrentNav() {
        const here = location.pathname.split('/').pop() || 'index.html';
        document.querySelectorAll('.site-nav a').forEach(a => {
            const target = a.getAttribute('href');
            if (target === here || (target === 'index.html' && (here === '' || here === 'index.html'))) {
                a.setAttribute('aria-current', 'page');
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        bind();
        initCustomCursor();
        markCurrentNav();
        const page = document.body.dataset.page;

        loadConfig().then(() => refreshAuthState()).then(() => {
            refreshUserUI();
            setupRealGoogleButtons();

            if (isAuthenticated() && (!isFullyRegistered() || needsPassword())) {
                promptRegistrationStep();
            }

            if (page === 'rate') initRatePage();
            if (page === 'ranking') initRankingPage();
            if (page === 'upload') initUploadPage();
            if (page === 'profile') initProfilePage();
            if (page === 'admin') initAdminPage();
        });
    });
})();
