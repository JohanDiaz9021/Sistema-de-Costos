'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) ¿Cuántos snapshots hay en mp_task_facts? ===');
    const snapshots = await query(
      `SELECT snapshot_date, COUNT(*) filas, COUNT(DISTINCT employee_id) empleados, SUM(budgeted_hours) total_budgeted
       FROM mp_task_facts
       GROUP BY snapshot_date
       ORDER BY snapshot_date DESC LIMIT 15`
    );
    console.table(snapshots);

    const maxSnap = snapshots[0].snapshot_date;
    console.log(`\n=== 2) Último snapshot: ${maxSnap} ===`);

    console.log('\n=== 3) Johan Gutierrez (id=?) — desglose de tareas en el ÚLTIMO snapshot ===');
    const johanId = (await query(`SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Johan Gutierrez%' LIMIT 1`))[0]?.employee_id;
    console.log('Johan employee_id:', johanId);

    const johanTasks = await query(
      `SELECT snapshot_date, week_number, project_name, LEFT(activity, 60) activity, budgeted_hours, total_executed_hours, task_status
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       ORDER BY week_number, budgeted_hours DESC`,
      [johanId, maxSnap]
    );
    console.table(johanTasks);

    console.log('\n=== 4) Johan Gutierrez — TOTAL horas presupuestadas por semana (último snapshot) ===');
    const johanWeeks = await query(
      `SELECT week_number, COUNT(*) tareas,
              SUM(budgeted_hours) total_presup,
              SUM(total_executed_hours) total_exec
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       GROUP BY week_number ORDER BY week_number`,
      [johanId, maxSnap]
    );
    console.table(johanWeeks);

    console.log('\n=== 5) Emily Tench — misma vista para comparar ===');
    const emilyId = (await query(`SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Emily Tench%' LIMIT 1`))[0]?.employee_id;
    const emilyWeeks = await query(
      `SELECT week_number, COUNT(*) tareas,
              SUM(budgeted_hours) total_presup,
              SUM(total_executed_hours) total_exec
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       GROUP BY week_number ORDER BY week_number`,
      [emilyId, maxSnap]
    );
    console.table(emilyWeeks);

    console.log('\n=== 6) ¿Hay duplicados dentro del último snapshot de Johan? (misma semana + misma actividad) ===');
    const dupes = await query(
      `SELECT week_number, project_name, LEFT(activity, 50) activity, COUNT(*) n, SUM(budgeted_hours) total
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = ?
       GROUP BY week_number, project_name, activity
       HAVING COUNT(*) > 1
       ORDER BY n DESC`,
      [johanId, maxSnap]
    );
    console.table(dupes);

    console.log('\n=== 7) Comparar snapshots del lunes vs hoy para Johan (misma tarea, ¿cambiaron horas?) ===');
    const evolution = await query(
      `SELECT snapshot_date, week_number, LEFT(activity, 50) activity, budgeted_hours
       FROM mp_task_facts
       WHERE employee_id = ?
         AND snapshot_date IN (
           SELECT DISTINCT snapshot_date FROM mp_task_facts
           WHERE snapshot_date >= DATE_SUB(?, INTERVAL 6 DAY)
           ORDER BY snapshot_date
         )
       ORDER BY activity, snapshot_date
       LIMIT 100`,
      [johanId, maxSnap]
    );
    console.table(evolution);
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
})();
