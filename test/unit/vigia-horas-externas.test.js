'use strict';

/**
 * Vigía de horas cargadas por fuera de la app
 * (src/services/vigia-horas-externas.js).
 *
 * Se prueba la POLITICA: cuándo vacía la caché y cuándo no. La lectura de
 * la base y la invalidación se inyectan.
 */

const test = require('node:test');
const assert = require('node:assert');

const { tick, resetVigia } = require('../../src/services/vigia-horas-externas');

function espia() {
  let llamadas = 0;
  const fn = () => { llamadas += 1; };
  fn.llamadas = () => llamadas;
  return fn;
}

test('la primera lectura solo fija la línea base, no vacía la caché', async () => {
  resetVigia();
  const invalidar = espia();
  assert.strictEqual(await tick({ leer: async () => '100:5000', invalidar }), false);
  assert.strictEqual(invalidar.llamadas(), 0);
});

test('si la tabla no cambió, no vacía la caché', async () => {
  resetVigia();
  const invalidar = espia();
  await tick({ leer: async () => '100:5000', invalidar });
  assert.strictEqual(await tick({ leer: async () => '100:5000', invalidar }), false);
  assert.strictEqual(invalidar.llamadas(), 0);
});

test('EL CASO QUE SE REPORTÓ: n8n recargó el día (sube el fact_id) -> vacía la caché', async () => {
  resetVigia();
  const invalidar = espia();
  await tick({ leer: async () => '100:5000', invalidar });
  // Misma cantidad de filas (la misma carga repetida), pero ids nuevos.
  assert.strictEqual(await tick({ leer: async () => '5100:5000', invalidar }), true);
  assert.strictEqual(invalidar.llamadas(), 1);
});

test('un borrado sin inserción (baja el conteo) también vacía la caché', async () => {
  resetVigia();
  const invalidar = espia();
  await tick({ leer: async () => '100:5000', invalidar });
  assert.strictEqual(await tick({ leer: async () => '100:4800', invalidar }), true);
});

test('un error al leer no revienta ni vacía la caché, y no pierde la línea base', async () => {
  resetVigia();
  const invalidar = espia();
  await tick({ leer: async () => '100:5000', invalidar });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(await tick({ leer: async () => { throw new Error('base caída'); }, invalidar }), false);
  } finally {
    // No hay carrera: las pruebas de este archivo corren en serie.
    // eslint-disable-next-line require-atomic-updates
    console.error = errorOriginal;
  }
  assert.strictEqual(invalidar.llamadas(), 0);
  // La base vuelve con los mismos datos: no hay nada que vaciar.
  assert.strictEqual(await tick({ leer: async () => '100:5000', invalidar }), false);
});

test('si una pasada sigue corriendo, la siguiente se salta (no apila consultas)', async () => {
  resetVigia();
  const invalidar = espia();
  let soltar;
  const lenta = tick({ leer: () => new Promise((r) => { soltar = () => r('100:5000'); }), invalidar });
  assert.strictEqual(await tick({ leer: async () => '999:1', invalidar }), false);
  soltar();
  await lenta;
  assert.strictEqual(invalidar.llamadas(), 0);
});
