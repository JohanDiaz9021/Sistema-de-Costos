'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) Empleados activos con canonical_name NULL/vacío o project_folder NULL ===');
    const bad = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active, created_at
       FROM mp_employees
       WHERE is_active = 1
         AND (canonical_name IS NULL OR TRIM(canonical_name) = '' OR project_folder IS NULL OR TRIM(project_folder) = '')`
    );
    console.table(bad);

    console.log('\n=== 2) Toda la lista de mp_employees activos (para inspección visual) ===');
    const all = await query(
      `SELECT employee_id, canonical_name, project_folder, is_active
       FROM mp_employees WHERE is_active = 1 ORDER BY employee_id`
    );
    console.table(all);

    console.log('\n=== 3) Runs recientes ===');
    const runs = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at, status FROM mp_ingestion_runs ORDER BY run_id DESC LIMIT 5`
    );
    console.table(runs);

    console.log('\n=== 4) Errores del snapshot de hoy ===');
    const errs = await query(
      `SELECT error_id, snapshot_date, employee_id, employee_folder_name, project_folder, error_type, LEFT(error_message, 80) msg
       FROM mp_validation_errors WHERE snapshot_date = CURDATE()
       ORDER BY error_id DESC LIMIT 20`
    );
    console.table(errs);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
