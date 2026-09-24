'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== ANTES ===');
    const before = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active
       FROM mp_employees
       WHERE employee_id IN (27, 34, 35)
       ORDER BY employee_id`
    );
    console.table(before);

    console.log('\n=== ¿Existen task_facts para id=35 (que voy a borrar)? ===');
    const check = await query(`SELECT COUNT(*) AS n FROM mp_task_facts WHERE employee_id = 35`);
    console.table(check);
    if (check[0].n > 0) {
      throw new Error('ABORTO: hay task_facts para employee_id=35, no puedo borrar sin decidir qué hacer con esas filas.');
    }

    console.log('\n=== APLICANDO CAMBIOS ===');

    const del = await query(`DELETE FROM mp_employees WHERE employee_id = 35 AND canonical_name = 'Lucia Trujillo QA'`);
    console.log('DELETE id=35 (Lucia Trujillo QA):', del.affectedRows, 'fila(s)');

    const react = await query(`UPDATE mp_employees SET is_active = 1 WHERE employee_id = 34 AND canonical_name = 'Lucia Trujillo'`);
    console.log('UPDATE id=34 is_active=1 (reactivar Lucia Trujillo):', react.affectedRows, 'fila(s)');

    const move = await query(`UPDATE mp_employees SET project_folder = 'QA' WHERE employee_id = 27 AND canonical_name = 'Jonathan Ariza'`);
    console.log('UPDATE id=27 project_folder=QA (Jonathan Ariza):', move.affectedRows, 'fila(s)');

    console.log('\n=== DESPUÉS ===');
    const after = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active
       FROM mp_employees
       WHERE employee_id IN (27, 34, 35)
       ORDER BY employee_id`
    );
    console.table(after);

    console.log('\n=== Todos los empleados QA activos (para verificar) ===');
    const qa = await query(
      `SELECT employee_id, canonical_name, email, leader_name, is_active
       FROM mp_employees
       WHERE project_folder = 'QA'
       ORDER BY is_active DESC, canonical_name`
    );
    console.table(qa);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
