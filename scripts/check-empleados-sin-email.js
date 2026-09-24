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

  // Empleados activos sin email
  const [sinEmail] = await conn.query(`
    SELECT employee_id, canonical_name, email, leader_name, project_folder
      FROM mp_employees
     WHERE is_active = 1
       AND (email IS NULL OR email = '' OR email NOT LIKE '%@%')
     ORDER BY canonical_name
  `);
  console.log('Empleados activos SIN email válido:');
  console.log(sinEmail);

  // PMOs sin email
  const [pmoSinEmail] = await conn.query(`
    SELECT project_folder, pmo_canonical_name, pmo_email
      FROM mp_project_owners
     WHERE is_active = 1
       AND (pmo_email IS NULL OR pmo_email = '' OR pmo_email NOT LIKE '%@%')
  `);
  console.log('\nPMOs SIN email válido:');
  console.log(pmoSinEmail);

  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
