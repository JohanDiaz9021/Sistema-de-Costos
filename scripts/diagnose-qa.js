'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== task_facts QA agrupado por semana ===');
    const facts = await query(
      `SELECT tf.employee_id, e.canonical_name, e.is_active,
              tf.year_number AS y, tf.month_number AS m, tf.week_number AS w,
              MIN(tf.snapshot_date) AS min_snap, MAX(tf.snapshot_date) AS max_snap,
              MIN(tf.estimated_delivery_date) AS min_edd, MAX(tf.estimated_delivery_date) AS max_edd,
              COUNT(*) AS tasks
       FROM mp_task_facts tf
       JOIN mp_employees e ON e.employee_id = tf.employee_id
       WHERE e.project_folder = 'QA'
       GROUP BY tf.employee_id, e.canonical_name, e.is_active, tf.year_number, tf.month_number, tf.week_number
       ORDER BY tf.year_number, tf.month_number, tf.week_number, e.canonical_name`
    );
    console.table(facts);

    console.log('\n=== snapshots QA únicos (para ver qué días se ingestaron) ===');
    const snaps = await query(
      `SELECT tf.employee_id, e.canonical_name, tf.snapshot_date, tf.year_number AS y, tf.month_number AS m, tf.week_number AS w, COUNT(*) AS n
       FROM mp_task_facts tf
       JOIN mp_employees e ON e.employee_id = tf.employee_id
       WHERE e.project_folder = 'QA'
       GROUP BY tf.employee_id, e.canonical_name, tf.snapshot_date, tf.year_number, tf.month_number, tf.week_number
       ORDER BY tf.snapshot_date DESC, e.canonical_name`
    );
    console.table(snaps);

    console.log('\n=== ¿Qué employee_id tiene task_facts para Lucia (34) vs (35)? ===');
    const lucifacts = await query(
      `SELECT employee_id, COUNT(*) AS n, MIN(snapshot_date) AS min_snap, MAX(snapshot_date) AS max_snap
       FROM mp_task_facts WHERE employee_id IN (34,35)
       GROUP BY employee_id`
    );
    console.table(lucifacts);

    console.log('\n=== mp_ingestion_runs recientes ===');
    const runs_cols = await query(`SHOW COLUMNS FROM mp_ingestion_runs`);
    console.log('cols:', runs_cols.map(x => x.Field).join(', '));
    const runs = await query(`SELECT * FROM mp_ingestion_runs ORDER BY 1 DESC LIMIT 5`);
    console.table(runs);
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
})();
