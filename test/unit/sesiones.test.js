'use strict';

/**
 * Cierre de sesiones de un usuario (src/lib/sesiones.js).
 *
 * Lo que protege: desactivar una cuenta tiene que cortarle el acceso YA.
 * requireAuth solo mira si hay sesion, nunca revalida contra la base, asi
 * que sin esto la persona seguia dentro hasta que caducara su cookie — 8
 * horas — en un sistema que muestra sueldos.
 *
 * Se prueba contra archivos de verdad en un directorio temporal, no con un
 * doble: lo unico que hace este modulo es leer y borrar archivos, asi que
 * simularlos probaria la simulacion.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { cerrarSesionesDe } = require('../../src/lib/sesiones');

// El modulo lee SESSION_DIR, igual que server.js. Cada prueba trabaja en su
// propio directorio para no pisarse con las demas.
async function conDirectorioDeSesiones(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sesiones-prueba-'));
  const guardado = process.env.SESSION_DIR;
  process.env.SESSION_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    // Restaurar el entorno no es una carrera: estas pruebas corren en serie.
    // eslint-disable-next-line require-atomic-updates
    if (guardado === undefined) delete process.env.SESSION_DIR;
    // eslint-disable-next-line require-atomic-updates
    else process.env.SESSION_DIR = guardado;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const escribirSesion = (dir, sid, userId) => fs.writeFile(
  path.join(dir, `${sid}.json`),
  JSON.stringify({ cookie: { maxAge: 28800000 }, user: { user_id: userId, email: `u${userId}@x.test` } })
);

test('cerrarSesionesDe: borra las sesiones de esa persona y NO las de las demas', async () => {
  await conDirectorioDeSesiones(async (dir) => {
    await escribirSesion(dir, 'sesion-a', 7);
    await escribirSesion(dir, 'sesion-b', 7); // la misma persona en otro navegador
    await escribirSesion(dir, 'sesion-c', 9); // otra persona

    const cerradas = await cerrarSesionesDe(7);
    assert.strictEqual(cerradas, 2, 'las DOS sesiones suyas, no solo la primera');

    const quedan = (await fs.readdir(dir)).sort();
    assert.deepStrictEqual(quedan, ['sesion-c.json'], 'la sesion de otra persona no se toca');
  });
});

test('cerrarSesionesDe: sin sesiones abiertas no hace nada y no revienta', async () => {
  await conDirectorioDeSesiones(async () => {
    assert.strictEqual(await cerrarSesionesDe(7), 0);
  });
});

// El directorio no existe hasta que alguien inicia sesion por primera vez
// despues de un despliegue. Desactivar una cuenta antes de eso no puede
// fallar: la desactivacion es lo que el usuario pidio, esto es un extra.
test('cerrarSesionesDe: si el directorio no existe, devuelve 0 en vez de fallar', async () => {
  const guardado = process.env.SESSION_DIR;
  process.env.SESSION_DIR = path.join(os.tmpdir(), 'no-existe-este-directorio-' + Date.now());
  try {
    assert.strictEqual(await cerrarSesionesDe(7), 0);
  } finally {
    // eslint-disable-next-line require-atomic-updates
    if (guardado === undefined) delete process.env.SESSION_DIR;
    // eslint-disable-next-line require-atomic-updates
    else process.env.SESSION_DIR = guardado;
  }
});

// Un archivo a medio escribir, o uno que el barrido de caducadas borro
// mientras esto recorria el directorio, no puede impedir que se cierren las
// sesiones que SI se pudieron identificar.
test('cerrarSesionesDe: un archivo corrupto no impide cerrar las demas', async () => {
  await conDirectorioDeSesiones(async (dir) => {
    await escribirSesion(dir, 'buena', 7);
    await fs.writeFile(path.join(dir, 'rota.json'), '{esto no es json');

    assert.strictEqual(await cerrarSesionesDe(7), 1, 'la buena se cierra igual');
    assert.ok((await fs.readdir(dir)).includes('rota.json'), 'la ilegible se deja donde esta');
  });
});

// Una sesion sin usuario (recien creada, antes del login) no pertenece a
// nadie: borrarla sacaria de la pantalla de login a quien la estuviera
// usando, sin ganar nada.
test('cerrarSesionesDe: ignora sesiones sin usuario', async () => {
  await conDirectorioDeSesiones(async (dir) => {
    await fs.writeFile(path.join(dir, 'anonima.json'), JSON.stringify({ cookie: { maxAge: 1000 } }));
    assert.strictEqual(await cerrarSesionesDe(7), 0);
    assert.ok((await fs.readdir(dir)).includes('anonima.json'));
  });
});

test('cerrarSesionesDe: un id invalido no borra nada', async () => {
  await conDirectorioDeSesiones(async (dir) => {
    await escribirSesion(dir, 'sesion-a', 7);
    for (const malo of [undefined, null, 0, -1, 'siete', NaN]) {
      assert.strictEqual(await cerrarSesionesDe(malo), 0, `id ${String(malo)} no deberia borrar`);
    }
    assert.strictEqual((await fs.readdir(dir)).length, 1, 'la sesion sigue ahi');
  });
});
