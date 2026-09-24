'use strict';

/**
 * Cache de indicadores entre peticiones (src/lib/shared-cache.js), contra el
 * servidor real y CON la cache encendida.
 *
 * Vive en su propio archivo, con su propio servidor, porque el resto de la
 * suite corre con COSTEO_CACHE_TTL_MS=0 (ver test/helpers/servidor.js: esas
 * pruebas siembran escribiendo directo en la base, un camino que el servidor
 * no puede ver para invalidar). Aqui se verifica lo contrario: que con la
 * cache activa siga siendo cierto lo unico de lo que depende produccion —
 * un cambio hecho DESDE LA APLICACION se ve en el numero siguiente, sin
 * esperar a que venza ningun TTL.
 *
 * Por que importa: la cache existe porque abrir Costeo costaba ~4,4s (medido
 * el 9 sep 2026 contra produccion, 12 centros: /indicadores-17 1657ms +
 * /alertas 2708ms, calculando dos veces lo mismo). Bajarlo a ~1s no sirve de
 * nada si el precio es que un gasto aprobado tarde un minuto en verse.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../helpers/db');
const fixtures = require('../helpers/fixtures');
const { arrancarServidor, clienteComo } = require('../helpers/servidor');

// Bien por encima de lo que dura la prueba: si la invalidacion no funcionara,
// el TTL no puede taparlo venciendo por su cuenta.
const TTL_LARGO = '600000';

let hayBase = false;

test.before(async () => {
  if (!(await db.esperarBase(15, 1000))) {
    console.warn('[test] base de prueba no disponible; se saltan las pruebas de cache');
    return;
  }
  await db.prepararEsquema();
  await db.resetearDatos();
  await fixtures.sembrar();
  hayBase = true;
});

test.after(async () => { await db.cerrarPool(); });

async function conServidorCacheado(fn) {
  const s = await arrancarServidor({ env: { COSTEO_CACHE_TTL_MS: TTL_LARGO } });
  try {
    return await fn(s);
  } finally {
    await s.cerrar();
  }
}

function ejecutadoDeAlfa(r) {
  const alfa = r.json.centros.find((c) => c.cost_center_id === fixtures.CENTROS.alfa.id);
  assert.ok(alfa, 'no vino el centro ALFA en la respuesta');
  assert.ok(
    Number.isFinite(Number(alfa.ejecutado_total)),
    `ejecutado_total no es un numero: ${JSON.stringify(alfa.ejecutado_total)}`
  );
  return Number(alfa.ejecutado_total);
}

/** Crea un gasto (nace 'pendiente') y devuelve su id. */
async function crearGasto(ceo, monto, descripcion) {
  const r = await ceo.post('/api/costeo/gastos', {
    cost_center_id: fixtures.CENTROS.alfa.id,
    description: descripcion,
    amount: monto,
    expense_date: '2026-08-20',
    category: 'otros',
  });
  assert.ok(r.status === 200 || r.status === 201, `no se pudo crear el gasto: ${r.status} ${r.texto || ''}`);
  const id = r.json.expense_id ?? r.json.id ?? r.json.gasto?.expense_id;
  assert.ok(id, `la respuesta no trajo el id del gasto: ${JSON.stringify(r.json)}`);
  return id;
}

// Ojo con lo que se elige como "la escritura" de esta prueba: CREAR un gasto
// no mueve el ejecutado, porque nace en 'pendiente' y ejecutadoNoPlaneado()
// (costo-motor.js) solo suma los que estan en 'aprobado'. La primera version
// de esta prueba usaba el alta y "pasaba" por el motivo equivocado: el numero
// no cambiaba ni con la cache apagada. La escritura que de verdad mueve el
// ejecutado es la APROBACION.
test('aprobar un gasto por la API se ve en el siguiente GET, sin esperar el TTL', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  await conServidorCacheado(async (s) => {
    const ceo = await clienteComo(s.url, fixtures.USUARIOS.ceo, fixtures.CLAVE);
    const id = await crearGasto(ceo, 1000000, 'Gasto que debe verse al aprobarse');

    // 1) Lectura que deja el calculo cacheado (el gasto todavia no cuenta).
    const antes = await ceo.get('/api/costeo/indicadores-17');
    assert.strictEqual(antes.status, 200);
    const ejecutadoAntes = ejecutadoDeAlfa(antes);

    // 2) Lectura identica: aqui SI debe servir la cache, y dar lo mismo.
    assert.strictEqual(
      ejecutadoDeAlfa(await ceo.get('/api/costeo/indicadores-17')),
      ejecutadoAntes,
      'sin cambios de por medio el numero no debe moverse'
    );

    // 3) La escritura.
    const aprobado = await ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: true });
    assert.strictEqual(aprobado.status, 200, `no se pudo aprobar: ${aprobado.status} ${aprobado.texto || ''}`);

    // 4) La lectura siguiente TIENE que reflejarlo. Sin invalidacion, aqui
    //    volveria el numero cacheado en el paso 1.
    const ejecutadoDespues = ejecutadoDeAlfa(await ceo.get('/api/costeo/indicadores-17'));
    assert.strictEqual(
      ejecutadoDespues - ejecutadoAntes,
      1000000,
      'el ejecutado debio subir el monto del gasto aprobado: la cache no se invalido con la escritura'
    );
  });
});

test('borrar por la API tambien invalida (no solo aprobar)', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  await conServidorCacheado(async (s) => {
    const ceo = await clienteComo(s.url, fixtures.USUARIOS.ceo, fixtures.CLAVE);
    const id = await crearGasto(ceo, 500000, 'Gasto temporal');
    const aprobado = await ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: true });
    assert.strictEqual(aprobado.status, 200, `no se pudo aprobar: ${aprobado.status}`);

    const conGasto = ejecutadoDeAlfa(await ceo.get('/api/costeo/indicadores-17'));

    const borrado = await ceo.delete(`/api/costeo/gastos/${id}`);
    assert.strictEqual(borrado.status, 200, `no se pudo borrar: ${borrado.status} ${borrado.texto || ''}`);

    const sinGasto = ejecutadoDeAlfa(await ceo.get('/api/costeo/indicadores-17'));
    assert.strictEqual(
      conGasto - sinGasto,
      500000,
      'el borrado no se reflejo: la cache siguio sirviendo el ejecutado con el gasto'
    );
  });
});

// La cache guarda por centro + filtros. Dos usuarios distintos que ven cosas
// distintas no pueden terminar leyendo lo del otro: lo que decide QUE centros
// ve cada uno es getCentrosVisibles(scope), antes de la cache.
test('con la cache caliente, un leader sigue viendo solo sus centros', async (t) => {
  if (!hayBase) return t.skip('base de prueba no disponible');

  await conServidorCacheado(async (s) => {
    const ceo = await clienteComo(s.url, fixtures.USUARIOS.ceo, fixtures.CLAVE);
    const ana = await clienteComo(s.url, fixtures.USUARIOS.liderAlfa, fixtures.CLAVE);

    // El CEO calienta la cache con TODOS los centros.
    const todos = await ceo.get('/api/costeo/indicadores-17');
    assert.ok(todos.json.centros.length > 1, 'el ceo deberia ver varios centros');

    // Ana entra despues: debe seguir viendo solo ALFA.
    const suyos = await ana.get('/api/costeo/indicadores-17');
    const ids = suyos.json.centros.map((c) => c.cost_center_id);
    assert.deepStrictEqual(ids, [fixtures.CENTROS.alfa.id], 'un leader no puede heredar los centros que cacheo el ceo');
  });
});
