'use strict';

/**
 * Aplica TODAS las migraciones de sql/ en orden contra la base configurada
 * en .env — el equivalente para producción de lo que prepararEsquema()
 * (test/helpers/db.js) ya hace en la base de pruebas en cada corrida.
 *
 * POR QUÉ EXISTE (28 ago 2026): dos veces en el mismo día la aplicación se
 * rompió en producción por una migración que nunca se aplicó allá —
 * sql/28 dejó todas las pestañas "Cargando…" (columna approval_status
 * inexistente), y sql/26 impedía registrar cualquier hora extra a mano
 * (columnas fecha/hora_inicio/hora_fin inexistentes). En los dos casos el
 * código y las pruebas estaban bien: lo que faltaba era correr el ALTER.
 * Aplicarlas de a una, a mano y de memoria, garantiza que tarde o temprano
 * se olvide alguna y lo descubra un usuario.
 *
 * TODAS las migraciones del proyecto son idempotentes a propósito (CREATE
 * TABLE IF NOT EXISTS, INSERT IGNORE, y ALTER guardados por un SELECT
 * contra information_schema), así que correr el lote entero sobre una base
 * al día no hace nada. Esa es justamente la propiedad que hace seguro
 * ejecutar esto después de cada despliegue.
 *
 * SIMULA POR DEFECTO: sin --aplicar solo dice qué archivos correría.
 * Se niega a tocar archivos con DROP o TRUNCATE (igual que run-migration.js).
 *
 * Uso:
 *   node scripts/migrar-todo.js
 *   node scripts/migrar-todo.js --aplicar
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { sentenciasDe, tieneSentenciasDestructivas } = require('./lib/sql-split');

const APLICAR = process.argv.includes('--aplicar');
const DIR_SQL = path.join(__dirname, '..', 'sql');

// sql/02_seed_users.js es un script de Node, no SQL (siembra el CEO/admin
// inicial) — se corre aparte con `npm run seed`, no desde aquí.
const NO_SON_MIGRACIONES = new Set(['02_seed_users.js']);

function archivosDeMigracion() {
  return fs.readdirSync(DIR_SQL)
    .filter((f) => f.endsWith('.sql') && !NO_SON_MIGRACIONES.has(f))
    .sort(); // 01, 02, ... 30: el orden importa, hay ALTERs que dependen de CREATEs previos
}

async function main() {
  const archivos = archivosDeMigracion();

  console.log(`\nBase: ${process.env.DB_NAME}`);
  console.log(`Archivos: ${archivos.length} en sql/`);
  console.log(APLICAR ? 'Modo: APLICANDO\n' : 'Modo: SIMULACIÓN (no escribe nada)\n');

  // Se revisan TODOS antes de tocar nada: si uno trae DROP/TRUNCATE, se
  // aborta el lote completo en vez de dejarlo aplicado a medias.
  const destructivos = archivos.filter((f) =>
    tieneSentenciasDestructivas(fs.readFileSync(path.join(DIR_SQL, f), 'utf8'))
  );
  if (destructivos.length) {
    console.error('Estos archivos contienen DROP o TRUNCATE y este runner no los ejecuta:');
    destructivos.forEach((f) => console.error(`  - ${f}`));
    console.error('\nCorrelos a mano, con respaldo previo, y vuelve a lanzar esto.\n');
    process.exitCode = 1;
    return;
  }

  if (!APLICAR) {
    archivos.forEach((f) => {
      const n = sentenciasDe(fs.readFileSync(path.join(DIR_SQL, f), 'utf8')).length;
      console.log(`  ${f}  (${n} sentencia(s))`);
    });
    console.log('\nTodas son idempotentes: las que ya estén aplicadas no harán nada.');
    console.log('Para ejecutarlas:\n    node scripts/migrar-todo.js --aplicar\n');
    return;
  }

  const conn = await pool.getConnection();
  let conCambios = 0;
  try {
    for (const archivo of archivos) {
      const sentencias = sentenciasDe(fs.readFileSync(path.join(DIR_SQL, archivo), 'utf8'));
      let filasTocadas = 0;
      for (const sentencia of sentencias) {
        try {
          // query() y no execute(): las sentencias DDL y las de sesión
          // (SET/PREPARE) no funcionan por prepared statements.
          const [res] = await conn.query(sentencia);
          if (res && res.affectedRows) filasTocadas += res.affectedRows;
        } catch (err) {
          console.error(`\n  ✖ ${archivo} falló: ${err.message}`);
          console.error(`    sentencia: ${sentencia.slice(0, 160)}...\n`);
          throw err;
        }
      }
      if (filasTocadas) conCambios++;
      console.log(`  ${filasTocadas ? '·' : ' '} ${archivo}${filasTocadas ? ` — ${filasTocadas} fila(s)` : ''}`);
    }
    console.log(`\nListo. ${archivos.length} archivo(s) aplicados${conCambios ? `, ${conCambios} con cambios` : ' (la base ya estaba al día)'}.\n`);
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
