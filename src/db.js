'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'sistema_monitoreo',
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
  connectionLimit: Number(process.env.DB_POOL_LIMIT) || 25,
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
