'use strict';

/**
 * Seguridad puntual: inyeccion SQL en los filtros dinamicos y atributos de
 * la cookie de sesion.
 *
 * Los filtros (month, project, leader, employee_id, week, cost_center_id)
 * son el punto donde el usuario mete texto que termina en una query. El
 * codigo usa `?` en todos, pero las clausulas de scope y de filtro se
 * arman concatenando cadenas, asi que conviene verificarlo contra la base
 * real y no leyendo el codigo.
 *
 * Criterio de exito: el payload se trata como DATO. O devuelve vacio (no
 * hay ningun proyecto que se llame asi) o 400, pero nunca ejecuta nada ni
 * revienta con un error de sintaxis SQL — un 500 aqui significa que la
 * cadena llego cruda hasta el motor.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

const PAYLOADS = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "'; DROP TABLE mp_centro_costo; --",
  "1'; UPDATE mp_centro_costo SET budget=0; --",
  "' UNION SELECT password_hash FROM mp_dashboard_users --",
  "\\' OR \\'1\\'=\\'1",
  "' AND (SELECT SLEEP(5)) --",
  '1 OR 1=1',
  "admin'--",
  "%' OR project_folder LIKE '%",
];

const FILTROS = ['month', 'project', 'leader', 'employee_id', 'week', 'cost_center_id'];

const ENDPOINTS_CON_FILTRO = [
  '/api/costeo/indicadores-17',
  '/api/costeo/alertas',
  '/api/costeo/comercial',
  '/api/costeo/equipo',
  '/api/costeo/gastos',
  '/api/costeo/overtime',
  '/api/filters/',
];

conBase(ctx, 'ningun payload de inyeccion produce un 500 en los filtros', async () => {
  // Un 500 significa error de sintaxis SQL: la cadena llego sin escapar.
  const fallos = [];

  for (const endpoint of ENDPOINTS_CON_FILTRO) {
    for (const filtro of FILTROS) {
      for (const payload of PAYLOADS) {
        const r = await ctx.clientes.ceo.get(`${endpoint}?${filtro}=${encodeURIComponent(payload)}`);
        if (r.status >= 500) {
          fallos.push(`${endpoint}?${filtro}=${payload} -> ${r.status} ${JSON.stringify(r.json)}`);
        }
      }
    }
  }

  assert.deepStrictEqual(fallos, [], `posible inyeccion SQL:\n  ${fallos.join('\n  ')}`);
});

conBase(ctx, 'las tablas siguen intactas despues de los payloads destructivos', async () => {
  const tablas = ['mp_centro_costo', 'mp_dashboard_users', 'mp_costo_no_planeado', 'mp_equipo_proyecto'];
  const antes = {};
  for (const t of tablas) antes[t] = Number((await ctx.db.query(`SELECT COUNT(*) n FROM ${t}`))[0].n);

  for (const payload of PAYLOADS) {
    for (const filtro of FILTROS) {
      await ctx.clientes.ceo.get(`/api/costeo/indicadores-17?${filtro}=${encodeURIComponent(payload)}`);
    }
  }

  for (const t of tablas) {
    const n = Number((await ctx.db.query(`SELECT COUNT(*) n FROM ${t}`))[0].n);
    assert.strictEqual(n, antes[t], `${t} cambio de tamaño tras los payloads`);
  }

  // Y en particular nadie puso los presupuestos en 0.
  const presupuestos = await ctx.db.query('SELECT budget FROM mp_centro_costo ORDER BY cost_center_id');
  assert.ok(presupuestos.some((p) => Number(p.budget) > 0), 'los presupuestos se pusieron en 0');
});

conBase(ctx, "un ' OR '1'='1 en un filtro NO amplia lo que se ve", async () => {
  // La prueba de fondo: si la inyeccion funcionara, Ana veria mas de un
  // centro. Con el payload tratado como dato, ve lo mismo o menos.
  const normal = await ctx.clientes.ana.get('/api/costeo/indicadores-17');
  const cuantosNormal = normal.json.centros.length;

  for (const payload of PAYLOADS) {
    const r = await ctx.clientes.ana.get(`/api/costeo/indicadores-17?project=${encodeURIComponent(payload)}`);
    assert.ok(r.status < 500, `${payload} -> ${r.status}`);
    if (r.json && Array.isArray(r.json.centros)) {
      assert.ok(
        r.json.centros.length <= cuantosNormal,
        `el payload "${payload}" amplio la vista de ${cuantosNormal} a ${r.json.centros.length} centros`
      );
      const texto = JSON.stringify(r.json);
      assert.ok(!texto.includes('BETA'), `el payload "${payload}" filtro datos de BETA`);
    }
  }
});

conBase(ctx, 'ningun payload devuelve hashes de contraseña', async () => {
  // El UNION SELECT password_hash es el clasico: si algo se colara, el
  // hash apareceria en la respuesta.
  for (const endpoint of ENDPOINTS_CON_FILTRO) {
    for (const payload of PAYLOADS) {
      const r = await ctx.clientes.ceo.get(`${endpoint}?leader=${encodeURIComponent(payload)}`);
      const texto = JSON.stringify(r.json ?? r.texto ?? '');
      assert.ok(!texto.includes('$2a$') && !texto.includes('$2b$'), `${endpoint} devolvio un hash con "${payload}"`);
      assert.ok(!texto.includes('password_hash'), `${endpoint} devolvio password_hash con "${payload}"`);
    }
  }
});

conBase(ctx, 'inyeccion en los parametros de RUTA (:id, :rol, :key)', async () => {
  // Estos no van por querystring sino en el path, y algunos se usan para
  // buscar en un catalogo antes de tocar la base.
  const rutas = [
    (p) => `/api/costeo/centros/${encodeURIComponent(p)}`,
    (p) => `/api/costeo/snapshots/${encodeURIComponent(p)}`,
    (p) => `/api/costeo/tarifas-cargo/${encodeURIComponent(p)}`,
    (p) => `/api/costeo/config/${encodeURIComponent(p)}`,
  ];
  for (const construir of rutas) {
    for (const payload of PAYLOADS) {
      const r = await ctx.clientes.ceo.get(construir(payload));
      assert.ok(r.status < 500, `${construir(payload)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
});

conBase(ctx, 'inyeccion en el cuerpo de un POST (descripcion de gasto)', async () => {
  // El texto se guarda tal cual: es un dato. Lo que no puede pasar es que
  // se ejecute, ni que rompa la query.
  const payload = "'; DROP TABLE mp_costo_no_planeado; --";
  const r = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: payload, amount: 1000,
    expense_date: '2026-08-20', category: 'otro',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [fila] = await ctx.db.query('SELECT description FROM mp_costo_no_planeado WHERE expense_id = ?', [r.json.expense_id]);
  assert.strictEqual(fila.description, payload, 'el texto se guarda literal, sin interpretarse');

  const tabla = await ctx.db.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mp_costo_no_planeado'");
  assert.strictEqual(Number(tabla[0].n), 1, 'la tabla sigue existiendo');

  await ctx.clientes.ana.delete(`/api/costeo/gastos/${r.json.expense_id}`);
});

conBase(ctx, 'inyeccion en el identificador del login', async () => {
  // El clasico admin'-- para saltarse la comprobacion de contraseña.
  const c = ctx.anonimo();
  for (const payload of ["' OR '1'='1", "admin'--", "' OR 1=1 --"]) {
    const r = await c.post('/api/auth/login', { email: payload, password: 'loquesea' });
    assert.ok(r.status === 401 || r.status === 429, `login con "${payload}" -> ${r.status}`);
    assert.ok(!c.cookie, `se creo una sesion con el payload "${payload}"`);
  }
});

// ---------------------------------------------------------------
// Cookie de sesion
// ---------------------------------------------------------------

conBase(ctx, 'la cookie es HttpOnly y SameSite=Lax', async () => {
  const c = await ctx.como(ctx.fixtures.USUARIOS.ceo);
  const cookie = c.cookieHeader;
  assert.ok(cookie, 'no se recibio Set-Cookie');

  // HttpOnly: JavaScript no puede leerla, asi que un XSS no se lleva la sesion.
  assert.match(cookie, /HttpOnly/i, cookie);
  // SameSite=Lax: el navegador no manda la cookie en un POST desde otro
  // sitio, que es lo que cubre el CSRF en este proyecto (no hay token).
  assert.match(cookie, /SameSite=Lax/i, cookie);
  assert.match(cookie, /Path=\//, cookie);
});

conBase(ctx, 'la cookie NO lleva Secure cuando COOKIE_SECURE=false', async () => {
  // En HTTP plano (LAN, pruebas) marcarla Secure haria que el navegador
  // no la enviara nunca y nadie podria entrar.
  const c = await ctx.como(ctx.fixtures.USUARIOS.ceo);
  assert.ok(!/;\s*Secure/i.test(c.cookieHeader), `no deberia llevar Secure: ${c.cookieHeader}`);
});

conBase(ctx, 'una cookie manipulada no da acceso', async () => {
  // express-session firma el id. Cambiarle un caracter invalida la firma.
  const c = await ctx.como(ctx.fixtures.USUARIOS.ceo);
  const original = c.cookie;

  const espia = ctx.anonimo();
  for (const falsa of [
    original.replace(/.$/, 'X'),
    'gtc.sid=s%3Ainventado.firmaFalsa',
    'gtc.sid=' + 'A'.repeat(50),
    original.replace('s%3A', ''),
  ]) {
    espia.forzarCookie(falsa);
    const r = await espia.get('/api/auth/me');
    assert.strictEqual(r.status, 401, `la cookie manipulada "${falsa.slice(0, 40)}..." fue aceptada`);
  }
});

conBase(ctx, 'la sesion de un usuario no sirve para otro', async () => {
  const ana = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);
  const bruno = await ctx.como(ctx.fixtures.USUARIOS.liderBeta);
  assert.notStrictEqual(ana.cookie, bruno.cookie);

  const conCookieDeAna = ctx.anonimo();
  conCookieDeAna.forzarCookie(ana.cookie);
  const r = await conCookieDeAna.get('/api/auth/me');
  assert.strictEqual(r.json.user.email, ctx.fixtures.USUARIOS.liderAlfa.email);
});

conBase(ctx, 'las cabeceras de seguridad estan puestas', async () => {
  const r = await ctx.clientes.ceo.get('/api/auth/me');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy'), 'falta la CSP');
  assert.ok(!r.headers.get('x-powered-by'), 'x-powered-by delata la tecnologia');

  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/, 'falta la proteccion contra clickjacking');
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), `la CSP permite scripts inline: ${csp}`);
});
