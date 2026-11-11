'use strict';

/**
 * Caché de las RESPUESTAS con que arranca cada pantalla, entre peticiones
 * (16 oct 2026).
 *
 * El síntoma reportado: moverse entre las pestañas de Costos es instantáneo,
 * pero pasar de Costos a Planeación (o al revés) se queda cargando. Medido
 * ese día en un navegador real, contra la base de stable.host (~105 ms por
 * consulta desde fuera de su red):
 *
 *   Costos -> Planeación ..... 1,4-1,8 s  (filtros + 18 indicadores + alertas del menú)
 *   Planeación -> Costos ..... 1,5-2,6 s  (19 peticiones)
 *   entre pestañas de Costos . 0 s        (no pide nada)
 *
 * No era un problema de rutas. Las pestañas de Costos son paneles de UNA
 * misma página (costeo.html), con los datos ya cargados; Planeación es otra
 * página (index.html). Cada salto entre las dos es una navegación completa
 * del navegador, y cada página vuelve a pedirle TODO a la base al cargar,
 * aunque nada haya cambiado desde la última vez que se abrió.
 *
 * Esto guarda la respuesta JSON de esas lecturas y la vuelve a servir
 * mientras siga siendo cierta:
 *
 * 1. Cualquier escritura por la API la invalida entera: comparte el contador
 *    de versión de shared-cache.js, que server.js sube en toda petición que no
 *    sea GET. Un gasto, una hora extra, un empleado editado: la lectura
 *    siguiente va a la base. Es la promesa de "lo que cambio se ve ya" (ver
 *    test/integration/cache-indicadores.test.js).
 * 2. Lo que n8n carga por fuera (Planeación con WF1, horas de Costeo con
 *    WF-COSTEO) no pasa por el servidor: lo detecta el vigía
 *    (src/services/vigia-horas-externas.js) en ~10 s, y vacía igual.
 * 3. El TTL solo acota lo que ninguno de los dos ve (un UPDATE a mano en la
 *    base). Y la clave lleva el día de negocio: lo que depende de "hoy"
 *    (tareas vencidas, días que lleva abierta una alerta) no cruza la
 *    medianoche.
 * 4. La clave lleva el usuario. Cada quien recibe solo lo que el servidor ya
 *    le había respondido a ÉL; no se comparte nada entre cuentas, así que lo
 *    que ve un CEO no le puede llegar a un PM.
 *
 * Solo entran las rutas de RUTAS_CACHEABLES, y la lista es de las que SÍ
 * entran a propósito: olvidarse de agregar una ruta nueva solo la deja igual
 * de lenta que hoy, mientras que olvidarse de EXCLUIR una podría servir datos
 * viejos. Quedan fuera las exportaciones (PDF/Excel), el estado del correo y
 * las pantallas que se abren a pedido (plan de recursos, salario conocido).
 *
 * Una consecuencia aceptada: GET /api/costeo/alertas, además de leer, anota
 * en mp_alerta_evento cuándo se vio cada alerta por última vez
 * (sincronizarEventos). Servida desde aquí, esa anotación se hace en la
 * siguiente lectura que vaya a la base, no en cada visita. Lo que cambia el
 * conjunto de alertas —una escritura o una carga de n8n— invalida, así que
 * una alerta nueva o resuelta se registra igual.
 */

const { versionCaches } = require('./shared-cache');
const { fechaNegocioISO } = require('./fecha-negocio');

// Lo que arma Planeación (index.html) y Costos (costeo.html) al abrirse.
// Se compara contra la ruta sin la query (?month=...), que sí va en la clave.
const RUTAS_CACHEABLES = [
  /^\/api\/filters\/?$/,
  /^\/api\/indicator\/\d+(\/drilldown)?\/?$/,
  /^\/api\/resource\/\d+\/?$/,
  /^\/api\/employees\/?$/,
  /^\/api\/validation\/(errors|errors\/summary|runs)\/?$/,
  /^\/api\/costeo\/(centros|indicadores|indicadores-17|alertas|meses|comercial|config|parametros-nomina|accesos|proyectos-disponibles|tarifas-cargo|equipo|gastos|overtime|historial)\/?$/,
];

function esCacheable(rutaSinQuery) {
  return RUTAS_CACHEABLES.some((re) => re.test(rutaSinQuery));
}

// LECTURAS_CACHE_TTL_MS manda si viene definida (0 la apaga). Si no viene,
// se apaga junto con la de indicadores cuando COSTEO_CACHE_TTL_MS=0: así
// corren las pruebas de integración, que siembran escribiendo DIRECTO en la
// base, un camino que ninguna de las dos cachés puede ver para invalidar.
function ttlDesdeEntorno(env = process.env) {
  const definida = (v) => v !== undefined && v !== '';
  if (definida(env.LECTURAS_CACHE_TTL_MS)) return Number(env.LECTURAS_CACHE_TTL_MS);
  if (definida(env.COSTEO_CACHE_TTL_MS) && Number(env.COSTEO_CACHE_TTL_MS) === 0) return 0;
  // 10 minutos: cubre el ir y volver entre Planeación y Costos de una sesión
  // normal de trabajo. Con el vigía y la invalidación por escritura, el TTL
  // ya no es lo que mantiene los datos al día (ver punto 3 arriba).
  return 10 * 60 * 1000;
}

/**
 * Arma el middleware. Las dependencias se inyectan para poder probar la
 * política sin reloj real ni servidor; en producción se usa la instancia
 * `cacheLecturas` de abajo.
 */
function crearCacheLecturas({
  ttlMs = ttlDesdeEntorno(),
  maxEntradas = 500,
  ahora = () => Date.now(),
  version = versionCaches,
  dia = () => fechaNegocioISO(),
} = {}) {
  const activa = Number.isFinite(ttlMs) && ttlMs > 0;
  // Map recuerda el orden de inserción: el primero es el usado hace más
  // tiempo (cada acierto lo vuelve a meter al final). Con eso basta para
  // acotar la memoria sin una librería de LRU.
  const store = new Map();

  function guardar(clave, entrada) {
    store.delete(clave);
    store.set(clave, entrada);
    while (store.size > maxEntradas) store.delete(store.keys().next().value);
  }

  function middleware(req, res, next) {
    if (!activa || req.method !== 'GET') return next();
    const user = req.session && req.session.user;
    if (!user) return next();
    const url = req.originalUrl;
    if (!esCacheable(url.split('?')[0])) return next();

    const clave = `${user.user_id}|${user.role}|${dia()}|${url}`;
    const versionAlEmpezar = version();

    const guardado = store.get(clave);
    if (guardado) {
      if (guardado.version === versionAlEmpezar && guardado.expira > ahora()) {
        guardar(clave, guardado);
        res.set('X-Cache-Lecturas', 'HIT');
        res.set('Content-Type', 'application/json; charset=utf-8');
        return res.send(guardado.cuerpo);
      }
      store.delete(clave);
    }

    const jsonOriginal = res.json.bind(res);
    res.json = (body) => {
      // Solo se guarda una respuesta buena, y solo si nadie escribió mientras
      // se calculaba: un cálculo que arrancó antes de una escritura trae los
      // números de antes del cambio.
      if (res.statusCode !== 200 || version() !== versionAlEmpezar) return jsonOriginal(body);
      const cuerpo = JSON.stringify(body);
      if (typeof cuerpo !== 'string') return jsonOriginal(body);
      guardar(clave, { cuerpo, version: versionAlEmpezar, expira: ahora() + ttlMs });
      res.set('X-Cache-Lecturas', 'MISS');
      if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
      return res.send(cuerpo);
    };
    next();
  }

  middleware.activa = activa;
  middleware.tamano = () => store.size;
  return middleware;
}

const cacheLecturas = crearCacheLecturas();

module.exports = { cacheLecturas, crearCacheLecturas, esCacheable, ttlDesdeEntorno, RUTAS_CACHEABLES };
