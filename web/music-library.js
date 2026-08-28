/*
 * Librería de música de fondo para los Curis.
 *
 * Los .mp3 viven en el bucket de Cloudflare R2 (prefijo music/), no en el
 * repo. Para agregar una canción nueva:
 * 1. Subí el archivo .mp3 al bucket R2, dentro de la carpeta music/, desde
 *    el dashboard de Cloudflare (R2 -> tu bucket -> Upload).
 * 2. Agregá una línea acá abajo, dentro de MUSIC_LIBRARY, con la URL
 *    pública completa del archivo (la misma base que R2_PUBLIC_BASE_URL):
 *      { id: 'un-id-unico', label: 'Nombre que va a ver la gente',
 *        src: 'https://pub-xxxx.r2.dev/music/archivo.mp3' }
 *    El "id" es lo único que se guarda por Curis (no el archivo ni la URL),
 *    así que podés cambiar el nombre del archivo o el label después sin
 *    romper nada, siempre que no cambies el id de una canción ya usada.
 * 3. Listo -- va a aparecer sola en el selector de "subir.html" la próxima
 *    vez que se cargue la página, sin tocar ningún otro archivo.
 */
window.MUSIC_LIBRARY = [
    // { id: 'ejemplo', label: 'Nombre de ejemplo', src: 'https://pub-xxxx.r2.dev/music/ejemplo.mp3' },
];
