'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== Todos los NO_DATA_INGESTED del snapshot de hoy ===');
    const errs = await query(
      `SELECT error_id, snapshot_date, execution_id, employee_id, employee_folder_name, project_folder, error_type, severity, error_message
       FROM mp_validation_errors
       WHERE snapshot_date = CURDATE() AND error_type = 'NO_DATA_INGESTED'`
    );
    console.table(errs.map(r => ({
      id: r.error_id,
      emp_id: r.employee_id,
      folder_name: r.employee_folder_name,
      project: r.project_folder,
      msg: r.error_message?.slice(0, 100)
    })));

    console.log('\n=== Todas las notifications de hoy ===');
    const notifs = await query(
      `SELECT id, snapshot_date, recipient_type, subject, recipient_email
       FROM mp_notifications WHERE snapshot_date = CURDATE()
       ORDER BY id DESC LIMIT 10`
    );
    console.table(notifs);

    console.log('\n=== Diana en el snapshot de hoy (tiene tareas o no?) ===');
    const dianaFacts = await query(
      `SELECT COUNT(*) tareas FROM mp_task_facts
       WHERE snapshot_date = CURDATE() AND employee_id = 12`
    );
    console.table(dianaFacts);

    console.log('\n=== Correr el mismo query que hace el nodo "Buscar empleados sin tareas" ===');
    const missing = await query(
      `SELECT e.employee_id, e.canonical_name, e.project_folder
         FROM mp_employees e
        WHERE e.is_active = 1
          AND e.employee_id NOT IN (
            SELECT DISTINCT employee_id FROM mp_task_facts WHERE snapshot_date = CURDATE()
          )
          AND NOT EXISTS (
            SELECT 1 FROM mp_validation_errors v
             WHERE v.snapshot_date = CURDATE()
               AND v.severity = 'critical'
               AND (
                 v.employee_id = e.employee_id
                 OR v.employee_folder_name = e.canonical_name
                 OR JSON_CONTAINS(e.aliases, JSON_QUOTE(v.employee_folder_name))
               )
          )`
    );
    console.log('Empleados que el nodo debería detectar como sin tareas:');
    console.table(missing);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
