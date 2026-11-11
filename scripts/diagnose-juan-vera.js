'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) Registro de Juan Vera en mp_employees ===');
    const emp = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active, aliases
       FROM mp_employees WHERE canonical_name LIKE '%Vera%' OR email LIKE '%vera%'`
    );
    console.table(emp);

    console.log('\n=== 2) Errores de Juan Vera en snapshot de hoy ===');
    const errs = await query(
      `SELECT error_id, snapshot_date, execution_id, employee_folder_name, project_folder, file_name, error_type, error_message
       FROM mp_validation_errors
       WHERE snapshot_date = CURDATE()
         AND (employee_folder_name LIKE '%Vera%' OR employee_folder_name LIKE '%JUAN%' OR employee_id IN (SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Vera%'))`
    );
    console.table(errs.map(r => ({
      id: r.error_id,
      folder: r.employee_folder_name,
      project: r.project_folder,
      file: r.file_name,
      type: r.error_type,
      msg: (r.error_message || '').slice(0, 150)
    })));

    console.log('\n=== 3) task_facts recientes de Juan Vera ===');
    const facts = await query(
      `SELECT snapshot_date, COUNT(*) tareas
       FROM mp_task_facts
       WHERE employee_id IN (SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Vera%')
         AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 10 DAY)
       GROUP BY snapshot_date ORDER BY snapshot_date DESC`
    );
    console.table(facts);

    console.log('\n=== 4) Runs recientes ===');
    const runs = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at, status
       FROM mp_ingestion_runs ORDER BY run_id DESC LIMIT 8`
    );
    console.table(runs);

    console.log('\n=== 5) TODOS los MISSING_MONTH_SHEET de hoy ===');
    const mms = await query(
      `SELECT employee_folder_name, project_folder, file_name, error_message
       FROM mp_validation_errors
       WHERE snapshot_date = CURDATE() AND error_type = 'MISSING_MONTH_SHEET'`
    );
    console.table(mms.map(r => ({
      folder: r.employee_folder_name,
      project: r.project_folder,
      file: r.file_name,
      msg_preview: (r.error_message || '').slice(0, 100)
    })));

    console.log('\n=== 6) MENSAJE COMPLETO del error de Juan Vera hoy ===');
    const full = await query(
      `SELECT error_message FROM mp_validation_errors
       WHERE snapshot_date = CURDATE()
         AND (employee_folder_name LIKE '%Juan%Vera%' OR employee_folder_name LIKE '%JUAN%VERA%')
         AND error_type = 'MISSING_MONTH_SHEET' LIMIT 1`
    );
    if (full.length) console.log(full[0].error_message);
    else console.log('(sin registro)');
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
