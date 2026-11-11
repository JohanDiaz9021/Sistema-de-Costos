'use strict';

/**
 * Arranque comun de las suites de integracion.
 *
 * Cada archivo de test/integration/ levanta SU propio servidor y resiembra
 * la base entera, para que ninguno dependa del orden ni del estado que
 * dejo otro. El precio es ~1s por archivo; a cambio, cualquier prueba se
 * puede correr suelta y da el mismo resultado.
 *
 * OJO: las suites comparten UNA base (la del contenedor), asi que los
 * archivos NO pueden correr en paralelo — el TRUNCATE de una le borraria
 * los datos a otra a mitad de camino. Por eso el script de npm usa
 * --test-concurrency=1. Si algun dia se quiere paralelizar, cada worker
 * necesita su propio esquema (CREATE DATABASE gtc_test_<n>).
 */

const test = require('node:test');

const db = require('./db');
const fixtures = require('./fixtures');
const { arrancarServidor, crearCliente, clienteComo } = require('./servidor');

/**
 * Registra los hooks before/after de la suite y devuelve un contexto
 * que se va llenando (los tests lo leen ya poblado).
 *
 * Si la base de prueba no responde, marca ctx.disponible = false en vez
 * de reventar: cada prueba hace `if (!ctx.disponible) return t.skip(...)`,
 * asi `npm test` sigue siendo util en una maquina sin Docker.
 */
function prepararSuite({ cookieSecure = false, env = {} } = {}) {
  const ctx = {
    disponible: false,
    url: null,
    servidor: null,
    fixtures,
    db,
    clientes: {},
    /** Vuelve a dejar la base en el estado sembrado inicial. */
    async resembrar() {
      await db.resetearDatos();
      await fixtures.sembrar();
    },
    /** Cliente sin sesion. */
    anonimo() { return crearCliente(ctx.url); },
    /** Cliente autenticado con uno de los usuarios de fixtures. */
    como(usuario) { return clienteComo(ctx.url, usuario, fixtures.CLAVE); },
  };

  test.before(async () => {
    if (!(await db.esperarBase(15, 1000))) {
      console.warn(
        '\n[test] La base de prueba no responde en ' +
        `${db.CONFIG.host}:${db.CONFIG.port}. Levantala con:\n` +
        '        docker compose -f docker-compose.test.yml up -d\n'
      );
      return;
    }
    await db.prepararEsquema();
    await db.resetearDatos();
    await fixtures.sembrar();

    ctx.servidor = await arrancarServidor({ cookieSecure, env });
    ctx.url = ctx.servidor.url;

    // Sesiones listas para los cuatro roles que se usan una y otra vez.
    // Se resuelven ANTES de tocar ctx: require-atomic-updates avisa (con
    // razon) de que `ctx.x = await ...` puede pisar un cambio hecho por
    // otra tarea mientras se esperaba. Aqui no puede pasar, pero escribir
    // una sola vez al final es igual de claro y no necesita excepcion.
    const [ceo, admin, ana, bruno] = await Promise.all([
      ctx.como(fixtures.USUARIOS.ceo),
      ctx.como(fixtures.USUARIOS.admin),
      ctx.como(fixtures.USUARIOS.liderAlfa),
      ctx.como(fixtures.USUARIOS.liderBeta),
    ]);
    Object.assign(ctx.clientes, { ceo, admin, ana, bruno });

    ctx.disponible = true;
  });

  test.after(async () => {
    if (ctx.servidor) await ctx.servidor.cerrar();
    await db.cerrarPool();
  });

  return ctx;
}

/**
 * Envoltorio que salta la prueba (en vez de fallarla) cuando no hay base.
 * Se usa en TODAS las pruebas de integracion.
 */
function conBase(ctx, nombre, fn) {
  test(nombre, async (t) => {
    if (!ctx.disponible) return t.skip('base de prueba no disponible');
    await fn(t);
  });
}

module.exports = { prepararSuite, conBase };
