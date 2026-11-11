'use strict';

/**
 * weeklyAggregate() de src/queries/costo-weekly-hours.js con la base de
 * datos reemplazada por un doble de prueba (misma técnica que
 * costo-motor-db-mock.test.js).
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

// Semana 2 de agosto 2026 (sáb 8 .. vie 14). Lunes 10-ago se marca festivo
// vía mp_holidays para probar que el motor lo excluye del límite legal
// incluso pasando por la capa de base de datos (doble de prueba).
db.query = fakeQuery([
  ['FROM mp_costeo_task_facts t', [
    { employee_id: 1, canonical_name: 'Ana', project_folder: 'ALFA', cost_center_id: 1, week_number: 2, month_number: 8, year_number: 2026, h_mon: 8, h_tue: 9, h_wed: 9, h_thu: 9, h_fri: 9, h_sat: 6, hourly_cost: 10 },
  ]],
  ['FROM mp_holidays', [{ holiday_date: '2026-08-10' }]],
]);

const { weeklyAggregate } = require('../../src/queries/costo-weekly-hours');

test('weeklyAggregate: agrega por día, respeta festivos (vía mp_holidays) y aplica los factores de la tabla de GTC', async () => {
  const rows = await weeklyAggregate({ role: 'ceo', allowedProjects: null }, { month: null, week: null, project: null, employee_id: null, leader: null });
  assert.strictEqual(rows.length, 1);
  // Total = 8+9+9+9+9+6 = 50h. Lunes (8h) es festivo -> fuera del cupo legal.
  // horasNormales = 42 (mar-sab), horasFestivas = 8 (lunes).
  // legalHours default = 46 -> horasLegales = min(42,46) = 42, sin extra diurna.
  // costo_legal = 42*10 = 420. costo_extra = 8*10*1.90 (dominical/festivo en
  // jornada ordinaria, tabla de GTC — sql/33) = 152.
  assert.strictEqual(rows[0].h_ejec, 50);
  assert.strictEqual(rows[0].h_extra, 8);
  assert.strictEqual(rows[0].costo_legal, 420);
  assert.strictEqual(rows[0].costo_extra_potencial, 152);
});
