'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== Datos disponibles ===');
    const meta = await query(
      `SELECT
         COUNT(*) AS total_rows,
         COUNT(DISTINCT snapshot_date) AS snaps,
         COUNT(DISTINCT month_name) AS months,
         MIN(snapshot_date) AS first, MAX(snapshot_date) AS last
       FROM mp_task_facts`
    );
    console.table(meta);

    console.log('\n=== Query ACTUAL (con 4 subqueries correlacionadas) ===');
    const t1 = Date.now();
    try {
      const rows1 = await query(
        `SELECT COUNT(*) AS n FROM (
          SELECT e.employee_id, t.week_number, t.project_folder, t.activity,
                 COUNT(DISTINCT t.estimated_delivery_date) AS changes_count
            FROM mp_task_facts t
            JOIN mp_employees e ON e.employee_id = t.employee_id
           WHERE t.month_name = 'Julio' AND t.activity IS NOT NULL AND e.is_active = 1
           GROUP BY e.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
          HAVING changes_count > 1
        ) x`
      );
      const ms = Date.now() - t1;
      console.log(`  Tiempo query base (sin subqueries): ${ms}ms — resultado: ${rows1[0].n} tareas modificadas`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }

    console.log('\n=== Query FULL (como lo hace indicator-17 actual) ===');
    const t2 = Date.now();
    try {
      const rows2 = await query(
        `SELECT  e.employee_id, e.canonical_name, e.contract_type,
                t.week_number, t.project_folder, t.activity,
                COUNT(DISTINCT t.estimated_delivery_date) AS changes_count,
                MIN(t.snapshot_date) AS first_snap,
                MAX(t.snapshot_date) AS last_snap,
                MAX(CASE WHEN t.snapshot_date = (
                  SELECT MAX(s2.snapshot_date) FROM mp_task_facts s2
                   WHERE s2.employee_id = t.employee_id
                     AND s2.week_number = t.week_number
                     AND s2.project_folder = t.project_folder
                     AND s2.activity = t.activity
                     AND s2.month_name = t.month_name
                ) THEN t.estimated_delivery_date END) AS last_estimated_date
          FROM mp_task_facts t
          JOIN mp_employees e ON e.employee_id = t.employee_id
         WHERE t.month_name = 'Julio' AND t.activity IS NOT NULL AND e.is_active = 1
         GROUP BY e.employee_id, e.canonical_name, e.contract_type,
                  t.week_number, t.project_folder, t.activity, t.month_name
         HAVING changes_count > 1
         ORDER BY e.canonical_name LIMIT 500`
      );
      const ms = Date.now() - t2;
      console.log(`  Tiempo query FULL: ${ms}ms — filas: ${rows2.length}`);
    } catch (e) {
      const ms = Date.now() - t2;
      console.log(`  ERROR después de ${ms}ms: ${e.message}`);
    }

    console.log('\n=== Query OPTIMIZADO (con window functions) ===');
    const t3 = Date.now();
    try {
      const rows3 = await query(
        `WITH ranked AS (
          SELECT t.*, e.canonical_name, e.contract_type,
                 ROW_NUMBER() OVER (
                   PARTITION BY t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
                   ORDER BY t.snapshot_date ASC
                 ) AS rn_first,
                 ROW_NUMBER() OVER (
                   PARTITION BY t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
                   ORDER BY t.snapshot_date DESC
                 ) AS rn_last
            FROM mp_task_facts t
            JOIN mp_employees e ON e.employee_id = t.employee_id
           WHERE t.month_name = 'Julio' AND t.activity IS NOT NULL AND e.is_active = 1
        ),
        firsts AS (
          SELECT employee_id, week_number, project_folder, activity, month_name,
                 estimated_delivery_date AS first_estimated_date,
                 snapshot_date AS first_snap
            FROM ranked WHERE rn_first = 1
        ),
        lasts AS (
          SELECT employee_id, week_number, project_folder, activity, month_name,
                 estimated_delivery_date AS last_estimated_date,
                 snapshot_date AS last_snap,
                 task_status AS last_task_status,
                 observations AS last_observations,
                 canonical_name, contract_type
            FROM ranked WHERE rn_last = 1
        ),
        changes AS (
          SELECT employee_id, week_number, project_folder, activity, month_name,
                 COUNT(DISTINCT estimated_delivery_date) AS changes_count
            FROM mp_task_facts
           WHERE month_name = 'Julio' AND activity IS NOT NULL
           GROUP BY employee_id, week_number, project_folder, activity, month_name
          HAVING COUNT(DISTINCT estimated_delivery_date) > 1
        )
        SELECT l.employee_id, l.canonical_name, l.contract_type,
               l.week_number, l.project_folder, l.activity,
               c.changes_count, f.first_snap, l.last_snap,
               l.last_estimated_date, f.first_estimated_date,
               l.last_task_status, l.last_observations
          FROM changes c
          JOIN lasts l USING (employee_id, week_number, project_folder, activity, month_name)
          JOIN firsts f USING (employee_id, week_number, project_folder, activity, month_name)
         ORDER BY l.canonical_name LIMIT 500`
      );
      const ms = Date.now() - t3;
      console.log(`  Tiempo query OPTIMIZADO: ${ms}ms — filas: ${rows3.length}`);
    } catch (e) {
      const ms = Date.now() - t3;
      console.log(`  ERROR después de ${ms}ms: ${e.message}`);
    }
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
