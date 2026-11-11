#!/usr/bin/env node
'use strict';

/**
 * Seed inicial de mp_dashboard_users.
 *
 * Crea la tabla (si no existe) y carga los usuarios iniciales con una
 * contraseña temporal ALEATORIA por usuario (se imprime una sola vez en
 * consola; no queda guardada en el repositorio). Usa bcryptjs.
 *
 * Ajusta la lista USERS con los correos reales antes de correrlo.
 *
 * Uso:
 *   npm run seed
 *
 * Idempotente: ON DUPLICATE KEY UPDATE solo refresca full_name/role/is_active
 * (NO la contraseña, para no pisar cambios hechos despues con set-password).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const USERS = [
  { email: 'gerencia@empresa.com', full_name: 'CEO',      role: 'ceo'    },
  { email: 'lider1@empresa.com',   full_name: 'Líder 1',  role: 'leader' },
  { email: 'lider2@empresa.com',   full_name: 'Líder 2',  role: 'leader' },
  { email: 'lider3@empresa.com',   full_name: 'Líder 3',  role: 'leader' },
  { email: 'admin@empresa.com',    full_name: 'Admin',    role: 'admin'  },
].map((u) => ({ ...u, password: crypto.randomBytes(12).toString('base64url') }));

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'sistema_monitoreo',
    multipleStatements: true,
  });

  try {
    // 1. Crear la tabla si no existe.
    const ddl = fs.readFileSync(path.join(__dirname, '01_dashboard_users.sql'), 'utf8');
    await conn.query(ddl);
    console.log('[seed] tabla mp_dashboard_users lista');

    // 2. Insertar usuarios (solo si no existen — no pisa contraseñas).
    const rounds = 12;
    let inserted = 0, updated = 0, skipped = 0;
    for (const u of USERS) {
      const [existing] = await conn.execute(
        'SELECT user_id, password_hash FROM mp_dashboard_users WHERE email = ? LIMIT 1',
        [u.email]
      );
      if (existing.length === 0) {
        const hash = await bcrypt.hash(u.password, rounds);
        await conn.execute(
          `INSERT INTO mp_dashboard_users (email, password_hash, full_name, role, is_active)
           VALUES (?, ?, ?, ?, 1)`,
          [u.email, hash, u.full_name, u.role]
        );
        inserted++;
        console.log(`[seed]  + ${u.email} (rol ${u.role}) — contraseña temporal: ${u.password}`);
      } else {
        await conn.execute(
          `UPDATE mp_dashboard_users SET full_name = ?, role = ?, is_active = 1 WHERE email = ?`,
          [u.full_name, u.role, u.email]
        );
        updated++;
        skipped++;
        console.log(`[seed]  = ${u.email} ya existe — contraseña NO modificada (use set-password para cambiarla)`);
      }
    }

    console.log(`\n[seed] OK — insertados: ${inserted}, refrescados sin tocar password: ${updated}`);
    console.log('\nIMPORTANTE: cambie las contraseñas temporales con:');
    console.log('  npm run set-password -- <email> <nuevaContraseña>\n');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[seed] FALLÓ:', err.message);
  process.exit(1);
});
