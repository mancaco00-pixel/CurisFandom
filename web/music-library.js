/*
 * Librería de música de fondo para los Curis.
 *
 * Los .mp3 viven en el bucket de Cloudflare R2 (prefijo music/), no en el
 * repo. Para agregar una canción nueva:
 * 1. Subí el archivo .mp3 al bucket R2, dentro de la carpeta music/, desde
 *    el dashboard de Cloudflare (R2 -> tu bucket -> Upload). Usá un nombre
 *    limpio, sin espacios ni acentos: p.ej. mi-cancion.mp3
 * 2. Agregá una línea acá abajo, dentro de MUSIC_LIBRARY, con la URL
 *    pública completa (la misma base que R2_PUBLIC_BASE_URL):
 *      { id: 'mi-cancion', label: 'Nombre que ve la gente',
 *        src: 'https://pub-xxxx.r2.dev/music/mi-cancion.mp3' }
 *    El "id" es lo único que se guarda por Curis (no el archivo ni la URL,
 *    y opcionalmente un "@<segundo>" de arranque que elige quien sube el
 *    Curi), así que podés cambiar el nombre del archivo o el label después
 *    sin romper nada, siempre que no cambies el id de una canción ya usada.
 * 3. Listo -- va a aparecer sola en el selector de "subir.html" la próxima
 *    vez que se cargue la página, sin tocar ningún otro archivo.
 */
window.MUSIC_LIBRARY = [
    { id: 'among-us', label: 'Audio del meme de Among Us', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/among-us.mp3' },
    { id: 'baki-porque-te-mientes', label: 'BAKI – ¿Por qué te mientes?', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/baki-porque-te-mientes.mp3' },
    { id: 'coka-y-marihuana', label: 'Coka y marihuana', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/coka-y-marihuana.mp3' },
    { id: 'cumbia-del-c-mamut', label: 'Cumbia del C mamut', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/cumbia-del-c-mamut.mp3' },
    { id: 'cumbia-del-rio', label: 'Los Pikadientes de Caborca – La cumbia del río', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/cumbia-del-rio.mp3' },
    { id: 'al-gusto', label: 'Los Pikadientes de Caborca – Al Gusto', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/al-gusto.mp3' },
    { id: 'double-life', label: 'Pharrell Williams – Double Life', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/double-life.mp3' },
    { id: 'el-cable', label: 'Tulio Enrique León – El Cable', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/el-cable.mp3' },
    { id: 'el-chapo', label: 'El Chapo', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/el-chapo.mp3' },
    { id: 'el-piso-es-laburo', label: 'El piso es LABURO', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/el-piso-es-laburo.mp3' },
    { id: 'familia-peluche-intro', label: 'La Familia P. Luche – Intro', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/familia-peluche-intro.mp3' },
    { id: 'fiesta-factory', label: 'Vámonos de fiesta a Factory', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/fiesta-factory.mp3' },
    { id: 'frijolero', label: 'Molotov – Frijolero', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/frijolero.mp3' },
    { id: 'imperio-de-cartagena', label: 'El imperio de Cartagena', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/imperio-de-cartagena.mp3' },
    { id: 'invisible', label: 'Zeus x Crona & Julius Dreisig – Invisible', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/invisible.mp3' },
    { id: 'jane', label: 'The Long Faces – Jane!', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/jane.mp3' },
    { id: 'judas', label: 'Lady Gaga – Judas', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/judas.mp3' },
    { id: 'boss', label: 'Lil Pump – Boss', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/boss.mp3' },
    { id: 'menea-tu-chapa', label: "Wilo D' New – Menea tu chapa", src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/menea-tu-chapa.mp3' },
    { id: 'musica-de-peleita', label: 'Música de peleíta', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/musica-de-peleita.mp3' },
    { id: 'ponernos-serios', label: 'Es hora de ponernos serios', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/ponernos-serios.mp3' },
    { id: 'que-maldicion', label: 'Qué maldición (versión Teto)', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/que-maldicion.mp3' },
    { id: 'rojo-vivo', label: 'Octavio Mesa – Rojo Vivo', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/rojo-vivo.mp3' },
    { id: 'seavolution', label: 'Seavolution', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/seavolution.mp3' },
    { id: 'seguidor-de-la-grasa', label: 'Yo era seguidor de la grasa', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/seguidor-de-la-grasa.mp3' },
    { id: 'skrillex', label: 'Skrillex', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/skrillex.mp3' },
    { id: 'toma-que-toma', label: 'Los Ángeles Azules – Toma que toma', src: 'https://pub-e8588ba3cc264d52aa86a6e651fbfd77.r2.dev/music/toma-que-toma.mp3' },
];
