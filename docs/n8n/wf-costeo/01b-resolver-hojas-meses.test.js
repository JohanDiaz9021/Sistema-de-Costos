'use strict';

/**
 * Prueba de elegirHojas() del nodo "Resolver hoja del mes" de WF-COSTEO
 * (01b-resolver-hojas-meses.js).
 *
 * Correr con:  node --test docs/n8n/wf-costeo/01b-resolver-hojas-meses.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function cargar() {
  const src = fs.readFileSync(path.join(__dirname, '01b-resolver-hojas-meses.js'), 'utf8');
  const corte = src.indexOf('// ---- n8n:');
  assert.ok(corte > 0, 'no se encontro el marcador de la seccion de n8n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(0, corte)}; return { elegirHojas, ANIO_MINIMO, MES_MINIMO };`)();
}

const { elegirHojas, ANIO_MINIMO, MES_MINIMO } = cargar();

test('dentro de ANIO_MINIMO, deja pasar los meses desde el piso hasta el actual', () => {
  const { hojas } = elegirHojas(['Julio', 'Agosto', 'Septiembre', 'Octubre'], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre']);
});

test('salta los meses futuros', () => {
  const { hojas } = elegirHojas(['Septiembre', 'Octubre', 'Noviembre', 'Diciembre'], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre']);
});

test('salta las pestañas que no son meses', () => {
  const { hojas } = elegirHojas(['Datos', 'Septiembre', 'Control de Cambios', 'Octubre'], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre']);
});

test('reconoce el mes sin importar mayusculas, tildes ni espacios', () => {
  const { hojas } = elegirHojas(['SEPTIEMBRE', ' octubre '], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['SEPTIEMBRE', ' octubre ']);
});

test('devuelve los nombres REALES, porque Graph los pide exactos', () => {
  const { hojas } = elegirHojas(['Septiembre '], 9, ANIO_MINIMO);
  assert.strictEqual(hojas[0], 'Septiembre ');
});

test('dos pestañas del mismo mes: usa la primera, reporta la otra (evita contar doble)', () => {
  const { hojas, duplicadas } = elegirHojas(['Septiembre', 'septiembre ', 'Octubre'], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre']);
  assert.strictEqual(duplicadas.length, 1);
  assert.strictEqual(duplicadas[0].descartada, 'septiembre ');
});

test('ordena por mes aunque el libro las tenga desordenadas', () => {
  const { hojas } = elegirHojas(['Octubre', 'Septiembre'], 10, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre']);
});

test('un archivo sin pestañas de mes devuelve lista vacia', () => {
  assert.deepStrictEqual(elegirHojas(['Datos', 'Hoja1'], 9, ANIO_MINIMO).hojas, []);
  assert.deepStrictEqual(elegirHojas([], 9, ANIO_MINIMO).hojas, []);
});

// ---- El piso es UNIVERSAL: aplica a TODOS los proyectos por igual. Desde
// el 6 nov 2026 es septiembre 2026 ("los datos que recolectaremos es desde
// septiembre"); del 23 sep al 6 nov 2026 fue agosto. ----

test('EL CASO REAL: dentro de 2026, agosto y los meses anteriores quedan AFUERA para CUALQUIER proyecto', () => {
  const { hojas } = elegirHojas(['Enero', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre'], 11, 2026);
  assert.deepStrictEqual(hojas, ['Septiembre', 'Octubre', 'Noviembre'],
    'el piso es por pestaña, antes de saber que proyectos trae adentro: corta hasta agosto para todos');
});

test('septiembre 2026 SI entra: es el primer mes del piso, no queda afuera', () => {
  const { hojas } = elegirHojas(['Agosto', 'Septiembre'], 9, 2026);
  assert.deepStrictEqual(hojas, ['Septiembre']);
});

test(`el piso es ${MES_MINIMO}/${ANIO_MINIMO} exacto: un mes antes no entra`, () => {
  assert.strictEqual(MES_MINIMO, 9, 'septiembre');
  const { hojas } = elegirHojas(['Agosto'], 12, ANIO_MINIMO);
  assert.deepStrictEqual(hojas, []);
});

test('en un año DISTINTO a ANIO_MINIMO el piso no aplica: se lee desde enero', () => {
  const { hojas } = elegirHojas(['Enero', 'Febrero', 'Marzo'], 3, ANIO_MINIMO + 1);
  assert.deepStrictEqual(hojas, ['Enero', 'Febrero', 'Marzo'],
    'cada año vive en su propia carpeta de SharePoint; el año siguiente no hereda el piso');
});
