'use strict';

/**
 * Levanta la app REAL (server.js sin modificar) contra la base de prueba,
 * y da un cliente HTTP que mantiene la cookie de sesion.
 *
 * Por que la app real y no un express armado a mano: la mitad de las
 * propiedades que hay que verificar viven en el orden del middleware de
 * server.js — requireAuth antes que las rutas, attachScope antes que
 * requestCache, la CSP. Un app sintetico las saltaria todas y las pruebas
 * darian verde sobre algo que en produccion no pasa.
 *
 * server.js llama a app.listen() al cargarse, asi que se ejecuta como
 * PROCESO HIJO en vez de require(). Es tambien lo mas fiel: es el mismo
 * `node server.js` del Dockerfile.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const { CONFIG } = require('./db');

const RAIZ = path.join(__dirname, '..', '..');

async function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Arranca `node server.js` apuntando a la base de prueba.
 * Devuelve { url, cerrar, logs }.
 */
async function arrancarServidor({ cookieSecure = false, env = {} } = {}) {
  const port = await puertoLibre();
  const logs = [];

  const hijo = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      // dotenv no pisa variables ya definidas, asi que esto gana sobre
      // el .env del proyecto y la app queda apuntando a la base de prueba.
      DB_HOST: CONFIG.host,
      DB_PORT: String(CONFIG.port),
      DB_USER: CONFIG.user,
      DB_PASSWORD: CONFIG.password,
      DB_NAME: CONFIG.database,
      PORT: String(port),
      SESSION_SECRET: 'secreto-solo-para-pruebas-de-integracion-0123456789abcdef',
      COOKIE_SECURE: String(cookieSecure),
      WORK_HOURS_MONDAY: '8',
      WORK_HOURS_TUE_FRI: '9',
      // Apagada la cache de indicadores entre peticiones (src/lib/shared-cache.js).
      //
      // No es por comodidad: estas pruebas siembran sus escenarios escribiendo
      // DIRECTO en la base (ctx.db.query('INSERT ...')), sin pasar por la API,
      // y ese es justamente el camino que el servidor no puede ver para
      // invalidar. Con la cache encendida, un INSERT hecho asi quedaba tapado
      // por lo que hubiera cacheado un GET anterior y la prueba fallaba por el
      // reloj, no por la logica (paso de verdad: "Arturo deberia contar en
      // BETA" en motor-costeo.test.js).
      //
      // La cache no queda sin probar por esto: su comportamiento propio esta
      // en test/unit/shared-cache.test.js, y que una escritura POR LA API la
      // invalide de inmediato — lo unico de lo que depende produccion — se
      // verifica en test/integration/cache-indicadores.test.js, que levanta su
      // propio servidor CON la cache encendida.
      COSTEO_CACHE_TTL_MS: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  hijo.stdout.on('data', (d) => logs.push(String(d)));
  hijo.stderr.on('data', (d) => logs.push(String(d)));

  const url = `http://127.0.0.1:${port}`;

  // Se espera a que /healthz responda ALGO: 200 si la base esta sana, 503
  // si no. Cualquiera de los dos confirma que el proceso levanto y acepta
  // conexiones.
  //
  // Exigir un 200 (r.ok) seria un error sutil: server.js hace listen() sin
  // esperar a la base (el pool de mysql2 es perezoso), asi que un servidor
  // apuntado a propositito a una base inalcanzable SI arranca, pero su
  // /healthz responde 503 para siempre. Con `if (r.ok)` esa espera agotaba
  // los 30s completos y la prueba del 503 terminaba saltandose con un
  // motivo equivocado ("el servidor no arranca") en vez de ejecutarse.
  const limite = Date.now() + 30000;
  let ultimoError = '';
  let respondio = false;
  while (Date.now() < limite) {
    if (hijo.exitCode !== null) {
      throw new Error(`server.js murio al arrancar (codigo ${hijo.exitCode}):\n${logs.join('')}`);
    }
    try {
      await fetch(`${url}/healthz`);
      respondio = true;
      break;
    } catch (err) {
      ultimoError = err.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!respondio) {
    throw new Error(`el servidor no respondio a tiempo (${ultimoError}):\n${logs.join('')}`);
  }

  const cerrar = () => new Promise((resolve) => {
    if (hijo.exitCode !== null) return resolve();
    hijo.once('exit', () => resolve());
    hijo.kill('SIGKILL'); // SIGTERM no lo mata en Windows
    setTimeout(resolve, 3000);
  });

  return { url, cerrar, logs, port };
}

/**
 * Cliente HTTP que recuerda la cookie gtc.sid, como un navegador.
 *
 * `cookies` se expone para poder inspeccionar los atributos de la cookie
 * (httpOnly, sameSite, secure) sin parsear el header a mano en cada prueba.
 */
function crearCliente(baseUrl) {
  let cookieCruda = null;
  let setCookieHeader = null;

  async function pedir(metodo, ruta, { body, headers = {}, redirect = 'manual' } = {}) {
    const opciones = { method: metodo, headers: { ...headers }, redirect };
    if (body !== undefined) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (cookieCruda) opciones.headers.Cookie = cookieCruda;

    const res = await fetch(baseUrl + ruta, opciones);

    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      if (c.startsWith('gtc.sid=')) {
        setCookieHeader = c;
        cookieCruda = c.split(';')[0];
        // Cookie borrada por el logout.
        if (/gtc\.sid=;/.test(c)) cookieCruda = null;
      }
    }

    // Se lee el cuerpo una sola vez y se expone ya parseado: el patron
    // `await r.json()` repetido en cada prueba revienta si el endpoint
    // devolvio HTML (un redirect, por ejemplo) y el error no dice nada.
    const tipo = res.headers.get('content-type') || '';
    let json = null;
    let texto = null;
    let buffer = null;
    if (tipo.includes('application/json')) {
      texto = await res.text();
      try { json = JSON.parse(texto); } catch { /* se deja en texto */ }
    } else if (tipo.includes('text/') || tipo.includes('html')) {
      texto = await res.text();
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
    }

    return {
      status: res.status,
      headers: res.headers,
      json,
      texto,
      buffer,
      location: res.headers.get('location'),
    };
  }

  return {
    get: (ruta, o) => pedir('GET', ruta, o),
    post: (ruta, body, o) => pedir('POST', ruta, { ...o, body: body ?? {} }),
    put: (ruta, body, o) => pedir('PUT', ruta, { ...o, body: body ?? {} }),
    delete: (ruta, o) => pedir('DELETE', ruta, o),

    /** Hace login de verdad contra /api/auth/login y guarda la cookie. */
    async login(identificador, clave) {
      const r = await pedir('POST', '/api/auth/login', {
        body: { email: identificador, password: clave },
      });
      return r;
    },
    async logout() {
      return pedir('POST', '/api/auth/logout', { body: {} });
    },
    get cookie() { return cookieCruda; },
    get cookieHeader() { return setCookieHeader; },
    /** Fuerza una cookie cruda: sirve para probar sesiones manipuladas. */
    forzarCookie(valor) { cookieCruda = valor; },
  };
}

/** Cliente ya autenticado con uno de los usuarios de fixtures.js. */
async function clienteComo(baseUrl, usuario, clave) {
  const c = crearCliente(baseUrl);
  const r = await c.login(usuario.email, clave);
  if (r.status !== 200) {
    throw new Error(`no se pudo autenticar a ${usuario.email}: ${r.status} ${r.texto || ''}`);
  }
  return c;
}

module.exports = { arrancarServidor, crearCliente, clienteComo, puertoLibre };
