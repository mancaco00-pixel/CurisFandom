(function(){
    const host = document.getElementById('bg');
    if (!host) return;

    // En pantallas táctiles no hay cursor que sobrevuele la grilla y el
    // touchmove durante el scroll lo hacía ir lento -> desactivado del todo.
    const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (isCoarsePointer) return;

    // Si el usuario pidió menos movimiento a nivel sistema, se respeta.
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    // ------------------------------------------------------------------
    // Fondo de grilla, reescrito para que NO genere lag:
    //   * la grilla base se dibuja UNA sola vez en un canvas offscreen y
    //     cada frame se copia de un saque (drawImage) -- no se re-trazan
    //     las ~900 celdas por frame;
    //   * las celdas cerca del mouse solo BRILLAN (glow por capas de relleno
    //     translúcido) -- ya no se agrandan/escalan, que era lo que obligaba
    //     a repintar zonas grandes;
    //   * sin shadowBlur (es de lo más caro del canvas 2D);
    //   * el loop se DETIENE con el mouse quieto y se reanuda al moverlo;
    //   * devicePixelRatio limitado a 1.5, y todo se corta si la pestaña
    //     pasa a segundo plano.
    // ------------------------------------------------------------------

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;pointer-events:none;';
    host.innerHTML = '';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const grid = document.createElement('canvas');
    const gctx = grid.getContext('2d');

    const SIZE = 36;
    const GAP = 14;
    const STEP = SIZE + GAP;
    const RADIUS = 140;
    const RADIUS2 = RADIUS * RADIUS;

    const COLORS = [
        [0, 255, 255],
        [255, 0, 255],
        [0, 200, 255],
        [180, 0, 255],
        [0, 255, 180]
    ];

    let dpr = 1;
    let cssW = 0, cssH = 0;
    let cols = 0, rows = 0;
    let mouseX = -9999, mouseY = -9999;
    let running = false;
    let rafId = 0;
    let idleFrames = 0;

    const active = new Map(); // indice -> intensidad (0..1)

    function colorFor(x, y){
        return COLORS[(x + y) % COLORS.length];
    }

    function resize(){
        cssW = window.innerWidth;
        cssH = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 1.5);

        canvas.width = grid.width = Math.round(cssW * dpr);
        canvas.height = grid.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        cols = Math.ceil(cssW / STEP) + 1;
        rows = Math.ceil(cssH / STEP) + 1;

        // Grilla base: una sola vez.
        gctx.clearRect(0, 0, cssW, cssH);
        gctx.lineWidth = 1;
        gctx.strokeStyle = 'rgba(255,255,255,0.08)';
        gctx.beginPath();
        for (let y = 0; y < rows; y++){
            const py = y * STEP + 0.5;
            for (let x = 0; x < cols; x++){
                gctx.rect(x * STEP + 0.5, py, SIZE, SIZE);
            }
        }
        gctx.stroke();

        render();
    }

    function markNearby(){
        if (mouseX <= -9999) return;
        const spread = Math.ceil(RADIUS / STEP) + 1;
        const cx = Math.round(mouseX / STEP);
        const cy = Math.round(mouseY / STEP);
        const xs = Math.max(0, cx - spread), xe = Math.min(cols - 1, cx + spread);
        const ys = Math.max(0, cy - spread), ye = Math.min(rows - 1, cy + spread);
        for (let y = ys; y <= ye; y++){
            for (let x = xs; x <= xe; x++){
                const i = y * cols + x;
                if (!active.has(i)) active.set(i, 0);
            }
        }
    }

    function render(){
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(grid, 0, 0, cssW, cssH);

        active.forEach(function(I, i){
            if (I <= 0.01) return;
            const x = i % cols;
            const y = (i - x) / cols;
            const px = x * STEP;
            const py = y * STEP;
            const col = colorFor(x, y);
            const rgb = col[0] + ',' + col[1] + ',' + col[2];

            // Glow por capas: sin escalar la celda, solo halos translúcidos
            // alrededor del cuadrado en su tamaño real.
            ctx.fillStyle = 'rgba(' + rgb + ',' + (I * 0.06).toFixed(3) + ')';
            ctx.fillRect(px - 10, py - 10, SIZE + 20, SIZE + 20);
            ctx.fillStyle = 'rgba(' + rgb + ',' + (I * 0.12).toFixed(3) + ')';
            ctx.fillRect(px - 4, py - 4, SIZE + 8, SIZE + 8);
            ctx.fillStyle = 'rgba(' + rgb + ',' + (I * 0.20).toFixed(3) + ')';
            ctx.fillRect(px, py, SIZE, SIZE);

            ctx.lineWidth = 1 + I;
            ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.08 + I * 0.8).toFixed(3) + ')';
            ctx.strokeRect(px + 0.5, py + 0.5, SIZE, SIZE);
        });
    }

    function tick(){
        markNearby();

        let anyActive = false;
        active.forEach(function(I, i){
            const x = i % cols;
            const y = (i - x) / cols;
            const dx = (x * STEP + SIZE / 2) - mouseX;
            const dy = (y * STEP + SIZE / 2) - mouseY;
            const d2 = dx * dx + dy * dy;

            let target = 0;
            if (d2 < RADIUS2){
                const t = 1 - Math.sqrt(d2) / RADIUS;
                target = t * t;
            }
            I += (target - I) * (target > I ? 0.14 : 0.08);

            if (I < 0.01 && target === 0){
                active.delete(i);
            } else {
                active.set(i, I);
                anyActive = true;
            }
        });

        render();

        if (!anyActive) {
            if (++idleFrames > 30) { stop(); return; }
        } else {
            idleFrames = 0;
        }
        rafId = requestAnimationFrame(tick);
    }

    function start(){
        if (running) return;
        running = true;
        idleFrames = 0;
        rafId = requestAnimationFrame(tick);
    }

    function stop(){
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    window.addEventListener('mousemove', function(e){
        mouseX = e.clientX;
        mouseY = e.clientY;
        start();
    }, { passive: true });

    window.addEventListener('mouseleave', function(){
        mouseX = -9999;
        mouseY = -9999;
    });

    window.addEventListener('resize', resize);

    document.addEventListener('visibilitychange', function(){
        if (document.hidden) stop();
    });

    resize();
})();
