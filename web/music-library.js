/*
 * Librería de música de fondo para los Curis.
 *
 * Para agregar una canción nueva:
 * 1. Poné el archivo de audio (.mp3) dentro de web/assets/music/.
 * 2. Agregá una línea acá abajo, dentro de MUSIC_LIBRARY:
 *      { id: 'un-id-unico', label: 'Nombre que va a ver la gente', src: 'assets/music/archivo.mp3' }
 *    El "id" es lo único que se guarda por Curis (no el archivo ni la URL),
 *    así que podés cambiar el nombre del archivo o el label después sin
 *    romper nada, siempre que no cambies el id de una canción ya usada.
 * 3. Listo -- va a aparecer sola en el selector de "subir.html" la próxima
 *    vez que se cargue la página, sin tocar ningún otro archivo.
 */
window.MUSIC_LIBRARY = [
    // { id: 'ejemplo', label: 'Nombre de ejemplo', src: 'assets/music/ejemplo.mp3' },
];
