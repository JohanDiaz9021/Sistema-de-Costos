'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');

// TLS hacia la base, apagado por defecto: el MariaDB de stable.host hoy tiene
// have_ssl=DISABLED (sin certificado) y rechaza el handshake cifrado
// (HANDSHAKE_NO_SSL_SUPPORT, verificado 30 sep 2026). Cuando el hosting lo
// habilite, basta DB_SSL=true. Encendido valida el certificado del servidor;
// DB_SSL_CA apunta al .pem de la CA si el hosting usa una CA propia.
function opcionesSsl() {
  if (String(process.env.DB_SSL).toLowerCase() !== 'true') return undefined;
  const ssl = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (process.env.DB_SSL_CA) ssl.ca = fs.readFileSync(process.env.DB_SSL_CA, 'utf8');
  return ssl;
}

const POOL_LIMIT = Number(process.env.DB_POOL_LIMIT) || 25;

// Soltar las conexiones que nadie usa (6 nov 2026). Con maxIdle sin poner,
// mysql2 lo iguala a connectionLimit y en ese caso NO arranca el proceso que
// cierra conexiones ociosas: cada copia de la app se quedaba con ~25
// conexiones abiertas para siempre, aunque nadie la estuviera usando. Con dos
// copias (producción + una local) y n8n se pasaba el tope de 50 de
// usuario_bd, y las pantallas se quedaban "Cargando…" con
// ER_TOO_MANY_USER_CONNECTIONS.
//
// maxIdle = límite - 1 basta para encender ese proceso sin cambiar nada más:
// mientras haya actividad las conexiones se reutilizan igual que antes (las
// que se usaron en los últimos 60 s no se tocan), y solo se cierran las que
// pasan idleTimeout (60 s, abajo) sin usarse. DB_POOL_MAX_IDLE permite bajarlo.
const POOL_MAX_IDLE = Number(process.env.DB_POOL_MAX_IDLE) || Math.max(1, POOL_LIMIT - 1);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'sistema_monitoreo',
  ssl: opcionesSsl(),
  waitForConnections: true,
  // 25 y no 10 (9 sep 2026). El techo real lo pone el MariaDB de stable.host:
  // `SHOW VARIABLES LIKE 'max_user_connections'` devuelve 50, así que 25 deja
  // la mitad libre para el RPA de n8n, los scripts de operación y una segunda
  // réplica si algún día se levanta.
  //
  // Por qué importa: abrir Costeo dispara Indicadores + Alertas + Comercial a
  // la vez, y cada uno recorre los centros de costos en paralelo. Con 10, esas
  // ramas se hacían cola entre ellas contra una base que está fuera del
  // servidor (~100ms de ida y vuelta por consulta), así que el límite del pool
  // —y no la base— era parte del cuello de botella.
  connectionLimit: POOL_LIMIT,
  maxIdle: POOL_MAX_IDLE,
  queueLimit: 0,
  dateStrings: true,
  timezone: 'Z',
  charset: 'utf8mb4_general_ci',
  // El servidor MariaDB de stable.host cierra conexiones idle agresivamente.
  // Estos flags evitan que el pool guarde conexiones muertas en caché.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 60000,
});

// Con maxIdle < connectionLimit, mysql2 revisa las conexiones ociosas con un
// setTimeout que se vuelve a programar cada segundo — y ese timer mantiene
// vivo el proceso: las pruebas y los scripts que no llaman pool.end() ya no
// terminaban nunca. Se le hace unref() a cada timer que programa (el método
// se reemplaza en la instancia, y el propio timer lo vuelve a llamar), así la
// limpieza sigue corriendo mientras la app vive pero no la retiene.
// Si una versión futura de mysql2 cambia este detalle interno, no se rompe
// nada: simplemente no se aplica el unref.
const internoPool = pool.pool;
if (internoPool && typeof internoPool._removeIdleTimeoutConnections === 'function') {
  const programarLimpieza = internoPool._removeIdleTimeoutConnections.bind(internoPool);
  internoPool._removeIdleTimeoutConnections = function programarLimpiezaSinRetener() {
    programarLimpieza();
    const timer = internoPool._removeIdleTimeoutConnectionsTimer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  if (internoPool._removeIdleTimeoutConnectionsTimer) internoPool._removeIdleTimeoutConnections();
}

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Ejecuta varias escrituras como una sola unidad: o quedan todas, o no queda
 * ninguna.
 *
 * Hace falta donde una operación toca más de una tabla. El caso que lo
 * motivó: crear un PM inserta en mp_dashboard_users y después en
 * mp_project_owners; si lo segundo falla, antes quedaba un usuario sin
 * ningún proyecto asignado, que puede entrar al sistema pero no ve nada, y
 * nadie se entera. Editar era peor: primero desactivaba TODAS sus
 * asignaciones y luego reinsertaba, así que un fallo en medio dejaba al PM
 * sin acceso a nada.
 *
 * Uso:
 *   await withTransaction(async (exec) => {
 *     const r = await exec('INSERT ...', [...]);
 *     await exec('INSERT ...', [r.insertId]);
 *   });
 *
 * `exec` tiene la misma forma que query(): devuelve las filas (o el
 * ResultSetHeader en escrituras). Importante usar SIEMPRE `exec` dentro del
 * callback — un query() suelto tomaría OTRA conexión del pool y quedaría
 * fuera de la transacción, que es justo el error que esto viene a evitar.
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const exec = async (sql, params = []) => {
      const [rows] = await conn.execute(sql, params);
      return rows;
    };
    const resultado = await fn(exec);
    await conn.commit();
    return resultado;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (errRollback) {
      console.error('[db] fallo el rollback:', errRollback.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, withTransaction };
