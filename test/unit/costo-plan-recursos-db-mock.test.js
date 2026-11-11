'use strict';

/**
 * validarFilasPlan() con la base reemplazada por un doble de prueba —
 * misma técnica que costo-motor-db-mock.test.js: parchar db.query ANTES de
 * requerir el módulo bajo prueba. Cubre la rama "por Persona" que
 * costo-plan-recursos-puro.test.js no puede probar sin tocar la base
 * (obtenerCostoHoraPersona y getParametrosNomina hacen SELECT de verdad).
 *
 * Es la corrección del 2 sep 2026 (hallazgo reportado por un PM real): una
 * fila "por Persona" sin salario conocido en ningún lado ahora puede traer
 * `monthly_salary`, y el servidor calcula el costo/hora desde ESE valor en
 * vez de rechazar la fila sin más salida.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/db');

function fakeQuery(reglas) {
  return async (sql) => {
    for (const [match, resultado] of reglas) {
      if (sql.includes(match)) return typeof resultado === 'function' ? resultado() : resultado;
    }
    return [];
  };
}

// Sin fila en mp_equipo_proyecto (nadie conoce su salario) y sin fila en
// mp_costeo_config (getConfigNumber cae al default de CONFIG_DEFAULTS:
// horas_mes_liquidacion = 210) — el escenario exacto del hallazgo: una
// persona que nunca ha estado en ningún equipo.
db.query = fakeQuery([
  ['FROM mp_equipo_proyecto', []],
  ['FROM mp_costeo_config', []],
]);

const { validarFilasPlan, eliminarPlanRecursos } = require('../../src/queries/costo-plan-recursos');

const ROLES = new Set(['desarrollador']);

test('validarFilasPlan: persona sin salario conocido pero con monthly_salary en la fila SÍ se acepta', async () => {
  const r = await validarFilasPlan(
    [{ role_catalog: 'desarrollador', employee_id: 99, horas_totales: 10, monthly_salary: 2100000 }],
    ROLES
  );
  assert.strictEqual(r.error, undefined, JSON.stringify(r));
  assert.strictEqual(r.filas[0].costo_hora, 10000, '2.100.000 / 210 (default) = 10.000');
  assert.strictEqual(r.filas[0].personas, 1);
});

test('validarFilasPlan: la fila queda marcada con salarioNuevo, para que crearEquipoDesdeFilasPlanTx sepa que hay que darla de alta', () => {
  return validarFilasPlan(
    [{ role_catalog: 'desarrollador', employee_id: 99, horas_totales: 10, monthly_salary: 2100000 }],
    ROLES
  ).then((r) => {
    assert.strictEqual(r.filas[0].salarioNuevo, 2100000);
  });
});

test('validarFilasPlan: sin monthly_salary y sin salario conocido, se rechaza con el mensaje que dice qué falta', async () => {
  const r = await validarFilasPlan(
    [{ role_catalog: 'desarrollador', employee_id: 99, horas_totales: 10 }],
    ROLES
  );
  assert.match(r.error, /no tiene un salario cargado/);
  assert.match(r.error, /escribe su salario mensual/);
});

test('validarFilasPlan: monthly_salary en 0 se trata igual que no mandarlo (se rechaza)', async () => {
  const r = await validarFilasPlan(
    [{ role_catalog: 'desarrollador', employee_id: 99, horas_totales: 10, monthly_salary: 0 }],
    ROLES
  );
  assert.match(r.error, /no tiene un salario cargado/);
});

// ---------------------------------------------------------------
// eliminarPlanRecursos: atomicidad (14 sep 2026, corregido tras revisión de
// código) — las 3 sentencias (2 DELETE + 1 UPDATE) van ahora en una sola
// transacción. Se mockea pool.getConnection y no db.query: withTransaction
// no pasa por query(), abre su propia conexión y llama exec() sobre ella.
// ---------------------------------------------------------------

test('eliminarPlanRecursos: si la 3ra sentencia falla, hace ROLLBACK y no COMMIT (todo o nada)', async () => {
  const ejecutadas = [];
  let commitLlamado = false;
  let rollbackLlamado = false;

  const conexionFalsa = {
    async beginTransaction() {},
    async execute(sql) {
      ejecutadas.push(sql);
      // La 3ra (el UPDATE) es la que falla — simula una conexión caída a
      // mitad de camino, después de que las 2 DELETE ya corrieron.
      if (sql.startsWith('UPDATE')) throw new Error('conexión perdida (simulado)');
      return [{}];
    },
    async commit() { commitLlamado = true; },
    async rollback() { rollbackLlamado = true; },
    release() {},
  };

  const originalGetConnection = db.pool.getConnection;
  db.pool.getConnection = async () => conexionFalsa;
  try {
    await assert.rejects(() => eliminarPlanRecursos(1), /conexión perdida/);
  } finally {
    // Restaurar el mock tras el await es intencional, no una condición de
    // carrera: el test corre en un solo hilo, nada más toca db.pool entre
    // medias.
    // eslint-disable-next-line require-atomic-updates
    db.pool.getConnection = originalGetConnection;
  }

  assert.strictEqual(ejecutadas.length, 3, 'las 3 sentencias se intentaron, en orden');
  assert.match(ejecutadas[0], /DELETE FROM mp_plan_recursos WHERE/);
  assert.match(ejecutadas[1], /DELETE FROM mp_plan_recursos_gasto/);
  assert.match(ejecutadas[2], /UPDATE mp_centro_costo/);
  assert.strictEqual(commitLlamado, false, 'no debe confirmar una transaccion que fallo');
  assert.strictEqual(rollbackLlamado, true, 'debe deshacer las 2 sentencias que si alcanzaron a correr');
});

// Quitar del plan a alguien sin horas (10 nov 2026): sale también del Equipo
// de ese proyecto, igual que "Ninguno" en Editar de Equipo.
async function eliminarConQuitado(otrasAsignaciones) {
  const ejecutadas = [];
  const conexionFalsa = {
    async beginTransaction() {},
    async execute(sql, params) {
      ejecutadas.push({ sql, params });
      if (sql.includes('SELECT team_member_id FROM mp_equipo_proyecto')) return [[{ team_member_id: 190 }]];
      if (sql.includes('SELECT COUNT(*) AS n FROM mp_equipo_proyecto')) return [[{ n: otrasAsignaciones }]];
      return [{}];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const originalGetConnection = db.pool.getConnection;
  db.pool.getConnection = async () => conexionFalsa;
  try {
    await eliminarPlanRecursos(46, [{ employee_id: 37, nombre: 'Johan' }], 9);
  } finally {
    // eslint-disable-next-line require-atomic-updates
    db.pool.getConnection = originalGetConnection;
  }
  return ejecutadas;
}

test('eliminarPlanRecursos: quien sigue en otros proyectos pierde solo esta asignacion', async () => {
  const ejecutadas = await eliminarConQuitado(1);
  const borrado = ejecutadas.find((e) => e.sql.startsWith('DELETE FROM mp_equipo_proyecto'));
  assert.ok(borrado, 'borra la fila de este proyecto');
  assert.deepStrictEqual(borrado.params, [190]);
  assert.ok(ejecutadas.findIndex((e) => e === borrado) < ejecutadas.findIndex((e) => /DELETE FROM mp_plan_recursos WHERE/.test(e.sql)),
    'el Equipo va antes que el plan (orden canonico)');
});

test('eliminarPlanRecursos: si era su unico proyecto queda "Sin proyecto"', async () => {
  const ejecutadas = await eliminarConQuitado(0);
  assert.ok(!ejecutadas.some((e) => e.sql.startsWith('DELETE FROM mp_equipo_proyecto')));
  const update = ejecutadas.find((e) => /UPDATE mp_equipo_proyecto SET cost_center_id = NULL/.test(e.sql));
  assert.ok(update, 'la fila pasa a Sin proyecto');
  assert.deepStrictEqual(update.params, [9, 190]);
});
