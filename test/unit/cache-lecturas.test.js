'use strict';

/**
 * Caché de respuestas entre peticiones (src/lib/cache-lecturas.js).
 *
 * Igual que shared-cache.js, un error aquí no se ve como lentitud sino como
 * números viejos en pantalla. Lo que se fija abajo es cuándo puede devolver
 * lo guardado y cuándo está obligada a dejar pasar la petición a la base.
 * El reloj, el día y el contador de versión se inyectan.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  crearCacheLecturas,
  esCacheable,
  ttlDesdeEntorno,
} = require('../../src/lib/cache-lecturas');

// Lo mínimo de express que usa el middleware.
function reqFalso({ url = '/api/costeo/equipo', method = 'GET', user = { user_id: 1, role: 'admin' } } = {}) {
  return { method, originalUrl: url, session: user ? { user } : {} };
}

function resFalso() {
  const headers = {};
  const res = {
    statusCode: 200,
    enviado: null,
    set(k, v) { headers[k.toLowerCase()] = v; return res; },
    get(k) { return headers[k.toLowerCase()]; },
    status(c) { res.statusCode = c; return res; },
    send(cuerpo) { res.enviado = cuerpo; return res; },
    json(body) {
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
      return res.send(JSON.stringify(body));
    },
    headers,
  };
  return res;
}

// Arma un entorno controlable: `pedir` corre el middleware y, si deja pasar,
// el "handler" que responde `respuesta()` (y cuenta cuántas veces se llegó a
// él, que es lo mismo que contar cuántas veces se fue a la base).
function entorno(opciones = {}) {
  const reloj = { ms: 1000 };
  const ver = { v: 0 };
  const dia = { d: '2026-10-16' };
  const cache = crearCacheLecturas({
    ttlMs: 60000,
    ahora: () => reloj.ms,
    version: () => ver.v,
    dia: () => dia.d,
    ...opciones,
  });
  let llegadas = 0;

  function pedir(reqOpts, { respuesta = () => ({ n: llegadas }), status = 200, antesDeResponder } = {}) {
    const req = reqFalso(reqOpts);
    const res = resFalso();
    let pasoAlHandler = false;
    cache(req, res, () => {
      pasoAlHandler = true;
      llegadas += 1;
      if (antesDeResponder) antesDeResponder();
      res.status(status).json(respuesta());
    });
    return { res, pasoAlHandler, cuerpo: res.enviado && JSON.parse(res.enviado) };
  }

  return { cache, pedir, reloj, ver, dia, llegadas: () => llegadas };
}

test('la segunda lectura igual se sirve guardada, sin ir a la base', () => {
  const e = entorno();
  const a = e.pedir({});
  const b = e.pedir({});

  assert.strictEqual(a.pasoAlHandler, true);
  assert.strictEqual(a.res.get('X-Cache-Lecturas'), 'MISS');
  assert.strictEqual(b.pasoAlHandler, false, 'la segunda no debió llegar al handler');
  assert.strictEqual(b.res.get('X-Cache-Lecturas'), 'HIT');
  assert.deepStrictEqual(b.cuerpo, a.cuerpo);
  assert.match(b.res.get('Content-Type'), /application\/json/);
  assert.strictEqual(e.llegadas(), 1);
});

test('dos usuarios distintos no comparten respuesta, aunque pidan la misma URL', () => {
  const e = entorno();
  e.pedir({ user: { user_id: 1, role: 'ceo' } });
  const pm = e.pedir({ user: { user_id: 2, role: 'leader' } });

  assert.strictEqual(pm.pasoAlHandler, true, 'el PM no puede recibir lo que se calculó para el CEO');
  assert.strictEqual(e.llegadas(), 2);
});

test('la query es parte de la clave: otro mes es otra respuesta', () => {
  const e = entorno();
  e.pedir({ url: '/api/indicator/5?month=Septiembre' });
  const octubre = e.pedir({ url: '/api/indicator/5?month=Octubre' });
  const septiembreOtraVez = e.pedir({ url: '/api/indicator/5?month=Septiembre' });

  assert.strictEqual(octubre.pasoAlHandler, true);
  assert.strictEqual(septiembreOtraVez.pasoAlHandler, false);
});

test('una escritura (sube la versión) obliga a ir a la base en la siguiente lectura', () => {
  const e = entorno();
  e.pedir({});
  e.ver.v += 1;
  const despues = e.pedir({});

  assert.strictEqual(despues.pasoAlHandler, true);
  assert.strictEqual(despues.res.get('X-Cache-Lecturas'), 'MISS');
});

test('si alguien escribe MIENTRAS se calculaba, esa respuesta no se guarda', () => {
  const e = entorno();
  // La lectura arrancó con la versión 0 y la escritura llegó antes de que
  // respondiera: trae los números de antes del cambio.
  e.pedir({}, { antesDeResponder: () => { e.ver.v += 1; } });
  const siguiente = e.pedir({});

  assert.strictEqual(siguiente.pasoAlHandler, true, 'no debió quedar guardado un cálculo previo a la escritura');
});

test('una respuesta de error no se guarda', () => {
  const e = entorno();
  e.pedir({}, { status: 403, respuesta: () => ({ error: 'Permiso insuficiente' }) });
  const reintento = e.pedir({});

  assert.strictEqual(reintento.pasoAlHandler, true);
});

test('vencido el TTL vuelve a la base', () => {
  const e = entorno();
  e.pedir({});
  e.reloj.ms += 59999;
  assert.strictEqual(e.pedir({}).pasoAlHandler, false, 'antes de vencer sigue sirviendo');
  e.reloj.ms += 2;
  assert.strictEqual(e.pedir({}).pasoAlHandler, true, 'vencido tiene que recalcular');
});

test('al cambiar el día de negocio vuelve a la base (lo de "hoy" no cruza la medianoche)', () => {
  const e = entorno();
  e.pedir({});
  e.dia.d = '2026-10-17';
  assert.strictEqual(e.pedir({}).pasoAlHandler, true);
});

test('solo se guardan las rutas de la lista; el resto pasa siempre', () => {
  const e = entorno();
  for (const url of ['/api/costeo/indicadores-17/export/xlsx', '/api/costeo/alertas/email/estado', '/api/auth/me']) {
    e.pedir({ url });
    assert.strictEqual(e.pedir({ url }).pasoAlHandler, true, `${url} no debería cachearse`);
  }
});

test('solo GET: una escritura pasa siempre y no deja nada guardado', () => {
  const e = entorno();
  e.pedir({ method: 'POST' });
  assert.strictEqual(e.pedir({ method: 'POST' }).pasoAlHandler, true);
  assert.strictEqual(e.cache.tamano(), 0);
});

test('sin sesión no guarda nada (requireAuth va antes, esto es por si acaso)', () => {
  const e = entorno();
  e.pedir({ user: null });
  assert.strictEqual(e.cache.tamano(), 0);
});

test('con el límite lleno sale la usada hace más tiempo', () => {
  const e = entorno({ maxEntradas: 2 });
  e.pedir({ url: '/api/indicator/1' });
  e.pedir({ url: '/api/indicator/2' });
  e.pedir({ url: '/api/indicator/1' }); // acierto: la 1 pasa a ser la más reciente
  e.pedir({ url: '/api/indicator/3' }); // entra la 3, sale la 2

  assert.strictEqual(e.cache.tamano(), 2);
  assert.strictEqual(e.pedir({ url: '/api/indicator/1' }).pasoAlHandler, false, 'la 1 se usó hace poco');
  assert.strictEqual(e.pedir({ url: '/api/indicator/2' }).pasoAlHandler, true, 'la 2 era la más vieja');
});

test('con TTL 0 está apagada: todo pasa a la base', () => {
  const e = entorno({ ttlMs: 0 });
  e.pedir({});
  assert.strictEqual(e.pedir({}).pasoAlHandler, true);
  assert.strictEqual(e.cache.activa, false);
});

test('esCacheable: lo que arma Planeación y Costos al abrir, y nada más', () => {
  for (const ruta of [
    '/api/filters', '/api/indicator/18', '/api/indicator/3/drilldown', '/api/resource/42',
    '/api/employees', '/api/validation/errors/summary', '/api/costeo/alertas',
    '/api/costeo/indicadores-17', '/api/costeo/comercial', '/api/costeo/historial',
  ]) {
    assert.strictEqual(esCacheable(ruta), true, `${ruta} debería cachearse`);
  }
  for (const ruta of [
    '/api/indicator/export/pdf', '/api/costeo/indicadores-17/export/pdf',
    '/api/costeo/centros/5/plan-recursos', '/api/costeo/equipo/salario-conocido/7',
    '/api/costeo/snapshots', '/api/auth/me',
  ]) {
    assert.strictEqual(esCacheable(ruta), false, `${ruta} NO debería cachearse`);
  }
});

test('ttlDesdeEntorno: se apaga junto con la de indicadores en las pruebas de integración', () => {
  assert.strictEqual(ttlDesdeEntorno({ COSTEO_CACHE_TTL_MS: '0' }), 0);
  assert.strictEqual(ttlDesdeEntorno({ COSTEO_CACHE_TTL_MS: '0', LECTURAS_CACHE_TTL_MS: '5000' }), 5000);
  assert.strictEqual(ttlDesdeEntorno({ LECTURAS_CACHE_TTL_MS: '0' }), 0);
  assert.strictEqual(ttlDesdeEntorno({ COSTEO_CACHE_TTL_MS: '600000' }), 10 * 60 * 1000);
  assert.strictEqual(ttlDesdeEntorno({}), 10 * 60 * 1000);
});
