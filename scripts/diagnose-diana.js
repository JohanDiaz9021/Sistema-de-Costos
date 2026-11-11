'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const dianaId = (await query(`SELECT employee_id, canonical_name FROM mp_employees WHERE canonical_name LIKE '%Diana%'`))[0];
    console.log('Diana:', dianaId);
    if (!dianaId) return;

    const maxSnap = (await query(`SELECT MAX(snapshot_date) s FROM mp_task_facts`))[0].s;
    console.log('Último snapshot:', maxSnap);

    console.log('\n=== Todas las tareas de Diana en el último snapshot ===');
    const tasks = await query(
      `SELECT week_number, project_name, LEFT(activity, 60) activity,
              budgeted_hours, total_executed_hours, task_status
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       ORDER BY week_number, activity`,
      [dianaId.employee_id, maxSnap]
    );
    console.table(tasks);

    console.log('\n=== Totales por semana ===');
    const totals = await query(
      `SELECT week_number, COUNT(*) tareas,
              SUM(budgeted_hours) budget_total,
              SUM(total_executed_hours) exec_total,
              SUM(CASE WHEN LOWER(TRIM(task_status)) = 'cancelado' THEN budgeted_hours ELSE 0 END) budget_cancelado,
              SUM(CASE WHEN LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL THEN budgeted_hours ELSE 0 END) budget_sin_cancelado
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       GROUP BY week_number`,
      [dianaId.employee_id, maxSnap]
    );
    console.table(totals);

    console.log('\n=== SUMA GLOBAL (como la muestra el tablero) ===');
    const global = await query(
      `SELECT COUNT(*) tareas,
              SUM(budgeted_hours) budget_incl_cancelado,
              SUM(total_executed_hours) exec_incl_cancelado,
              SUM(CASE WHEN LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL THEN budgeted_hours ELSE 0 END) budget_excl_cancelado,
              SUM(CASE WHEN LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL THEN total_executed_hours ELSE 0 END) exec_excl_cancelado
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?`,
      [dianaId.employee_id, maxSnap]
    );
    console.table(global);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
})();
