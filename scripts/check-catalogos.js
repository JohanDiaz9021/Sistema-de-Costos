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

  const [empCols] = await conn.query(`SHOW COLUMNS FROM mp_employees`);
  console.log('=== mp_employees columnas ===');
  console.log(empCols.map(c => `${c.Field} (${c.Type})`).join('\n'));

  const [ownerCols] = await conn.query(`SHOW COLUMNS FROM mp_project_owners`);
  console.log('\n=== mp_project_owners columnas ===');
  console.log(ownerCols.map(c => `${c.Field} (${c.Type})`).join('\n'));

  const [owners] = await conn.query(`SELECT * FROM mp_project_owners ORDER BY project_folder`);
  console.log('\n=== mp_project_owners actual ===');
  console.log(owners);

  const [maxId] = await conn.query(`SELECT MAX(employee_id) AS max FROM mp_employees`);
  console.log('\nMax employee_id actual:', maxId[0].max);

  const [cesar] = await conn.query(`SELECT employee_id, canonical_name, email FROM mp_employees WHERE canonical_name LIKE '%Cesar%' OR canonical_name LIKE '%Arbel%' OR email LIKE '%cesar%'`);
  console.log('\nCesar Arbeláez en mp_employees:', cesar);

  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
