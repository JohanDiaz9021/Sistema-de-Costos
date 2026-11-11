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

  // Tabla nueva: cada vez que un admin marca un error como falso positivo,
  // se inserta un registro acá. Conservamos histórico — nunca borramos, solo
  // marcamos active=0 si se "deshace" la reversión.
  const sql = `
    CREATE TABLE IF NOT EXISTS mp_validation_overrides (
      override_id INT AUTO_INCREMENT PRIMARY KEY,
      error_id INT NOT NULL,
      reverted_by_email VARCHAR(150) NOT NULL,
      reverted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      active TINYINT(1) NOT NULL DEFAULT 1,
      undone_by_email VARCHAR(150),
      undone_at DATETIME,
      INDEX idx_error_active (error_id, active),
      INDEX idx_reverted_by (reverted_by_email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `;
  await conn.query(sql);
  console.log('✓ Tabla mp_validation_overrides creada (o ya existía)');

  const [cols] = await conn.query(`SHOW COLUMNS FROM mp_validation_overrides`);
  console.log('\nColumnas:');
  for (const c of cols) console.log(`  ${c.Field} (${c.Type})`);

  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
