'use strict';

/**
 * Escapado de HTML por defecto.
 *
 * El problema que resuelve: todas las tablas y tarjetas de la app se pintan
 * con innerHTML y plantillas de texto. Cualquier dato que venga de la base
 * (nombre de proyecto, descripcion de un gasto, nombre de una persona,
 * cliente) se insertaba tal cual, asi que un PM podia registrar un gasto
 * llamado <img src=x onerror="..."> y ese codigo se ejecutaba despues en el
 * navegador de quien abriera el panel — incluido el CEO, que es la cuenta
 * con mas permisos. Existia un escapeHtml() pero habia que acordarse de
 * llamarlo, y en la practica solo se usaba en un par de sitios.
 *
 * La solucion es invertir el defecto: en vez de escapar cuando uno se
 * acuerda, se escapa siempre y hay que pedir explicitamente lo contrario.
 *
 *   tbody.innerHTML = h`<td>${gasto.description}</td>`;   // escapado
 *   grid.innerHTML  = h`<div>${raw(subplantilla)}</div>`; // HTML a proposito
 *
 * `raw()` es la unica puerta de salida, y se ve a simple vista en el diff:
 * si aparece envolviendo un dato en vez de una subplantilla ya construida,
 * es un error que salta a la vista en el code review.
 */

function escapeHtml(str) {
  // Marca de raw(): ya es HTML construido por nosotros, pasa sin tocar.
  if (str && typeof str === 'object' && typeof str.__html === 'string') return str.__html;
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Marca un fragmento como HTML ya seguro (subplantillas armadas con h`...`,
// o literales fijos del propio codigo). NUNCA envolver datos del servidor.
function raw(html) {
  return { __html: String(html ?? '') };
}

/**
 * Tag template que escapa CADA interpolacion.
 * Los arreglos se unen sin separador, para que `${filas.map(...)}` funcione
 * igual que hoy (cada elemento se escapa o se respeta segun sea texto o raw).
 */
function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += Array.isArray(v) ? v.map(escapeHtml).join('') : escapeHtml(v);
    out += strings[i + 1];
  }
  return out;
}

// En el navegador este archivo es un <script> normal y las tres funciones
// quedan globales. Este bloque solo se activa bajo Node, para que las
// pruebas (test/safe-html.test.js) puedan importarlo.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, raw, h };
}
