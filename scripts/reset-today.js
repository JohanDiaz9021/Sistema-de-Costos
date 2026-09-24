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

  console.log('Borrando datos parciales de hoy...');

  const [r1] = await conn.query(`DELETE FROM mp_task_facts WHERE snapshot_date = CURDATE()`);
  console.log(`  mp_task_facts: ${r1.affectedRows} filas borradas`);

  const [r2] = await conn.query(`DELETE FROM mp_validation_errors WHERE snapshot_date = CURDATE()`);
  console.log(`  mp_validation_errors: ${r2.affectedRows} filas borradas`);

  const [r3] = await conn.query(`DELETE FROM mp_ingestion_runs WHERE run_date = CURDATE()`);
  console.log(`  mp_ingestion_runs: ${r3.affectedRows} filas borradas`);

  const [r4] = await conn.query(`DELETE FROM mp_indicators WHERE snapshot_date = CURDATE()`);
  console.log(`  mp_indicators: ${r4.affectedRows} filas borradas`);

  const [r5] = await conn.query(`DELETE FROM mp_ai_recommendations WHERE snapshot_date = CURDATE()`);
  console.log(`  mp_ai_recommendations: ${r5.affectedRows} filas borradas`);

  await conn.end();
  console.log('✓ Listo - puedes re-ejecutar WF1');
})().catch((e) => { console.error(e); process.exit(1); });
