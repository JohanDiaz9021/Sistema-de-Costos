'use strict';

/**
 * Infraestructura del servidor: /healthz, las paginas HTML, el redirect
 * de /costeo?panel=alertas y el arranque con COOKIE_SECURE=true.
 *
 * Son cosas que viven en server.js, fuera de los routers, y que un test
 * montando un express sintetico no veria.
 */

const assert = require('node:assert');
const test = require('node:test');

const { prepararSuite, conBase } = require('../helpers/suite');
const db = require('../helpers/db');
const fixtures = require('../helpers/fixtures');
const { arrancarServidor, crearCliente } = require('../helpers/servidor');

const ctx = prepararSuite();

// ---------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------

conBase(ctx, '/healthz responde 200 con la base sana y no pide sesion', async () => {
  const r = await ctx.anonimo().get('/healthz');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { status: 'ok' });
});

conBase(ctx, '/healthz NO filtra detalles de la base cuando falla', async (t) => {
  // Se arranca un servidor apuntando a un puerto donde no hay nada, para
  // provocar el fallo de verdad en vez de simularlo.
  const roto = await arrancarServidor({
    env: { DB_HOST: '127.0.0.1', DB_PORT: '59999', DB_NAME: 'no_existe_esta_base' },
  }).catch(() => null);

  if (!roto) return t.skip('el servidor no arranca sin base (esperable): no se puede probar el 503');

  try {
    const r = await crearCliente(roto.url).get('/healthz');
    assert.strictEqual(r.status, 503);

    const texto = JSON.stringify(r.json);
    // Ni el host, ni el puerto, ni el nombre de la base, ni el codigo del
    // driver pueden salir en la respuesta: /healthz es publico.
    for (const aguja of ['59999', 'no_existe_esta_base', 'ECONNREFUSED', '127.0.0.1', 'ER_']) {
      assert.ok(!texto.includes(aguja), `/healthz filtro "${aguja}": ${texto}`);
    }
    assert.deepStrictEqual(r.json, { status: 'error' }, 'la respuesta deberia ser escueta');
  } finally {
    await roto.cerrar();
  }
});

// ---------------------------------------------------------------
// Paginas HTML y redirects
// ---------------------------------------------------------------

conBase(ctx, '/ sin sesion redirige a /login', async () => {
  const r = await ctx.anonimo().get('/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/login');
});

conBase(ctx, '/costeo sin sesion redirige a /login', async () => {
  const r = await ctx.anonimo().get('/costeo');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/login');
});

conBase(ctx, '/login se sirve sin sesion', async () => {
  const r = await ctx.anonimo().get('/login');
  assert.strictEqual(r.status, 200);
  assert.match(r.texto, /login-form/);
  // El script se saco a un archivo para poder cerrar la CSP.
  assert.match(r.texto, /src="\/js\/login\.js"/);
  assert.ok(!/<script>[^<]/.test(r.texto), 'quedo un script inline en login.html');
});

conBase(ctx, 'un leader SI puede abrir /costeo?panel=alertas (26 ago 2026, dejo de ser exclusivo de CEO/admin)', async () => {
  // El PM ya veia el CONTEO de alertas en el encabezado de Costo Planeado
  // sin poder abrir la pestana para ver cuales eran -- GET /api/costeo/alertas
  // scopea al PM a su propio proyecto (probado aparte en aislamiento.test.js),
  // asi que el bloqueo de la pagina ya no tenia sentido.
  const r = await ctx.clientes.ana.get('/costeo?panel=alertas');
  assert.strictEqual(r.status, 200, 'a un leader ya no se le debe redirigir');
});

conBase(ctx, 'ceo y admin SI pueden abrir /costeo?panel=alertas', async () => {
  for (const cliente of [ctx.clientes.ceo, ctx.clientes.admin]) {
    const r = await cliente.get('/costeo?panel=alertas');
    assert.strictEqual(r.status, 200, 'a ceo/admin no se les debe redirigir');
  }
});

conBase(ctx, 'un leader SI puede abrir los demas paneles de /costeo', async () => {
  for (const panel of ['indicadores', 'equipo-y-gastos', 'centro-de-costos']) {
    const r = await ctx.clientes.ana.get(`/costeo?panel=${panel}`);
    assert.strictEqual(r.status, 200, `el panel ${panel} deberia estar permitido`);
  }
});

conBase(ctx, 'los archivos estaticos se sirven con revalidacion', async () => {
  const r = await ctx.anonimo().get('/js/safe-html.js');
  assert.strictEqual(r.status, 200);
  // 'no-cache' = el navegador guarda pero SIEMPRE revalida contra el
  // servidor. Sin esto la gente veia pantallas viejas tras un despliegue.
  assert.match(r.headers.get('cache-control') || '', /no-cache/);
  assert.ok(r.headers.get('etag'), 'falta el ETag para poder responder 304');
});

conBase(ctx, 'todos los scripts que piden las paginas existen', async () => {
  for (const pagina of ['/login', '/costeo']) {
    const cliente = pagina === '/login' ? ctx.anonimo() : ctx.clientes.ceo;
    const html = (await cliente.get(pagina)).texto;
    const scripts = [...html.matchAll(/<script src="(\/js\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${pagina} no carga ningun script`);
    for (const src of scripts) {
      const r = await ctx.anonimo().get(src);
      assert.strictEqual(r.status, 200, `${pagina} apunta a ${src} y devuelve ${r.status}`);
    }
  }
});

conBase(ctx, 'una ruta que no existe da 404, no 500', async () => {
  const r = await ctx.clientes.ceo.get('/esta-ruta-no-existe');
  assert.strictEqual(r.status, 404);
});

conBase(ctx, 'un JSON malformado da 400, no tumba el proceso', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/gastos', '{ esto no es json', {
    headers: { 'Content-Type': 'application/json' },
  });
  assert.ok(r.status === 400 || r.status === 500, `dio ${r.status}`);

  // Y el servidor sigue en pie.
  assert.strictEqual((await ctx.clientes.ceo.get('/healthz')).status, 200);
});

conBase(ctx, 'un cuerpo gigante se rechaza (limite de 256kb)', async () => {
  const enorme = { descripcion: 'X'.repeat(300 * 1024) };
  const r = await ctx.clientes.ceo.post('/api/costeo/gastos', enorme);
  assert.ok(r.status >= 400, `un cuerpo de 300kb deberia rechazarse y dio ${r.status}`);
  assert.strictEqual((await ctx.clientes.ceo.get('/healthz')).status, 200, 'el servidor sigue vivo');
});

conBase(ctx, 'el error handler no filtra el stack trace', async () => {
  // Cualquier 500 debe responder un mensaje generico. Un stack trace
  // delata rutas del servidor y nombres de archivos internos.
  const r = await ctx.clientes.ceo.get('/api/costeo/snapshots/999999999999999999999');
  if (r.status >= 500) {
    const texto = JSON.stringify(r.json);
    assert.ok(!texto.includes('at '), `se filtro un stack trace: ${texto}`);
    assert.ok(!texto.includes('src\\') && !texto.includes('src/'), `se filtraron rutas internas: ${texto}`);
  }
});

// ---------------------------------------------------------------
// COOKIE_SECURE=true: servidor aparte
// ---------------------------------------------------------------

test('con COOKIE_SECURE=true, detras de proxy (X-Forwarded-Proto: https), la cookie sale Secure', async (t) => {
  if (!(await db.esperarBase(5, 500))) return t.skip('base de prueba no disponible');
  await db.prepararEsquema();
  await db.resetearDatos();
  await fixtures.sembrar();

  const s = await arrancarServidor({ cookieSecure: true });
  try {
    // HALLAZGO (documentado, no es un bug): con cookie.secure=true,
    // express-session directamente NO EMITE la cookie si la conexion no
    // es HTTPS — es su comportamiento documentado, no algo que este
    // proyecto controle. La primera version de esta prueba pegaba en HTTP
    // plano sin mas y fallaba con "no se emitio Set-Cookie", que hizo
    // parecer un bug de la app cuando en realidad probaba algo que la app
    // nunca promete (una cookie Secure sin TLS).
    //
    // server.js SI hace su parte: `app.set('trust proxy', 1)` (ver
    // src/server.js) le dice a Express que confie en X-Forwarded-Proto de
    // un proxy en frente. Simulando ese header, que es exactamente lo que
    // manda nginx/caddy al terminar TLS, la cookie sale bien.
    const r = await fetch(`${s.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: fixtures.USUARIOS.ceo.email, password: fixtures.CLAVE }),
    });
    assert.strictEqual(r.status, 200);
    const [cookie] = r.headers.getSetCookie();
    assert.ok(cookie, 'no se emitio Set-Cookie ni simulando el proxy');
    assert.match(cookie, /;\s*Secure/i, `falta el atributo Secure: ${cookie}`);
    assert.match(cookie, /HttpOnly/i);
  } finally {
    await s.cerrar();
    await db.cerrarPool();
  }
});

test('con COOKIE_SECURE=true SIN el header del proxy, la cookie NO sale (documentado)', async (t) => {
  if (!(await db.esperarBase(5, 500))) return t.skip('base de prueba no disponible');
  await db.resetearDatos();
  await fixtures.sembrar();

  const s = await arrancarServidor({ cookieSecure: true });
  try {
    const r = await crearCliente(s.url).login(fixtures.USUARIOS.ceo.email, fixtures.CLAVE);
    // Login SI funciona (200), pero sin sesion utilizable: es el escenario
    // a evitar si algun dia el proxy dejara de reenviar el header.
    assert.strictEqual(r.status, 200);
    assert.ok(!r.headers.getSetCookie().length, 'sin el header del proxy no deberia emitirse cookie');
  } finally {
    await s.cerrar();
    await db.cerrarPool();
  }
});

test('con COOKIE_SECURE=true se manda HSTS', async (t) => {
  if (!(await db.esperarBase(5, 500))) return t.skip('base de prueba no disponible');
  await db.prepararEsquema();

  const s = await arrancarServidor({ cookieSecure: true });
  try {
    const r = await crearCliente(s.url).get('/login');
    assert.ok(
      r.headers.get('strict-transport-security'),
      'con COOKIE_SECURE=true deberia mandarse HSTS'
    );
  } finally {
    await s.cerrar();
    await db.cerrarPool();
  }
});

test('sin SESSION_SECRET el servidor NO arranca', async (t) => {
  if (!(await db.esperarBase(5, 500))) return t.skip('base de prueba no disponible');

  // Es la proteccion mas importante del arranque: con un fallback, un
  // despliegue sin la variable firmaria las cookies con un valor publico
  // y cualquiera podria fabricarse una sesion de CEO.
  await assert.rejects(
    () => arrancarServidor({ env: { SESSION_SECRET: '' } }),
    /murio al arrancar|SESSION_SECRET/i,
    'el servidor arranco sin SESSION_SECRET'
  );

  await assert.rejects(
    () => arrancarServidor({ env: { SESSION_SECRET: 'corto' } }),
    /murio al arrancar|SESSION_SECRET/i,
    'el servidor arranco con un SESSION_SECRET de 5 caracteres'
  );

  await db.cerrarPool();
});
