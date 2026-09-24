'use strict';

/**
 * Humo del router de /api/costeo: que las 36 rutas respondan.
 *
 * Nacio al partir src/routes/costeo.js (1.514 lineas) en
 * src/routes/costeo/*.js. Un corte asi puede romperse de dos formas que
 * `node --check` no ve: que un modulo se quede sin un import, o que al
 * remontar las rutas alguna quede tapada por otra.
 *
 * HISTORIA IMPORTANTE: la primera version de este archivo levantaba el
 * router con la configuracion del .env, o sea contra la base REAL de
 * produccion. Eran solo lecturas, pero es una practica peligrosa: basta
 * que alguien agregue una prueba de escritura para que la suite escriba
 * en produccion. Ahora usa la base desechable como el resto de
 * test/integration/, y test/helpers/db.js se niega a arrancar si el
 * nombre de la base o el puerto huelen a entorno real.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// endpoint -> clave que debe traer la respuesta
const LECTURAS = {
  '/api/costeo/centros': 'centros',
  '/api/costeo/tarifas-cargo': 'cargos',
  '/api/costeo/equipo': 'equipo',
  '/api/costeo/gastos': 'gastos',
  '/api/costeo/overtime': 'overtime',
  '/api/costeo/indicadores': 'centros',
  '/api/costeo/indicadores-17': 'centros',
  '/api/costeo/meses': 'months',
  '/api/costeo/alertas': 'alertas',
  '/api/costeo/comercial': 'proyectos',
  '/api/costeo/snapshots': 'snapshots',
  '/api/costeo/proyectos-disponibles': 'proyectos',
  '/api/costeo/accesos': 'accesos',
  '/api/costeo/historial': 'historial',
  '/api/costeo/config': 'config',
};

for (const [ruta, clave] of Object.entries(LECTURAS)) {
  conBase(ctx, `GET ${ruta} responde 200 con "${clave}"`, async () => {
    const r = await ctx.clientes.ceo.get(ruta);
    assert.strictEqual(r.status, 200, `${ruta} devolvio ${r.status}`);
    assert.ok(clave in r.json, `${ruta} no trajo la clave "${clave}"`);
  });
}

conBase(ctx, 'el filtro de periodo no rompe ningun calculo', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');
  assert.strictEqual(r.status, 200);
  const { centros, portafolio } = r.json;
  assert.ok(Array.isArray(centros));
  if (centros.length) assert.ok(portafolio, 'con centros activos deberia haber portafolio');
});

conBase(ctx, 'una ruta inexistente da 404, no 500', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/no-existe-esta-ruta');
  assert.strictEqual(r.status, 404);
});

conBase(ctx, 'PUT /config rechaza una clave del prototipo de Object', async () => {
  // Antes `CONFIG_DEFS['constructor']` devolvia algo truthy y pasaba la
  // validacion, insertando una fila basura en mp_costeo_config.
  for (const clave of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await ctx.clientes.ceo.put(`/api/costeo/config/${clave}`, { config_value: 1 });
    assert.strictEqual(r.status, 400, `/config/${clave} deberia dar 400 y dio ${r.status}`);
  }

  // Y no quedo ninguna fila con esas claves.
  const filas = await ctx.db.query(
    "SELECT config_key FROM mp_costeo_config WHERE config_key IN ('constructor','toString','__proto__','hasOwnProperty')"
  );
  assert.deepStrictEqual(filas, []);
});

conBase(ctx, 'las 53 rutas del router siguen registradas tras el split', async () => {
  // Si un `router.use(require('./x'))` se cayera de index.js, el modulo
  // entero desapareceria en silencio y solo se notaria en produccion.
  const costeoRoutes = require('../../src/routes/costeo');

  function listar(router) {
    const out = [];
    for (const capa of router.stack) {
      if (capa.route) {
        for (const metodo of Object.keys(capa.route.methods)) {
          out.push(`${metodo.toUpperCase()} ${capa.route.path}`);
        }
      } else if (capa.handle && capa.handle.stack) {
        out.push(...listar(capa.handle));
      }
    }
    return out;
  }

  // 53 = 51 anteriores + DELETE /equipo/:id (borrado real, distinto de
  // inactivar) y POST /alertas/corregida (marcar una alerta como resuelta
  // a mano), ambos del 16 sep 2026.
  // (envío de alertas por correo SMTP).
  const rutas = listar(costeoRoutes);
  assert.strictEqual(rutas.length, 53, `el router tiene ${rutas.length} rutas y deberian ser 53:\n${rutas.join('\n')}`);

  // Al menos una ruta de cada modulo del split.
  for (const esperada of [
    'GET /centros', 'GET /tarifas-cargo', 'GET /equipo', 'GET /gastos',
    'GET /overtime', 'GET /indicadores-17', 'GET /comercial',
    'GET /snapshots', 'GET /accesos', 'GET /historial', 'GET /config',
  ]) {
    assert.ok(rutas.includes(esperada), `falta la ruta ${esperada}: se cayo un modulo del index.js`);
  }
});
