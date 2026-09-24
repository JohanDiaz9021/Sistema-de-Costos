'use strict';

/**
 * Comprueba que los <script> del front cargan y se ven entre si.
 *
 * Nace de partir public/js/costeo.js (2.752 lineas) en ocho archivos. Son
 * <script> clasicos, no modulos ES, asi que el riesgo del corte no es de
 * sintaxis (eso lo ve `node --check`) sino de ORDEN: si un archivo leyera
 * al cargarse una constante que declara otro posterior, el navegador
 * reventaria con un ReferenceError y la pantalla quedaria en blanco.
 *
 * Aqui se ejecutan los ocho en el mismo orden que costeo.html, dentro de un
 * contexto compartido con un `document` y un `window` minimos — que es
 * exactamente lo que hace el navegador. Si el orden estuviera mal, esta
 * prueba falla.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '..', '..', 'public', 'js');
const HTML = path.join(__dirname, '..', '..', 'public', 'costeo.html');

// El orden real de carga se lee del HTML, no de una lista escrita a mano:
// si alguien agrega un <script> y olvida esta prueba, igual se cubre.
function scriptsDeCosteoHtml() {
  const html = fs.readFileSync(HTML, 'utf8');
  return [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
}

// document/window minimos: los archivos solo registran listeners al cargarse.
function contextoNavegador() {
  const nodoFalso = () => ({
    addEventListener() {}, appendChild() {}, removeAttribute() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '',
  });
  const ctx = {
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: nodoFalso,
      body: nodoFalso(),
      readyState: 'loading',
    },
    window: {},
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: '', search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    alert() {}, confirm: () => true,
    URLSearchParams, FormData: class {}, Node: class {},
    requestAnimationFrame: (fn) => fn(),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

test('los scripts de costeo.html cargan en orden sin reventar', () => {
  const archivos = scriptsDeCosteoHtml();
  assert.ok(archivos.length >= 8, `se esperaban al menos 8 scripts, hay ${archivos.length}`);

  const ctx = contextoNavegador();
  for (const archivo of archivos) {
    const ruta = path.join(JS, archivo);
    assert.ok(fs.existsSync(ruta), `costeo.html apunta a /js/${archivo} y ese archivo no existe`);
    // Si el orden estuviera mal, aqui salta un ReferenceError.
    vm.runInContext(fs.readFileSync(ruta, 'utf8'), ctx, { filename: archivo });
  }
});

test('las funciones de cada panel quedan visibles entre archivos', () => {
  const ctx = contextoNavegador();
  for (const archivo of scriptsDeCosteoHtml()) {
    vm.runInContext(fs.readFileSync(path.join(JS, archivo), 'utf8'), ctx, { filename: archivo });
  }

  // Una funcion representativa de cada archivo del corte, mas los helpers
  // compartidos: si alguna falta, es que ese archivo no se esta cargando.
  const esperadas = [
    'escapeHtml', 'h', 'raw',          // safe-html.js
    'formatCOP', 'fetchJSON',          // costeo-core.js
    'renderCentrosGrid',               // costeo-centros.js
    'renderAccesosTable',              // costeo-accesos.js
    'renderEquipoTable', 'renderGastosTable', // costeo-equipo.js
    'renderOvertimeTable',             // costeo-overtime.js
    'loadHistorial',                   // costeo-overtime.js (historial)
  ];
  for (const nombre of esperadas) {
    assert.strictEqual(typeof ctx[nombre], 'function', `falta la funcion global ${nombre}()`);
  }

  // Las constantes de nivel superior (const/let) NO son propiedades del
  // objeto global: viven en el "global lexical scope". Por eso hay que
  // preguntar por ellas evaluando una expresion, no mirando ctx.X. Es el
  // mismo comportamiento del navegador (window.state es undefined pero
  // state funciona), y es justo lo que hace que el corte sea seguro: cada
  // archivo ve las constantes de los demas.
  const compartidas = {
    state: 'costeo-core.js',
    INDICATOR_DEFS: 'costeo-core.js',
    PANELES_CON_FILTRO: 'costeo-indicadores.js',
    TIPO_LABEL: 'costeo-centros.js',
    ROLE_LABEL: 'costeo-centros.js',
    GASTO_CATEGORY_LABEL: 'costeo-equipo.js',
    ESTADO_LABEL: 'costeo-comercial.js',
    // PM_DECISION_LABEL se retiró el 4 sep 2026 junto con la columna
    // "Decisión PM" (no hay flujo de aprobación de horas extra).
    HIST_ENTITY_LABEL: 'costeo-overtime.js',
  };
  for (const [nombre, archivo] of Object.entries(compartidas)) {
    const tipo = vm.runInContext(`typeof ${nombre}`, ctx);
    assert.notStrictEqual(tipo, 'undefined', `${nombre} (de ${archivo}) no quedo disponible`);
  }

  // Y el estado tiene que ser UNO solo, compartido por todos los archivos.
  assert.strictEqual(vm.runInContext('typeof state', ctx), 'object');
  assert.strictEqual(
    vm.runInContext('state.centros !== undefined && state.overtime !== undefined', ctx),
    true,
    'el objeto state no trae los campos que esperan los otros archivos'
  );
});

test('index.html apunta a archivos que existen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script src="\/js\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(JS, m[1])), `index.html apunta a /js/${m[1]}, que no existe`);
  }
});

test('login.html apunta a archivos que existen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'login.html'), 'utf8');
  for (const m of html.matchAll(/<script src="\/js\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(JS, m[1])), `login.html apunta a /js/${m[1]}, que no existe`);
  }
});

// ---------------------------------------------------------------
// El menu lateral de las DOS paginas (16 sep 2026)
// ---------------------------------------------------------------

// index.html (Planeacion) y costeo.html listan los mismos accesos a Costeo.
// Hasta hoy lo hacian en DISTINTO orden, asi que el menu "se movia" al pasar
// de un modulo al otro y habia que releerlo entero para encontrar la opcion.
// Ya habia un comentario en ambos archivos pidiendo "el mismo orden EXACTO"
// y aun asi divergieron: un comentario no lo impide, una prueba si.
test('el menu lateral lista los mismos items, en el mismo orden, en Planeacion y en Costeo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const RAIZ = path.join(__dirname, '..', '..');

  // Se compara el par (subtab, rol que lo ve): el rol importa tanto como el
  // orden — si un item fuera data-pm-only en una pagina y data-ceo-only en
  // la otra, el menu tambien cambiaria al navegar.
  const menuDe = (archivo, attr) => {
    const html = fs.readFileSync(path.join(RAIZ, 'public', archivo), 'utf8');
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    return [...nav.matchAll(new RegExp(`${attr}=["']?([a-z-]+)["']?([^>]*)`, 'g'))]
      .map((m) => `${m[1]}:${/data-ceo-only/.test(m[2]) ? 'ceo' : 'pm'}`);
  };

  const planeacion = menuDe('index.html', 'subtab');
  const costeo = menuDe('costeo.html', 'data-subtab');

  assert.ok(planeacion.length > 0, 'se esperaban items de menu en index.html');
  assert.deepStrictEqual(
    planeacion, costeo,
    'el menu de Planeacion y el de Costeo tienen que listar lo mismo, en el mismo orden y para el mismo rol'
  );
});
