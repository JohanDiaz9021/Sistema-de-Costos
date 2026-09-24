#!/usr/bin/env node
'use strict';

/**
 * Cambia la contraseña de un usuario del dashboard.
 *
 * Uso:
 *   npm run set-password -- correo@dominio nuevaContraseña
 *
 * Ejemplo:
 *   npm run set-password -- usuario@empresa.com NuevoPassSeguro_2026
 *
 * Notas:
 *  - La contraseña se hashea con bcryptjs (12 rounds) antes de guardarse.
 *  - Si el usuario no existe, el comando falla (no lo crea).
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Uso: npm run set-password -- <email> <nuevaContraseña>');
    process.exit(2);
  }
  const [email, password] = args;
  if (password.length < 8) {
    console.error('La contraseña debe tener al menos 8 caracteres.');
    process.exit(2);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'sistema_monitoreo',
  });

  try {
    const [rows] = await conn.execute(
      'SELECT user_id FROM mp_dashboard_users WHERE email = ? LIMIT 1',
      [email]
    );
    if (rows.length === 0) {
      console.error(`Usuario no encontrado: ${email}`);
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    await conn.execute(
      'UPDATE mp_dashboard_users SET password_hash = ? WHERE email = ?',
      [hash, email]
    );
    console.log(`OK — contraseña actualizada para ${email}.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('set-password FALLÓ:', err.message);
  process.exit(1);
});
