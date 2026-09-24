'use strict';

/**
 * src/services/snapshot-scheduler.js — el disparo automático diario de
 * snapshots, contra la base real.
 *
 * REFACTOR DE TESTEABILIDAD (documentado, el único cambio de producción de
 * este archivo): tick() ahora acepta { ahora, guardar } como dependencias
 * inyectables con el mismo comportamiento por defecto. Sin eso, probar la
 * guarda "no dispara antes de las 6am" exigiría poder mentirle a
 * MariaDB sobre su propia hora, y probar la reentrancia exigiría una
 * carrera real de timing. Ver el comentario en el archivo de origen.
 *
 * No se prueba `startSnapshotScheduler()` en sí (hace setInterval de una
 * hora): eso convertiría la suite en algo que tarda una hora o que hay que
 * mockear con temporizadores falsos tocando producción. En cambio se
 * prueban sus dos piezas por separado: que tick() hace lo correcto, y que
 * startSnapshotScheduler llama a tick() una vez al arrancar (verificable
 * sin esperar el intervalo).
 */

const test = require('node:test');
const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// src/db.js crea su PROPIO pool de mysql2 (distinto del que usa
// test/helpers/db.js). test.after() de prepararSuite() no sabe de su
// existencia y no lo cierra, y ese pool mantiene conexiones keep-alive
// abiertas que impiden que el proceso de pruebas termine solo. Se cierra
// aqui explicitamente cuando este archivo termina.
let appPool;
test.after(async () => { if (appPool) await appPool.end(); });

let scheduler;
conBase(ctx, '(setup) el modulo carga sin reventar', async () => {
  // src/services/snapshot-scheduler.js importa src/db.js, que arma su pool
  // de mysql2 LEYENDO process.env.DB_* en el momento del require() (una
  // sola vez, el modulo queda cacheado). Las demas suites requieren la app
  // como PROCESO HIJO (arrancarServidor()), que le pasa esas variables por
  // su propio entorno — pero este archivo necesita llamar a las funciones
  // del scheduler EN ESTE MISMO proceso para poder inyectarle los `ahora`/
  // `guardar` falsos, asi que hay que apuntar el proceso de pruebas mismo a
  // la base de prueba ANTES del primer require(), o el pool se arma con
  // host/usuario vacios y explota con ER_ACCESS_DENIED_ERROR.
  ctx.db.apuntarAppALaBaseDePrueba();
  scheduler = require('../../src/services/snapshot-scheduler');
  appPool = require('../../src/db').pool;
  assert.strictEqual(typeof scheduler.tick, 'function');
});

// ---------------------------------------------------------------
// La guarda de horario: no dispara antes de las 6am
// ---------------------------------------------------------------

conBase(ctx, 'tick(): antes de las 6am NO llama a guardar, y lo dice en el resultado', async () => {
  let seLlamoGuardar = false;
  const resultado = await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 3 }),
    guardar: async () => { seLlamoGuardar = true; },
  });

  assert.strictEqual(seLlamoGuardar, false, 'guardar() no debia llamarse antes de las 6am');
  assert.deepStrictEqual(resultado, { corrio: false, motivo: 'fuera_de_horario' });
});

conBase(ctx, 'tick(): justo a las 6am (el limite) SI llama a guardar', async () => {
  // RUN_AFTER_HOUR = 6, y la condicion es `hora < RUN_AFTER_HOUR`: a las
  // 6 en punto la guarda deja pasar. Se prueba el borde exacto, no solo
  // un valor comodo como el mediodia.
  assert.strictEqual(scheduler.RUN_AFTER_HOUR, 6, 'premisa: el limite documentado es 6am');

  let seLlamoGuardar = false;
  const resultado = await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 6 }),
    guardar: async () => { seLlamoGuardar = true; },
  });

  assert.strictEqual(seLlamoGuardar, true, 'a las 6:00 en punto deberia guardar');
  assert.deepStrictEqual(resultado, { corrio: true });
});

conBase(ctx, 'tick(): a las 5:59 (un minuto antes del limite) NO guarda', async () => {
  let seLlamoGuardar = false;
  await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 5 }),
    guardar: async () => { seLlamoGuardar = true; },
  });
  assert.strictEqual(seLlamoGuardar, false);
});

conBase(ctx, 'tick(): un error de guardar() se atrapa, no revienta el proceso', async () => {
  const resultado = await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 10 }),
    guardar: async () => { throw new Error('fallo simulado de la base'); },
  });
  assert.strictEqual(resultado.corrio, false);
  assert.strictEqual(resultado.motivo, 'error');
  assert.match(resultado.error.message, /fallo simulado/);
});

// ---------------------------------------------------------------
// Reentrancia: dos ticks no pueden correr a la vez
// ---------------------------------------------------------------

conBase(ctx, 'tick(): un segundo tick mientras el primero corre se salta solo', async () => {
  let terminoElPrimero = false;
  let vecesQueSeLlamoGuardar = 0;

  const primero = scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 10 }),
    guardar: async () => {
      vecesQueSeLlamoGuardar++;
      // Guardar "lento" a proposito: da tiempo a que el segundo tick
      // arranque mientras este todavia esta en curso.
      await new Promise((r) => setTimeout(r, 200));
      terminoElPrimero = true;
    },
  });

  // Se lanza el segundo ANTES de esperar al primero.
  await new Promise((r) => setTimeout(r, 20));
  const segundo = await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 10 }),
    guardar: async () => { vecesQueSeLlamoGuardar++; },
  });

  assert.strictEqual(terminoElPrimero, false, 'premisa: el segundo tick corrio MIENTRAS el primero seguia');
  assert.deepStrictEqual(segundo, { corrio: false, motivo: 'reentrancia' });

  const resultadoPrimero = await primero;
  assert.deepStrictEqual(resultadoPrimero, { corrio: true });
  assert.strictEqual(vecesQueSeLlamoGuardar, 1, 'guardar() debio llamarse UNA sola vez, no dos');
});

conBase(ctx, 'tick(): despues de terminar, el siguiente tick ya no se salta', async () => {
  // La bandera enCurso debe liberarse en el finally: si se quedara en
  // true por error, el scheduler dejaria de guardar snapshots para siempre.
  await scheduler.tick({ ahora: async () => ({ hoy: '2026-08-25', hora: 10 }), guardar: async () => {} });

  let seLlamo = false;
  const resultado = await scheduler.tick({
    ahora: async () => ({ hoy: '2026-08-25', hora: 10 }),
    guardar: async () => { seLlamo = true; },
  });
  assert.strictEqual(seLlamo, true, 'la bandera de reentrancia quedo trabada');
  assert.deepStrictEqual(resultado, { corrio: true });
});

// ---------------------------------------------------------------
// ahoraSegunLaBase(): consulta el reloj de MariaDB, no el del proceso
// ---------------------------------------------------------------

conBase(ctx, 'ahoraSegunLaBase() devuelve la hora y fecha reales de MariaDB', async () => {
  const { hoy, hora } = await scheduler.ahoraSegunLaBase();
  assert.match(hoy, /^\d{4}-\d{2}-\d{2}$/, `formato de fecha raro: ${hoy}`);
  assert.ok(Number.isInteger(hora) && hora >= 0 && hora <= 23, `hora fuera de rango: ${hora}`);

  const [directo] = await ctx.db.query('SELECT CURDATE() AS hoy, HOUR(NOW()) AS hora');
  assert.strictEqual(hoy, directo.hoy, 'no coincide con CURDATE() de la base');
  assert.strictEqual(hora, Number(directo.hora));
});

// ---------------------------------------------------------------
// centrosConSnapshotHoy(): distingue portafolio de centros, en una query
// ---------------------------------------------------------------

conBase(ctx, 'centrosConSnapshotHoy(): sin snapshots hoy, todo vacio', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  const r = await scheduler.centrosConSnapshotHoy();
  assert.strictEqual(r.portafolio, false);
  assert.strictEqual(r.centros.size, 0);
});

conBase(ctx, 'centrosConSnapshotHoy(): distingue el snapshot de portafolio (cost_center_id NULL) de los de centro', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  await ctx.db.query(
    `INSERT INTO mp_costeo_snapshot (cost_center_id, project_name, snapshot_date, indicadores_json)
     VALUES (NULL, 'Todos los proyectos (portafolio)', CURDATE(), '{}'),
            (?, 'Proyecto Alfa', CURDATE(), '{}')`,
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const r = await scheduler.centrosConSnapshotHoy();
  assert.strictEqual(r.portafolio, true);
  assert.strictEqual(r.centros.has(ctx.fixtures.CENTROS.alfa.id), true);
  assert.strictEqual(r.centros.has(ctx.fixtures.CENTROS.beta.id), false);

  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});

conBase(ctx, 'centrosConSnapshotHoy(): un snapshot de AYER no cuenta como "de hoy"', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  await ctx.db.query(
    `INSERT INTO mp_costeo_snapshot (cost_center_id, project_name, snapshot_date, indicadores_json)
     VALUES (?, 'Proyecto Alfa', DATE_SUB(CURDATE(), INTERVAL 1 DAY), '{}')`,
    [ctx.fixtures.CENTROS.alfa.id]
  );
  const r = await scheduler.centrosConSnapshotHoy();
  assert.strictEqual(r.centros.has(ctx.fixtures.CENTROS.alfa.id), false, 'un snapshot de ayer no debe contar');

  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});

// ---------------------------------------------------------------
// guardarSnapshotsAutomaticos(): el flujo completo contra datos reales
// ---------------------------------------------------------------

conBase(ctx, 'guardarSnapshotsAutomaticos(): crea un snapshot por centro activo + uno de portafolio', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');

  await scheduler.guardarSnapshotsAutomaticos();

  const filas = await ctx.db.query('SELECT cost_center_id FROM mp_costeo_snapshot WHERE snapshot_date = CURDATE()');
  const centrosActivos = await ctx.db.query("SELECT cost_center_id FROM mp_centro_costo WHERE status != 'inactivo'");

  assert.strictEqual(filas.length, centrosActivos.length + 1, 'debe haber uno por centro activo, mas el del portafolio');
  assert.ok(filas.some((f) => f.cost_center_id === null), 'falta el snapshot del portafolio');
  for (const c of centrosActivos) {
    assert.ok(filas.some((f) => f.cost_center_id === c.cost_center_id), `falta el snapshot del centro ${c.cost_center_id}`);
  }

  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});

conBase(ctx, 'guardarSnapshotsAutomaticos(): NO duplica si ya existe un snapshot de hoy', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  await scheduler.guardarSnapshotsAutomaticos();
  const primeraPasada = await ctx.db.query('SELECT COUNT(*) n FROM mp_costeo_snapshot WHERE snapshot_date = CURDATE()');

  await scheduler.guardarSnapshotsAutomaticos();
  const segundaPasada = await ctx.db.query('SELECT COUNT(*) n FROM mp_costeo_snapshot WHERE snapshot_date = CURDATE()');

  assert.strictEqual(Number(segundaPasada[0].n), Number(primeraPasada[0].n), 'correr dos veces no debe duplicar filas');

  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});

conBase(ctx, 'guardarSnapshotsAutomaticos(): completa lo que falta sin tocar lo que ya existia', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  // Se guarda a mano SOLO el del centro Alfa, con un JSON reconocible.
  await ctx.db.query(
    `INSERT INTO mp_costeo_snapshot (cost_center_id, project_name, snapshot_date, indicadores_json)
     VALUES (?, 'Proyecto Alfa (a mano)', CURDATE(), '{"marca":"no-tocar"}')`,
    [ctx.fixtures.CENTROS.alfa.id]
  );

  await scheduler.guardarSnapshotsAutomaticos();

  const [alfa] = await ctx.db.query(
    'SELECT indicadores_json FROM mp_costeo_snapshot WHERE cost_center_id = ? AND snapshot_date = CURDATE()',
    [ctx.fixtures.CENTROS.alfa.id]
  );
  const json = typeof alfa.indicadores_json === 'string' ? JSON.parse(alfa.indicadores_json) : alfa.indicadores_json;
  assert.strictEqual(json.marca, 'no-tocar', 'el snapshot que ya existia se sobreescribio');

  const portafolio = await ctx.db.query('SELECT 1 FROM mp_costeo_snapshot WHERE cost_center_id IS NULL AND snapshot_date = CURDATE()');
  assert.strictEqual(portafolio.length, 1, 'el snapshot de portafolio, que faltaba, deberia haberse creado');

  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});

conBase(ctx, 'guardarSnapshotsAutomaticos(): un centro inactivo NO recibe snapshot automatico', async () => {
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
  await ctx.db.query("UPDATE mp_centro_costo SET status = 'inactivo' WHERE cost_center_id = ?", [ctx.fixtures.CENTROS.beta.id]);

  try {
    await scheduler.guardarSnapshotsAutomaticos();
    const filas = await ctx.db.query('SELECT 1 FROM mp_costeo_snapshot WHERE cost_center_id = ?', [ctx.fixtures.CENTROS.beta.id]);
    assert.strictEqual(filas.length, 0, 'un centro inactivo no deberia recibir snapshot automatico');
  } finally {
    await ctx.db.query('DELETE FROM mp_costeo_snapshot');
    await ctx.resembrar();
  }
});

conBase(ctx, 'getCentrosActivos(): excluye los centros inactivos', async () => {
  await ctx.db.query("UPDATE mp_centro_costo SET status = 'inactivo' WHERE cost_center_id = ?", [ctx.fixtures.CENTROS.gamma.id]);
  try {
    const activos = await scheduler.getCentrosActivos();
    assert.ok(!activos.some((c) => c.cost_center_id === ctx.fixtures.CENTROS.gamma.id));
    assert.ok(activos.some((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id));
  } finally {
    await ctx.resembrar();
  }
});

// ---------------------------------------------------------------
// startSnapshotScheduler(): dispara un tick al arrancar
// ---------------------------------------------------------------

conBase(ctx, 'startSnapshotScheduler(): al arrancar corre un tick inmediato, sin esperar la primera hora', async () => {
  // "por si el contenedor arranca despues de las 6am" (ver el comentario
  // en el propio archivo): sin este tick inicial, un despliegue a media
  // tarde se quedaria sin snapshot hasta la primera revision del
  // setInterval, hasta una hora despues.
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');

  const interval = scheduler.startSnapshotScheduler();
  // El tick inicial es async y no se espera dentro de la funcion (fire and
  // forget, ver el codigo fuente); se le da un margen para completar
  // contra la base real.
  await new Promise((r) => setTimeout(r, 3000));

  const filas = await ctx.db.query('SELECT 1 FROM mp_costeo_snapshot WHERE snapshot_date = CURDATE() LIMIT 1');
  assert.ok(filas.length > 0, 'startSnapshotScheduler no disparo un guardado al arrancar');

  clearInterval(interval);
  await ctx.db.query('DELETE FROM mp_costeo_snapshot');
});
