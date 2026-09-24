'use strict';

/**
 * Pruebas unitarias de src/queries/costo-motor.js CON la base de datos
 * reemplazada por un doble de prueba (no --experimental-test-module-mocks:
 * db.js exporta un objeto mutable, y como este archivo lo requiere y lo
 * parcha ANTES de requerir costo-motor.js por primera vez en este proceso,
 * el `const { query } = require('../db')` de costo-motor.js captura la
 * versión parchada). node:test aísla cada archivo de test en su propio
 * proceso, así que este parche no se filtra a ningún otro test.
 *
 * El comportamiento de fondo (las fórmulas) ya está probado end-to-end
 * contra la base real en test/integration/motor-costeo.test.js; esto prueba
 * lo mismo pero de forma unitaria, con datos fijos y sin Docker.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/db');

// Todo el SQL que el motor le pasa a la base, en orden. Sirve para probar
// las guardas que viven DENTRO de la query (ej. que el gasto no planeado
// solo sume si esta aprobado): esas no se ven en el valor de retorno.
const sqlsVistos = [];

function fakeQuery(reglas) {
  return async (sql, params) => {
    sqlsVistos.push(sql);
    for (const [match, resultado] of reglas) {
      if (sql.includes(match)) return typeof resultado === 'function' ? resultado(params) : resultado;
    }
    return [];
  };
}

// Semana 2 de agosto 2026 (sáb 8 .. vie 14), sin festivos en este archivo
// (ninguna regla matchea 'FROM mp_holidays' -> holidaysSet vacío, mismo
// comportamiento que antes de sql/25).
db.query = fakeQuery([
  // Cualquier mes real resuelve a Agosto/2026 — EXCEPTO el mes centinela
  // "Junio-sin-datos", que simula un mes sin ninguna fila en
  // mp_costeo_task_facts (Costeo nunca lo cargó, aunque Planeación sí lo
  // tenga). Usado por los tests de regresión de más abajo.
  ['SELECT month_number, year_number', (params) =>
    (params && params[0] === 'Junio-sin-datos' ? [] : [{ month_number: 8, year_number: 2026 }])],
  // El costo laboral se atribuye por el proyecto de la TAREA (t.project_name),
  // no por la carpeta de la persona — este substring identifica esa query.
  ['cc.project_name = t.project_name', [
    { employee_id: 1, week_number: 2, month_number: 8, year_number: 2026, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 },
    { employee_id: 2, week_number: 2, month_number: 8, year_number: 2026, h_mon: 10, h_tue: 10, h_wed: 10, h_thu: 10, h_fri: 10, h_sat: 10, hourly_cost: 20 },
  ]],
  ['SUM(extra_cost_final)', [{ total: 150.5 }]],
  ['SUM(amount)', [{ total: 300 }]],
]);

const {
  mesANumero, mesYAnio, costoLaboralEjecutado, costoExtraAprobado,
  costoNoPlaneadoTotal, desgloseEjecutado, ejecutadoTotal,
} = require('../../src/queries/costo-motor');

test('mesYAnio: null si no se pasa mes', async () => {
  assert.strictEqual(await mesYAnio(null), null);
});

test('mesYAnio: resuelve mes y año a partir de mp_costeo_task_facts', async () => {
  assert.deepStrictEqual(await mesYAnio('Agosto'), { month: 8, year: 2026 });
});

test('mesANumero: devuelve solo el número de mes', async () => {
  assert.strictEqual(await mesANumero('Agosto'), 8);
});

test('mesANumero: null si no se pasa mes', async () => {
  assert.strictEqual(await mesANumero(null), null);
});

test('costoLaboralEjecutado: suma min(hEjec, legalHours) * tarifa por fila', async () => {
  // legalHours cae al default (46, mp_costeo_config no matchea ninguna regla).
  // fila1: min(40,46)*10 = 400 ; fila2: min(60,46)*20 = 920 -> 1320
  const total = await costoLaboralEjecutado(1);
  assert.strictEqual(total, 1320);
});

test('costoExtraAprobado: devuelve el total de la query, 0 si no hay filas', async () => {
  assert.strictEqual(await costoExtraAprobado(1), 150.5);
});

test('costoNoPlaneadoTotal: devuelve el total de la query', async () => {
  assert.strictEqual(await costoNoPlaneadoTotal(1), 300);
});

test('costoNoPlaneadoTotal: es 0 cuando se filtra por talento (el gasto es del proyecto, no de la persona)', async () => {
  assert.strictEqual(await costoNoPlaneadoTotal(1, { employee_id: 7 }), 0);
});

// Regresion (8 sep 2026, reportado por el usuario con un caso real:
// filtrar Indicadores por "Junio" — un mes que Planeacion tiene pero
// Costeo NO — mostraba horas y plata que no eran de junio). La causa:
// mesYAnio() devuelve null cuando el mes no esta en mp_costeo_task_facts,
// y costoExtraAprobado/costoNoPlaneadoTotal tenian un `if (periodo) {...}`
// que SOLO agregaba la condicion de mes/año cuando periodo no era null —
// si era null, la condicion de mes simplemente no se agregaba, y la query
// devolvia TODA la historia sin filtrar en vez de nada. Estos tests fuerzan
// ese null (mp_costeo_task_facts sin filas para el mes) y verifican que el
// resultado sea 0, sin llegar siquiera a la query de SUM.
test('mesYAnio: null si el mes pedido no tiene ninguna fila en mp_costeo_task_facts', async () => {
  assert.strictEqual(await mesYAnio('Junio-sin-datos'), null);
});

test('costoExtraAprobado: un mes sin datos en Costeo da 0 — NUNCA las horas extra de otros meses sin filtrar', async () => {
  // El mock global YA tiene 'SUM(extra_cost_final)' -> 150.5 (linea 48): si
  // el filtro de mes se saltara en silencio (el bug real), este test
  // recibiria 150.5 en vez de 0.
  const total = await costoExtraAprobado(1, { month: 'Junio-sin-datos' });
  assert.strictEqual(total, 0, 'debe cortar en 0 antes de llegar a la query de SUM');
});

test('costoNoPlaneadoTotal: un mes sin datos en Costeo da 0 — NUNCA los gastos de otros meses sin filtrar', async () => {
  // Mismo criterio: el mock global tiene 'SUM(amount)' -> 300 (linea 49).
  const total = await costoNoPlaneadoTotal(1, { month: 'Junio-sin-datos' });
  assert.strictEqual(total, 0, 'debe cortar en 0 antes de llegar a la query de SUM');
});

// sql/28: el gasto no planeado nace 'pendiente' y solo es dinero cuando
// admin/ceo lo aprueba. Si esta guarda se cae, un gasto pendiente (o uno
// rechazado) volveria a inflar el presupuesto ejecutado sin que nadie lo
// autorizara — y el valor de retorno se veria igual de normal.
test('costoNoPlaneadoTotal: solo suma los gastos aprobados', async () => {
  sqlsVistos.length = 0;
  await costoNoPlaneadoTotal(1);
  const sql = sqlsVistos.find((q) => q.includes('FROM mp_costo_no_planeado'));
  assert.ok(sql, 'deberia haber consultado mp_costo_no_planeado');
  assert.match(sql, /approval_status\s*=\s*'aprobado'/);
});

test('desgloseEjecutado: combina laboral + extra + noPlaneado', async () => {
  const d = await desgloseEjecutado(1);
  assert.strictEqual(d.laboral, 1320);
  assert.strictEqual(d.extra, 150.5);
  assert.strictEqual(d.noPlaneado, 300);
  assert.strictEqual(d.total, 1770.5);
});

// "Costo anterior" (previous_cost) se sumaba al total y se retiró en ago
// 2026 (ningún centro lo usaba). El desglose ya no debe traer ese campo ni
// leer la columna: si volviera a aparecer, estaría inflando el Ejecutado.
test('desgloseEjecutado: ya no incluye el costo histórico previo', async () => {
  const d = await desgloseEjecutado(1);
  assert.strictEqual(d.previousCost, undefined);
});

test('ejecutadoTotal: devuelve solo el total del desglose', async () => {
  assert.strictEqual(await ejecutadoTotal(1), 1770.5);
});
