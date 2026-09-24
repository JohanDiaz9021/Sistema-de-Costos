'use strict';

/**
 * Corre un archivo de sql/ sentencia por sentencia.
 *
 * SIMULA POR DEFECTO: sin --aplicar lista qué sentencias ejecutaría y
 * termina sin tocar la base. Es a propósito — hasta ahora cada migración
 * de este proyecto se aplicaba con un script propio y a mano, y era fácil
 * correr la equivocada.
 *
 * Se niega a correr archivos que contengan DROP o TRUNCATE: para eso hay
 * que ir a la base a conciencia, no pasar por aquí.
 *
 * Uso:
 *   node scripts/run-migration.js sql/19_sistema_alertas.sql
 *   node scripts/run-migration.js sql/19_sistema_alertas.sql --aplicar
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
// El troceo vive en scripts/lib/sql-split.js desde que existe
// migrar-todo.js: si cada runner tuviera su propia copia, las migraciones
// podrían partirse de una forma al probarlas y de otra al aplicarlas.
const { separarSentencias, quitarComentarios, tieneSentenciasDestructivas } = require('./lib/sql-split');

const APLICAR = process.argv.includes('--aplicar');
const archivo = process.argv.find((a) => a.endsWith('.sql'));

function resumen(sentencia) {
  const s = sentencia.replace(/\s+/g, ' ').trim();
  const m = s.match(/^(CREATE TABLE IF NOT EXISTS|CREATE TABLE|ALTER TABLE|INSERT IGNORE INTO|INSERT INTO|UPDATE|SET|PREPARE|EXECUTE|DEALLOCATE PREPARE|SELECT)\s+(\S+)?/i);
  const cabeza = m ? `${m[1]}${m[2] ? ' ' + m[2] : ''}` : s.slice(0, 50);
  return `${cabeza}  (${s.length} car.)`;
}

async function main() {
  if (!archivo) {
    console.error('Falta el archivo .sql.\n  Uso: node scripts/run-migration.js sql/19_sistema_alertas.sql [--aplicar]');
    process.exitCode = 1;
    return;
  }

  const ruta = path.resolve(archivo);
  if (!fs.existsSync(ruta)) {
    console.error(`No existe: ${ruta}`);
    process.exitCode = 1;
    return;
  }

  const bruto = fs.readFileSync(ruta, 'utf8');
  if (tieneSentenciasDestructivas(bruto)) {
    console.error('\nEste archivo contiene DROP o TRUNCATE. Este runner no los ejecuta.');
    console.error('Si de verdad hay que correrlo, hacerlo a mano y con respaldo previo.\n');
    process.exitCode = 1;
    return;
  }

  const sentencias = separarSentencias(quitarComentarios(bruto));
  console.log(`\nArchivo: ${archivo}`);
  console.log(`Base: ${process.env.DB_NAME}`);
  console.log(APLICAR ? 'Modo: APLICANDO\n' : 'Modo: SIMULACIÓN (no escribe nada)\n');

  sentencias.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${resumen(s)}`));

  if (!APLICAR) {
    console.log(`\n${sentencias.length} sentencia(s). Para ejecutarlas:`);
    console.log(`    node scripts/run-migration.js ${archivo} --aplicar\n`);
    return;
  }

  console.log('\nEjecutando...');
  const conn = await pool.getConnection();
  try {
    for (let i = 0; i < sentencias.length; i++) {
      // query() y no execute(): las sentencias DDL y las de sesión (SET/PREPARE)
      // no funcionan por protocolo de prepared statements.
      const [res] = await conn.query(sentencias[i]);
      const filas = res && res.affectedRows !== undefined ? ` — ${res.affectedRows} fila(s)` : '';
      console.log(`  ${String(i + 1).padStart(2)}. OK${filas}`);
    }
    console.log('\nMigración aplicada.\n');
  } finally {
    conn.release();
  }
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
