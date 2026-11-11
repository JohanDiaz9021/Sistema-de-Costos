'use strict';

/**
 * Guarda de arranque de las pruebas de integracion.
 *
 * POR QUE EXISTE: cada suite se salta sus pruebas (t.skip) cuando la base
 * no responde, para que `npm test` siga siendo util en una maquina sin
 * Docker. Pero node:test devuelve EXIT 0 con todo saltado, asi que
 * `npm run test:integration` daba "verde" sin haber ejecutado NADA.
 *
 * Eso es lo peor que le puede pasar a una suite: en CI, cualquier fallo
 * del contenedor se ve igual que un exito. Este script se ejecuta antes y
 * corta con exit 1 y un mensaje que dice exactamente que hacer.
 *
 * Uso:  node test/helpers/verificar-base.js
 */

const db = require('./db');

// 10 segundos alcanzan de sobra para un contenedor que ya esta levantado en
// la maquina del desarrollador (`npm run db:test:up` corrio antes). En CI la
// base arranca a la vez que el paso, y un MariaDB recien creado puede tardar
// mas en aceptar conexiones — de ahi que sea configurable en vez de un numero
// fijo generoso, que en local solo alargaria la espera cuando algo falla.
const INTENTOS = Number(process.env.TEST_DB_INTENTOS) || 10;

(async () => {
  const disponible = await db.esperarBase(INTENTOS, 1000);
  await db.cerrarPool();

  if (!disponible) {
    console.error('');
    console.error('  ============================================================');
    console.error('   No hay base de datos de prueba en ' + `${db.CONFIG.host}:${db.CONFIG.port}`);
    console.error('  ------------------------------------------------------------');
    console.error(`   Las pruebas de integracion necesitan MariaDB desechable.`);
    console.error(`   (se reintento ${INTENTOS} veces, 1s entre cada una)`);
    console.error('   Levantala con:');
    console.error('');
    console.error('       docker compose -f docker-compose.test.yml up -d');
    console.error('');
    console.error('   Y cuando termines:');
    console.error('');
    console.error('       docker compose -f docker-compose.test.yml down -v');
    console.error('  ============================================================');
    console.error('');
    process.exit(1);
  }

  console.log(`[test] base de prueba lista en ${db.CONFIG.host}:${db.CONFIG.port}/${db.CONFIG.database}`);
})();
