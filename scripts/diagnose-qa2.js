'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== A) todos los employee_id distintos que aparecen en mp_task_facts con project_folder=QA ===');
    const a = await query(
      `SELECT tf.employee_id,
              (SELECT canonical_name FROM mp_employees WHERE employee_id = tf.employee_id) AS canonical_name,
              (SELECT project_folder FROM mp_employees WHERE employee_id = tf.employee_id) AS emp_current_project,
              (SELECT is_active FROM mp_employees WHERE employee_id = tf.employee_id) AS is_active_now,
              MIN(tf.snapshot_date) AS min_snap, MAX(tf.snapshot_date) AS max_snap,
              COUNT(*) AS tasks
       FROM mp_task_facts tf
       WHERE tf.project_folder = 'QA'
       GROUP BY tf.employee_id
       ORDER BY tasks DESC`
    );
    console.table(a);

    console.log('\n=== B) desglose de esos empleados por semana ===');
    const b = await query(
      `SELECT tf.employee_id,
              (SELECT canonical_name FROM mp_employees WHERE employee_id = tf.employee_id) AS canonical_name,
              tf.year_number AS y, tf.month_number AS m, tf.week_number AS w,
              COUNT(*) AS tasks,
              MIN(tf.snapshot_date) AS min_snap, MAX(tf.snapshot_date) AS max_snap
       FROM mp_task_facts tf
       WHERE tf.project_folder = 'QA' AND tf.year_number = 2026 AND tf.month_number = 7
       GROUP BY tf.employee_id, tf.year_number, tf.month_number, tf.week_number
       ORDER BY y, m, w, tf.employee_id`
    );
    console.table(b);

    console.log('\n=== C) empleados marcados como QA histórico (por leader Bastidas, Aldana, u otros hallazgos) ===');
    const c = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active, created_at
       FROM mp_employees
       WHERE (leader_name LIKE '%Bastidas%' OR leader_name LIKE '%Aldana%' OR project_folder LIKE '%QA%')
       ORDER BY project_folder, is_active DESC, canonical_name`
    );
    console.table(c);

    console.log('\n=== D) últimos snapshots del último día de QA (2026-07-09) — snapshot latest ===');
    const d = await query(
      `SELECT tf.employee_id,
              (SELECT canonical_name FROM mp_employees WHERE employee_id = tf.employee_id) AS canonical_name,
              tf.snapshot_date, tf.year_number AS y, tf.month_number AS m, tf.week_number AS w,
              COUNT(*) AS tasks
       FROM mp_task_facts tf
       WHERE tf.project_folder = 'QA' AND tf.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE project_folder='QA')
       GROUP BY tf.employee_id, tf.snapshot_date, tf.year_number, tf.month_number, tf.week_number
       ORDER BY tf.employee_id, tf.week_number`
    );
    console.table(d);

    console.log('\n=== E) mp_validation_errors recientes de QA/Lucia ===');
    const ec = await query(`SHOW COLUMNS FROM mp_validation_errors`);
    console.log('cols mp_validation_errors:', ec.map(x => x.Field).join(', '));
    const e = await query(
      `SELECT * FROM mp_validation_errors ORDER BY 1 DESC LIMIT 25`
    );
    console.table(e);
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
})();
