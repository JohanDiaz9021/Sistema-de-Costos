'use strict';

/**
 * Funciones puras de src/queries/_common.js (parseFilters, buildFilterClause,
 * baseWhere, notCancelledClause) — sin tocar la base de datos, así que se
 * pueden probar como unitarias de verdad. resolveScope() queda afuera a
 * propósito: hace una consulta real (mp_project_owners) y ya está cubierta
 * por los tests de integración (aislamiento.test.js, indicadores-planeacion.test.js
 * con ?leader=), donde sí tiene sentido probarla contra datos reales.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseFilters, parseDrilldownFilters, buildFilterClause, baseWhere, notCancelledClause,
} = require('../../src/queries/_common');

// ---------------------------------------------------------------
// parseFilters
// ---------------------------------------------------------------

test('parseFilters: valores ausentes quedan en null, no en undefined ni ""', () => {
  const f = parseFilters({});
  assert.deepStrictEqual(f, { month: null, week: null, project: null, employee_id: null, leader: null });
});

test('parseFilters: NO devuelve status ni tipo (son exclusivas del drilldown)', () => {
  // En Costeo `status` es el estado del centro de costos, que no tiene nada
  // que ver con el task_status del indicador 5: por eso esa clave no se
  // arrastra por todos los endpoints.
  const f = parseFilters({ status: 'Bloqueado', tipo: 'Interno' });
  assert.ok(!('status' in f));
  assert.ok(!('tipo' in f));
});

// ---------------------------------------------------------------
// parseDrilldownFilters (QA-07)
// ---------------------------------------------------------------

test('parseDrilldownFilters: conserva status y tipo, que parseFilters descartaba', () => {
  const f = parseDrilldownFilters({ status: 'Bloqueado', tipo: 'Interno', employee_id: '7' });
  assert.strictEqual(f.status, 'Bloqueado');
  assert.strictEqual(f.tipo, 'Interno');
  assert.strictEqual(f.employee_id, 7, 'y sigue haciendo todo lo que hacía parseFilters');
});

test('parseDrilldownFilters: sin status/tipo quedan en null, no undefined', () => {
  const f = parseDrilldownFilters({});
  assert.strictEqual(f.status, null);
  assert.strictEqual(f.tipo, null);
});

test('parseDrilldownFilters: status y tipo se fuerzan a string (llegan de la query)', () => {
  const f = parseDrilldownFilters({ status: 123, tipo: ['Interno'] });
  assert.strictEqual(typeof f.status, 'string');
  assert.strictEqual(typeof f.tipo, 'string');
});

test('parseFilters: castea week y employee_id a Number', () => {
  const f = parseFilters({ week: '3', employee_id: '42' });
  assert.strictEqual(f.week, 3);
  assert.strictEqual(f.employee_id, 42);
  assert.strictEqual(typeof f.week, 'number');
  assert.strictEqual(typeof f.employee_id, 'number');
});

test('parseFilters: month/project/leader quedan como string, aunque lleguen como otro tipo', () => {
  const f = parseFilters({ month: 'Agosto', project: 'ALFA', leader: 'ana@ejemplo.test' });
  assert.strictEqual(f.month, 'Agosto');
  assert.strictEqual(f.project, 'ALFA');
  assert.strictEqual(f.leader, 'ana@ejemplo.test');
});

test('parseFilters: week/employee_id como string "0" SI se castean a 0 (la cadena "0" es truthy)', () => {
  // Documenta el comportamiento actual a propósito: la condicion es
  // `q.week ? Number(q.week) : null` — la cadena nunca-vacia "0" pasa el
  // `if`, así que termina en el numero 0, no en null. Distinto seria
  // mandar week sin el campo (ver el test de "valores ausentes" arriba),
  // que sí cae en null.
  const f = parseFilters({ week: '0', employee_id: '0' });
  assert.strictEqual(f.week, 0);
  assert.strictEqual(f.employee_id, 0);
});

test('parseFilters: week/employee_id como NUMERO 0 (no string) SI caen en null', () => {
  // Aqui `q.week` es el numero 0, que es falsy de verdad -> toma la rama
  // `null`. La distincion importa porque req.query de Express SIEMPRE manda
  // strings, pero esta funcion tambien se usa en otros lugares con objetos
  // ya parseados.
  const f = parseFilters({ week: 0, employee_id: 0 });
  assert.strictEqual(f.week, null);
  assert.strictEqual(f.employee_id, null);
});

// ---------------------------------------------------------------
// buildFilterClause
// ---------------------------------------------------------------

test('buildFilterClause: sin filtros no agrega nada', () => {
  const r = buildFilterClause({});
  assert.strictEqual(r.clause, '');
  assert.deepStrictEqual(r.params, []);
});

test('buildFilterClause: combina week + project + employee_id, en ese orden, con el alias por defecto', () => {
  const r = buildFilterClause({ week: 2, project: 'ALFA', employee_id: 7 });
  assert.strictEqual(r.clause, ' AND t.week_number = ? AND t.project_folder = ? AND t.employee_id = ?');
  assert.deepStrictEqual(r.params, [2, 'ALFA', 7]);
});

test('buildFilterClause: usa el alias que se le pase, no el de por defecto', () => {
  const r = buildFilterClause({ project: 'BETA' }, 'x');
  assert.strictEqual(r.clause, ' AND x.project_folder = ?');
});

test('buildFilterClause: los valores nunca se interpolan en el SQL (siempre placeholders)', () => {
  const r = buildFilterClause({ project: "ALFA'; DROP TABLE mp_task_facts; --" });
  assert.ok(!r.clause.includes('DROP TABLE'), 'el valor no debe aparecer dentro del SQL');
  assert.strictEqual(r.params[0], "ALFA'; DROP TABLE mp_task_facts; --", 'debe viajar intacto como parametro');
});

// ---------------------------------------------------------------
// baseWhere
// ---------------------------------------------------------------

test('baseWhere: sin mes, usa el snapshot mas reciente de TODA la tabla', () => {
  const r = baseWhere({});
  assert.match(r.clause, /snapshot_date = \(SELECT MAX\(snapshot_date\) FROM mp_task_facts\)/);
  assert.ok(!r.clause.includes('month_name'), 'sin filtro de mes no debe filtrar por month_name');
  assert.deepStrictEqual(r.params, []);
});

test('baseWhere: con mes, usa el ultimo snapshot QUE TENGA datos de ese mes (soporta historico)', () => {
  const r = baseWhere({ month: 'Julio' });
  assert.match(r.clause, /WHERE month_name = \?/, 'la subconsulta debe acotar por mes, no mirar el snapshot global');
  assert.match(r.clause, /AND t\.month_name = \?/);
  assert.deepStrictEqual(r.params, ['Julio', 'Julio']);
});

test('baseWhere: usa el alias que se le pase', () => {
  const r = baseWhere({}, 'x');
  assert.match(r.clause, /^x\.snapshot_date/);
});

// ---------------------------------------------------------------
// notCancelledClause
// ---------------------------------------------------------------

test('notCancelledClause: NULL cuenta como no cancelado', () => {
  const c = notCancelledClause();
  assert.match(c, /IS NULL/);
});

test('notCancelledClause: compara en mayuscula/minuscula y sin espacios (LOWER+TRIM)', () => {
  const c = notCancelledClause('t');
  assert.match(c, /LOWER\(TRIM\(t\.task_status\)\)/);
  assert.match(c, /<> 'cancelado'/);
});

test('notCancelledClause: usa el alias que se le pase', () => {
  const c = notCancelledClause('x');
  assert.ok(c.includes('x.task_status'));
});
