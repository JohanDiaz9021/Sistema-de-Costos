'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== Data por snapshot (últimos días) ===');
    const rows = await query(
      `SELECT
         snapshot_date,
         (SELECT COUNT(*) FROM mp_task_facts WHERE snapshot_date = s.snapshot_date) AS task_facts,
         (SELECT COUNT(*) FROM mp_validation_errors WHERE snapshot_date = s.snapshot_date) AS validation_errors,
         (SELECT COUNT(*) FROM mp_notifications WHERE snapshot_date = s.snapshot_date) AS notifications
       FROM (
         SELECT DISTINCT snapshot_date FROM mp_task_facts
         UNION SELECT DISTINCT snapshot_date FROM mp_validation_errors
         UNION SELECT DISTINCT snapshot_date FROM mp_notifications
       ) s
       ORDER BY snapshot_date DESC LIMIT 10`
    );
    console.table(rows);

    console.log('\n=== ¿Hay data de Juan Guzman del viernes 10? ===');
    const juanFri = await query(
      `SELECT snapshot_date, COUNT(*) tareas, SUM(budgeted_hours) presup, SUM(total_executed_hours) ejec
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
       WHERE e.canonical_name LIKE '%Juan Jose Guzman%' AND snapshot_date IN ('2026-07-10','2026-07-14')
       GROUP BY snapshot_date ORDER BY snapshot_date`
    );
    console.table(juanFri);

    console.log('\n=== Validation errors de Juan por snapshot ===');
    const juanErr = await query(
      `SELECT snapshot_date, error_type, COUNT(*) cnt
       FROM mp_validation_errors
       WHERE (employee_folder_name LIKE '%Guzman%' OR employee_folder_name LIKE '%Guzmán%')
         AND snapshot_date IN ('2026-07-10','2026-07-14')
       GROUP BY snapshot_date, error_type ORDER BY snapshot_date, error_type`
    );
    console.table(juanErr);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
