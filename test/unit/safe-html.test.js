'use strict';

/**
 * Cubre el escapado de HTML del front (public/js/safe-html.js).
 *
 * Estas pruebas existen por un XSS almacenado real: las tablas de Costeo
 * pintaban con innerHTML el nombre del proyecto, la descripcion de un gasto
 * y el historial de acciones sin escapar, asi que un PM podia registrar un
 * gasto llamado <img src=x onerror="..."> y ese codigo se ejecutaba en el
 * navegador de quien abriera el panel — el CEO incluido.
 */

const test = require('node:test');
const assert = require('node:assert');

const { escapeHtml, raw, h } = require('../../public/js/safe-html');

test('escapeHtml neutraliza una etiqueta inyectada', () => {
  const ataque = '<img src=x onerror="alert(1)">';
  const salida = escapeHtml(ataque);
  assert.ok(!salida.includes('<img'), 'no debe quedar ninguna etiqueta viva');
  assert.strictEqual(salida, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('escapeHtml cierra la fuga por atributo (comilla simple y doble)', () => {
  // value="${dato}" con una comilla sin escapar deja colgar un onfocus.
  assert.strictEqual(escapeHtml('" onfocus="alert(1)'), '&quot; onfocus=&quot;alert(1)');
  assert.strictEqual(escapeHtml("' onfocus='alert(1)"), '&#39; onfocus=&#39;alert(1)');
});

test('escapeHtml trata null y undefined como cadena vacia, no como texto', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(0), '0');
});

test('escapeHtml escapa el & primero, sin doble escapado ni escapes rotos', () => {
  assert.strictEqual(escapeHtml('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('h`` escapa cada interpolacion', () => {
  const gasto = { description: '<script>robar()</script>', amount: 1000 };
  const fila = h`<td>${gasto.description}</td><td>${gasto.amount}</td>`;
  assert.ok(!fila.includes('<script>'));
  assert.strictEqual(fila, '<td>&lt;script&gt;robar()&lt;/script&gt;</td><td>1000</td>');
});

test('h`` une arreglos escapando cada elemento', () => {
  const nombres = ['ok', '<b>malo</b>'];
  assert.strictEqual(h`<p>${nombres}</p>`, '<p>ok&lt;b&gt;malo&lt;/b&gt;</p>');
});

test('raw() deja pasar HTML propio, y solo ese', () => {
  const sub = h`<span>${'<i>x</i>'}</span>`;
  const salida = h`<div>${raw(sub)}</div>`;
  assert.strictEqual(salida, '<div><span>&lt;i&gt;x&lt;/i&gt;</span></div>');
});
