'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');
const ind17 = require('../src/queries/indicator-17');

(async () => {
  try {
    console.log('=== Ejecutando aggregate() del indicator-17 v3 (optimizado) ===');
    const scope = { role: 'ceo', allowedProjects: null };

    const t1 = Date.now();
    const result = await ind17.aggregate(scope, { month: 'Julio', week: null, project: null, employee_id: null, leader: null });
    const ms = Date.now() - t1;

    console.log(`\n✅ Tiempo: ${ms}ms`);
    console.log(`   Tareas modificadas: ${result.tasks.length}`);
    console.log(`   Empleados afectados: ${result.employees.length}`);
    console.log(`   Días pushed forward totales: ${result.totals.total_days_pushed}`);

    console.log('\n=== Top 5 tareas con mayor days_moved ===');
    console.table(result.tasks.slice(0, 5).map(t => ({
      employee: t.canonical_name.slice(0, 25),
      week: t.week_number,
      project: t.project_folder,
      activity: t.activity?.slice(0, 40),
      first: t.first_estimated_date,
      last: t.last_estimated_date,
      days_moved: t.days_moved,
      changes: t.changes_count,
    })));

    console.log('\n=== Top empleados por tareas modificadas ===');
    console.table(result.employees.slice(0, 5).map(e => ({
      employee: e.canonical_name.slice(0, 30),
      tasks_modified: e.tasks_modified,
      pushed_forward: e.pushed_forward,
      pulled_back: e.pulled_back,
      total_days_moved: e.total_days_moved,
    })));
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
})();
