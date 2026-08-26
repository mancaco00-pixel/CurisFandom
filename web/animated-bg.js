(function(){
    const bg = document.getElementById('bg');
    if (!bg) return;

    // En pantallas táctiles (celulares/tablets, la mayoría de los
    // "dispositivos malos") este efecto reactivo al mouse no aporta nada
    // real -- no hay cursor que sobrevuele la grilla -- y arrastrar el dedo
    // para hacer scroll disparaba touchmove todo el tiempo, haciendo que
    // scrollear se sintiera lento. Se desactiva del todo ahí: ni se
    // construye la grilla ni se arranca el loop de animación.
    const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (isCoarsePointer) return;

    bg.style.position = 'fixed';
    bg.style.inset = '0';
    bg.style.width = '100vw';
    bg.style.height = '100vh';
    bg.style.zIndex = '0';
    bg.style.overflow = 'hidden';
    bg.style.pointerEvents = 'none';

    const SIZE = 36;
    const GAP = 14;
    const STEP = SIZE + GAP;
    const RADIUS = 140;

    const COLORS = [
        [0, 255, 255],
        [255, 0, 255],
        [0, 200, 255],
        [180, 0, 255],
        [0, 255, 180]
    ];

    let cells = [];
    let cols = 0, rows = 0;
    let mouseX = -9999, mouseY = -9999;

    // Solo se procesan las celdas que están activas o recién dejaron de
    // estarlo (fade-out en curso). Antes se recorrían y reescribían los
    // estilos de TODAS las celdas de la grilla (cientos en pantallas
    // grandes) 60 veces por segundo, estén o no cerca del mouse -- eso era
    // el mayor costo de CPU/repintado de toda la página.
    let trackedIndices = new Set();

    function build(){
        bg.innerHTML = '';
        cells = [];
        trackedIndices.clear();
        const w = window.innerWidth;
        const h = window.innerHeight;
        cols = Math.ceil(w / STEP) + 1;
        rows = Math.ceil(h / STEP) + 1;
        for (let y = 0; y < rows; y++){
            for (let x = 0; x < cols; x++){
                const c = document.createElement('div');
                const px = x * STEP;
                const py = y * STEP;
                const colorIdx = (x + y) % COLORS.length;
                const col = COLORS[colorIdx];

                c.style.position = 'absolute';
                c.style.width = SIZE + 'px';
                c.style.height = SIZE + 'px';
                c.style.left = px + 'px';
                c.style.top = py + 'px';
                c.style.border = '1px solid rgba(255,255,255,0.08)';
                c.style.borderRadius = '4px';
                c.style.boxSizing = 'border-box';
                c.style.transformOrigin = 'center';
                c.style.transition = 'all 0.5s cubic-bezier(0.23, 1, 0.32, 1)';
                bg.appendChild(c);
                cells.push({
                    el: c,
                    cx: px + SIZE / 2,
                    cy: py + SIZE / 2,
                    col: col,
                    intensity: 0
                });
            }
        }
    }

    // En vez de recorrer las ~500+ celdas de toda la grilla, calcula solo
    // las columnas/filas dentro del radio de influencia alrededor del mouse
    // (unas pocas decenas como mucho) y las agrega al set a animar.
    function markNearbyActive(){
        const colCenter = mouseX / STEP;
        const rowCenter = mouseY / STEP;
        const spread = Math.ceil(RADIUS / STEP) + 1;
        const xStart = Math.max(0, Math.floor(colCenter - spread));
        const xEnd = Math.min(cols - 1, Math.ceil(colCenter + spread));
        const yStart = Math.max(0, Math.floor(rowCenter - spread));
        const yEnd = Math.min(rows - 1, Math.ceil(rowCenter + spread));
        for (let y = yStart; y <= yEnd; y++){
            for (let x = xStart; x <= xEnd; x++){
                trackedIndices.add(y * cols + x);
            }
        }
    }

    function animate(){
        if (mouseX > -9999) markNearbyActive();

        trackedIndices.forEach(function(i){
            const c = cells[i];
            if (!c) { trackedIndices.delete(i); return; }
            const dx = c.cx - mouseX;
            const dy = c.cy - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < RADIUS){
                const t = 1 - dist / RADIUS;
                const target = t * t;
                c.intensity += (target - c.intensity) * 0.12;
            } else {
                c.intensity += (0 - c.intensity) * 0.08;
            }

            if (c.intensity > 0.01){
                // Picos de brillo/blur bajados un poco (antes 0.92/0.7/20px)
                // para que el efecto sea vistoso pero no encandile.
                const I = c.intensity;
                const r = c.col[0];
                const g = c.col[1];
                const b = c.col[2];
                const alpha = (0.08 + I * 0.7).toFixed(2);
                const glowAlpha = (I * 0.5).toFixed(2);
                const scale = (1 + I * 0.4).toFixed(3);
                const bw = (1 + I * 2).toFixed(1);
                const blur = (I * 12).toFixed(0);

                c.el.style.borderColor = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
                c.el.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + (I * 0.12).toFixed(2) + ')';
                c.el.style.transform = 'scale(' + scale + ')';
                c.el.style.boxShadow = '0 0 ' + blur + 'px rgba(' + r + ',' + g + ',' + b + ',' + glowAlpha + '), inset 0 0 ' + (I * 6).toFixed(0) + 'px rgba(' + r + ',' + g + ',' + b + ',' + (I * 0.22).toFixed(2) + ')';
                c.el.style.borderWidth = bw + 'px';
                c.el.style.borderRadius = '6px';
            } else {
                c.el.style.borderColor = 'rgba(255,255,255,0.08)';
                c.el.style.backgroundColor = 'transparent';
                c.el.style.transform = 'scale(1)';
                c.el.style.boxShadow = 'none';
                c.el.style.borderWidth = '1px';
                trackedIndices.delete(i);
            }
        });
        requestAnimationFrame(animate);
    }

    window.addEventListener('mousemove', function(e){
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    window.addEventListener('mouseleave', function(){
        mouseX = -9999;
        mouseY = -9999;
    });

    window.addEventListener('resize', build);

    build();
    animate();
})();
