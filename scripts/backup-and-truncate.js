'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Deja la BD lista para el despliegue: respalda todo y vacía los datos.
//
// Uso:  node scripts/backup-and-truncate.js --confirm
// Sin --confirm solo hace el backup y muestra qué vaciaría.

// Se vacían. Los proyectos también (centros de costo, sus PMs, equipos con
// salarios, planes y gastos): tras el despliegue cada PM crea los suyos.
const DATA_TABLES = [
  // Planeación
  'mp_task_facts',
  'mp_validation_errors',
  'mp_validation_overrides',
  'mp_ingestion_runs',
  'mp_indicators',
  'mp_ai_recommendations',
  'mp_notifications',
  'mp_execution_history',
  // Proyectos
  'mp_project_owners',
  'mp_centro_costo',
  'mp_equipo_proyecto',
  'mp_plan_recursos',
  'mp_plan_recursos_gasto',
  // Costeo
  'mp_costeo_task_facts',
  'mp_costeo_snapshot',
  'mp_costo_no_planeado',
  'mp_overtime_decisions',
  'mp_costeo_audit_log',
  // Alertas generadas (los tipos de alerta son configuración y se conservan)
  'mp_alerta_evento',
  'mp_alerta_envio',
  'mp_alerta_email_envio',
  'mp_alerta_email_cola',
];

// NO se tocan: trabajadores, usuarios del dashboard (PMs con sus contraseñas),
// festivos y la configuración del sistema (umbrales, catálogo de cargos y
// tipos de alerta).
const PROTECTED_TABLES = [
  'mp_employees',
  'mp_dashboard_users',
  'mp_holidays',
  'mp_costeo_config',
  'mp_tarifa_cargo',
  'mp_alerta_tipo',
];

const CONFIRMED = process.argv.includes('--confirm');

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

  const [existingRows] = await conn.query(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name LIKE 'mp\\_%'`
  );
  const existing = new Set(existingRows.map((r) => r.t));
  for (const t of [...DATA_TABLES, ...PROTECTED_TABLES]) {
    if (!existing.has(t)) console.log(`  (omitida: ${t} no existe en esta BD)`);
  }
  const unlisted = [...existing].filter((t) => !DATA_TABLES.includes(t) && !PROTECTED_TABLES.includes(t));
  if (unlisted.length) {
    console.log(`⚠️  Tablas mp_* no clasificadas (no se tocan): ${unlisted.join(', ')}`);
  }
  DATA_TABLES.splice(0, DATA_TABLES.length, ...DATA_TABLES.filter((t) => existing.has(t)));
  PROTECTED_TABLES.splice(0, PROTECTED_TABLES.length, ...PROTECTED_TABLES.filter((t) => existing.has(t)));

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

  if (!CONFIRMED) {
    console.log(`\nBackup hecho. NO se vació nada. Se vaciarían: ${DATA_TABLES.join(', ')}`);
    console.log('Para vaciar, vuelve a correr con --confirm');
    await conn.end();
    return;
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
