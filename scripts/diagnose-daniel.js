'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) Datos de Daniel en mp_employees ===');
    const emp = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active, aliases
       FROM mp_employees
       WHERE canonical_name LIKE '%Daniel%Gómez%' OR canonical_name LIKE '%Daniel%Gomez%' OR email LIKE '%daniel%gomez%'`
    );
    console.table(emp);

    console.log('\n=== 2) Errores de Daniel en el snapshot de hoy ===');
    const errs = await query(
      `SELECT error_id, snapshot_date, execution_id, employee_id, employee_folder_name, project_folder, error_type, error_message
       FROM mp_validation_errors
       WHERE snapshot_date = CURDATE() AND (employee_folder_name LIKE '%Daniel%' OR employee_id IN (SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Daniel%'))`
    );
    console.table(errs.map(r => ({
      id: r.error_id,
      folder: r.employee_folder_name,
      project: r.project_folder,
      type: r.error_type,
      msg: r.error_message?.slice(0, 100)
    })));

    console.log('\n=== 3) ¿Daniel tiene task_facts para hoy? ===');
    const facts = await query(
      `SELECT snapshot_date, COUNT(*) tareas
       FROM mp_task_facts
       WHERE employee_id IN (SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Daniel%')
         AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 10 DAY)
       GROUP BY snapshot_date ORDER BY snapshot_date DESC`
    );
    console.table(facts);

    console.log('\n=== 4) Runs recientes ===');
    const runs = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at, status FROM mp_ingestion_runs ORDER BY run_id DESC LIMIT 8`
    );
    console.table(runs);

    console.log('\n=== 5) MISSING_MONTH_SHEET de hoy (todos) ===');
    const missing = await query(
      `SELECT error_id, employee_folder_name, project_folder, file_name, error_message
       FROM mp_validation_errors
       WHERE snapshot_date = CURDATE() AND error_type = 'MISSING_MONTH_SHEET'`
    );
    console.table(missing.map(r => ({
      id: r.error_id,
      folder: r.employee_folder_name,
      file: r.file_name,
      msg: r.error_message?.slice(0, 120)
    })));
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
