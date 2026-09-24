'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) ¿Existe Germán Tovar en mp_employees? ===');
    const german = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, leader_email, is_active, created_at
       FROM mp_employees
       WHERE canonical_name LIKE '%Tovar%' OR email LIKE '%tovar%'`
    );
    console.table(german);

    console.log('\n=== 2) Otros empleados con líder Mónica Bastidas (para sacar su email) ===');
    const monicaLed = await query(
      `SELECT DISTINCT leader_name, leader_email
       FROM mp_employees
       WHERE leader_name LIKE '%Bastidas%' OR leader_name LIKE '%Mónica%' OR leader_name LIKE '%Monica%'`
    );
    console.table(monicaLed);

    console.log('\n=== 3) ¿Ya existe "Transversales 2" o "Transversales" en mp_project_owners? ===');
    const owners = await query(
      `SELECT * FROM mp_project_owners WHERE project_folder LIKE '%ransversal%'`
    );
    console.table(owners);

    console.log('\n=== 4) Estructura de mp_project_owners ===');
    const cols = await query(`SHOW COLUMNS FROM mp_project_owners`);
    console.table(cols);

    console.log('\n=== 5) ¿Hay tareas de Germán en task_facts? (para no perder historial si existe) ===');
    const facts = await query(
      `SELECT COUNT(*) n, MIN(snapshot_date) primer_snap, MAX(snapshot_date) ultimo_snap
       FROM mp_task_facts
       WHERE employee_id IN (SELECT employee_id FROM mp_employees WHERE canonical_name LIKE '%Tovar%')`
    );
    console.table(facts);

    console.log('\n=== 6) Todos los project_folder distintos actualmente ===');
    const projects = await query(
      `SELECT project_folder, COUNT(*) empleados FROM mp_employees WHERE is_active=1 GROUP BY project_folder ORDER BY project_folder`
    );
    console.table(projects);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
