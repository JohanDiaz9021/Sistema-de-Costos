'use strict';

/**
 * Pruebas de la cache de indicadores COMPARTIDA entre peticiones
 * (src/lib/shared-cache.js).
 *
 * Es la pieza mas delicada del arreglo de rendimiento del 9 sep 2026: a
 * diferencia de request-cache.js, esta SI sobrevive a la peticion, asi que
 * un error aqui no se ve como lentitud sino como numeros viejos en pantalla
 * — mucho peor. Lo que se fija abajo es justamente eso: cuando puede servir
 * lo guardado y cuando esta obligada a recalcular.
 */

const test = require('node:test');
const assert = require('node:assert');
const { runWithCache } = require('../../src/lib/request-cache');
const {
  cacheCompartida,
  invalidarIndicadores,
  resetCacheCompartida,
} = require('../../src/lib/shared-cache');

test.beforeEach(() => resetCacheCompartida());

test('dentro de una peticion, la segunda llamada NO recalcula', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => { veces += 1; return veces; });

  const a = await runWithCache(calcular);
  const b = await runWithCache(calcular);

  assert.strictEqual(veces, 1, 'debio calcularse una sola vez');
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1, 'la segunda peticion recibe lo ya calculado');
});

// Es el caso real: /indicadores-17 y /alertas ahora salen a la vez desde
// costeo-nav.js. Si se guardara el VALOR en vez de la PROMESA, la segunda
// entraria antes de que la primera termine y volveria a calcular todo.
test('dos peticiones simultaneas comparten el calculo en vuelo, no lanzan dos', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => {
    veces += 1;
    await new Promise((r) => setTimeout(r, 20));
    return veces;
  });

  const [a, b] = await Promise.all([runWithCache(calcular), runWithCache(calcular)]);

  assert.strictEqual(veces, 1, 'la segunda debio colgarse de la primera');
  assert.deepStrictEqual([a, b], [1, 1]);
});

test('una escritura invalida: la siguiente lectura recalcula', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => { veces += 1; return veces; });

  await runWithCache(calcular);
  invalidarIndicadores();
  const despues = await runWithCache(calcular);

  assert.strictEqual(veces, 2, 'tras invalidar no puede servir lo viejo');
  assert.strictEqual(despues, 2);
});

// El caso feo: alguien aprueba un gasto MIENTRAS se estan calculando los
// indicadores. Ese calculo arranco antes del cambio, asi que su resultado ya
// nacio viejo y no puede quedarse guardado esperando a que venza el TTL.
test('si la escritura ocurre mientras se calcula, ese resultado no se guarda', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => {
    veces += 1;
    await new Promise((r) => setTimeout(r, 30));
    return veces;
  });

  const enVuelo = runWithCache(calcular);
  await new Promise((r) => setTimeout(r, 5));
  invalidarIndicadores();
  await enVuelo;

  await runWithCache(calcular);
  assert.strictEqual(veces, 2, 'el resultado que nacio antes de la escritura no debio quedar cacheado');
});

test('claves distintas (otro centro u otro filtro) no se pisan entre si', async () => {
  const calcular = (key, valor) => runWithCache(() => cacheCompartida(key, async () => valor));

  assert.strictEqual(await calcular('ind17:1:mes-agosto', 'A'), 'A');
  assert.strictEqual(await calcular('ind17:2:mes-agosto', 'B'), 'B');
  assert.strictEqual(await calcular('ind17:1:mes-julio', 'C'), 'C');

  assert.strictEqual(await calcular('ind17:1:mes-agosto', 'IGNORADO'), 'A', 'cada clave conserva lo suyo');
});

// El snapshot-scheduler y los scripts corren FUERA de una peticion HTTP. Un
// snapshot es un registro historico: no puede quedar amarrado a un calculo
// que ya estaba guardado de hace un minuto.
test('fuera de una peticion no cachea nada: siempre calcula fresco', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => { veces += 1; return veces; });

  await calcular();
  await calcular();

  assert.strictEqual(veces, 2, 'sin peticion, cada llamada recalcula');
});

test('un calculo que falla no queda cacheado: la siguiente llamada reintenta', async () => {
  let veces = 0;
  const calcular = () => cacheCompartida('k', async () => {
    veces += 1;
    if (veces === 1) throw new Error('la base no respondio');
    return 'ok';
  });

  await assert.rejects(() => runWithCache(calcular), /la base no respondio/);
  assert.strictEqual(await runWithCache(calcular), 'ok', 'debio reintentar, no heredar el error');
  assert.strictEqual(veces, 2);
});
