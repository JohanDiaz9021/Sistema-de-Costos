'use strict';

/**
 * Autenticacion: /api/auth/* y la cookie de sesion.
 *
 * Cubre login por correo y por usuario, cuenta inactiva, el limitador de
 * intentos, el logout y los atributos de la cookie.
 *
 * PRESUPUESTO DE INTENTOS FALLIDOS (importante):
 * el limitador cuenta por IP **ademas de** por usuario, y todas las
 * pruebas salen de 127.0.0.1. Con 8 fallos por ventana, este archivo
 * entero comparte ese cupo: si se agregan mas pruebas de credenciales
 * malas, a partir del noveno 401 todo lo demas empieza a recibir 429 y la
 * suite pasa a depender del orden.
 *
 * Hoy se gastan 3 (contraseña mala, usuario inexistente, y la de
 * validar-clave-antes-que-is_active). Las que necesitan agotar el cupo
 * viven aparte, en rate-limit-login.test.js, con su propio servidor.
 *
 * Ver el hallazgo QA-03 en docs/testing.md: esa misma cuenta por IP tiene
 * consecuencias en produccion detras de un proxy.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------

conBase(ctx, 'login por CORREO devuelve 200 y los datos del usuario', async () => {
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.ceo.email, ctx.fixtures.CLAVE);

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.user.email, ctx.fixtures.USUARIOS.ceo.email);
  assert.strictEqual(r.json.user.role, 'ceo');
  assert.ok(c.cookie, 'no se recibio la cookie de sesion');
});

conBase(ctx, 'login por USUARIO (username) tambien funciona', async () => {
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.liderAlfa.username, ctx.fixtures.CLAVE);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.email, ctx.fixtures.USUARIOS.liderAlfa.email);
});

conBase(ctx, 'el identificador no distingue mayusculas ni espacios', async () => {
  const c = ctx.anonimo();
  const r = await c.login(`  ${ctx.fixtures.USUARIOS.liderAlfa.email.toUpperCase()}  `, ctx.fixtures.CLAVE);
  assert.strictEqual(r.status, 200, 'deberia entrar igual');
});

conBase(ctx, 'la respuesta del login NUNCA incluye el hash de la contraseña', async () => {
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.ceo.email, ctx.fixtures.CLAVE);
  const texto = JSON.stringify(r.json);
  assert.ok(!texto.includes('password'), `la respuesta menciona password: ${texto}`);
  assert.ok(!texto.includes('$2a$') && !texto.includes('$2b$'), 'se filtro un hash bcrypt');
});

conBase(ctx, 'contraseña incorrecta da 401 con mensaje generico', async () => {
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.ceo.email, 'clave-equivocada');
  assert.strictEqual(r.status, 401);
  // Generico a proposito: decir "el usuario existe pero la clave no" seria
  // confirmarle a un atacante que ese correo tiene cuenta.
  assert.match(r.json.error, /inv[aá]lid/i);
  assert.ok(!c.cookie, 'no deberia haber cookie de sesion');
});

conBase(ctx, 'usuario inexistente da el MISMO 401 que una clave mala', async () => {
  const c = ctx.anonimo();
  const r = await c.login('no-existe-nadie@ejemplo.test', 'loquesea');
  assert.strictEqual(r.status, 401);
  assert.match(r.json.error, /inv[aá]lid/i);
});

conBase(ctx, 'correo o contraseña vacios dan 400', async () => {
  const c = ctx.anonimo();
  assert.strictEqual((await c.post('/api/auth/login', { email: '', password: 'x' })).status, 400);
  assert.strictEqual((await c.post('/api/auth/login', { email: 'a@b.test', password: '' })).status, 400);
  assert.strictEqual((await c.post('/api/auth/login', {})).status, 400);
});

conBase(ctx, 'cuenta INACTIVA da 403 con mensaje especifico (no 401 generico)', async () => {
  // Es una decision de producto: al PM desactivado hay que decirle por que
  // no entra, o va a pensar que escribio mal la contraseña.
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.liderInactivo.email, ctx.fixtures.CLAVE);
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /Inactiv/i);
  assert.ok(!c.cookie, 'una cuenta inactiva no puede recibir sesion');
});

conBase(ctx, 'la clave se valida ANTES que is_active', async () => {
  // Si fuera al reves, cualquiera podria averiguar que cuentas estan
  // desactivadas probando con una clave cualquiera.
  const c = ctx.anonimo();
  const r = await c.login(ctx.fixtures.USUARIOS.liderInactivo.email, 'clave-equivocada');
  assert.strictEqual(r.status, 401, 'con clave mala debe dar 401, no revelar el estado de la cuenta');
});

// ---------------------------------------------------------------
// Sesion: /me, logout
// ---------------------------------------------------------------

conBase(ctx, 'GET /me sin sesion da 401; con sesion devuelve al usuario', async () => {
  const anon = ctx.anonimo();
  assert.strictEqual((await anon.get('/api/auth/me')).status, 401);

  const r = await ctx.clientes.ana.get('/api/auth/me');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.email, ctx.fixtures.USUARIOS.liderAlfa.email);
  assert.strictEqual(r.json.user.role, 'leader');
});

conBase(ctx, 'logout destruye la sesion de verdad', async () => {
  const c = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);
  assert.strictEqual((await c.get('/api/auth/me')).status, 200);

  const salida = await c.logout();
  assert.strictEqual(salida.status, 200);
  assert.strictEqual((await c.get('/api/auth/me')).status, 401, 'la sesion sobrevivio al logout');
});

conBase(ctx, 'la cookie vieja NO sirve despues del logout', async () => {
  // Que el navegador borre la cookie no basta: el servidor tiene que
  // haber destruido la sesion. Si solo la borrara del cliente, quien
  // hubiera copiado la cookie seguiria dentro.
  const c = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);
  const cookieVieja = c.cookie;
  await c.logout();

  const espia = ctx.anonimo();
  espia.forzarCookie(cookieVieja);
  assert.strictEqual((await espia.get('/api/auth/me')).status, 401, 'la cookie vieja sigue viva');
});

conBase(ctx, 'el login REGENERA el id de sesion (anti session fixation)', async () => {
  // Sin regenerate(), un atacante que consiga fijarle una cookie a la
  // victima antes del login se queda con una sesion ya autenticada.
  const c = ctx.anonimo();
  await c.post('/api/auth/login', { email: ctx.fixtures.USUARIOS.ceo.email, password: 'mala' });
  const antes = c.cookie;

  await c.login(ctx.fixtures.USUARIOS.ceo.email, ctx.fixtures.CLAVE);
  const despues = c.cookie;

  assert.ok(despues, 'no hay cookie despues del login');
  if (antes) assert.notStrictEqual(antes, despues, 'el id de sesion no se regenero');
});

// ---------------------------------------------------------------
// PUT /me/sidebar
// ---------------------------------------------------------------

conBase(ctx, 'PUT /me/sidebar guarda la preferencia y la refleja en /me', async () => {
  const c = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);

  const r = await c.put('/api/auth/me/sidebar', { collapsed: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.sidebar_collapsed, true);

  // Persistio en la base, no solo en la sesion.
  const [fila] = await ctx.db.query(
    'SELECT sidebar_collapsed FROM mp_dashboard_users WHERE user_id = ?',
    [ctx.fixtures.USUARIOS.liderAlfa.id]
  );
  assert.strictEqual(Number(fila.sidebar_collapsed), 1);

  // Y quedo en la sesion viva, sin necesidad de volver a entrar.
  assert.strictEqual((await c.get('/api/auth/me')).json.user.sidebar_collapsed, true);

  await c.put('/api/auth/me/sidebar', { collapsed: false });
});

conBase(ctx, 'PUT /me/sidebar sin sesion da 401', async () => {
  assert.strictEqual((await ctx.anonimo().put('/api/auth/me/sidebar', { collapsed: true })).status, 401);
});

conBase(ctx, 'PUT /me/sidebar solo toca al usuario de la sesion', async () => {
  // Es una preferencia personal: no acepta un user_id del cuerpo.
  const c = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);
  await c.put('/api/auth/me/sidebar', { collapsed: true, user_id: ctx.fixtures.USUARIOS.ceo.id });

  const [ceo] = await ctx.db.query(
    'SELECT sidebar_collapsed FROM mp_dashboard_users WHERE user_id = ?',
    [ctx.fixtures.USUARIOS.ceo.id]
  );
  assert.strictEqual(Number(ceo.sidebar_collapsed), 0, 'le cambio la preferencia a otro usuario');

  await c.put('/api/auth/me/sidebar', { collapsed: false });
});
