'use strict';

/**
 * Logica pura del modulo de Costeo: la descripcion del historial y el rango
 * de fechas del filtro de periodo.
 *
 * rangoMes() se prueba aparte porque reemplaza a `MONTH(expense_date) = ?`,
 * que ignoraba el año: filtrar "Agosto" sumaba los gastos de agosto de TODOS
 * los años en el mismo total.
 */

const test = require('node:test');
const assert = require('node:assert');

const { describirCambios } = require('../../src/queries/costo-audit');
const { rangoMes } = require('../../src/queries/costo-motor');
const { estadoPresupuestal } = require('../../src/queries/costo-comercial');
const { pool } = require('../../src/db');

// Los modulos de arriba abren el pool al cargarse (nunca se conectan aqui:
// estas pruebas no tocan la base). Se cierra para que el proceso termine.
test.after(() => pool.end());

test('rangoMes arma el primer dia del mes con su año', () => {
  assert.deepStrictEqual(rangoMes({ month: 8, year: 2026 }), { desde: '2026-08-01' });
  // Un digito: debe quedar con cero a la izquierda o MySQL no lo parsea.
  assert.deepStrictEqual(rangoMes({ month: 1, year: 2026 }), { desde: '2026-01-01' });
});

test('rangoMes distingue el mismo mes de años distintos', () => {
  // Este era el bug: los dos caian en MONTH(expense_date) = 8 y se sumaban.
  assert.notDeepStrictEqual(rangoMes({ month: 8, year: 2025 }), rangoMes({ month: 8, year: 2026 }));
});

test('rangoMes sin periodo devuelve null (no filtra nada)', () => {
  assert.strictEqual(rangoMes(null), null);
  assert.strictEqual(rangoMes(undefined), null);
});

test('describirCambios solo lista lo que de verdad cambio', () => {
  const antes = { budget: 10000, status: 'vigente', project_name: 'MIA' };
  const despues = { budget: 12000, status: 'vigente' };
  const desc = describirCambios(antes, despues, {
    budget: 'Presupuesto', status: 'Estado', project_name: 'Nombre',
  });
  assert.strictEqual(desc, 'Presupuesto: 10000 → 12000');
});

test('describirCambios ignora campos que no vienen en el cuerpo', () => {
  const desc = describirCambios({ budget: 1, status: 'vigente' }, { budget: 2 }, {
    budget: 'Presupuesto', status: 'Estado',
  });
  assert.ok(!desc.includes('Estado'));
});

test('describirCambios no marca cambio falso por tipo (12000 vs "12000")', () => {
  const desc = describirCambios({ budget: 12000 }, { budget: '12000' }, { budget: 'Presupuesto' });
  assert.strictEqual(desc, 'Sin cambios detectados');
});

test('describirCambios muestra — cuando el valor estaba vacio', () => {
  const desc = describirCambios({ client_name: null }, { client_name: 'ACME' }, { client_name: 'Cliente' });
  assert.strictEqual(desc, 'Cliente: — → ACME');
});

test('describirCambios usa el formateador cuando se le pasa uno', () => {
  const desc = describirCambios({ is_active: 1 }, { is_active: false }, { is_active: 'Activo' }, {
    is_active: (v) => (v ? 'Sí' : 'No'),
  });
  assert.strictEqual(desc, 'Activo: Sí → No');
});

// ---------------------------------------------------------------
// Bandas de Ejecucion Presupuestal (11 sep 2026, a pedido explicito):
// 0-70 dentro del presupuesto, 71-90 en riesgo, 91 o mas sobre-ejecutado.
// Antes la alarma empezaba recien al pasar el techo (100 / 120), o sea
// cuando el problema ya estaba hecho.
// ---------------------------------------------------------------

test('estadoPresupuestal: los limites exactos de cada banda', () => {
  assert.strictEqual(estadoPresupuestal(0), 'sin_riesgo');
  assert.strictEqual(estadoPresupuestal(70), 'sin_riesgo', '70 todavia es "dentro"');
  assert.strictEqual(estadoPresupuestal(70.1), 'en_riesgo', 'pasado 70 ya es riesgo');
  assert.strictEqual(estadoPresupuestal(90), 'en_riesgo', '90 todavia es riesgo');
  assert.strictEqual(estadoPresupuestal(90.1), 'perdida', 'pasado 90 ya es sobre-ejecutado');
  assert.strictEqual(estadoPresupuestal(100), 'perdida');
  assert.strictEqual(estadoPresupuestal(416.7), 'perdida', 'pasarse del techo sigue cayendo aqui');
});

// Sin presupuesto cargado no hay contra que comparar: no se puede inventar
// que esta "dentro" solo porque el porcentaje no existe.
test('estadoPresupuestal: sin presupuesto es "no aplica", no "sin riesgo"', () => {
  assert.strictEqual(estadoPresupuestal(null), 'no_aplica');
  assert.strictEqual(estadoPresupuestal(undefined), 'no_aplica');
});
