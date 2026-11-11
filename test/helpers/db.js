'use strict';

/**
 * Base de datos de prueba: arranque, migraciones y reset.
 *
 * REGLA DURA: esto NUNCA lee el .env del proyecto. La configuracion sale
 * de TEST_DB_* con defaults que apuntan al contenedor de
 * docker-compose.test.yml (puerto 3399). Si alguien corriera las pruebas
 * contra produccion por accidente, `resetearDatos()` le vaciaria las
 * tablas — por eso la conexion se construye aqui a mano y hay ademas una
 * comprobacion de seguridad en `abrirPool()`.
 *
 * El esquema se crea UNA vez por corrida (`prepararEsquema`), y los datos
 * se limpian entre suites (`resetearDatos`). Crear el esquema entero por
 * cada suite tardaria de mas sin aportar aislamiento extra.
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const RAIZ = path.join(__dirname, '..', '..');

const CONFIG = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT) || 3399,
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD || 'test',
  database: process.env.TEST_DB_NAME || 'gtc_test',
};

// Nombres que delatan que alguien apunto las pruebas a un entorno real.
const NOMBRES_PROHIBIDOS = [/^jalo/i, /prod/i, /sistema_monitoreo/i, /stage/i];

function verificarQueNoEsProduccion() {
  for (const patron of NOMBRES_PROHIBIDOS) {
    if (patron.test(CONFIG.database)) {
      throw new Error(
        `[test/db] Me niego a correr contra la base "${CONFIG.database}": ` +
        'las pruebas BORRAN datos. Revisa TEST_DB_NAME.'
      );
    }
  }
  if (CONFIG.port === 3306 && !process.env.TEST_DB_PERMITIR_3306) {
    throw new Error(
      '[test/db] El puerto 3306 suele ser la base real. El contenedor de ' +
      'pruebas usa 3399. Si de verdad quieres 3306, exporta TEST_DB_PERMITIR_3306=1.'
    );
  }
}

let pool = null;

function abrirPool() {
  if (pool) return pool;
  verificarQueNoEsProduccion();
  pool = mysql.createPool({
    ...CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Iguales a los de src/db.js: si difieren, las pruebas validarian un
    // comportamiento distinto del de produccion (sobre todo dateStrings,
    // que cambia el tipo de todas las fechas que devuelve el driver).
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4_general_ci',
    multipleStatements: false,
  });
  return pool;
}

async function cerrarPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function query(sql, params = []) {
  const [rows] = await abrirPool().execute(sql, params);
  return rows;
}

/**
 * Espera a que el contenedor acepte conexiones.
 * Devuelve false (no lanza) si no responde: las suites lo usan para
 * saltarse las pruebas con un mensaje util en vez de un stack trace.
 */
async function esperarBase(intentos = 30, esperaMs = 1000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const conn = await abrirPool().getConnection();
      await conn.ping();
      conn.release();
      return true;
    } catch (err) {
      if (i === intentos) {
        console.error(`[test/db] la base no respondio tras ${intentos} intentos: ${err.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
  return false;
}

// ---------------------------------------------------------------
// Migraciones
// ---------------------------------------------------------------

// sql/02_seed_users.js es un script de Node, no SQL: siembra el CEO/admin
// inicial. Las pruebas crean sus propios usuarios en fixtures.js, asi que
// no aplica. sql/05 es un archivo de solo comentarios.
const NO_SON_MIGRACIONES = new Set(['02_seed_users.js']);

/**
 * Trocea un archivo .sql en sentencias.
 *
 * No basta con partir por ';': varias migraciones usan el patron
 * SET @sql := '...ALTER...'; PREPARE stmt FROM @sql; y ese texto lleva
 * punto y coma adentro de comillas. Se recorre caracter por caracter
 * respetando cadenas y comentarios, igual que hace scripts/run-migration.js.
 */
function trocearSql(sql) {
  const sentencias = [];
  let actual = '';
  let enCadena = null;
  let enComentarioLinea = false;
  let enComentarioBloque = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const siguiente = sql[i + 1];

    if (enComentarioLinea) {
      if (c === '\n') { enComentarioLinea = false; actual += c; }
      continue;
    }
    if (enComentarioBloque) {
      if (c === '*' && siguiente === '/') { enComentarioBloque = false; i++; }
      continue;
    }
    if (!enCadena && c === '-' && siguiente === '-') { enComentarioLinea = true; i++; continue; }
    if (!enCadena && c === '/' && siguiente === '*') { enComentarioBloque = true; i++; continue; }

    if (enCadena) {
      actual += c;
      if (c === '\\') { actual += sql[++i] ?? ''; continue; }
      if (c === enCadena) enCadena = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { enCadena = c; actual += c; continue; }

    if (c === ';') {
      if (actual.trim()) sentencias.push(actual.trim());
      actual = '';
      continue;
    }
    actual += c;
  }
  if (actual.trim()) sentencias.push(actual.trim());
  return sentencias;
}

/**
 * Crea el esquema completo: primero las tablas que el RPA crea fuera del
 * repo (ver test/fixtures/00-schema-externo.sql y el hallazgo QA-02) y
 * despues sql/01..22 en orden.
 *
 * Las migraciones son idempotentes, asi que correrlas sobre un esquema ya
 * creado no hace nada — es justamente lo que se quiere verificar.
 */
async function prepararEsquema({ verbose = false } = {}) {
  const conn = await abrirPool().getConnection();
  try {
    const archivos = [
      path.join(RAIZ, 'test', 'fixtures', '00-schema-externo.sql'),
      ...fs.readdirSync(path.join(RAIZ, 'sql'))
        .filter((f) => f.endsWith('.sql') && !NO_SON_MIGRACIONES.has(f))
        .sort()
        .map((f) => path.join(RAIZ, 'sql', f)),
    ];

    for (const archivo of archivos) {
      const sentencias = trocearSql(fs.readFileSync(archivo, 'utf8'));
      for (const sentencia of sentencias) {
        try {
          await conn.query(sentencia);
        } catch (err) {
          throw new Error(
            `[test/db] fallo ${path.basename(archivo)}: ${err.message}\n` +
            `  sentencia: ${sentencia.slice(0, 160)}...`
          );
        }
      }
      if (verbose) console.log(`  aplicado ${path.basename(archivo)} (${sentencias.length} sentencias)`);
    }
  } finally {
    conn.release();
  }
}

// Orden inverso al de las dependencias: primero las hijas. Aun asi se
// desactivan las FK, porque hay ciclos (mp_costeo_audit_log -> centro,
// centro -> users) y el orden exacto no deberia ser un dato que mantener.
const TABLAS_DE_DATOS = [
  'mp_alerta_envio',
  'mp_alerta_evento',
  'mp_costeo_audit_log',
  'mp_costeo_snapshot',
  'mp_overtime_decisions',
  'mp_costo_no_planeado',
  'mp_equipo_proyecto',
  'mp_plan_recursos_gasto',
  'mp_plan_recursos',
  'mp_centro_costo',
  'mp_tarifa_cargo',
  'mp_costeo_config',
  'mp_task_facts',
  'mp_costeo_task_facts',
  'mp_project_owners',
  'mp_employees',
  'mp_dashboard_users',
  'mp_holidays',
  'mp_validation_overrides',
  'mp_validation_errors',
  'mp_ingestion_runs',
];

/**
 * Deja la base vacia pero con el esquema intacto.
 *
 * TRUNCATE y no DELETE para que los AUTO_INCREMENT vuelvan a 1: asi los
 * ids son deterministas y una prueba puede afirmar sobre ellos sin
 * depender de cuantas corrieron antes.
 */
async function resetearDatos() {
  const conn = await abrirPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const tabla of TABLAS_DE_DATOS) {
      await conn.query(`TRUNCATE TABLE ${tabla}`);
    }
    // mp_tarifa_cargo la siembra sql/20 con el catalogo de cargos; el
    // TRUNCATE se la lleva y varios endpoints la dan por poblada.
    await conn.query(`
      INSERT INTO mp_tarifa_cargo (role_catalog, nombre_visible)
      VALUES ('desarrollador','Desarrollador'), ('analista','Analista'),
             ('lider_proyecto','Líder de proyecto'), ('qa','QA'),
             ('disenador','Diseñador'), ('scrum_master','Scrum Master'),
             ('otro','Otro')
    `);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    conn.release();
  }
}

/**
 * Variables de entorno que hacen que src/db.js apunte a la base de
 * prueba. Hay que llamarla ANTES del primer require('../src/db').
 */
function apuntarAppALaBaseDePrueba() {
  process.env.DB_HOST = CONFIG.host;
  process.env.DB_PORT = String(CONFIG.port);
  process.env.DB_USER = CONFIG.user;
  process.env.DB_PASSWORD = CONFIG.password;
  process.env.DB_NAME = CONFIG.database;
  // server.js aborta el proceso si falta o es corto (ver el hallazgo de
  // seguridad que lo introdujo). 64 caracteres fijos: las pruebas de
  // sesion necesitan que el secreto no cambie entre reinicios.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET
    || 'secreto-solo-para-pruebas-de-integracion-0123456789abcdef';
  process.env.COOKIE_SECURE = process.env.COOKIE_SECURE || 'false';
  process.env.WORK_HOURS_MONDAY = '8';
  process.env.WORK_HOURS_TUE_FRI = '9';
}

module.exports = {
  CONFIG,
  abrirPool,
  cerrarPool,
  query,
  esperarBase,
  prepararEsquema,
  resetearDatos,
  apuntarAppALaBaseDePrueba,
  trocearSql,
};
