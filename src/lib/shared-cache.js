'use strict';

/**
 * Cache de los 17 indicadores COMPARTIDA entre peticiones.
 *
 * Complementa a request-cache.js, que solo vive dentro de UNA peticion. El
 * problema que resuelve es distinto y estaba medido (9 sep 2026, contra la
 * base real de produccion, 12 centros):
 *
 *   GET /indicadores-17 .......... 1657-2373ms
 *   GET /alertas ................. 2708ms   <- recalcula EXACTAMENTE lo mismo
 *   -------------------------------------
 *   total al abrir Costeo ........ ~4400-5100ms
 *
 *   los dos, compartiendo el calculo ....... ~2460ms
 *
 * Es decir: mas de la mitad del tiempo de carga se iba en calcular dos veces
 * lo mismo, porque cada peticion HTTP arranca con la cache de request-cache
 * vacia. Y volvia a pasar entero cada vez que se entraba a Costeo — que es
 * cada vez que se vuelve de Planeacion, porque son dos paginas distintas y
 * eso es una navegacion real del navegador, no un cambio de panel.
 *
 * Por que es seguro servir esto entre peticiones:
 *
 * 1. computeIndicadores17(centro, filters) NO recibe el scope del usuario:
 *    depende solo de cost_center_id + filtros. Dos usuarios distintos que
 *    pidan el mismo centro con los mismos filtros tienen que ver el mismo
 *    numero. Quien puede ver CUALES centros se decide antes, en
 *    getCentrosVisibles(scope), y eso no pasa por aqui.
 * 2. Cualquier escritura invalida TODO (invalidarIndicadores(), enganchado en
 *    server.js a toda peticion que no sea GET). Un gasto aprobado, una hora
 *    extra, un cambio de configuracion: la siguiente lectura recalcula. Esto
 *    es lo que mantiene la promesa de "los cambios en Costeo se ven ya" — la
 *    cache no puede sobrevivir a un cambio hecho desde la aplicacion.
 * 3. El TTL acota lo unico que la invalidacion no puede ver: los datos que
 *    entran por fuera (el RPA/n8n escribiendo mp_costeo_task_facts). Por eso
 *    es corto y no "hasta que alguien lo borre".
 * 4. Solo se usa DENTRO de una peticion HTTP (igual que memo()). El
 *    snapshot-scheduler y los scripts calculan siempre fresco: un snapshot es
 *    un registro historico y no debe quedar amarrado a un calculo de hace un
 *    minuto.
 *
 * Se guarda la PROMESA, no el valor: si /indicadores-17 y /alertas entran a
 * la vez (hoy salen en paralelo, ver costeo-nav.js), el segundo se cuelga del
 * calculo que ya esta corriendo en vez de lanzar otro igual.
 */

const { dentroDePeticion } = require('./request-cache');

// COSTEO_CACHE_TTL_MS=0 la apaga por completo (cada lectura recalcula). Se usa
// en las pruebas de integracion, que siembran sus datos escribiendo DIRECTO en
// la base — un camino que el servidor no puede ver para invalidar. Ojo con el
// `|| 60000`: Number('0') es 0, que es falsy, asi que el default se aplica solo
// cuando la variable no viene definida.
const TTL_MS = process.env.COSTEO_CACHE_TTL_MS !== undefined && process.env.COSTEO_CACHE_TTL_MS !== ''
  ? Number(process.env.COSTEO_CACHE_TTL_MS)
  : 60000;

const CACHE_ACTIVA = Number.isFinite(TTL_MS) && TTL_MS > 0;

const store = new Map();

// Se sube en cada escritura. Un calculo que arranco ANTES de una escritura no
// puede guardarse despues de ella: traeria numeros previos al cambio y se
// quedaria ahi hasta que venciera el TTL.
let version = 0;

function invalidarIndicadores() {
  version += 1;
  store.clear();
}

function cacheCompartida(key, factory) {
  if (!CACHE_ACTIVA || !dentroDePeticion()) return factory();

  const guardado = store.get(key);
  if (guardado && guardado.expira > Date.now()) return guardado.promesa;

  const versionAlEmpezar = version;
  const promesa = factory().catch((err) => {
    store.delete(key);
    throw err;
  });

  promesa
    .then(() => {
      if (version !== versionAlEmpezar) store.delete(key);
    })
    .catch(() => {
      // El .catch() de arriba ya lo saco del store; aqui solo se evita un
      // unhandled rejection por esta segunda rama.
    });

  store.set(key, { promesa, expira: Date.now() + TTL_MS });
  return promesa;
}

// Solo para las pruebas: deja la cache como recien arrancada.
function resetCacheCompartida() {
  version = 0;
  store.clear();
}

module.exports = { cacheCompartida, invalidarIndicadores, resetCacheCompartida, TTL_MS, CACHE_ACTIVA };
