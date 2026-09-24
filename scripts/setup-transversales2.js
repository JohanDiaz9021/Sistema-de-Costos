'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== ANTES ===');
    const empBefore = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, is_active
       FROM mp_employees WHERE employee_id = 24`
    );
    console.table(empBefore);

    const ownersBefore = await query(
      `SELECT * FROM mp_project_owners WHERE project_folder LIKE '%Transversales%'`
    );
    console.table(ownersBefore);

    console.log('\n=== APLICANDO CAMBIOS ===');

    // 1) Reactivar Germán y moverlo a Transversales 2
    const u1 = await query(
      `UPDATE mp_employees
       SET is_active = 1, project_folder = 'Transversales 2'
       WHERE employee_id = 24 AND canonical_name = 'Germán Tovar'`
    );
    console.log(`UPDATE mp_employees (id=24 → Transversales 2 + activo):`, u1.affectedRows, 'fila(s)');

    // 2) Registrar Transversales 2 como proyecto con Mónica Bastidas de líder
    const u2 = await query(
      `INSERT INTO mp_project_owners (project_folder, pmo_canonical_name, pmo_email, is_active)
       VALUES ('Transversales 2', 'Mónica Bastidas', 'COLOCAR_correo_lider@empresa.com' /* #colocar credenciales */, 1)
       ON DUPLICATE KEY UPDATE
         pmo_canonical_name = VALUES(pmo_canonical_name),
         pmo_email = VALUES(pmo_email),
         is_active = 1`
    );
    console.log(`INSERT mp_project_owners (Transversales 2 → Mónica):`, u2.affectedRows, 'fila(s)');

    console.log('\n=== DESPUÉS ===');
    const empAfter = await query(
      `SELECT employee_id, canonical_name, email, project_folder, leader_name, leader_email, is_active
       FROM mp_employees WHERE employee_id = 24`
    );
    console.table(empAfter);

    const ownersAfter = await query(
      `SELECT * FROM mp_project_owners WHERE project_folder LIKE '%Transversales%'`
    );
    console.table(ownersAfter);

    console.log('\n=== Empleados activos por proyecto (verificación) ===');
    const perProj = await query(
      `SELECT project_folder, COUNT(*) empleados
       FROM mp_employees WHERE is_active = 1
       GROUP BY project_folder ORDER BY project_folder`
    );
    console.table(perProj);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
