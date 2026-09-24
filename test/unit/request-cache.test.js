'use strict';

/**
 * Cubre la cache por peticion (src/lib/request-cache.js), que es lo que
 * evita que GET /alertas repita, una vez por centro de costos, el mismo
 * agregado sobre todo mp_task_facts.
 *
 * Lo importante que se verifica aqui no es la velocidad: es que la cache NO
 * se filtre entre peticiones (dos usuarios distintos no pueden verse los
 * datos) y que dos filtros distintos no compartan clave.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runWithCache, memo, filtersKey } = require('../../src/lib/request-cache');

test('memo ejecuta la funcion una sola vez dentro de la misma peticion', async () => {
  let veces = 0;
  const caro = async () => { veces++; return 'resultado'; };

  await runWithCache(async () => {
    assert.strictEqual(await memo('k', caro), 'resultado');
    assert.strictEqual(await memo('k', caro), 'resultado');
    assert.strictEqual(await memo('k', caro), 'resultado');
  });

  assert.strictEqual(veces, 1);
});

test('la cache NO sobrevive a la peticion: cada una arranca vacia', async () => {
  let veces = 0;
  const caro = async () => { veces++; return veces; };

  await runWithCache(() => memo('k', caro));
  await runWithCache(() => memo('k', caro));

  // Si compartieran cache, un cambio guardado en la peticion 1 quedaria
  // servido en la 2. Peor: los datos scopeados de un PM podrian llegarle a
  // otro usuario.
  assert.strictEqual(veces, 2);
});

test('sin peticion abierta (scripts, scheduler) no memoiza y sigue funcionando', async () => {
  let veces = 0;
  const caro = async () => { veces++; return 'ok'; };

  assert.strictEqual(await memo('k', caro), 'ok');
  assert.strictEqual(await memo('k', caro), 'ok');
  assert.strictEqual(veces, 2);
});

test('llamadas en paralelo comparten UNA sola ejecucion', async () => {
  let veces = 0;
  const caro = async () => {
    veces++;
    await new Promise((r) => setTimeout(r, 10));
    return 'x';
  };

  await runWithCache(async () => {
    await Promise.all([memo('k', caro), memo('k', caro), memo('k', caro)]);
  });

  assert.strictEqual(veces, 1);
});

test('un fallo no queda cacheado: se puede reintentar', async () => {
  let veces = 0;
  const inestable = async () => {
    veces++;
    if (veces === 1) throw new Error('fallo temporal');
    return 'ok';
  };

  await runWithCache(async () => {
    await assert.rejects(() => memo('k', inestable), /fallo temporal/);
    assert.strictEqual(await memo('k', inestable), 'ok');
  });
});

test('el middleware abre la cache para toda la peticion express, y la cierra al terminar', async () => {
  const express = require('express');
  const { requestCache } = require('../../src/lib/request-cache');

  let veces = 0;
  const caro = async () => { veces++; return veces; };

  const app = express();
  app.use(requestCache);
  app.get('/x', async (req, res) => {
    // Dos capas de await: si AsyncLocalStorage no propagara el contexto a
    // traves de las continuaciones async, aqui ya se habria perdido.
    await new Promise((r) => setImmediate(r));
    const a = await memo('k', caro);
    const b = await memo('k', caro);
    res.json({ a, b });
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;

  const r1 = await (await fetch(url)).json();
  const r2 = await (await fetch(url)).json();
  server.close();

  assert.deepStrictEqual(r1, { a: 1, b: 1 }, 'dentro de una peticion, una sola ejecucion');
  assert.deepStrictEqual(r2, { a: 2, b: 2 }, 'la peticion siguiente arranca con la cache vacia');
  assert.strictEqual(veces, 2);
});

test('filtersKey no depende del orden de las claves', () => {
  const a = { month: 'Agosto', week: 2, employee_id: null };
  const b = { employee_id: null, week: 2, month: 'Agosto' };
  assert.strictEqual(filtersKey(a), filtersKey(b));
});

test('filtersKey distingue filtros distintos (no puede mezclar meses)', () => {
  assert.notStrictEqual(
    filtersKey({ month: 'Agosto', week: null }),
    filtersKey({ month: 'Julio', week: null })
  );
  // null y undefined son el mismo "sin filtro"; 0 y null NO lo son.
  assert.strictEqual(filtersKey({ week: null }), filtersKey({ week: undefined }));
  assert.notStrictEqual(filtersKey({ week: 0 }), filtersKey({ week: 1 }));
});
