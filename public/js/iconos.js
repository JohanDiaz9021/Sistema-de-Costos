'use strict';

/**
 * Iconos SVG compartidos por las dos pantallas del sistema (Planeacion y
 * Costeo). Vivia dentro de costeo-core.js, pero Planeacion no carga ese
 * archivo y tenia los mismos emojis que se quitaron de Costeo, asi que el
 * set se saco aparte para no copiarlo.
 *
 * Se carga ANTES que el resto de scripts de cada pagina: tanto el HTML
 * estatico (huecos data-ico) como el HTML generado desde JS dependen de el.
 */

// ===================== Iconos =====================
// Set de iconos SVG del modulo (11 sep 2026, a pedido explicito: "cambia
// todos los emojis por iconos"). Los emojis se veian distintos en cada
// sistema operativo, no heredaban el color del texto y desentonaban con los
// iconos del menu lateral, que ya eran SVG.
//
// FUENTE UNICA: este mapa. El HTML no los escribe a mano — marca el hueco con
// <span class="cst-ico" data-ico="nombre"></span> y pintarIconos() lo rellena
// al arrancar; el HTML generado desde JS llama a icono('nombre') directo.
//
// Todos comparten el mismo lenguaje: 24x24, trazo de 2, sin relleno y en
// currentColor, asi que toman el color y el tamano de la letra que los rodea
// (ver .cst-ico en costeo.css).
const ICONOS = {
  indicadores: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
  alertas: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  caja: '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/>',
  comercial: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  candado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  persona: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/><path d="M17 8a3 3 0 1 1 0 6"/><path d="M17.5 14.2c2.5.5 4.5 2.6 4.5 5.8"/>',
  personas: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/><path d="M17 8a3 3 0 1 1 0 6"/><path d="M17.5 14.2c2.5.5 4.5 2.6 4.5 5.8"/>',
  etiqueta: '<path d="M20.59 13.41 13 21l-9-9V4h8l9 9a2 2 0 0 1-.41 1.41z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  recibo: '<path d="M7 3h10a1 1 0 0 1 1 1v16l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1Z"/><path d="M9 8h6M9 12h6"/>',
  cronometro: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/>',
  reloj: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  engranaje: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  matraz: '<path d="M9 3h6"/><path d="M10 3v6.5L4.8 18.6A2 2 0 0 0 6.5 21.6h11a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7.5 15h9"/>',
  brujula: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2z"/>',
  descargar: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
  subir: '<path d="M12 21V9"/><path d="m7 13 5-5 5 5"/><path d="M5 4h14"/>',
  tabla: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>',
  camara: '<path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  basura: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  advertencia: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  campana: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  balanza: '<path d="M12 4v16"/><path d="M7 20h10"/><path d="M6 8h12"/><path d="m3 14 3-6 3 6a3 3 0 0 1-6 0Z"/><path d="m15 14 3-6 3 6a3 3 0 0 1-6 0Z"/>',
  calculadora: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8"/>',
  dinero: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.5 9.5a2.5 2.5 0 0 0-5 .5c0 2.5 5 1.5 5 4a2.5 2.5 0 0 1-5 .5"/>',
  calendario: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  luna: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  media_luna: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18Z"/>',
  carpeta: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  regla: '<path d="M3 21h18L3 3Z"/><path d="M9 21v-4M14 21v-7"/>',
  llave: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 2 2"/><path d="m14 9 2 2"/>',
  trofeo: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 6H5a3 3 0 0 0 3 3"/><path d="M16 6h3a3 3 0 0 1-3 3"/><path d="M12 13v4"/><path d="M9 21h6"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="m5 12 5 5L20 6"/>',
  cerrar: '<path d="M6 6l12 12M18 6 6 18"/>',
  documento: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  imagen: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 5-5 4 4 2-2 3 3"/>',
  expandir: '<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M16 21h5v-5"/><path d="M8 21H3v-5"/>',
  estrella: '<path d="m12 3 2.7 5.9 6.3.7-4.7 4.3 1.3 6.1L12 17l-5.6 3 1.3-6.1L3 9.6l6.3-.7Z"/>',
};

// El SVG completo de un icono, listo para interpolar en una plantilla.
// `extra` agrega clases (por ejemplo tamanos puntuales).
function icono(nombre, extra = '') {
  const trazos = ICONOS[nombre];
  if (!trazos) return '';
  return `<span class="cst-ico ${extra}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${trazos}</svg></span>`;
}

// Rellena los huecos que deja el HTML estatico. Se llama al arrancar, antes
// de pedir datos, y despues de cualquier render que reinserte huecos.
function pintarIconos(raiz = document) {
  raiz.querySelectorAll('.cst-ico[data-ico]:empty').forEach((el) => {
    const trazos = ICONOS[el.dataset.ico];
    if (!trazos) return;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${trazos}</svg>`;
  });
}
