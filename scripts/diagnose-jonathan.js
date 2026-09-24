'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) Últimas ingesta_runs y validación ===');
    const runs = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at, status, files_processed, files_rejected, rows_inserted
       FROM mp_ingestion_runs ORDER BY run_id DESC LIMIT 10`
    );
    console.table(runs);

    console.log('\n=== 2) TODOS los validation_errors de Jonathan Ariza (id=27) ===');
    const errs = await query(
      `SELECT error_id, snapshot_date, execution_id, error_type, severity, week_number, LEFT(error_message, 120) AS msg
       FROM mp_validation_errors
       WHERE employee_id = 27
       ORDER BY error_id DESC LIMIT 60`
    );
    console.table(errs);

    console.log('\n=== 3) validation_errors de Jonathan agrupados por execution + severity ===');
    const g = await query(
      `SELECT execution_id, severity, error_type, COUNT(*) n
       FROM mp_validation_errors WHERE employee_id = 27
       GROUP BY execution_id, severity, error_type
       ORDER BY execution_id DESC, severity, error_type`
    );
    console.table(g);

    console.log('\n=== 4) task_facts actuales de Jonathan por snapshot/semana ===');
    const facts = await query(
      `SELECT snapshot_date, year_number, month_number, week_number, COUNT(*) tasks
       FROM mp_task_facts WHERE employee_id = 27
       GROUP BY snapshot_date, year_number, month_number, week_number
       ORDER BY snapshot_date DESC, week_number`
    );
    console.table(facts);

    console.log('\n=== 5) últimas notifications ===');
    const notif_cols = await query(`SHOW COLUMNS FROM mp_notifications`);
    console.log('cols mp_notifications:', notif_cols.map(x => x.Field).join(', '));
    const notifs = await query(`SELECT * FROM mp_notifications ORDER BY 1 DESC LIMIT 5`);
    console.table(notifs);

    console.log('\n=== 6) Excel real de Jonathan — filas ingestadas más recientes ===');
    const raw = await query(
      `SELECT snapshot_date, week_number, activity, planned_type, estimated_delivery_date, task_status, total_executed_hours
       FROM mp_task_facts
       WHERE employee_id = 27 AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE employee_id = 27)
       ORDER BY week_number, activity LIMIT 200`
    );
    console.table(raw);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
