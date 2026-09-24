'use strict';

/**
 * Pruebas unitarias de src/queries/costo-alertas.js CON la base de datos
 * reemplazada por un doble de prueba, misma técnica que
 * costo-motor-db-mock.test.js: parchar db.query ANTES de requerir el módulo
 * bajo prueba, para que su `const { query } = require('../db')` capture la
 * versión parchada. node:test aísla cada archivo en su propio proceso, así
 * que esto no afecta a ningún otro test.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/db');

function fakeQuery(reglas) {
  // `sql` llega al resultado cuando es funcion, no solo `()`: algunas
  // pruebas necesitan inspeccionar el texto exacto que mandó el módulo
  // (ver el filtro de approval_status más abajo), no solo controlar qué
  // devuelve.
  return async (sql, params) => {
    for (const [match, resultado] of reglas) {
      if (sql.includes(match)) return typeof resultado === 'function' ? resultado(sql, params) : resultado;
    }
    return [];
  };
}

// Se llenan cuando costo-alertas.js manda la consulta correspondiente —
// permiten comprobar el SQL/params exactos que mandó, no solo el resultado
// que le devolvimos. No se puede reasignar db.query DESPUÉS del primer
// require (costo-alertas.js ya capturó esa referencia con
// `const { query } = require('../db')`), así que la captura vive DENTRO de
// estas mismas reglas, fijadas una sola vez antes de requerir el módulo.
let sqlGastosCapturado = null;
let sinTarifaCapturado = null;

db.query = fakeQuery([
  ['FROM mp_project_owners', [{ 1: 1 }]], // getPMActivo: hay una fila -> activo
  ['FROM mp_overtime_decisions od', [
    { decision_id: 1, employee_id: 1, canonical_name: 'Ana', pm_decision: 'pendiente', approval_status: 'pendiente', extra_cost_potential: 80 },
  ]],
  // Substring corto y no la sentencia completa: el SQL real trae un salto
  // de línea entre la tabla y el WHERE (getGastosDeCentro en
  // costo-alertas.js), así que un match más largo se rompía en silencio —
  // caía al [] por defecto sin que ningún assert de este archivo lo notara.
  ['FROM mp_costo_no_planeado', (sql) => {
    sqlGastosCapturado = sql;
    return [{ expense_id: 1, description: 'Viático', amount: 40 }];
  }],
  ['HAVING horas > 0', (sql, params) => { // sinAsignacion
    sinTarifaCapturado = { sql, params };
    return [{ employee_id: 2, canonical_name: 'Beto', horas: 5 }];
  }],
  ['ep.hourly_cost IS NULL OR ep.hourly_cost = 0', [{ employee_id: 3, canonical_name: 'Caro' }]], // tarifaCero
  ['HAVING n_centros >= 2', [{ employee_id: 4, canonical_name: 'Dani', n_centros: 3 }]],
  ['JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id', [
    { employee_id: 5, canonical_name: 'Eva', hourly_cost: 30, project_name: 'ALFA' },
  ]],
]);

const {
  generarAlertasParaCentro, generarAlertasGlobales,
} = require('../../src/queries/costo-alertas');

const CENTRO = { cost_center_id: 1, project_name: 'Proyecto X', status: 'activo', project_folder: 'ALFA', planned_end_date: null, actual_end_date: null, budget: 1000 };
const IND17 = {
  ind4_se_queda_sin_plata_antes: false, ind4_fecha_quiebre_presupuestal: null,
  ind3_ritmo_gasto_vs_tiempo: 0, ind12_costo_errores_pct: 0, ind11_trabajo_no_remunerado: 0,
  ind6_bus_factor_pct: 0, ind7_personas_trabajando: 2, ind9_proporcion_horas_extra_pct: 0,
  ind14_gasto_no_predecible_pct: 0, ind13_responsable_sobrecosto_interno_pct: 0, ind1_presupuesto_ejecutado_pct: 0,
};

test('generarAlertasParaCentro: junta los datos reales (mock) y evalúa las reglas de negocio', async () => {
  const alertas = await generarAlertasParaCentro(CENTRO, IND17, {});
  const tipos = alertas.map((a) => a.tipo);
  // De los datos mockeados deberían salir 2 talentos sin costo/hora
  // (sinAsignacion + tarifaCero). PM está activo -> no debe salir "Sin PM
  // asignado".
  assert.strictEqual(tipos.filter((t) => t === 'Talento sin costo/hora registrado').length, 2);
  assert.ok(!tipos.includes('Sin PM asignado'));
  // Las horas extra del mock (pm_decision/approval_status en 'pendiente') ya
  // NO generan alerta: el flujo de aprobación se retiró el 4 sep 2026.
  assert.ok(!tipos.includes('Aprobación pendiente'));
  assert.ok(!tipos.includes('Decisión pendiente del PM'));
});

test('generarAlertasGlobales: junta sobrecarga cross-proyecto y costo/hora sobre promedio', async () => {
  const alertas = await generarAlertasGlobales();
  const tipos = alertas.map((a) => a.tipo);
  assert.ok(tipos.includes('Sobrecarga cross-proyecto'));
  // Un solo talento con hourly_cost=30: promedio=30, umbral=37.5, 30 < 37.5 -> no dispara.
  assert.ok(!tipos.includes('Costo/hora por encima del promedio'));
});

// ---------------------------------------------------------------
// getGastosDeCentro: filtra por approval_status (14 sep 2026, corregido
// tras revisión de código) — se prueba el SQL en sí, no la función pura de
// evaluación, que ya no sabe nada de approval_status (ese filtro vive
// enteramente en la consulta).
// ---------------------------------------------------------------

test('getGastosDeCentro: el SQL excluye los rechazados, pero NO los pendientes ni los aprobados', async () => {
  sqlGastosCapturado = null;
  await generarAlertasParaCentro(CENTRO, IND17, {});

  assert.ok(sqlGastosCapturado, 'deberia haber consultado mp_costo_no_planeado');
  assert.match(sqlGastosCapturado, /approval_status\s*<>\s*'rechazado'/);
  assert.doesNotMatch(
    sqlGastosCapturado, /approval_status\s*=\s*'aprobado'/,
    'NO debe filtrar a solo aprobados: la alerta "Dato desactualizado" necesita contar tambien los pendientes'
  );
});

// ---------------------------------------------------------------
// getTalentosSinTarifa: filtra y correlaciona por PROYECTO, no por la
// carpeta de SharePoint de quien subió el Excel (14 sep 2026, corregido
// tras revisión de código). Misma técnica de captura que
// getGastosDeCentro arriba.
// ---------------------------------------------------------------

test('getTalentosSinTarifa: filtra por project_name (centro.project_name Y project_folder), no por project_folder de la persona', async () => {
  sinTarifaCapturado = null;
  await generarAlertasParaCentro(CENTRO, IND17, {});

  assert.ok(sinTarifaCapturado, 'deberia haber consultado mp_costeo_task_facts (sinAsignacion)');
  // Filtra por project_name, contra los DOS valores del centro (mismo
  // criterio que el resto del sistema: baseWhere, el JOIN de atribución en
  // costo-motor.js, filtrarPorCentro en la carga del Excel).
  assert.match(sinTarifaCapturado.sql, /t\.project_name = \? OR t\.project_name = \?/);
  assert.doesNotMatch(sinTarifaCapturado.sql, /t\.project_folder/, 'ya no debe filtrar por la carpeta de quien subió el Excel');
  assert.deepStrictEqual(sinTarifaCapturado.params, [CENTRO.cost_center_id, CENTRO.project_name, CENTRO.project_folder]);
  // El "snapshot vigente" correlaciona por (empleado, proyecto), no solo
  // por empleado — si no, una carga más reciente en OTRO proyecto de la
  // misma persona apagaba la alerta de este.
  assert.match(sinTarifaCapturado.sql, /t2\.employee_id = t\.employee_id/);
  assert.match(sinTarifaCapturado.sql, /t2\.project_name = t\.project_name/);
});
