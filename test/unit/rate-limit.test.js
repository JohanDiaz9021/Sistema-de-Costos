'use strict';

/**
 * Cubre el limitador de intentos de login (src/middleware/rate-limit.js).
 * Antes de esto, /api/auth/login aceptaba intentos sin ningun techo.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  limitarIntentosLogin,
  registrarIntentoFallido,
  limpiarIntentos,
  MAX_INTENTOS,
} = require('../../src/middleware/rate-limit');

// Doble minimo de req/res, suficiente para este middleware.
function pedir(ip, email) {
  return { ip, body: { email }, socket: {} };
}

function ejecutar(req) {
  let estado = null;
  let cuerpo = null;
  let siguio = false;
  const res = {
    setHeader() {},
    status(c) { estado = c; return this; },
    json(b) { cuerpo = b; return this; },
  };
  limitarIntentosLogin(req, res, () => { siguio = true; });
  return { siguio, estado, cuerpo };
}

test('deja pasar mientras no se supere el limite, y bloquea despues', () => {
  const req = pedir('10.0.0.1', 'victima@gtc.com');
  limpiarIntentos(req);

  for (let i = 0; i < MAX_INTENTOS; i++) {
    assert.strictEqual(ejecutar(req).siguio, true, `el intento ${i + 1} deberia pasar`);
    registrarIntentoFallido(req);
  }

  const bloqueado = ejecutar(req);
  assert.strictEqual(bloqueado.siguio, false);
  assert.strictEqual(bloqueado.estado, 429);
  limpiarIntentos(req);
});

test('un login correcto limpia el contador', () => {
  const req = pedir('10.0.0.2', 'pm@gtc.com');
  limpiarIntentos(req);

  // Se equivoca varias veces y acierta: no debe quedar al borde del bloqueo.
  for (let i = 0; i < MAX_INTENTOS - 1; i++) registrarIntentoFallido(req);
  limpiarIntentos(req);

  for (let i = 0; i < MAX_INTENTOS; i++) {
    assert.strictEqual(ejecutar(req).siguio, true);
    registrarIntentoFallido(req);
  }
  limpiarIntentos(req);
});

test('el bloqueo cuenta tambien por usuario, no solo por IP', () => {
  const desdeUnaIp = pedir('10.0.0.3', 'objetivo@gtc.com');
  limpiarIntentos(desdeUnaIp);
  for (let i = 0; i < MAX_INTENTOS; i++) registrarIntentoFallido(desdeUnaIp);

  // Mismo usuario, IP distinta: el atacante no se escapa cambiando de IP.
  const desdeOtraIp = pedir('10.0.0.99', 'objetivo@gtc.com');
  assert.strictEqual(ejecutar(desdeOtraIp).estado, 429);

  // Otro usuario desde esa misma IP nueva sigue pudiendo entrar: bloquear la
  // cuenta de un tercero no debe ser posible desde fuera.
  const otroUsuario = pedir('10.0.0.99', 'ajeno@gtc.com');
  assert.strictEqual(ejecutar(otroUsuario).siguio, true);

  limpiarIntentos(desdeUnaIp);
  limpiarIntentos(desdeOtraIp);
  limpiarIntentos(otroUsuario);
});

// ---------------------------------------------------------------
// Aviso de proxy mal configurado (hallazgo QA-03).
//
// La app hace `app.set('trust proxy', 1)`, asi que req.ip sale de
// X-Forwarded-For. Si nginx no reenvia ese header, TODOS los usuarios
// comparten la IP del proxy y ocho fallos de cualquiera bloquean a la
// empresa entera. El aviso existe para que esa configuracion se note en los
// logs en vez de descubrirse el dia que nadie puede entrar.
// ---------------------------------------------------------------

const { avisarSiElProxyNoReenviaLaIp, _resetAvisoProxy } = require('../../src/middleware/rate-limit');

// Captura lo que se escriba en console.warn mientras corre `fn`.
function avisosDe(fn) {
  const original = console.warn;
  const avisos = [];
  console.warn = (...args) => avisos.push(args.join(' '));
  try { fn(); } finally { console.warn = original; }
  return avisos;
}

// `app.get('trust proxy')` importa desde el 16 sep 2026: el aviso solo tiene
// sentido cuando la app confia en el proxy, porque es entonces cuando req.ip
// sale del header y todos acaban compartiendo contador. Por defecto se simula
// encendido, que es el escenario del que habla el aviso.
const peticion = (remoteAddress, headers = {}, trustProxy = 1) => ({
  headers,
  socket: { remoteAddress },
  app: { get: (clave) => (clave === 'trust proxy' ? trustProxy : undefined) },
});

test('avisa cuando la peticion viene de un proxy local y NO trae X-Forwarded-For', () => {
  _resetAvisoProxy();
  const avisos = avisosDe(() => avisarSiElProxyNoReenviaLaIp(peticion('127.0.0.1')));

  assert.strictEqual(avisos.length, 1, 'deberia avisar: es la combinacion peligrosa');
  assert.match(avisos[0], /X-Forwarded-For/, 'el aviso debe decir que header falta');
  assert.match(avisos[0], /nginx/i, 'y donde arreglarlo');
});

test('NO avisa si el proxy si reenvia X-Forwarded-For (configuracion correcta)', () => {
  _resetAvisoProxy();
  const avisos = avisosDe(() => avisarSiElProxyNoReenviaLaIp(
    peticion('127.0.0.1', { 'x-forwarded-for': '190.85.10.20' })
  ));
  assert.deepStrictEqual(avisos, [], 'con el header presente no hay nada que avisar');
});

// Sin `trust proxy` no hay problema que avisar: req.ip sale del socket, asi
// que cada cliente cuenta por separado aunque la peticion venga de una IP
// privada (el caso tipico: entrar por localhost a la app en Docker). Avisar
// ahi empujaria a "arreglar" un nginx que ni siquiera existe.
test('NO avisa si la app no confia en el proxy, aunque la IP sea privada y falte el header', () => {
  _resetAvisoProxy();
  const avisos = avisosDe(() => avisarSiElProxyNoReenviaLaIp(peticion('172.22.0.1', {}, false)));
  assert.deepStrictEqual(avisos, [], 'sin trust proxy, nadie comparte contador');
});

// Una conexion directa desde una IP publica no pasa por ningun proxy: ahi
// req.ip ya es la del usuario y no falta nada que reenviar.
test('NO avisa cuando la conexion llega directa desde una IP publica', () => {
  _resetAvisoProxy();
  const avisos = avisosDe(() => avisarSiElProxyNoReenviaLaIp(peticion('190.85.10.20')));
  assert.deepStrictEqual(avisos, []);
});

test('reconoce las tres familias de IP privada, no solo loopback', () => {
  for (const ip of ['10.1.2.3', '192.168.1.10', '172.16.0.5', '::ffff:127.0.0.1']) {
    _resetAvisoProxy();
    const avisos = avisosDe(() => avisarSiElProxyNoReenviaLaIp(peticion(ip)));
    assert.strictEqual(avisos.length, 1, `${ip} deberia contar como proxy local`);
  }
});

test('avisa UNA sola vez: es configuracion, no un evento por peticion', () => {
  _resetAvisoProxy();
  const avisos = avisosDe(() => {
    for (let i = 0; i < 5; i++) avisarSiElProxyNoReenviaLaIp(peticion('127.0.0.1'));
  });
  assert.strictEqual(avisos.length, 1, 'repetirlo en cada login solo ensuciaria el log');
});
