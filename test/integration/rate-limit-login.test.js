'use strict';

/**
 * Limitador de intentos de login, contra el servidor real.
 *
 * Vive en su propio archivo porque agota el cupo de intentos de la IP, y
 * cualquier prueba que corriera despues en el mismo proceso recibiria 429
 * sin tener nada que ver.
 *
 * Ademas, cada prueba levanta SU PROPIO servidor: los contadores viven en
 * memoria del proceso (src/middleware/rate-limit.js), asi que un proceso
 * nuevo es la unica forma de empezar con el cupo limpio. La alternativa
 * seria exponer un reset, pero eso es codigo de produccion escrito para
 * las pruebas — y ademas un endpoint de reset del limitador es justo lo
 * que un atacante querria.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../helpers/db');
const fixtures = require('../helpers/fixtures');
const { arrancarServidor, crearCliente } = require('../helpers/servidor');

const MAX_INTENTOS = 8; // igual que src/middleware/rate-limit.js

let hayBase = false;

test.before(async () => {
  if (!(await db.esperarBase(15, 1000))) {
    console.warn('[test] base de prueba no disponible; se saltan las pruebas del limitador');
    return;
  }
  await db.prepararEsquema();
  await db.resetearDatos();
  await fixtures.sembrar();
  hayBase = true;
});

test.after(async () => { await db.cerrarPool(); });

/** Arranca un servidor limpio y se asegura de cerrarlo pase lo que pase. */
async function conServidorLimpio(fn) {
  const s = await arrancarServidor();
  try {
    return await fn(crearCliente(s.url), s);
  } finally {
    await s.cerrar();
  }
}

test('a los 8 intentos fallidos responde 429 con Retry-After', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  await conServidorLimpio(async (c) => {
    for (let i = 1; i <= MAX_INTENTOS; i++) {
      const r = await c.post('/api/auth/login', { email: 'victima@ejemplo.test', password: 'mala' });
      assert.strictEqual(r.status, 401, `el intento ${i} deberia ser 401 y fue ${r.status}`);
    }

    const bloqueado = await c.post('/api/auth/login', { email: 'victima@ejemplo.test', password: 'mala' });
    assert.strictEqual(bloqueado.status, 429, 'el intento 9 deberia estar bloqueado');

    const retryAfter = bloqueado.headers.get('retry-after');
    assert.ok(retryAfter, 'falta el header Retry-After');
    assert.ok(Number(retryAfter) > 0, `Retry-After deberia ser segundos y es "${retryAfter}"`);
    assert.ok(Number(retryAfter) <= 15 * 60, `Retry-After exagerado: ${retryAfter}s`);
  });
});

test('el bloqueo tapa incluso la contraseña CORRECTA', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  // Si el limitador dejara pasar el acierto, no serviria de nada: un
  // atacante podria seguir probando hasta dar con la clave.
  await conServidorLimpio(async (c) => {
    const usuario = fixtures.USUARIOS.admin;
    for (let i = 0; i < MAX_INTENTOS; i++) {
      await c.post('/api/auth/login', { email: usuario.email, password: 'mala' });
    }
    const conClaveBuena = await c.post('/api/auth/login', {
      email: usuario.email, password: fixtures.CLAVE,
    });
    assert.strictEqual(conClaveBuena.status, 429, 'el limitador debe aplicar tambien al acierto');
  });
});

test('un login CORRECTO limpia el contador de esa cuenta', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  // Equivocarse un par de veces y acertar no puede dejar al usuario a un
  // intento del bloqueo la proxima vez.
  await conServidorLimpio(async (c) => {
    const usuario = fixtures.USUARIOS.ceo;
    for (let i = 0; i < MAX_INTENTOS - 2; i++) {
      await c.post('/api/auth/login', { email: usuario.email, password: 'mala' });
    }
    assert.strictEqual((await c.post('/api/auth/login', {
      email: usuario.email, password: fixtures.CLAVE,
    })).status, 200, 'deberia poder entrar antes de agotar el cupo');

    // Contador reiniciado: vuelve a haber margen completo.
    for (let i = 1; i <= MAX_INTENTOS - 1; i++) {
      const r = await c.post('/api/auth/login', { email: usuario.email, password: 'mala' });
      assert.strictEqual(r.status, 401, `tras el acierto, el intento ${i} deberia seguir dando 401`);
    }
  });
});

test('HALLAZGO QA-03: el cupo es de la IP, no solo de la cuenta', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  // Esta prueba DOCUMENTA el comportamiento actual, no lo aprueba.
  //
  // Ocho fallos contra CUALQUIER combinacion de correos, desde una misma
  // IP, bloquean tambien a un usuario que nunca fallo. Es lo correcto
  // contra un atacante que prueba muchas cuentas desde una maquina.
  //
  // Pero el dashboard corre detras de un proxy (app.set('trust proxy', 1)).
  // Si ese proxy no reenvia bien el X-Forwarded-For, TODA la empresa
  // comparte una sola IP: ocho errores de tipeo de cualquiera dejan sin
  // entrar a todos los demas durante 15 minutos.
  //
  // Ver docs/testing.md (QA-03) para las opciones de mitigacion.
  await conServidorLimpio(async (c) => {
    for (let i = 0; i < MAX_INTENTOS; i++) {
      await c.post('/api/auth/login', { email: `nadie${i}@ejemplo.test`, password: 'mala' });
    }

    const inocente = await c.post('/api/auth/login', {
      email: fixtures.USUARIOS.liderAlfa.email,
      password: fixtures.CLAVE,
    });
    assert.strictEqual(
      inocente.status, 429,
      'cambio el comportamiento del limitador: revisar QA-03 en docs/testing.md'
    );
  });
});

test('el 429 no revela si la cuenta existe', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  await conServidorLimpio(async (c) => {
    for (let i = 0; i < MAX_INTENTOS; i++) {
      await c.post('/api/auth/login', { email: 'da-igual@ejemplo.test', password: 'mala' });
    }
    const existente = await c.post('/api/auth/login', { email: fixtures.USUARIOS.ceo.email, password: 'x' });
    const inexistente = await c.post('/api/auth/login', { email: 'fantasma@ejemplo.test', password: 'x' });

    assert.strictEqual(existente.status, inexistente.status);
    assert.deepStrictEqual(existente.json, inexistente.json, 'el mensaje distingue cuentas existentes');
  });
});
