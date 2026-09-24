'use strict';

/**
 * fechaNegocioISO() — la fecha de calendario colombiana de un instante.
 *
 * Por que existe: el contenedor corre en UTC (docker-compose.yml no le
 * define TZ) y GTC opera en Colombia, UTC-5 todo el año. El indicador #4
 * (Fecha de Quiebre Presupuestal) se calcula como "ahora + N semanas" y
 * antes se recortaba con `.toISOString().slice(0, 10)`, que corta por UTC:
 * entre las 7:00 p.m. y la medianoche hora de Colombia, en UTC ya es el dia
 * siguiente, asi que la fecha salia un dia adelantada. Cinco horas de cada
 * dia, todos los dias, sin que nada lo marcara como error.
 *
 * Estas pruebas fijan instantes UTC exactos (Date.UTC) en vez de usar el
 * reloj: asi el resultado no depende de la hora a la que se corra la suite
 * ni de la zona horaria de la maquina que la corre.
 *
 * Funcion pura: no toca la base.
 */

const test = require('node:test');
const assert = require('node:assert');

const { fechaNegocioISO } = require('../../src/lib/fecha-negocio');

test('fechaNegocioISO: a media mañana UTC coincide con la fecha colombiana', () => {
  // 4 sep 2026, 12:00 UTC = 7:00 a.m. en Colombia. Mismo dia en ambas.
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 8, 4, 12, 0)), '2026-09-04');
});

test('fechaNegocioISO: despues de las 7pm en Colombia NO se adelanta al dia siguiente', () => {
  // Este es el caso que rompia: 5 sep 02:00 UTC son las 9:00 p.m. del 4 de
  // septiembre en Colombia. toISOString() decia '2026-09-05'.
  const instante = Date.UTC(2026, 8, 5, 2, 0);
  assert.strictEqual(new Date(instante).toISOString().slice(0, 10), '2026-09-05', 'premisa: UTC ya paso de dia');
  assert.strictEqual(fechaNegocioISO(instante), '2026-09-04', 'en Colombia todavia es el 4');
});

test('fechaNegocioISO: justo en la medianoche colombiana ya es el dia nuevo', () => {
  // 5 sep 05:00 UTC = 5 sep 00:00 en Colombia (UTC-5).
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 8, 5, 5, 0)), '2026-09-05');
  // Un minuto antes sigue siendo el 4.
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 8, 5, 4, 59)), '2026-09-04');
});

test('fechaNegocioISO: cruza bien el fin de año', () => {
  // 1 ene 2027, 02:00 UTC = 31 dic 2026, 9:00 p.m. en Colombia.
  assert.strictEqual(fechaNegocioISO(Date.UTC(2027, 0, 1, 2, 0)), '2026-12-31');
});

test('fechaNegocioISO: Colombia no tiene horario de verano, el desfase es -5 todo el año', () => {
  // Mismo instante relativo en enero y en julio: si hubiera DST, uno de los
  // dos daria distinto. Ambos son 02:00 UTC = 9:00 p.m. del dia anterior.
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 0, 15, 2, 0)), '2026-01-14');
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 6, 15, 2, 0)), '2026-07-14');
});

test('fechaNegocioISO: siempre devuelve YYYY-MM-DD con ceros a la izquierda', () => {
  // El formato tiene que ser el que entiende MySQL y el que parsea
  // formatFecha() en el front: '2026-01-05', no '2026-1-5'.
  assert.strictEqual(fechaNegocioISO(Date.UTC(2026, 0, 5, 12, 0)), '2026-01-05');
  assert.match(fechaNegocioISO(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});
