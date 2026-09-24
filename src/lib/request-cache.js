'use strict';

/**
 * Cache de vida corta, con alcance de UNA peticion HTTP.
 *
 * Por que existe: los paneles de Costeo recalculan lo mismo muchas veces
 * dentro de la misma peticion. GET /alertas, por ejemplo, llamaba
 * computeIndicadores17() una vez por centro, y cada una de esas llamadas
 * volvia a ejecutar weeklyAggregate() — un agregado sobre TODO mp_task_facts
 * que despues se filtra en JavaScript. Con 20 centros eran 20 escaneos
 * completos identicos, mas 20x4 queries de desgloseEjecutado. Con
 * connectionLimit: 10 eso satura el pool y el dashboard se arrastra.
 *
 * La solucion NO cambia ninguna formula ni ninguna firma de funcion: se
 * memoiza el resultado de las funciones puras de lectura mientras dure la
 * peticion. Como el store se crea por peticion y muere con ella, no hay
 * riesgo de servir datos viejos entre usuarios ni despues de una escritura:
 * la peticion siguiente arranca con la caché vacia.
 *
 * Fuera de una peticion (scripts, snapshot-scheduler) no hay store y las
 * funciones se ejecutan tal cual, sin memoizar. Es deliberado: el scheduler
 * corre una vez al dia y no gana nada, y asi no hay estado global vivo.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// Middleware de express: abre un store nuevo para el resto de la peticion.
function requestCache(req, res, next) {
  storage.run(new Map(), next);
}

// Misma cache, pero fuera de express: para scripts y para las pruebas.
function runWithCache(fn) {
  return storage.run(new Map(), fn);
}

// ¿Estamos atendiendo una petición? Lo usa shared-cache.js para no cachear
// entre peticiones lo que corre fuera de una (snapshot-scheduler, scripts),
// que debe calcular siempre fresco.
function dentroDePeticion() {
  return storage.getStore() !== undefined;
}

/**
 * Memoiza `factory()` bajo `key` durante la peticion actual.
 * Se guarda la PROMESA, no el valor resuelto: si dos ramas de un
 * Promise.all piden lo mismo a la vez, ambas esperan la misma query en vez
 * de lanzar dos.
 */
function memo(key, factory) {
  const store = storage.getStore();
  if (!store) return factory();

  if (store.has(key)) return store.get(key);

  const promise = factory().catch((err) => {
    // Un fallo no se cachea: la siguiente llamada dentro de la misma
    // peticion debe poder reintentar en vez de heredar el error.
    store.delete(key);
    throw err;
  });
  store.set(key, promise);
  return promise;
}

// Clave estable a partir de un objeto de filtros. JSON.stringify directo no
// sirve: {month, week} y {week, month} son el mismo filtro pero producirian
// dos claves distintas.
function filtersKey(filters) {
  if (!filters) return 'null';
  return JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((k) => [k, filters[k] ?? null])
  );
}

module.exports = { requestCache, runWithCache, memo, filtersKey, dentroDePeticion };
