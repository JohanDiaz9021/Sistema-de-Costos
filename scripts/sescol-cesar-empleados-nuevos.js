'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const CESAR_EMAIL = 'COLOCAR_correo_pm@empresa.com'; // #colocar credenciales (correos reales de empleados en este script)
  const CESAR_NAME  = 'Cesar Arbeláez';

  // === Paso 1: Crear Cesar como empleado/PMO ===
  const [cesarExists] = await conn.query(`SELECT employee_id FROM mp_employees WHERE email = ?`, [CESAR_EMAIL]);
  if (!cesarExists.length) {
    const [r1] = await conn.query(
      `INSERT INTO mp_employees
        (canonical_name, aliases, email, leader_name, leader_email, project_folder, contract_type, is_active, receive_alerts)
       VALUES (?, ?, ?, ?, ?, ?, 'planta', 1, 1)`,
      [CESAR_NAME, '["Cesar A.", "César Arbeláez"]', CESAR_EMAIL, 'Dirección', CESAR_EMAIL, 'SESCOL']
    );
    console.log(`✓ Cesar Arbeláez creado (employee_id=${r1.insertId})`);
  } else {
    console.log(`= Cesar Arbeláez ya existía (employee_id=${cesarExists[0].employee_id})`);
  }

  // === Paso 2: Johan Gutierrez (MIA, líder Diego Chamorro) ===
  const [johanExists] = await conn.query(`SELECT employee_id FROM mp_employees WHERE email = ?`, ['COLOCAR_correo_empleado1@empresa.com']);
  if (!johanExists.length) {
    const [r2] = await conn.query(
      `INSERT INTO mp_employees
        (canonical_name, aliases, email, leader_name, leader_email, project_folder, contract_type, is_active, receive_alerts)
       VALUES (?, ?, ?, ?, ?, ?, 'planta', 1, 1)`,
      ['Johan Gutierrez', '["Johan David Gutierrez", "Johan D. Gutierrez"]',
       'COLOCAR_correo_empleado1@empresa.com', 'Diego Chamorro',
       'COLOCAR_correo_lider@empresa.com', 'MIA']
    );
    console.log(`✓ Johan Gutierrez creado (employee_id=${r2.insertId})`);
  } else {
    console.log(`= Johan Gutierrez ya existía (employee_id=${johanExists[0].employee_id})`);
  }

  // === Paso 3: Jaider Bermudez (SESCOL, líder Cesar) ===
  const [jaiderExists] = await conn.query(`SELECT employee_id FROM mp_employees WHERE email = ?`, ['COLOCAR_correo_empleado2@empresa.com']);
  if (!jaiderExists.length) {
    const [r3] = await conn.query(
      `INSERT INTO mp_employees
        (canonical_name, aliases, email, leader_name, leader_email, project_folder, contract_type, is_active, receive_alerts)
       VALUES (?, ?, ?, ?, ?, ?, 'planta', 1, 1)`,
      ['Jaider Bermudez', '["Jaider B."]',
       'COLOCAR_correo_empleado2@empresa.com', CESAR_NAME, CESAR_EMAIL, 'SESCOL']
    );
    console.log(`✓ Jaider Bermudez creado (employee_id=${r3.insertId})`);
  } else {
    console.log(`= Jaider Bermudez ya existía (employee_id=${jaiderExists[0].employee_id})`);
  }

  // === Paso 4: PMO de SESCOL pasa a Cesar ===
  const [r4] = await conn.query(
    `UPDATE mp_project_owners
        SET pmo_canonical_name = ?, pmo_email = ?
      WHERE project_folder = 'SESCOL'`,
    [CESAR_NAME, CESAR_EMAIL]
  );
  console.log(`✓ PMO de SESCOL actualizado a Cesar (filas afectadas: ${r4.affectedRows})`);

  // === Paso 5: Empleados de SESCOL que tenían a Mónica como líder, ahora líder = Cesar ===
  const [r5] = await conn.query(
    `UPDATE mp_employees
        SET leader_name = ?, leader_email = ?
      WHERE project_folder = 'SESCOL'
        AND leader_name = 'Mónica Bastidas'`,
    [CESAR_NAME, CESAR_EMAIL]
  );
  console.log(`✓ Empleados SESCOL re-asignados a Cesar (filas afectadas: ${r5.affectedRows})`);

  // === Verificación final ===
  console.log('\n=== Estado final ===');
  const [empsSescol] = await conn.query(
    `SELECT employee_id, canonical_name, leader_name FROM mp_employees WHERE project_folder = 'SESCOL' AND is_active = 1 ORDER BY canonical_name`
  );
  console.log('Empleados de SESCOL:');
  console.log(empsSescol);

  const [nuevos] = await conn.query(
    `SELECT employee_id, canonical_name, email, project_folder, leader_name FROM mp_employees WHERE email IN (?, ?, ?) ORDER BY canonical_name`,
    [CESAR_EMAIL, 'COLOCAR_correo_empleado1@empresa.com', 'COLOCAR_correo_empleado2@empresa.com']
  );
  console.log('\nNuevos empleados/PMO:');
  console.log(nuevos);

  const [pmoSescol] = await conn.query(
    `SELECT * FROM mp_project_owners WHERE project_folder = 'SESCOL'`
  );
  console.log('\nPMO de SESCOL:');
  console.log(pmoSescol);

  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
