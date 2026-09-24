'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Tablas transaccionales — se truncan
const DATA_TABLES = [
  'mp_task_facts',
  'mp_validation_errors',
  'mp_ingestion_runs',
  'mp_indicators',
  'mp_ai_recommendations',
  'mp_notifications',
  'mp_execution_history',
];

// Tablas de catálogo / config — NO se tocan
const PROTECTED_TABLES = [
  'mp_employees',
  'mp_holidays',
  'mp_project_owners',
  'mp_dashboard_users',
];

function escapeSqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '')}'`;
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups', stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`📦 Backup → ${backupDir}\n`);

  // ============= BACKUP =============
  for (const t of DATA_TABLES) {
    const [rows] = await conn.query(`SELECT * FROM \`${t}\``);
    const filePath = path.join(backupDir, `${t}.sql`);

    if (rows.length === 0) {
      fs.writeFileSync(filePath, `-- ${t}: 0 filas\n`);
      console.log(`  ${t.padEnd(30)} → 0 filas (vacío)`);
      continue;
    }

    const cols = Object.keys(rows[0]);
    const colsList = cols.map((c) => `\`${c}\``).join(', ');

    const lines = [`-- Backup ${t} — ${rows.length} filas — ${stamp}`];
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = batch
        .map((r) => `(${cols.map((c) => escapeSqlValue(r[c])).join(',')})`)
        .join(',\n');
      lines.push(`INSERT INTO \`${t}\` (${colsList}) VALUES\n${values};`);
    }

    fs.writeFileSync(filePath, lines.join('\n\n'));
    console.log(`  ${t.padEnd(30)} → ${rows.length} filas → ${path.basename(filePath)}`);
  }

  // Backup también las tablas protegidas (por si acaso)
  console.log('\n📋 Backup de catálogos (precaución):');
  for (const t of PROTECTED_TABLES) {
    const [rows] = await conn.query(`SELECT * FROM \`${t}\``);
    const filePath = path.join(backupDir, `${t}.sql`);

    if (rows.length === 0) {
      fs.writeFileSync(filePath, `-- ${t}: 0 filas\n`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const colsList = cols.map((c) => `\`${c}\``).join(', ');
    const values = rows
      .map((r) => `(${cols.map((c) => escapeSqlValue(r[c])).join(',')})`)
      .join(',\n');
    fs.writeFileSync(
      filePath,
      `-- Backup ${t} — ${rows.length} filas — ${stamp}\nINSERT INTO \`${t}\` (${colsList}) VALUES\n${values};`
    );
    console.log(`  ${t.padEnd(30)} → ${rows.length} filas`);
  }

  // ============= TRUNCATE =============
  console.log('\n🗑️  Truncando tablas transaccionales:');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of DATA_TABLES) {
    await conn.query(`TRUNCATE TABLE \`${t}\``);
    console.log(`  ✓ ${t}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // ============= VERIFY =============
  console.log('\n✅ Verificación:');
  for (const t of [...DATA_TABLES, ...PROTECTED_TABLES]) {
    const [cnt] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    const tag = PROTECTED_TABLES.includes(t) ? '[catálogo]' : '[data]';
    console.log(`  ${tag} ${t.padEnd(30)} → ${cnt[0].c} filas`);
  }

  await conn.end();
  console.log(`\n✓ Backup completo en: ${backupDir}`);
})().catch((e) => { console.error(e); process.exit(1); });
