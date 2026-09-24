'use strict';

/**
 * Limitador de intentos en memoria, para el login.
 *
 * Por que sin libreria: express-rate-limit haria lo mismo, pero este
 * dashboard corre en un solo contenedor y con un solo proceso, y no vale la
 * pena sumar una dependencia (y su cadena) para 40 lineas. Si algun dia esto
 * escala a varias replicas, ESTE es el archivo a reemplazar por un limitador
 * con Redis: en memoria, cada replica cuenta por su lado.
 *
 * Politica: N intentos FALLIDOS por ventana y por (IP + usuario). Un login
 * correcto limpia el contador, asi que a un usuario legitimo que se
 * equivoca dos veces y acierta a la tercera no le pasa nada.
 *
 * Se cuenta por IP *y* por identificador para que un atacante con una sola
 * IP no pueda probar contra muchas cuentas, y para que alguien no pueda
 * bloquear la cuenta de otra persona a proposito desde fuera.
 */

const intentos = new Map(); // clave -> { conteo, expira }

const VENTANA_MS = 15 * 60 * 1000; // 15 minutos
const MAX_INTENTOS = 8;
const LIMPIEZA_MS = 30 * 60 * 1000;

// Sin esto el Map crece sin techo con cada IP que toque el login.
const limpieza = setInterval(() => {
  const ahora = Date.now();
  for (const [clave, dato] of intentos) {
    if (dato.expira <= ahora) intentos.delete(clave);
  }
}, LIMPIEZA_MS);
limpieza.unref(); // no debe impedir que el proceso termine

function clavesDe(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
  const identificador = String(req.body?.email || '').trim().toLowerCase();
  const claves = [`ip:${ip}`];
  if (identificador) claves.push(`user:${identificador}`);
  return claves;
}

// ---------------------------------------------------------------
// Detección de proxy mal configurado (hallazgo QA-03)
// ---------------------------------------------------------------
// El riesgo: server.js hace `app.set('trust proxy', 1)` para que
// express-session sepa que la conexión original era HTTPS. Con eso, `req.ip`
// sale del header X-Forwarded-For. Si nginx NO lo reenvía, ese header no
// llega y `req.ip` cae al socket — que detrás de un proxy es SIEMPRE la
// misma IP (el propio nginx). Resultado: las 8 claves `ip:` de toda la
// empresa se vuelven UNA, y ocho errores de tipeo de cualquiera dejan sin
// entrar a todo el mundo durante 15 minutos.
//
// Lo peor es que no se nota hasta que pasa: la app funciona igual. Por eso
// se avisa apenas se detecta la combinación peligrosa (viene de una IP
// privada/loopback, o sea de un proxy, y sin X-Forwarded-For). Es la forma
// de VERIFICAR la configuración sin entrar al servidor: si nginx está bien,
// esto nunca se imprime. Ver la sección de proxy en DEPLOY.md.
let yaSeAviso = false;

function esDeUnProxyLocal(direccion) {
  if (!direccion) return false;
  const ip = String(direccion).replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1'
    || ip.startsWith('10.') || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function avisarSiElProxyNoReenviaLaIp(req) {
  if (yaSeAviso) return;
  // Sin `trust proxy` no hay nada que avisar (16 sep 2026): req.ip sale del
  // socket, asi que cada cliente cuenta por su cuenta y no se comparte
  // ningun contador. Avisarlo igual seria una falsa alarma — y de las
  // caras, porque empuja a "arreglar" nginx para un problema inexistente.
  // Ver el comentario de trust proxy en server.js.
  if (!req.app?.get('trust proxy')) return;
  if (req.headers?.['x-forwarded-for']) return;
  if (!esDeUnProxyLocal(req.socket?.remoteAddress)) return;

  yaSeAviso = true;
  console.warn(
    '[rate-limit] AVISO: llegan intentos de login desde %s SIN X-Forwarded-For. ' +
    'La app confía en el proxy (trust proxy), así que TODOS los usuarios están ' +
    'compartiendo esa misma IP para el limitador: %d fallos de cualquiera bloquean ' +
    'a toda la empresa 15 minutos. Falta `proxy_set_header X-Forwarded-For` en nginx ' +
    '(ver DEPLOY.md, sección Proxy inverso).',
    req.socket?.remoteAddress, MAX_INTENTOS
  );
}

// Solo para las pruebas: vuelve a armar el aviso, que por diseño sale una vez.
function _resetAvisoProxy() {
  yaSeAviso = false;
}

function segundosRestantes(dato) {
  return Math.max(1, Math.ceil((dato.expira - Date.now()) / 1000));
}

// Middleware: bloquea si alguna de las claves ya paso el limite.
function limitarIntentosLogin(req, res, next) {
  avisarSiElProxyNoReenviaLaIp(req);
  const ahora = Date.now();
  for (const clave of clavesDe(req)) {
    const dato = intentos.get(clave);
    if (dato && dato.expira > ahora && dato.conteo >= MAX_INTENTOS) {
      const espera = segundosRestantes(dato);
      res.setHeader('Retry-After', String(espera));
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Espera ${Math.ceil(espera / 60)} minuto(s) antes de volver a intentar.`,
      });
    }
  }
  next();
}

function registrarIntentoFallido(req) {
  const ahora = Date.now();
  for (const clave of clavesDe(req)) {
    const dato = intentos.get(clave);
    if (dato && dato.expira > ahora) {
      dato.conteo += 1;
    } else {
      intentos.set(clave, { conteo: 1, expira: ahora + VENTANA_MS });
    }
  }
}

function limpiarIntentos(req) {
  for (const clave of clavesDe(req)) intentos.delete(clave);
}

module.exports = {
  limitarIntentosLogin,
  registrarIntentoFallido,
  limpiarIntentos,
  MAX_INTENTOS,
  avisarSiElProxyNoReenviaLaIp,
  _resetAvisoProxy,
};
