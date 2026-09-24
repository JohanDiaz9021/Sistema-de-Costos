'use strict';

/**
 * Pruebas de COMPONENTE del frontend: cada función `render*` se ejecuta
 * en aislamiento contra un DOM real (jsdom) montado sobre el
 * public/costeo.html verdadero, con `state` controlado a mano.
 *
 * Por qué jsdom y no un DOM sintético (como test/unit/front-carga.test.js):
 * ese archivo solo verifica que los 8 scripts CARGUEN en orden, con un
 * `document` de mentira que no soporta innerHTML de verdad. Aquí se
 * necesita que `tbody.innerHTML = '<tr>...</tr>'` de verdad parsee HTML y
 * se pueda consultar con `querySelector`/`textContent` — eso es exactamente
 * lo que hace jsdom.
 *
 * Se monta el costeo.html REAL (no un fragmento inventado a mano) para que
 * los ids que se leen (`cst-cc-grid`, `cst-f-centro`, etc.) sean los mismos
 * que usa la aplicación de verdad — si alguien renombra un id en el HTML
 * sin actualizar el JS, esto lo revienta.
 *
 * `runScripts: 'outside-only'` le dice a jsdom que NO ejecute los <script
 * src> del HTML por su cuenta (evita que intente hacer fetch() de archivos
 * en disco). En su lugar, cada archivo de public/js/ se ejecuta a mano con
 * `vm.runInContext` contra `dom.window`, en el mismo orden que
 * costeo.html — igual que hace el navegador.
 *
 * Complementa a la capa E2E (Playwright), que prueba los mismos
 * componentes pero dentro de un flujo completo con red y base de datos
 * real. Aquí el foco es aislar CADA función de render con datos de borde
 * que serían caros de armar como fixtures de base de datos (HTML
 * malicioso, campos ausentes, listas vacías, availability de rol).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const JS = path.join(RAIZ, 'public', 'js');

// Mismo orden que los <script> de costeo.html (ver public/costeo.html),
// SIN costeo-nav.js: ese archivo trae el listener de DOMContentLoaded que
// arranca la app entera (fetch de todo lo necesario para pintar la
// pantalla). jsdom SI dispara DOMContentLoaded de verdad al terminar de
// parsear el documento (a diferencia de las <script src> del propio HTML,
// que 'outside-only' no ejecuta), asi que cargar costeo-nav.js aqui
// arrancaba ese bootstrap completo en cada prueba, disparando fetch() en
// segundo plano despues de que la prueba ya habia terminado. Ninguna
// funcion de render depende de costeo-nav.js — solo lo usa
// front-carga.test.js, que si necesita probar el arranque completo.
const ARCHIVOS_EN_ORDEN = [
  'safe-html.js',
  'iconos.js',
  'sidebar.js',
  'costeo-core.js',
  'costeo-indicadores.js',
  'costeo-centros.js',
  'costeo-accesos.js',
  'costeo-equipo.js',
  'costeo-alertas.js',
  'costeo-comercial.js',
  'costeo-overtime.js',
];

/**
 * Monta el costeo.html real en jsdom y ejecuta los scripts del front
 * contra su `window`. Devuelve { window, document, run } donde `run`
 * evalúa una expresión JS en ese contexto (para leer `state`, llamar
 * funciones, etc.) — necesario porque `state`, `render*` y compañía son
 * declaraciones de nivel superior (scope léxico), no propiedades de
 * `window`, así que no se pueden leer como `window.state`.
 */
function montarCosteo() {
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'costeo.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/costeo',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  // El front usa fetch en varias funciones de carga; no se ejercitan aquí
  // (se prueban por HTTP en test/integration y por Playwright en
  // test/e2e), pero definir un fetch que grite si algo lo llama por
  // accidente evita que una prueba "pase" en realidad esperando una
  // promesa colgada contra la red.
  dom.window.fetch = async () => {
    throw new Error('fetch() no deberia llamarse en una prueba de componente: mockea el dato en `state` directamente');
  };
  // requestAnimationFrame/alert/confirm: algunos handlers los referencian
  // al definirse (no al montar), pero se agregan por si acaso.
  dom.window.alert = () => {};
  dom.window.confirm = () => true;

  for (const archivo of ARCHIVOS_EN_ORDEN) {
    const src = fs.readFileSync(path.join(JS, archivo), 'utf8');
    vm.runInContext(src, dom.window, { filename: archivo });
  }

  return {
    window: dom.window,
    document: dom.window.document,
    /** Evalua una expresion en el contexto del front (scope global lexico). */
    run: (expr) => vm.runInContext(expr, dom.window),
    /** Asigna al `state` global del front. Se serializa via JSON para no
     *  compartir referencias con el objeto que le paso la prueba. */
    setState(parcial) {
      vm.runInContext(
        `Object.assign(state, ${JSON.stringify(parcial)})`,
        dom.window
      );
    },
  };
}

// ---------------------------------------------------------------
// cstToast (costeo-core.js) — reemplaza alert() nativo (31 ago 2026, a
// pedido explícito: "es de mala práctica que salga alerta").
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// initAyudaToggle (costeo-core.js) — el boton "Ayuda visible" del menu
// lateral existia sin NINGUN codigo detras: hacer clic no hacia nada
// (31 ago 2026). Ahora apaga/enciende los textos explicativos.
// ---------------------------------------------------------------

test('initAyudaToggle: al hacer clic apaga la ayuda y cambia la etiqueta del boton', () => {
  const { document, run } = montarCosteo();
  run('initAyudaToggle()');

  const btn = document.getElementById('cst-help-btn');
  assert.strictEqual(document.body.classList.contains('is-ayuda-oculta'), false, 'arranca con la ayuda visible');
  assert.strictEqual(btn.querySelector('span').textContent, 'Ocultar ayuda', 'el boton dice lo que HACE, no el estado');

  btn.dispatchEvent(new (run('window.Event'))('click', { bubbles: true }));
  assert.strictEqual(document.body.classList.contains('is-ayuda-oculta'), true);
  assert.strictEqual(btn.querySelector('span').textContent, 'Mostrar ayuda');
});

test('initAyudaToggle: un segundo clic la vuelve a encender', () => {
  const { document, run } = montarCosteo();
  run('initAyudaToggle()');
  const btn = document.getElementById('cst-help-btn');
  const Event = run('window.Event');

  btn.dispatchEvent(new Event('click', { bubbles: true }));
  btn.dispatchEvent(new Event('click', { bubbles: true }));
  assert.strictEqual(document.body.classList.contains('is-ayuda-oculta'), false);
  assert.strictEqual(btn.querySelector('span').textContent, 'Ocultar ayuda');
});

test('initAyudaToggle: recuerda la preferencia guardada al montar', () => {
  const { document, window, run } = montarCosteo();
  window.localStorage.setItem('gtc.costeo.ayudaOculta', '1');
  run('initAyudaToggle()');

  assert.strictEqual(document.body.classList.contains('is-ayuda-oculta'), true, 'debio arrancar apagada');
  assert.strictEqual(document.getElementById('cst-help-btn').querySelector('span').textContent, 'Mostrar ayuda');
});

test('initAyudaToggle: si el navegador bloquea localStorage, no revienta', () => {
  const { document, window, run } = montarCosteo();
  // Modo privado: leer/escribir localStorage lanza en vez de devolver null.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('acceso denegado'); },
  });

  run('initAyudaToggle()');
  const btn = document.getElementById('cst-help-btn');
  btn.dispatchEvent(new (run('window.Event'))('click', { bubbles: true }));
  assert.strictEqual(document.body.classList.contains('is-ayuda-oculta'), true, 'debe seguir funcionando, solo sin recordar');
});

test('cstToast: aparece en el contenedor con el texto y el tipo correcto', () => {
  const { document, run } = montarCosteo();
  run(`cstToast('Guardado con éxito')`);

  const toast = document.querySelector('#cst-toast-container .cst-toast');
  assert.ok(toast, 'deberia crear el toast dentro del contenedor');
  assert.strictEqual(toast.textContent, 'Guardado con éxito');
  assert.ok(toast.classList.contains('cst-toast-ok'), 'por defecto deberia ser de tipo ok');
});

test('cstToast: se apilan varios a la vez, cada uno con su propio texto', () => {
  const { document, run } = montarCosteo();
  run(`cstToast('Primero')`);
  run(`cstToast('Segundo')`);

  const textos = [...document.querySelectorAll('#cst-toast-container .cst-toast')].map((t) => t.textContent);
  assert.deepStrictEqual(textos, ['Primero', 'Segundo']);
});

test('cstToast: escapa contenido peligroso (usa textContent, no innerHTML)', () => {
  const { document, run } = montarCosteo();
  run(`cstToast('<img src=x onerror=alert(1)>')`);

  const toast = document.querySelector('#cst-toast-container .cst-toast');
  assert.strictEqual(toast.querySelectorAll('img').length, 0, 'no debio crear un <img> real');
  assert.strictEqual(toast.textContent, '<img src=x onerror=alert(1)>');
});

test('cstToast: a los 5s por defecto empieza a cerrarse (clase is-saliendo)', async () => {
  const { document, run } = montarCosteo();
  run(`cstToast('Se va sola', { duracionMs: 20 })`);

  const toast = document.querySelector('#cst-toast-container .cst-toast');
  assert.strictEqual(toast.classList.contains('is-saliendo'), false, 'no deberia cerrarse antes de tiempo');

  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(toast.classList.contains('is-saliendo'), true, 'deberia empezar a cerrarse pasado el tiempo');

  // jsdom no dispara transitionend solo (no ejecuta animaciones CSS de
  // verdad) — se simula para confirmar que el toast SI se quita del DOM
  // cuando el navegador real termine la transicion.
  toast.dispatchEvent(new (run('window.Event'))('transitionend'));
  assert.strictEqual(document.querySelector('#cst-toast-container .cst-toast'), null, 'deberia quitarse del DOM tras la transicion');
});

// ---------------------------------------------------------------
// renderSnapshotBulkbar / initSnapshotBulkbar (costeo-core.js) — borrado
// multiple de snapshots (8 sep 2026, a pedido explicito: antes solo se
// podia eliminar uno por uno).
// ---------------------------------------------------------------

const SNAP_A = { snapshot_id: 1, snapshot_date: '2026-08-01', project_name: 'ALFA' };
const SNAP_B = { snapshot_id: 2, snapshot_date: '2026-08-08', project_name: 'ALFA' };

// jsdom no simula un clic real al despachar 'change' en un checkbox: hay que
// fijar `checked` a mano antes, o el listener del front ve el valor viejo.
function marcarCasilla(document, run, id, valor = true) {
  const chk = document.querySelector(`[data-snapshot-check="${id}"]`);
  chk.checked = valor;
  chk.dispatchEvent(new (run('window.Event'))('change', { bubbles: true }));
}

test('renderSnapshotBulkbar: sin seleccion la barra queda oculta', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotBulkbar()');
  assert.strictEqual(document.getElementById('cst-snapshot-bulkbar').hidden, true);
});

test('renderSnapshotList: marcar una casilla muestra la barra con el contador singular', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');

  marcarCasilla(document, run, 1);

  const barra = document.getElementById('cst-snapshot-bulkbar');
  assert.strictEqual(barra.hidden, false);
  assert.strictEqual(document.getElementById('cst-snapshot-bulk-count').textContent, '1 seleccionado');
});

test('renderSnapshotList: dos casillas marcadas usan el plural y "Seleccionar todos" queda en indeterminate', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B, { snapshot_id: 3, snapshot_date: '2026-08-15', project_name: 'ALFA' }] });
  run('renderSnapshotList()');

  marcarCasilla(document, run, 1);
  marcarCasilla(document, run, 2);

  assert.strictEqual(document.getElementById('cst-snapshot-bulk-count').textContent, '2 seleccionados');
  const selectAll = document.getElementById('cst-snapshot-select-all');
  assert.strictEqual(selectAll.checked, false, '2 de 3 no es "todos" marcado');
  assert.strictEqual(selectAll.indeterminate, true, 'una seleccion parcial debe verse como indeterminate, no como vacia');
});

test('renderSnapshotList: desmarcar la unica casilla elegida vuelve a ocultar la barra', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A] });
  run('renderSnapshotList()');

  marcarCasilla(document, run, 1, true);
  assert.strictEqual(document.getElementById('cst-snapshot-bulkbar').hidden, false);

  marcarCasilla(document, run, 1, false);
  assert.strictEqual(document.getElementById('cst-snapshot-bulkbar').hidden, true);
});

test('initSnapshotBulkbar: "Seleccionar todos" marca las casillas de todos los snapshots visibles', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  run('initSnapshotBulkbar()');

  const Event = run('window.Event');
  const selectAll = document.getElementById('cst-snapshot-select-all');
  selectAll.checked = true;
  selectAll.dispatchEvent(new Event('change', { bubbles: true }));

  assert.strictEqual(document.getElementById('cst-snapshot-bulk-count').textContent, '2 seleccionados');
  const casillas = [...document.querySelectorAll('[data-snapshot-check]')];
  assert.ok(casillas.every((c) => c.checked), 'las dos casillas deberian quedar marcadas');
});

test('initSnapshotBulkbar: desmarcar "Seleccionar todos" limpia la seleccion', () => {
  const { document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  run('initSnapshotBulkbar()');
  const Event = run('window.Event');
  const selectAll = document.getElementById('cst-snapshot-select-all');

  selectAll.checked = true;
  selectAll.dispatchEvent(new Event('change', { bubbles: true }));
  selectAll.checked = false;
  selectAll.dispatchEvent(new Event('change', { bubbles: true }));

  assert.strictEqual(document.getElementById('cst-snapshot-bulkbar').hidden, true);
});

test('initSnapshotBulkbar: pide confirmacion con la cantidad elegida antes de borrar', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  run('initSnapshotBulkbar()');
  const Event = run('window.Event');
  marcarCasilla(document, run, 1);
  marcarCasilla(document, run, 2);

  // sidebar.js registra su propio listener de click en `document` (ajeno a
  // esta prueba) que dispara un fetch a /api/auth/me con cualquier clic; el
  // mock solo cuenta los DELETE de snapshots, que son los que importan aqui.
  let deleteLlamado = false;
  window.fetch = async (url, opts) => {
    if (opts && opts.method === 'DELETE') deleteLlamado = true;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
  };

  document.getElementById('cst-snapshot-bulk-delete').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(document.getElementById('cst-confirm-message').textContent, '¿Eliminar 2 snapshots? No se puede deshacer.');
  assert.strictEqual(deleteLlamado, false, 'no deberia borrar nada antes de que se confirme el modal');

  document.getElementById('cst-confirm-cancel').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(deleteLlamado, false, 'cancelar no deberia disparar ningun DELETE');
});

test('initSnapshotBulkbar: al confirmar, borra cada snapshot elegido y recarga la lista', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  run('initSnapshotBulkbar()');
  const Event = run('window.Event');
  marcarCasilla(document, run, 1);
  marcarCasilla(document, run, 2);

  const borrados = [];
  window.fetch = async (url, opts) => {
    if (opts && opts.method === 'DELETE') {
      borrados.push(url);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    }
    if (String(url).includes('/api/costeo/snapshots')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ snapshots: [] }) };
    }
    throw new Error(`fetch inesperado en esta prueba: ${url}`);
  };

  document.getElementById('cst-snapshot-bulk-delete').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  document.getElementById('cst-confirm-accept').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(borrados.sort(), ['/api/costeo/snapshots/1', '/api/costeo/snapshots/2'].sort());
  assert.strictEqual(document.getElementById('cst-snapshot-bulkbar').hidden, true, 'tras borrar, la seleccion queda vacia');
  assert.match(document.getElementById('cst-snapshot-list').textContent, /Todavia no hay snapshots|Todavía no hay snapshots/, 'loadSnapshots() debio recargar la lista (queda vacia)');
});

test('initSnapshotBulkbar: si uno de los borrados falla, los demas igual se eliminan (Promise.allSettled)', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  run('initSnapshotBulkbar()');
  const Event = run('window.Event');
  marcarCasilla(document, run, 1);
  marcarCasilla(document, run, 2);

  const borrados = [];
  let alertMensaje = null;
  window.alert = (msg) => { alertMensaje = msg; };
  window.fetch = async (url, opts) => {
    if (opts && opts.method === 'DELETE') {
      if (String(url).endsWith('/1')) {
        return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ error: 'No encontrado' }) };
      }
      borrados.push(url);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ snapshots: [] }) };
  };

  document.getElementById('cst-snapshot-bulk-delete').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  document.getElementById('cst-confirm-accept').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(borrados, ['/api/costeo/snapshots/2'], 'el que no fallo debio borrarse igual');
  assert.match(alertMensaje || '', /1 de 2 snapshot/, 'debio avisar cuantos no se pudieron eliminar');
});

test('loadSnapshots: un snapshot que desaparece de la lista deja de contar como seleccionado', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({ snapshots: [SNAP_A, SNAP_B] });
  run('renderSnapshotList()');
  marcarCasilla(document, run, 1);
  marcarCasilla(document, run, 2);
  assert.strictEqual(document.getElementById('cst-snapshot-bulk-count').textContent, '2 seleccionados');

  window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ snapshots: [SNAP_A] }) });
  await run('loadSnapshots()');

  assert.strictEqual(document.getElementById('cst-snapshot-bulk-count').textContent, '1 seleccionado', 'el snapshot 2 ya no existe, no deberia seguir contando');
});

test('cstToast: pasar el mouse encima pausa el cierre automatico', async () => {
  const { document, run } = montarCosteo();
  run(`cstToast('No te vayas', { duracionMs: 20 })`);
  const toast = document.querySelector('#cst-toast-container .cst-toast');
  const Event = run('window.Event');

  toast.dispatchEvent(new Event('mouseenter', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(toast.classList.contains('is-saliendo'), false, 'con el mouse encima no deberia cerrarse');

  toast.dispatchEvent(new Event('mouseleave', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(toast.classList.contains('is-saliendo'), true, 'al quitar el mouse deberia retomar el cierre');
});

// ---------------------------------------------------------------
// renderCentrosGrid (costeo-centros.js)
// ---------------------------------------------------------------

test('renderCentrosGrid: escapa el nombre del proyecto y el cliente', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, codigo: 'CC-2026-001',
      project_name: '<img src=x onerror=alert(1)>',
      client_name: '<svg onload=alert(2)>',
      project_folder: 'X', tipo: 'Desarrollo', status: 'vigente',
      budget: 1000000,
      start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    porCentro: [{ cost_center_id: 1, ejecutado_total: 500000 }],
  });

  run('renderCentrosGrid()');

  const grid = document.getElementById('cst-cc-grid');
  assert.strictEqual(grid.querySelectorAll('img').length, 0, 'se creo un <img> real a partir del dato');
  // Los <svg> de .cst-ico son los iconos de la tarjeta (ver ICONOS en
  // costeo-core.js), no salen del dato: se excluyen a proposito. Lo que no
  // puede aparecer es un svg venido del texto que escribio el usuario.
  assert.strictEqual(
    grid.querySelectorAll('svg:not(.cst-ico > svg)').length, 0,
    'se creo un <svg> real a partir del dato'
  );
  assert.strictEqual(
    grid.querySelectorAll('[onload], [onerror]').length, 0,
    'el payload no puede dejar un manejador de eventos vivo'
  );
  assert.match(grid.innerHTML, /&lt;img/, 'el payload no quedo escapado en el HTML');
  assert.match(grid.textContent, /<img src=x onerror=alert\(1\)>/, 'el usuario deberia poder leer lo que escribio, como texto');
});

test('renderCentrosGrid: calcula el % de ejecucion contra el presupuesto', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, project_name: 'Proyecto Test', project_folder: 'T',
      tipo: 'Desarrollo', status: 'vigente', budget: 1000000,
      start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    porCentro: [{ cost_center_id: 1, ejecutado_total: 250000 }],
  });
  run('renderCentrosGrid()');
  const texto = document.getElementById('cst-cc-grid').textContent;
  assert.match(texto, /25%/, `deberia mostrar 25% de ejecucion: ${texto}`);
});

test('renderCentrosGrid: muestra "Horas trabajadas" con ind9_horas_ejecutadas de Indicadores', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, project_name: 'Document Online', project_folder: 'Document Online',
      tipo: 'Desarrollo', status: 'vigente', budget: 3000000,
      start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    // Ejecutado ($) sale de porCentro (GET /api/costeo/indicadores); Horas
    // trabajadas sale de indicadores17 (GET /api/costeo/indicadores-17) —
    // son dos respuestas del backend distintas, con dos arreglos distintos
    // en el estado. Confundirlos fue justo el bug real (22 sep 2026): daba
    // 0 h siempre, aunque Ejecutado ($) se viera bien.
    porCentro: [{ cost_center_id: 1, ejecutado_total: 250000 }],
    indicadores17: [{ cost_center_id: 1, ind9_horas_ejecutadas: 123.456 }],
  });
  run('renderCentrosGrid()');
  const texto = document.getElementById('cst-cc-grid').textContent;
  assert.match(texto, /Horas trabajadas/, 'falta la etiqueta nueva');
  assert.match(texto, /123\.5 h/, `deberia redondear a 1 decimal: ${texto}`);
});

test('renderCentrosGrid: sin ind9_horas_ejecutadas (Indicadores todavia sin cargar) muestra 0 h, no revienta', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, project_name: 'Proyecto Test', project_folder: 'T',
      tipo: 'Desarrollo', status: 'vigente', budget: 1000000,
      start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    porCentro: [{ cost_center_id: 1, ejecutado_total: 250000 }],
  });
  run('renderCentrosGrid()');
  const texto = document.getElementById('cst-cc-grid').textContent;
  assert.match(texto, /0\.0 h/, `sin el dato deberia caer a 0.0 h en vez de romper el render: ${texto}`);
});

test('renderCentrosGrid: sin centros muestra el mensaje vacio, no una tabla rota', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, centros: [], porCentro: [] });
  run('renderCentrosGrid()');
  assert.match(document.getElementById('cst-cc-grid').textContent, /Sin centros de costos/);
});

// Desde ago 2026 un leader (PM) tambien ve el boton Eliminar — el backend
// (canWriteCenter en DELETE /centros/:id) es quien limita que solo pueda
// borrar SUS PROPIOS centros; GET /centros ya le filtra la lista a esos
// mismos, asi que si el boton aparece es porque es un centro suyo.
test('renderCentrosGrid: el boton Eliminar aparece para leader y para admin/ceo, no para otros roles', () => {
  const { document, run, setState } = montarCosteo();
  const centro = {
    cost_center_id: 1, project_name: 'P', project_folder: 'P', tipo: 'Desarrollo',
    status: 'vigente', budget: 1, start_date: '2026-01-01', planned_end_date: '2026-12-31',
  };

  setState({ user: { role: 'leader' }, centros: [centro], porCentro: [] });
  run('renderCentrosGrid()');
  assert.strictEqual(
    document.getElementById('cst-cc-grid').querySelectorAll('[data-centro-delete]').length, 1,
    'un leader si deberia ver el boton Eliminar en sus propios centros'
  );

  setState({ user: { role: 'admin' }, centros: [centro], porCentro: [] });
  run('renderCentrosGrid()');
  assert.strictEqual(
    document.getElementById('cst-cc-grid').querySelectorAll('[data-centro-delete]').length, 1,
    'un admin si deberia ver el boton Eliminar'
  );
});

// ---------------------------------------------------------------
// Historial de cambios de un proyecto (costeo-centros.js) — el antes/despues
// que pidio el dueno de la empresa (7 sep 2026). Lo unico con logica de
// verdad aqui es partirCambio(): las descripciones vienen del backend como
// texto plano ("Campo: antes -> despues", separadas por coma o por ' · ') y
// hay que partirlas bien para poder pintar las dos cajas de color. Si esto
// se rompe, el historial se ve como una frase corrida y pierde justo lo que
// se pedia.
// ---------------------------------------------------------------

test('partirCambio: separa "Campo: antes → despues" en sus tres pedazos', () => {
  const { run } = montarCosteo();
  const partes = run('JSON.stringify(partirCambio("Valor de contrato: $10.000.000 → $100.000.000"))');
  assert.deepStrictEqual(JSON.parse(partes), [
    { titulo: 'Valor de contrato', antes: '$10.000.000', despues: '$100.000.000' },
  ]);
});

test('partirCambio: parte una descripcion con VARIOS campos cambiados (separados por coma)', () => {
  const { run } = montarCosteo();
  const partes = JSON.parse(run('JSON.stringify(partirCambio("Presupuesto: $10.000 → $12.000, Estado: vigente → inactivo"))'));
  assert.strictEqual(partes.length, 2, 'deberian salir dos cambios, no uno solo con la coma adentro');
  assert.strictEqual(partes[0].titulo, 'Presupuesto');
  assert.strictEqual(partes[1].despues, 'inactivo');
});

// El conteo de equipo/gastos se agrega al final de la descripcion con ' · '
// (ver src/routes/costeo/equipo.js y gastos.js): la primera mitad es texto
// libre sin flecha y no debe romper el parseo de la segunda.
test('partirCambio: texto libre + conteo "Equipo: 3 → 4 personas" se separan sin romperse', () => {
  const { run } = montarCosteo();
  const partes = JSON.parse(run('JSON.stringify(partirCambio("Agregó a Juan como Analista, $8.000/h · Equipo: 3 → 4 personas"))'));
  assert.strictEqual(partes.length, 2);
  assert.strictEqual(partes[0].antes, null, 'el texto sin flecha no tiene antes/despues que pintar');
  assert.deepStrictEqual(partes[1], { titulo: 'Equipo', antes: '3', despues: '4 personas' });
});

// Puntos de miles en el historial (7 sep 2026, a pedido explicito: "se ve
// 94000 o 100000000 y es dificil de leer"). El backend ya guarda el monto
// formateado, pero las filas viejas traen el numero crudo y son las que el
// CEO abre primero — se formatean al pintarlas.
test('formatearMontosEnTexto: le pone puntos a los montos pegados a un $, y deja el resto quieto', () => {
  const { run } = montarCosteo();
  assert.strictEqual(
    run('formatearMontosEnTexto("Solicitó gasto \\"Licencia\\" por $500000 (otro)")'),
    'Solicitó gasto "Licencia" por $ 500.000 (otro)'
  );
  // Un numero suelto puede ser cualquier cosa (horas, personas, un codigo):
  // meterle puntos seria peor que dejarlo.
  assert.strictEqual(run('formatearMontosEnTexto("Equipo: 3 → 4 personas")'), 'Equipo: 3 → 4 personas');
  // Lo que ya viene formateado del backend no se toca dos veces.
  assert.strictEqual(run('formatearMontosEnTexto("Contrato: $ 10.000.000")'), 'Contrato: $ 10.000.000');
});

// Regresion (7 sep 2026, reportado por el usuario): la tabla de Historial
// (pestaña aparte de "Ver cambios") no formateaba NADA — usaba solo
// formatearMontosEnTexto (montos pegados a un "$"), y las filas viejas de
// describirCambios no tienen "$" ("Presupuesto: 452400 → 500000"). Ahora usa
// formatearDescripcionHistorial, que reusa partirCambio/valorCambioTexto
// (las mismas de "Ver cambios") para tambien cubrir ese caso.
test('formatearDescripcionHistorial: formatea "Campo: antes → despues" SIN "$" (filas viejas de describirCambios)', () => {
  const { run } = montarCosteo();
  assert.strictEqual(
    run('formatearDescripcionHistorial("Presupuesto: 452400 → 500000, Estado: vigente → inactivo")'),
    'Presupuesto: $ 452.400 → $ 500.000, Estado: vigente → inactivo'
  );
  // Regresion puntual: antes la coma que separa "500000," del siguiente
  // campo hacia que el regex del "$" fallara a mitad de camino y dejara
  // "$ 452.400 500000" (la flecha y el segundo numero se perdian).
  assert.doesNotMatch(
    run('formatearDescripcionHistorial("Presupuesto: 452400 → 500000, Estado: vigente → inactivo")'),
    /452400|500000/,
    'no deberia quedar ningun numero crudo sin puntos'
  );
});

// DECIMAL de MySQL: mp_centro_costo.budget es DECIMAL(...), asi que un valor
// "antes" leido directo de la fila puede llegar como "7000000.00", no como
// entero puro — valorCambioTexto tiene que reconocer tambien ese formato.
test('formatearDescripcionHistorial: formatea un DECIMAL de MySQL ("7000000.00"), no solo enteros', () => {
  const { run } = montarCosteo();
  assert.strictEqual(
    run('formatearDescripcionHistorial("Presupuesto: 7000000.00 → 8500000.00")'),
    'Presupuesto: $ 7.000.000 → $ 8.500.000'
  );
});

// Regresion (7 sep 2026, reportado por el usuario en datos REALES de su
// base): un monto con decimal de MySQL pegado directo al "$" ("$50000.00",
// de una fila vieja de gastos.js que interpolaba rows[0].amount tal cual)
// no se formateaba NADA — el ".00" hacia fallar el negative lookahead que
// evita romper un numero YA formateado ("$ 1.000.000"), y como el match
// entero fallaba, no se tocaba ni el entero.
test('formatearMontosEnTexto: formatea "$50000.00" (decimal de MySQL pegado al $), no solo enteros sin decimales', () => {
  const { run } = montarCosteo();
  assert.strictEqual(
    run('formatearMontosEnTexto("Rechazó el gasto \\"Prueba\\" por $50000.00 (Esta muy caro)")'),
    'Rechazó el gasto "Prueba" por $ 50.000 (Esta muy caro)'
  );
  // Sigue sin tocar lo que YA esta formateado (no debe duplicar puntos).
  assert.strictEqual(run('formatearMontosEnTexto("Contrato: $ 10.000.000")'), 'Contrato: $ 10.000.000');
});

// Regresion (7 sep 2026, reportado por el usuario en datos REALES): Equipo
// del Proyecto antepone el NOMBRE de la persona a toda la descripcion
// ("Oscar Naranjo: Costo/hora: 10952.00 → 10952...", ver PUT /equipo en
// src/routes/costeo/equipo.js). Con el primer ":" en vez del ULTIMO,
// partirCambio cortaba en el ":" de "Oscar Naranjo" y "antes" quedaba como
// " Costo/hora: 10952.00" (texto con letras) — nunca pasaba el regex de
// numero puro y se quedaba sin formatear.
test('formatearDescripcionHistorial: un campo de dinero con el NOMBRE de la persona antepuesto tambien se formatea', () => {
  const { run } = montarCosteo();
  assert.strictEqual(
    run('formatearDescripcionHistorial("Oscar Naranjo: Costo/hora: 10952.00 → 10952, Salario mensual: 2300000.00 → 2300000, Activo: Sí → Sí")'),
    'Oscar Naranjo: Costo/hora: $ 10.952 → $ 10.952, Salario mensual: $ 2.300.000 → $ 2.300.000, Activo: Sí → Sí'
  );
});

test('cambioEntradaHTML: un campo con el nombre antepuesto se reconoce igual como dinero (mismo caso, en las cajas de color)', () => {
  const { document, run } = montarCosteo();
  const html = run(`cambioEntradaHTML({
    entity_type: 'equipo', action: 'editar', user_name: 'Johan', created_at: '2026-09-07T10:00:00',
    description: 'Oscar Naranjo: Costo/hora: 10952.00 → 10952',
  })`);
  const cont = document.createElement('div');
  cont.innerHTML = html;
  assert.strictEqual(cont.querySelector('.cst-cambio-antes').textContent, '$ 10.952');
  assert.strictEqual(cont.querySelector('.cst-cambio-despues').textContent, '$ 10.952');
});

test('valorCambioTexto: formatea el valor crudo solo si el campo es de dinero', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run('valorCambioTexto("Presupuesto", "100000000")'), '$ 100.000.000');
  assert.strictEqual(run('valorCambioTexto("Valor de contrato", "94000")'), '$ 94.000');
  // "Horas planeadas: 40" o "Equipo: 3" no son dinero: se dejan igual.
  assert.strictEqual(run('valorCambioTexto("Horas planeadas", "40")'), '40');
  assert.strictEqual(run('valorCambioTexto("Equipo", "3")'), '3');
});

test('cambioEntradaHTML: una fila vieja con el monto crudo se pinta con puntos de miles', () => {
  const { run } = montarCosteo();
  const html = run(`cambioEntradaHTML({
    entity_type: 'centro_costo', action: 'editar', user_name: 'Johan',
    created_at: '2026-09-07T10:00:00', description: 'Valor de contrato: 10000000 → 100000000',
  })`);
  assert.match(html, /\$ 10\.000\.000/, 'el valor de ANTES deberia salir con puntos');
  assert.match(html, /\$ 100\.000\.000/, 'el valor de DESPUES deberia salir con puntos');
});

test('cambioEntradaHTML: escapa la descripcion (la escriben usuarios: nombres de gasto, proyecto...)', () => {
  const { document, run } = montarCosteo();
  const html = run(`cambioEntradaHTML({
    entity_type: 'gasto', action: 'crear', user_name: 'Ana',
    created_at: '2026-09-07T10:00:00', description: 'Gasto "<img src=x onerror=alert(1)>" por $5',
  })`);
  const cont = document.createElement('div');
  cont.innerHTML = html;
  assert.strictEqual(cont.querySelectorAll('img').length, 0, 'se creo un <img> real a partir del dato');
  assert.match(cont.textContent, /<img src=x onerror=alert\(1\)>/, 'deberia leerse como texto');
});

test('renderCentrosGrid: "Ver cambios" sale deshabilitado si el proyecto no tiene cambios todavia', () => {
  const { document, run, setState } = montarCosteo();
  const base = {
    cost_center_id: 1, project_name: 'P', project_folder: 'P', tipo: 'Desarrollo',
    status: 'vigente', budget: 1, start_date: '2026-01-01', planned_end_date: '2026-12-31',
  };

  setState({ user: { role: 'ceo' }, centros: [{ ...base, cambios_total: 0 }], porCentro: [] });
  run('renderCentrosGrid()');
  assert.strictEqual(document.querySelector('[data-centro-cambios]').disabled, true);

  setState({ user: { role: 'ceo' }, centros: [{ ...base, cambios_total: 12 }], porCentro: [] });
  run('renderCentrosGrid()');
  const btn = document.querySelector('[data-centro-cambios]');
  assert.strictEqual(btn.disabled, false);
  assert.match(btn.textContent, /12/, 'deberia decir cuantos cambios lleva el proyecto');
});

// Regresion: el error al eliminar un centro usaba alert() nativo mientras
// el resto del flujo de borrado (31 ago 2026) ya usa el modal/toast propio
// — quedaba inconsistente justo en la ruta de error.
// ---------------------------------------------------------------
// renderPlanRecursosBody (costeo-centros.js) — Costo No Planeado aprobado
// dentro del Plan de Recursos. Regresion / feature (9 sep 2026, a pedido
// explicito del usuario, con captura): un gasto de "Costo No Planeado" ya
// APROBADO no se veia en ningun lado al entrar al proyecto desde "Costo
// Planeado" — el usuario esperaba verlo listado ahi y sumado al total.
// ---------------------------------------------------------------

// Monta la tarjeta de edicion del centro y deja `planRecursosEdit` listo,
// sin pasar por abrirEdicionCentro() (que hace fetch): esta funcion prueba
// solo el render, no la carga por red.
function montarPlanRecursosEdit({ run, setState }, { filas = [], gastosIniciales = [], gastosNoPlaneados = [], overtime = [] }) {
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, project_name: 'Transversales', project_folder: 'TRANSV', tipo: 'Desarrollo',
      status: 'vigente', budget: 2000000, contract_value: 2000000,
      start_date: '2026-08-20', planned_end_date: '2027-08-20',
    }],
    porCentro: [],
    gastos: gastosNoPlaneados,
    overtime,
    tarifasCargo: [],
    employees: [],
  });
  run('renderCentrosGrid()');
  run(`document.querySelector('.cst-cc-card[data-centro-id="1"]').innerHTML = centroEditFormHTML(state.centros[0])`);
  // abrirEdicionCentro() siempre hace esto justo despues de insertar el HTML:
  // sin convertir el input a type="text", "1.000.000" (con puntos) no es un
  // numero valido para un <input type="number"> y el navegador lo deja vacio.
  run(`['budget', 'contract_value'].forEach((n) => attachMilesFormat(document.querySelector('.cst-cc-card[data-centro-id="1"] [name="' + n + '"]')))`);
  run(`planRecursosEdit = { costCenterId: 1, filas: ${JSON.stringify(filas)}, gastos: ${JSON.stringify(gastosIniciales)} }`);
  return run(`(() => { renderPlanRecursosBody(document.querySelector('.cst-cc-card[data-centro-id="1"]')); return true; })()`);
}

test('Plan de Recursos: un gasto no planeado APROBADO se lista y se suma al total', () => {
  const ctx = montarCosteo();
  montarPlanRecursosEdit(ctx, {
    gastosIniciales: [{ description: 'Licencia inicial', amount: 1831170 }],
    gastosNoPlaneados: [
      { cost_center_id: 1, description: 'Pureba', amount: 200000, expense_date: '2026-09-09', approval_status: 'aprobado' },
    ],
  });
  const { document } = ctx;

  assert.match(document.body.textContent, /Pureba/, 'debe listar la descripcion del gasto aprobado');
  const totalGeneral = document.querySelector('[data-plan-total-general]');
  assert.ok(totalGeneral, 'debe aparecer el total general cuando hay algo no planeado');
  assert.match(totalGeneral.textContent, /2\.031\.170/, '1.831.170 (gastos iniciales) + 200.000 (no planeado) = 2.031.170');
});

test('Plan de Recursos: un gasto no planeado PENDIENTE o de OTRO centro no cuenta', () => {
  const ctx = montarCosteo();
  montarPlanRecursosEdit(ctx, {
    gastosIniciales: [],
    gastosNoPlaneados: [
      { cost_center_id: 1, description: 'Todavia sin aprobar', amount: 500000, expense_date: '2026-09-09', approval_status: 'pendiente' },
      { cost_center_id: 2, description: 'De otro proyecto', amount: 999999, expense_date: '2026-09-09', approval_status: 'aprobado' },
    ],
  });
  const { document } = ctx;

  assert.doesNotMatch(document.body.textContent, /Todavia sin aprobar/, 'un gasto pendiente no es dinero ya gastado, no debe contar todavia');
  assert.doesNotMatch(document.body.textContent, /De otro proyecto/, 'el gasto de otro centro de costos no es de este proyecto');
  assert.match(document.body.textContent, /Sin gastos no planeados aprobados en este proyecto todavía/);
  assert.strictEqual(document.querySelector('[data-plan-total-general]'), null, 'sin nada no planeado, no debe existir un total general aparte');
});

test('Plan de Recursos: el Presupuesto auto-calculado NO se infla con el no planeado aprobado', () => {
  const ctx = montarCosteo();
  const { document, run } = ctx;
  montarPlanRecursosEdit(ctx, {
    gastosIniciales: [{ description: 'Licencia', amount: 1000000 }],
    gastosNoPlaneados: [
      { cost_center_id: 1, description: 'Imprevisto', amount: 200000, expense_date: '2026-09-09', approval_status: 'aprobado' },
    ],
  });
  const card = document.querySelector('.cst-cc-card[data-centro-id="1"]');
  card.querySelector('[data-plan-toggle]').checked = true;
  run(`renderPlanRecursosBody(document.querySelector('.cst-cc-card[data-centro-id="1"]'))`);

  const budgetInput = card.querySelector('[name="budget"]');
  assert.match(
    budgetInput.value,
    /1\.000\.000/,
    'el presupuesto debe salir SOLO del plan (equipo+gastos iniciales); si se inflara con el no planeado ' +
    'rompería el % ejecutado-sobre-presupuesto (indicador #1)'
  );
});

// Horas Extra aprobadas dentro del Plan de Recursos (17 sep 2026, a pedido
// explicito, con captura): igual que el no planeado, una hora extra ya
// aprobada es plata real del proyecto y no se veia en ningun lado al entrar
// a "Costo Planeado" — mismo criterio y misma forma que las pruebas de
// arriba, aplicado a state.overtime en vez de state.gastos.
test('Plan de Recursos: una hora extra APROBADA se lista y se suma al total', () => {
  const ctx = montarCosteo();
  montarPlanRecursosEdit(ctx, {
    gastosIniciales: [{ description: 'Licencia inicial', amount: 1831170 }],
    overtime: [
      {
        decision_id: 5, cost_center_id: 1, canonical_name: 'Alicia Alfa',
        fecha: '2026-08-29', week_number: 5, month_number: 8, year_number: 2026,
        extra_hours: 3, extra_cost_potential: 45000, extra_cost_final: 45000,
        approval_status: 'aprobado',
      },
    ],
  });
  const { document } = ctx;

  assert.match(document.body.textContent, /Alicia Alfa/, 'debe listar el talento de la hora extra aprobada');
  const totalGeneral = document.querySelector('[data-plan-total-general]');
  assert.ok(totalGeneral, 'debe aparecer el total general cuando hay horas extra aprobadas');
  assert.match(totalGeneral.textContent, /1\.876\.170/, '1.831.170 (gastos iniciales) + 45.000 (hora extra) = 1.876.170');
});

test('Plan de Recursos: una hora extra PENDIENTE o de OTRO centro no cuenta', () => {
  const ctx = montarCosteo();
  montarPlanRecursosEdit(ctx, {
    overtime: [
      {
        decision_id: 6, cost_center_id: 1, canonical_name: 'Sin decidir',
        fecha: '2026-08-29', week_number: 5, month_number: 8, year_number: 2026,
        extra_hours: 2, extra_cost_potential: 30000, extra_cost_final: null,
        approval_status: 'pendiente',
      },
      {
        decision_id: 7, cost_center_id: 2, canonical_name: 'De otro proyecto',
        fecha: '2026-08-29', week_number: 5, month_number: 8, year_number: 2026,
        extra_hours: 9, extra_cost_potential: 999999, extra_cost_final: 999999,
        approval_status: 'aprobado',
      },
    ],
  });
  const { document } = ctx;

  assert.doesNotMatch(document.body.textContent, /Sin decidir/, 'una hora extra pendiente no es dinero ya comprometido, no debe contar todavia');
  assert.doesNotMatch(document.body.textContent, /De otro proyecto/, 'la hora extra de otro centro de costos no es de este proyecto');
  assert.match(document.body.textContent, /Sin horas extra aprobadas en este proyecto todavía/);
  assert.strictEqual(document.querySelector('[data-plan-total-general]'), null, 'sin nada aprobado (ni no planeado ni horas extra), no debe existir un total general aparte');
});

test('Plan de Recursos: el total general suma no planeado Y horas extra a la vez', () => {
  const ctx = montarCosteo();
  montarPlanRecursosEdit(ctx, {
    gastosIniciales: [{ description: 'Licencia', amount: 1000000 }],
    gastosNoPlaneados: [
      { cost_center_id: 1, description: 'Imprevisto', amount: 200000, expense_date: '2026-09-09', approval_status: 'aprobado' },
    ],
    overtime: [
      {
        decision_id: 8, cost_center_id: 1, canonical_name: 'Alicia Alfa',
        fecha: '2026-08-29', week_number: 5, month_number: 8, year_number: 2026,
        extra_hours: 3, extra_cost_potential: 50000, extra_cost_final: 50000,
        approval_status: 'aprobado',
      },
    ],
  });
  const { document } = ctx;

  const totalGeneral = document.querySelector('[data-plan-total-general]');
  assert.match(totalGeneral.textContent, /1\.250\.000/, '1.000.000 + 200.000 (no planeado) + 50.000 (hora extra) = 1.250.000');
});

test('handleDeleteCentro: si falla, muestra el error con cstToast, no con alert() nativo', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    centros: [{
      cost_center_id: 1, project_name: 'ALFA', project_folder: 'ALFA', tipo: 'Desarrollo',
      status: 'vigente', budget: 1000000, start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    porCentro: [],
  });
  run('renderCentrosGrid()');
  run('initCentroForm()');

  let alertLlamado = false;
  window.alert = () => { alertLlamado = true; };
  window.fetch = async () => ({
    ok: false, status: 409, headers: { get: () => 'application/json' },
    json: async () => ({ error: 'No se pudo eliminar el centro' }),
  });

  const Event = run('window.Event');
  document.querySelector('[data-centro-delete]').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  document.getElementById('cst-confirm-accept').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(alertLlamado, false, 'no deberia usar el alert() nativo del navegador');
  const toast = document.querySelector('.cst-toast-error');
  assert.ok(toast, 'deberia mostrar el error como toast');
  assert.strictEqual(toast.textContent, 'No se pudo eliminar el centro');
});

// Regresion: tras cargar un Excel de horas, el resumen de arriba
// (Presupuesto/Ejecutado totales) tiene que quedar tan actualizado como
// las tarjetas de abajo — ambos vienen de state.porCentro, pero cada uno
// lo pinta una función distinta (renderCentroSummary vs renderCentrosGrid).
test('renderCentroCostosPanel: refresca tanto el resumen de arriba como las tarjetas de abajo', async () => {
  const { window, document, run, setState } = montarCosteo();
  window.fetch = async (url) => {
    if (String(url).includes('/api/filters')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ projects: [] }) };
    }
    throw new Error(`fetch inesperado en esta prueba: ${url}`);
  };
  setState({
    user: { role: 'ceo' },
    alertas: [],
    centros: [{
      cost_center_id: 1, project_name: 'ALFA', project_folder: 'ALFA', tipo: 'Desarrollo',
      status: 'vigente', budget: 1000000, start_date: '2026-01-01', planned_end_date: '2026-12-31',
    }],
    porCentro: [{ cost_center_id: 1, ejecutado_total: 250000 }],
  });

  await run('renderCentroCostosPanel()');

  assert.match(document.getElementById('cst-cc-ejecutado').textContent, /250\.000/, 'el resumen de arriba deberia reflejar el ejecutado nuevo');
  assert.match(document.getElementById('cst-cc-grid').textContent, /25%/, 'la tarjeta de abajo tambien deberia reflejarlo');
});

// ---------------------------------------------------------------
// cstConfirm (costeo-core.js) — el boton de aceptar. Regresion (9 sep 2026,
// reportado por el usuario con captura): "¿Aprobar este gasto?" salia con un
// boton ROJO que decia "Eliminar", porque el texto estaba fijo en el HTML y
// el modal nacio para los borrados.
// ---------------------------------------------------------------

test('cstConfirm: por defecto el boton de aceptar dice "Eliminar" y va en rojo', () => {
  const { document, run } = montarCosteo();
  run(`cstConfirm('¿Eliminar este gasto?')`);

  const btn = document.getElementById('cst-confirm-accept');
  assert.strictEqual(btn.textContent, 'Eliminar');
  assert.strictEqual(btn.classList.contains('is-ok'), false, 'un borrado no debe verse como accion positiva');
  assert.strictEqual(document.getElementById('cst-confirm-overlay').hidden, false);
});

test('cstConfirm: al aprobar, el boton dice "Aprobar" y deja de ser rojo', () => {
  const { document, run } = montarCosteo();
  run(`cstConfirm('¿Aprobar este gasto?', { aceptar: 'Aprobar', peligro: false })`);

  const btn = document.getElementById('cst-confirm-accept');
  assert.strictEqual(btn.textContent, 'Aprobar', 'el boton no puede contradecir la pregunta');
  assert.strictEqual(btn.classList.contains('is-ok'), true);
});

// El <button> es UNO solo y se reusa en cada confirmacion: si el texto no
// volviera a su valor por defecto, el borrado siguiente pediria "Aprobar".
test('cstConfirm: tras una aprobacion, el siguiente borrado vuelve a decir "Eliminar" en rojo', async () => {
  const { document, run } = montarCosteo();
  const Event = run('window.Event');

  run(`cstConfirm('¿Aprobar este gasto?', { aceptar: 'Aprobar', peligro: false })`);
  document.getElementById('cst-confirm-cancel').dispatchEvent(new Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  run(`cstConfirm('¿Eliminar este gasto?')`);
  const btn = document.getElementById('cst-confirm-accept');
  assert.strictEqual(btn.textContent, 'Eliminar', 'se quedo pegado el texto de la confirmacion anterior');
  assert.strictEqual(btn.classList.contains('is-ok'), false, 'se quedo pegado el color de la confirmacion anterior');
});

test('cstConfirm: aceptar resuelve true y cancelar resuelve false', async () => {
  const { document, run } = montarCosteo();
  const Event = run('window.Event');

  const aceptada = run(`cstConfirm('¿Aprobar?', { aceptar: 'Aprobar', peligro: false })`);
  document.getElementById('cst-confirm-accept').dispatchEvent(new Event('click', { bubbles: true }));
  assert.strictEqual(await aceptada, true);
  assert.strictEqual(document.getElementById('cst-confirm-overlay').hidden, true, 'debe cerrarse al aceptar');

  const cancelada = run(`cstConfirm('¿Aprobar?', { aceptar: 'Aprobar', peligro: false })`);
  document.getElementById('cst-confirm-cancel').dispatchEvent(new Event('click', { bubbles: true }));
  assert.strictEqual(await cancelada, false);
});

// ---------------------------------------------------------------
// renderHeader (costeo-indicadores.js) — KPI de Alertas/Riesgo del
// encabezado. Regresion (9 sep 2026, reportado por el usuario): al volver
// de una navegacion real (entrar y salir de Planeacion, que recarga la
// pagina completa de Costeo desde cero) esta tarjeta pintaba "0" durante
// los ~5s que tarda /api/costeo/alertas (motor de costeo contra la base
// remota) ANTES de mostrar el numero real — loadIndicadores() llama a
// renderHeader() antes de que loadAlertas() responda, y state.alertas
// arranca como arreglo vacio. Cambiar de panel DENTRO de Costeo (Indicadores
// <-> Costo Planeado, sin recargar la pagina) nunca disparaba esto porque
// ahi state.alertas ya estaba cargado en memoria.
// ---------------------------------------------------------------

test('renderHeader: antes de que loadAlertas() responda, deja el "—" en vez de pintar "0" (falso)', () => {
  const { document, run, setState } = montarCosteo();
  setState({ centros: [], alertas: [], alertasListas: false });
  run('renderHeader()');

  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '—');
  assert.strictEqual(document.getElementById('cst-kpi-riesgo').textContent, '—');
});

test('renderHeader: una vez que alertasListas es true, pinta el conteo real (incluido 0 genuino)', () => {
  const { document, run, setState } = montarCosteo();
  setState({ centros: [], alertas: [], alertasListas: true });
  run('renderHeader()');
  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '0', 'un 0 real (ya cargado) si debe mostrarse');

  setState({
    alertas: [{ severidad: 'critica' }, { severidad: 'critica' }, { severidad: 'media' }],
    alertasListas: true,
  });
  run('renderHeader()');
  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '3');
  assert.strictEqual(document.getElementById('cst-kpi-riesgo').textContent, '2', 'cuenta solo las criticas');
});

test('loadAlertas: marca alertasListas en true y ahi si renderHeader() pinta el numero real', async () => {
  const { window, document, run, setState } = montarCosteo();
  setState({ centros: [], alertas: [], alertasListas: false });
  run('renderHeader()');
  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '—', 'arranca en loading, no en 0');

  window.fetch = async (url) => {
    if (String(url).includes('/api/costeo/alertas')) {
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => ({ alertas: [{ severidad: 'critica' }], escalamientos: [] }),
      };
    }
    throw new Error(`fetch inesperado en esta prueba: ${url}`);
  };
  await run('loadAlertas()');

  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '1', 'tras responder, ya no debe quedarse en "—"');
});

// ---------------------------------------------------------------
// renderGastosTable (costeo-equipo.js)
// ---------------------------------------------------------------

test('renderGastosTable: un gasto con <script> no se ejecuta ni crea la etiqueta', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [{
      expense_id: 1, project_name: 'ALFA', description: '<script>window.__X=1</script>',
      amount: 1000, expense_date: '2026-08-20', cost_center_id: 1,
    }],
  });
  run('renderGastosTable()');

  const tbody = document.getElementById('cst-gastos-tbody');
  assert.strictEqual(tbody.querySelectorAll('script').length, 0, 'se creo una etiqueta <script> real');
  assert.match(tbody.textContent, /<script>window\.__X=1<\/script>/, 'el texto deberia verse literal');
  assert.strictEqual(run('window.__X'), undefined, 'el script se ejecuto');
});

test('renderGastosTable: formatea el monto en pesos colombianos', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [{ expense_id: 1, project_name: 'ALFA', description: 'Licencia', amount: 1234567, expense_date: '2026-08-20', cost_center_id: 1 }],
  });
  run('renderGastosTable()');
  const texto = document.getElementById('cst-gastos-tbody').textContent;
  assert.match(texto, /1\.234\.567/, `esperaba el monto con separador de miles: ${texto}`);
});

test('renderGastosTable: el filtro global de centro oculta gastos de otros centros', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [
      { expense_id: 1, project_name: 'ALFA', description: 'Gasto Alfa', amount: 1, expense_date: '2026-08-01', cost_center_id: 1 },
      { expense_id: 2, project_name: 'BETA', description: 'Gasto Beta', amount: 1, expense_date: '2026-08-01', cost_center_id: 2 },
    ],
  });
  document.getElementById('cst-f-centro').innerHTML = '<option value="1">ALFA</option>';
  document.getElementById('cst-f-centro').value = '1';

  run('renderGastosTable()');
  const texto = document.getElementById('cst-gastos-tbody').textContent;
  assert.match(texto, /Gasto Alfa/);
  assert.doesNotMatch(texto, /Gasto Beta/, 'el filtro de centro no se aplico');
});

// sql/28 — el gasto no planeado que registra el PM es una SOLICITUD: se ve
// su estado con color (amarillo pendiente, verde aprobado, rojo rechazado)
// y el PM pierde Editar/Eliminar en cuanto el CEO la resuelve.
test('renderGastosTable: pinta el estado de aprobacion con su color', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [
      { expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'pendiente' },
      { expense_id: 2, project_name: 'ALFA', description: 'B', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'aprobado' },
      { expense_id: 3, project_name: 'ALFA', description: 'C', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'rechazado' },
    ],
  });
  run('renderGastosTable()');

  const pills = [...document.querySelectorAll('.cst-gasto-estado')];
  assert.deepStrictEqual(pills.map((p) => p.textContent), ['Pendiente', 'Aprobado', 'Rechazado']);
  assert.ok(pills[0].classList.contains('estado-pendiente'));
  assert.ok(pills[1].classList.contains('estado-aprobado'));
  assert.ok(pills[2].classList.contains('estado-rechazado'));
});

// Un gasto no planeado es un REGISTRO: solo se puede resolver (Aprobar /
// Rechazar) mientras esta pendiente, y una vez resuelto la fila no ofrece
// ninguna accion (11 sep 2026, a pedido explicito). Editar despues cambiaria
// un numero que ya paso por aprobacion; eliminar haria desaparecer del
// historial algo que si ocurrio.
test('renderGastosTable: pendiente ofrece Aprobar y Rechazar, y nada mas', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [{ expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'pendiente' }],
  });
  run('renderGastosTable()');

  const acciones = [...document.querySelectorAll('[data-gasto-row="1"] td:last-child button')]
    .map((b) => b.textContent);
  assert.deepStrictEqual(acciones, ['Aprobar', 'Rechazar']);
});

test('renderGastosTable: un gasto ya aprobado o rechazado no ofrece ninguna accion', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [
      { expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'aprobado' },
      { expense_id: 2, project_name: 'ALFA', description: 'B', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'rechazado' },
    ],
  });
  run('renderGastosTable()');

  assert.strictEqual(document.querySelectorAll('[data-gasto-row] td:last-child button').length, 0);
  assert.strictEqual(document.querySelectorAll('[data-gasto-edit], [data-gasto-delete]').length, 0,
    'ni Editar ni Eliminar, ni siquiera para admin/ceo');
});

// Quien no aprueba no ve botones: un PM manda la solicitud y espera. Su
// unica salida si se equivoco es que el aprobador la rechace, que es lo que
// deja rastro de por que ese costo no cuenta.
test('renderGastosTable: un PM no ve acciones ni sobre su propia solicitud pendiente', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'leader' },
    gastos: [{ expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'pendiente' }],
  });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelectorAll('[data-gasto-row] td:last-child button').length, 0);
});

test('renderGastosTable: un gasto sin estado (fila vieja) se muestra como pendiente, no en blanco', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    gastos: [{ expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01', cost_center_id: 1 }],
  });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelector('.cst-gasto-estado').textContent, 'Pendiente');
});

test('renderGastosTable: el motivo del rechazo queda visible en el title del estado', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'leader' },
    gastos: [{
      expense_id: 1, project_name: 'ALFA', description: 'A', amount: 1, expense_date: '2026-08-01',
      cost_center_id: 1, approval_status: 'rechazado', rejection_note: 'No corresponde al proyecto',
    }],
  });
  run('renderGastosTable()');
  assert.match(document.querySelector('.cst-gasto-estado').getAttribute('title'), /No corresponde al proyecto/);
});

test('renderGastosTable: solo admin/ceo ven Aprobar y Rechazar, y solo si sigue pendiente', () => {
  const { document, run, setState } = montarCosteo();
  const pendiente = { expense_id: 1, project_name: 'ALFA', description: 'X', amount: 1, expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'pendiente' };

  setState({ user: { role: 'ceo' }, gastos: [pendiente] });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelectorAll('[data-gasto-aprobar]').length, 1);
  assert.strictEqual(document.querySelectorAll('[data-gasto-rechazar]').length, 1);

  setState({ user: { role: 'ceo' }, gastos: [{ ...pendiente, approval_status: 'aprobado' }] });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelectorAll('[data-gasto-aprobar]').length, 0, 'un gasto ya aprobado no se vuelve a aprobar');

  setState({ user: { role: 'leader' }, gastos: [pendiente] });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelectorAll('[data-gasto-aprobar]').length, 0, 'el PM no aprueba su propio gasto');
});

// Sin usuario en sesion tampoco hay acciones: isAdmin sale de state.user, y
// una sesion a medio cargar no puede ofrecer Aprobar.
test('renderGastosTable: sin usuario en sesion no se ofrece ninguna accion', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: null,
    gastos: [{ expense_id: 1, project_name: 'ALFA', description: 'X', amount: 1, expense_date: '2026-08-01', cost_center_id: 1 }],
  });
  run('renderGastosTable()');
  assert.strictEqual(document.querySelectorAll('[data-gasto-row] td:last-child button').length, 0);
});

// ---------------------------------------------------------------
// renderEquipoTable (costeo-equipo.js) — agrupacion por empleado
// ---------------------------------------------------------------

test('renderEquipoTable: agrupa las filas de una misma persona y solo repite el nombre una vez', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    equipo: [
      { team_member_id: 1, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'qa', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 20000, is_active: 1, cost_center_id: 1 },
      { team_member_id: 2, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'desarrollador', project_name: 'BETA', project_folder: 'BETA', hourly_cost: 25000, is_active: 1, cost_center_id: 2 },
    ],
  });
  run('renderEquipoTable()');

  const tbody = document.getElementById('cst-equipo-tbody');
  const ocurrencias = (tbody.textContent.match(/Alicia Alfa/g) || []).length;
  assert.strictEqual(ocurrencias, 1, 'el nombre deberia aparecer una sola vez para el grupo, no una por fila');
  assert.strictEqual(tbody.querySelectorAll('tr[data-equipo-row]').length, 2, 'pero deben seguir siendo 2 filas editables');
});

// Un cargo creado por un PM (no uno de los 7 originales del fallback
// estático ROLE_LABEL en costeo-centros.js) solo se puede traducir contra
// state.tarifasCargo, que llega de GET /tarifas-cargo. Si esa carga
// todavía no llegó (loadEquipoYGastos y loadTarifasCargo corren en
// paralelo al arrancar, ver costeo-nav.js), roleLabel() no tiene con qué
// resolverlo y cae al slug crudo — este caso confirma que CON el catálogo
// cargado, se resuelve bien; loadTarifasCargo() vuelve a pintar la tabla
// para el caso en que la carrera lo dejara sin resolver.
test('renderEquipoTable: un cargo creado dinamicamente (no uno de los 7 originales) muestra su nombre, no el slug', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    tarifasCargo: [{ role_catalog: 'analista_de_desarrollo', nombre_visible: 'Analista de Desarrollo', hourly_cost: 9000 }],
    equipo: [{ team_member_id: 1, employee_id: 1, canonical_name: 'X', role_catalog: 'analista_de_desarrollo', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 9000, is_active: 1, cost_center_id: 1 }],
  });
  run('renderEquipoTable()');
  const texto = document.getElementById('cst-equipo-tbody').textContent;
  assert.match(texto, /Analista de Desarrollo/);
  assert.doesNotMatch(texto, /analista_de_desarrollo/);
});

test('renderEquipoTable: sin tarifa muestra "Sin definir", no $0', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    equipo: [{ team_member_id: 1, employee_id: 1, canonical_name: 'X', role_catalog: 'qa', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 0, is_active: 1, cost_center_id: 1 }],
  });
  run('renderEquipoTable()');
  assert.match(document.getElementById('cst-equipo-tbody').textContent, /Sin definir/);
});

// 16 sep 2026, a pedido explicito: los inactivos SE VEN, con su pastilla
// "Inactivo". Antes se ocultaban (tambien a pedido explicito, para que quien
// salio de un proyecto no estorbara), pero eso hacia imposible reactivarlos:
// la persona desaparecia de la tabla y ya no habia donde pulsar "Activar".
test('renderEquipoTable: una asignacion inactiva SIGUE viendose, etiquetada, para poder reactivarla', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    equipo: [
      { team_member_id: 1, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'qa', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 20000, is_active: 0, cost_center_id: 1 },
      { team_member_id: 2, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'desarrollador', project_name: 'BETA', project_folder: 'BETA', hourly_cost: 25000, is_active: 1, cost_center_id: 2 },
    ],
  });
  run('renderEquipoTable()');
  const tbody = document.getElementById('cst-equipo-tbody');

  assert.strictEqual(tbody.querySelectorAll('tr[data-equipo-row]').length, 2, 'se ven las dos: la activa y la inactiva');
  assert.match(tbody.textContent, /Inactivo/, 'la inactiva tiene que decir que lo esta');
  assert.strictEqual(tbody.querySelectorAll('tr.emp-inactive').length, 1, 'y distinguirse a simple vista');

  // Sin el boton de editar no habria por donde reactivarla: la accion vive
  // dentro de ese formulario.
  assert.ok(
    tbody.querySelector('tr.emp-inactive [data-equipo-edit]'),
    'la fila inactiva tiene que seguir siendo editable, que es por donde se reactiva'
  );
});

// El filtro sigue existiendo para ocultarlos si algun dia son demasiados: lo
// que cambio es cual es el defecto, no que la opcion desaparezca.
test('renderEquipoTable: el filtro "Inactivos: Ocultar" vuelve a esconderlos', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    equipo: [
      { team_member_id: 1, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'qa', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 20000, is_active: 0, cost_center_id: 1 },
      { team_member_id: 2, employee_id: 10, canonical_name: 'Alicia Alfa', role_catalog: 'desarrollador', project_name: 'BETA', project_folder: 'BETA', hourly_cost: 25000, is_active: 1, cost_center_id: 2 },
    ],
  });

  document.getElementById('cst-equipo-filtro-inactivos').value = '';
  run('renderEquipoTable()');

  const tbody = document.getElementById('cst-equipo-tbody');
  assert.strictEqual(tbody.querySelectorAll('tr[data-equipo-row]').length, 1, 'solo la activa');
  assert.doesNotMatch(tbody.textContent, /Inactivo/);
});

test('renderEquipoTable: el filtro de la tabla (cst-equipo-filtro-*) es independiente del formulario de alta (cst-equipo-*)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    equipo: [
      { team_member_id: 1, employee_id: 1, canonical_name: 'Alicia Alfa', role_catalog: 'desarrollador', project_name: 'ALFA', project_folder: 'ALFA', hourly_cost: 20000, is_active: 1, cost_center_id: 1 },
      { team_member_id: 2, employee_id: 2, canonical_name: 'Bruno Beta', role_catalog: 'analista', project_name: 'BETA', project_folder: 'BETA', hourly_cost: 25000, is_active: 1, cost_center_id: 2 },
    ],
  });

  // Elegir un centro en el formulario de ALTA ("Agregar al equipo") no
  // debe ocultar de la tabla a quien no sea de ese centro -- ese fue
  // justo el bug reportado: antes el mismo select hacia doble funcion.
  document.getElementById('cst-equipo-centro').value = '1';
  run('renderEquipoTable()');
  assert.strictEqual(
    document.getElementById('cst-equipo-tbody').querySelectorAll('tr[data-equipo-row]').length, 2,
    'elegir un centro en el formulario de alta NO deberia filtrar la tabla'
  );

  // El select de FILTRO si debe filtrar (agrega la opcion a mano: en la
  // app real la llena populateEquipoGastoCentroSelect() desde state.centros,
  // que aqui no hace falta montar completo para esta prueba puntual).
  const filtroCentro = document.getElementById('cst-equipo-filtro-centro');
  filtroCentro.innerHTML += '<option value="1">ALFA</option>';
  filtroCentro.value = '1';
  run('renderEquipoTable()');
  const tbody = document.getElementById('cst-equipo-tbody');
  assert.strictEqual(tbody.querySelectorAll('tr[data-equipo-row]').length, 1, 'el select de filtro si deberia acotar la tabla');
  assert.match(tbody.textContent, /Alicia Alfa/);
  assert.doesNotMatch(tbody.textContent, /Bruno Beta/);
});

// ---------------------------------------------------------------
// renderComparativo (costeo-indicadores.js) — Panel Comparativo
// ---------------------------------------------------------------

test('renderComparativo: sin semanas con datos muestra el mensaje vacio, no una tabla rota', () => {
  const { document, run, setState } = montarCosteo();
  setState({ portafolio17: { project_name: 'Todos', serie_semanal: [] }, indicadores17: [] });
  run('renderComparativo()');
  assert.match(document.getElementById('cst-comp-tbody').textContent, /Sin semanas con datos/);
});

test('renderComparativo: pinta una fila por semana y calcula el % de variacion contra la semana anterior', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    portafolio17: {
      project_name: 'Todos',
      serie_semanal: [
        { year: 2026, month: 8, week: 1, costo_laboral: 1000000, horas_extra: 2 },
        { year: 2026, month: 8, week: 2, costo_laboral: 1500000, horas_extra: 0 },
      ],
    },
    indicadores17: [],
  });
  run('renderComparativo()');
  const tbody = document.getElementById('cst-comp-tbody');
  const filas = tbody.querySelectorAll('tr');
  assert.strictEqual(filas.length, 2, 'una fila por semana de la serie');
  assert.match(filas[0].textContent, /—/, 'la primera semana no tiene semana anterior con la que compararse');
  assert.match(filas[1].textContent, /\+50\.0%/, '(1.500.000 - 1.000.000) \\/ 1.000.000 = +50%');
  assert.match(tbody.textContent, /Agosto · Semana 2/, 'la fila trae el mes ademas de la semana (bug weekKey, 17 sep 2026)');

  // Las 3 tarjetas resumen + los 2 gráficos SVG que se agregaron para que
  // el panel no fuera solo una tabla (a pedido explícito).
  const kpis = document.getElementById('cst-comp-kpis');
  assert.strictEqual(kpis.querySelectorAll('.cst-comp-kpi').length, 3, 'promedio, semana con mayor costo, tendencia');
  assert.match(kpis.textContent, /\+50\.0%/, 'la tendencia primera-vs-ultima semana tambien es +50%');

  const svgLinea = document.getElementById('cst-comp-svg-linea');
  const svgBarras = document.getElementById('cst-comp-svg-barras');
  assert.strictEqual(svgLinea.querySelectorAll('svg').length, 1);
  assert.strictEqual(svgBarras.querySelectorAll('svg').length, 1);

  // La grilla + eje + etiquetas de valor son lo que se agregó para que el
  // gráfico no se viera "pelado" (a pedido explícito) — se comprueba que
  // de verdad esté ahí, no solo que exista un <svg> vacío.
  assert.ok(svgLinea.querySelectorAll('line').length >= 5, 'grilla horizontal (4 divisiones) + linea base');
  assert.match(svgLinea.textContent, /\$1\.5M|\$1\.0M/, 'etiquetas del eje en formato compacto');
  assert.match(svgLinea.textContent, /\$ 1\.500\.000|\$ 1\.000\.000/, 'las etiquetas de cada punto muestran el peso completo');

  assert.ok(svgBarras.querySelectorAll('line').length >= 5, 'grilla horizontal + linea base');
  assert.ok(svgBarras.querySelectorAll('rect').length === 2, 'una barra por semana de la serie');
});

test('svgLinea: la etiqueta del primer y ultimo punto ancla hacia adentro, no queda cortada ni encimada con el eje', () => {
  // Regresion de un caso real reportado: con text-anchor="middle" en todos
  // los puntos, la etiqueta del primero se encimaba con los numeros del eje
  // Y (ambos viven cerca de x=padI) y la del ultimo quedaba cortada por el
  // borde derecho del SVG.
  const { document, run, setState } = montarCosteo();
  setState({
    portafolio17: {
      project_name: 'Todos',
      serie_semanal: [
        { year: 2026, month: 8, week: 1, costo_laboral: 2691320, horas_extra: 0 },
        { year: 2026, month: 8, week: 2, costo_laboral: 3305640, horas_extra: 14.3 },
        { year: 2026, month: 8, week: 3, costo_laboral: 2811620, horas_extra: 0.5 },
        { year: 2026, month: 8, week: 4, costo_laboral: 1302880, horas_extra: 0 },
      ],
    },
    indicadores17: [],
  });
  run('renderComparativo()');
  const textos = [...document.getElementById('cst-comp-svg-linea').querySelectorAll('text')];
  const primero = textos.find((t) => t.textContent.includes('2.691.320'));
  const ultimo = textos.find((t) => t.textContent.includes('1.302.880'));
  assert.ok(primero, 'deberia existir la etiqueta del primer punto');
  assert.ok(ultimo, 'deberia existir la etiqueta del ultimo punto');
  assert.strictEqual(primero.getAttribute('text-anchor'), 'start', 'el primero ancla a la derecha de su x (se aleja del eje Y)');
  assert.strictEqual(ultimo.getAttribute('text-anchor'), 'end', 'el ultimo ancla a la izquierda de su x (se aleja del borde derecho)');
});

test('renderComparativo: respeta el Centro de Costos elegido en el filtro global', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    portafolio17: { project_name: 'Todos', serie_semanal: [{ year: 2026, month: 7, week: 1, costo_laboral: 999, horas_extra: 0 }] },
    indicadores17: [
      { cost_center_id: 7, project_name: 'Proyecto Filtrado', serie_semanal: [{ year: 2026, month: 8, week: 3, costo_laboral: 500000, horas_extra: 1.5 }] },
    ],
  });
  document.getElementById('cst-f-centro').innerHTML = '<option value="7">Proyecto Filtrado</option>';
  document.getElementById('cst-f-centro').value = '7';
  run('renderComparativo()');
  const texto = document.getElementById('cst-comp-tbody').textContent;
  assert.match(texto, /Semana 3/, 'deberia mostrar la serie del centro filtrado, no la del portafolio');
  assert.doesNotMatch(texto, /Semana 1/);
});

// ---------------------------------------------------------------
// renderGraficos (costeo-indicadores.js) — Gráficos
// ---------------------------------------------------------------

// jsdom no ejecuta el <script> de ECharts (es un CDN externo, ver
// montarCosteo): renderGraficos() debe armar igual las tarjetas del
// grid y solo saltarse el setOption() de cada chart. Así se prueba el
// armado del grid sin depender de que ECharts esté disponible.
//
// #10, #12-#17 y "Dependencia de una Sola Persona" (bus factor) se
// retiraron de INDICATOR_DEFS (ago-sep 2026, sin dato real o a pedido
// directo) — IND17_COMPLETO conserva sus campos porque el backend los
// sigue calculando, solo ya no se muestran. Los que quedan se
// renumeraron 1..8 sin huecos.
const IND17_COMPLETO = {
  cost_center_id: 1, project_name: 'Proyecto Test',
  ind1_presupuesto_ejecutado_pct: 62.4, ind2_tiempo_transcurrido_pct: 40,
  ind3_ritmo_gasto_vs_tiempo: 22.4, ind4_fecha_quiebre_presupuestal: '2026-12-01',
  ind4_se_queda_sin_plata_antes: false, ind5_ritmo_gasto_semanal: 2500000,
  ind6_bus_factor_pct: 55.5, ind6_bus_factor_employee_id: 10, ind6_bus_factor_employee_name: 'Alicia Alfa',
  ind7_personas_trabajando: 6, ind8_costo_real_por_hora: 18000,
  ind9_proporcion_horas_extra_pct: 8.5, ind10_aprobacion_horas_extra_pct: 90,
  ind11_trabajo_no_remunerado: 150000, ind12_costo_errores_pct: 3.2,
  ind13_responsable_sobrecosto_interno_pct: 60, ind14_gasto_no_predecible_pct: 12,
  ind15_gasto_mas_grande: { descripcion: 'Licencia anual', valor: 900000 },
  ind16_variacion_semanal_pct: -5.3, ind17_racha_semanas_horas_extra: 2,
  serie_semanal: [{ year: 2026, month: 8, week: 1, costo_laboral: 1000000, horas_extra: 2 }],
};

test('renderComparativo: una serie SIN month (datos viejos/cache) cae a la etiqueta sin mes, no se rompe', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    portafolio17: { project_name: 'Todos', serie_semanal: [{ year: 2026, week: 5, costo_laboral: 900000, horas_extra: 1 }] },
    indicadores17: [],
  });
  run('renderComparativo()');
  assert.match(document.getElementById('cst-comp-tbody').textContent, /Semana 5/, 'sin month aun muestra "Semana N", igual que antes del fix');
});

test('renderGraficos: arma una tarjeta por cada uno de los indicadores que quedan', () => {
  const { document, run, setState } = montarCosteo();
  setState({ portafolio17: IND17_COMPLETO, indicadores17: [] });
  run('renderGraficos()');
  const grid = document.getElementById('cst-graf-grid');
  assert.strictEqual(grid.querySelectorAll('.cst-graf-ind-card').length, 8, 'debe haber una tarjeta por indicador');
});

test('renderGraficos: 4 velocimetros, 3 barras comparativas entre proyectos, 1 tarjeta de dato (fecha de quiebre)', () => {
  const { document, run, setState } = montarCosteo();
  setState({ portafolio17: IND17_COMPLETO, indicadores17: [] });
  run('renderGraficos()');
  const grid = document.getElementById('cst-graf-grid');
  assert.strictEqual(grid.querySelectorAll('.cst-gauge-donut').length, 4, '#1,2,3,8');
  assert.strictEqual(grid.querySelectorAll('.cst-graf-barras-proyectos').length, 3, '#5,6,7');
  assert.strictEqual(grid.querySelectorAll('.cst-graf-ind-stat').length, 1, '#4 (fecha de quiebre) no es comparable en barra');
});

test('renderGraficos: la barra comparativa entre proyectos resalta el Centro de Costos elegido en el filtro global', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    portafolio17: IND17_COMPLETO,
    indicadores17: [
      { cost_center_id: 1, project_name: 'Alfa', ind7_personas_trabajando: 4 },
      { cost_center_id: 2, project_name: 'Beta', ind7_personas_trabajando: 9 },
    ],
  });
  document.getElementById('cst-f-centro').innerHTML = '<option value="2">Beta</option>';
  document.getElementById('cst-f-centro').value = '2';
  run('renderGraficos()');
  const filas = document.getElementById('cst-graf-grid').querySelectorAll('.cst-graf-barra-fila');
  assert.strictEqual(filas.length, 6, '3 indicadores (#5,6,7) x 2 proyectos (Alfa, Beta) = 6 filas');
  const destacadas = document.getElementById('cst-graf-grid').querySelectorAll('.cst-graf-barra-fila.is-destacado');
  assert.ok(destacadas.length > 0, 'al menos una fila deberia quedar resaltada');
  destacadas.forEach((f) => assert.match(f.textContent, /Beta/, 'la fila resaltada debe ser la del centro elegido (Beta)'));
});

test('renderGraficos: sin centros todavia muestra el mensaje vacio, no un grid roto', () => {
  const { document, run, setState } = montarCosteo();
  setState({ portafolio17: null, indicadores17: [] });
  run('renderGraficos()');
  assert.match(document.getElementById('cst-graf-grid').textContent, /Sin centros de costos/);
});

// ---------------------------------------------------------------
// renderAccesosTable (costeo-accesos.js)
// ---------------------------------------------------------------

test('renderAccesosTable: nunca imprime la contraseña, siempre puntos', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    accesos: [{ user_id: 1, full_name: 'Ana', username: 'ana', email: 'ana@x.test', is_active: 1, proyectos: [], password: 'esto-no-deberia-salir' }],
  });
  run('renderAccesosTable()');
  const texto = document.getElementById('cst-accesos-tbody').textContent;
  assert.match(texto, /••••••••/);
  assert.doesNotMatch(texto, /esto-no-deberia-salir/, 'se filtro un campo de contraseña');
});

test('renderAccesosTable: sin proyectos asignados lo dice explicitamente', () => {
  const { document, run, setState } = montarCosteo();
  setState({ accesos: [{ user_id: 1, full_name: 'Ana', username: null, email: 'a@x.test', is_active: 1, proyectos: [] }] });
  run('renderAccesosTable()');
  assert.match(document.getElementById('cst-accesos-tbody').textContent, /Sin asignar/);
});

test('renderAccesosTable: escapa un nombre malicioso en full_name', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    accesos: [{ user_id: 1, full_name: '<img src=x onerror=alert(1)>', username: 'x', email: 'a@x.test', is_active: 1, proyectos: [] }],
  });
  run('renderAccesosTable()');
  const tbody = document.getElementById('cst-accesos-tbody');
  assert.strictEqual(tbody.querySelectorAll('img').length, 0);
});

// ---------------------------------------------------------------
// renderOvertimeTable (costeo-overtime.js)
// ---------------------------------------------------------------

// Sin paso de aprobación ni acciones en esta tabla (31 ago 2026, a pedido
// explícito): solo se listan las horas extra ya aprobadas (pm_decision
// 'si'), todas con la misma pill verde de "Aprobado" — mismo color que ya
// usa el resto del sistema (.cst-gasto-estado.estado-aprobado).
test('renderOvertimeTable: solo muestra filas aprobadas (pm_decision "si")', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [
      { decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Aprobada', project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000, pm_decision: 'si' },
      { decision_id: 2, employee_id: 2, cost_center_id: 1, canonical_name: 'Pendiente', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'pendiente' },
      { decision_id: 3, employee_id: 3, cost_center_id: 1, canonical_name: 'NoPaga', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'no' },
    ],
  });
  run('renderOvertimeTable()');
  const texto = document.getElementById('cst-overtime-tbody').textContent;
  assert.match(texto, /Aprobada/, 'la fila aprobada deberia verse');
  assert.doesNotMatch(texto, /Pendiente/, 'una fila sin decidir no deberia verse en esta tabla');
  assert.doesNotMatch(texto, /NoPaga/, 'una fila que el PM decidio no pagar no deberia verse en esta tabla');
});

// Las columnas "Decisión PM" y "Aprobación" se quitaron el 4 sep 2026, a
// pedido explícito: no hay flujo de aprobación — toda hora extra registrada
// desde la plataforma queda aprobada en el acto, así que las dos mostraban
// siempre el mismo valor. Esta prueba fija que no vuelvan a aparecer.
test('renderOvertimeTable: no muestra columnas de decisión ni de aprobación', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si',
    }],
  });
  run('renderOvertimeTable()');
  const tbody = document.getElementById('cst-overtime-tbody');
  assert.strictEqual(tbody.querySelectorAll('.cst-gasto-estado').length, 0, 'ya no va la pill de "Aprobado"');
  assert.doesNotMatch(tbody.textContent, /Sí paga|No paga|Pendiente/, 'ya no va la columna de decisión del PM');
});

test('renderOvertimeTable: no hay columna ni botones de Acciones', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'leader' },
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si',
    }],
  });
  run('renderOvertimeTable()');
  const fila = document.querySelector('#cst-overtime-tbody tr');
  // 7 columnas: Talento, Proyecto, Semana, Fecha y turno, Tipo de hora,
  // Extra y Costo. Sin Acciones, y sin Decisión PM / Aprobación (4 sep 2026).
  assert.strictEqual(fila.children.length, 7, 'deberian ser 7 columnas: sin Acciones');
  assert.strictEqual(document.querySelectorAll('[data-overtime-decide], [data-overtime-approve], [data-overtime-edit], [data-overtime-delete]').length, 0);
});

test('renderOvertimeTable: el CEO/admin ve la columna Acciones con botón Eliminar (17 sep 2026)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'admin' },
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si',
    }],
  });
  run('renderOvertimeTable()');
  const fila = document.querySelector('#cst-overtime-tbody tr');
  assert.strictEqual(fila.children.length, 8, 'el admin debería ver 8 columnas, con Acciones');

  const btn = document.querySelector('[data-overtime-delete="1"]');
  assert.ok(btn, 'el admin debería ver el botón Eliminar');
  assert.strictEqual(btn.textContent, 'Eliminar');
  assert.strictEqual(document.getElementById('cst-overtime-th-acciones').textContent, 'Acciones');
  assert.strictEqual(document.querySelectorAll('#cst-overtime-table thead th').length, 8);

  // Al pasar a leader la cabecera y los botones desaparecen del DOM (no
  // quedan ocultos): filas y cabecera siguen descuadrando la tabla igual.
  setState({ user: { role: 'leader' } });
  run('renderOvertimeTable()');
  assert.strictEqual(document.querySelectorAll('#cst-overtime-table thead th').length, 7, 'sin Acciones para un líder');
  assert.strictEqual(document.querySelector('[data-overtime-delete]'), null, 'sin botón Eliminar para un líder');
  assert.strictEqual(document.getElementById('cst-overtime-th-acciones'), null, 'la cabecera Acciones no debería existir para un líder');
});

test('renderOvertimeTable: el mensaje de tabla vacía ajusta su colspan según el rol', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, overtime: [] });
  run('renderOvertimeTable()');
  let celda = document.querySelector('#cst-overtime-tbody td');
  assert.strictEqual(celda.colSpan, 8, 'el CEO con tabla vacía debe cubrir 8 columnas');

  setState({ user: { role: 'leader' }, overtime: [] });
  run('renderOvertimeTable()');
  celda = document.querySelector('#cst-overtime-tbody td');
  assert.strictEqual(celda.colSpan, 7, 'el líder con tabla vacía debe cubrir 7 columnas');
});

// El recorte por persona lo hace el filtro de Talento de la tabla
// (cst-overtime-filtro-talento, 11 sep 2026); el de Proyecto sigue viniendo
// del encabezado. Los dos se combinan.
test('renderOvertimeTable: el Proyecto del encabezado y el Talento de la tabla se combinan', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [
      { decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
      { decision_id: 2, employee_id: 2, cost_center_id: 1, canonical_name: 'Arturo', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
    ],
  });
  document.getElementById('cst-f-centro').innerHTML = '<option value="1">ALFA</option>';
  document.getElementById('cst-f-centro').value = '1';
  run('populateOvertimeTalentoFilter()');
  document.getElementById('cst-overtime-filtro-talento').value = '1';

  run('renderOvertimeTable()');
  const texto = document.getElementById('cst-overtime-tbody').textContent;
  assert.match(texto, /Alicia/);
  assert.doesNotMatch(texto, /Arturo/, 'el filtro combinado de proyecto+talento no se aplico');
});

// El Recurso global ya no se ve en Horas Extra: si la tabla siguiera
// leyendolo, un valor dejado en otra pantalla la recortaria sin que nada
// visible en esta lo explique.
test('renderOvertimeTable: ignora el Recurso global (ya no se muestra en esta pantalla)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [
      { decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
      { decision_id: 2, employee_id: 2, cost_center_id: 1, canonical_name: 'Arturo', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
    ],
  });
  document.getElementById('cst-f-recurso').innerHTML = '<option value="1">Alicia</option>';
  document.getElementById('cst-f-recurso').value = '1';

  run('renderOvertimeTable()');
  const texto = document.getElementById('cst-overtime-tbody').textContent;
  assert.match(texto, /Alicia/);
  assert.match(texto, /Arturo/, 'el Recurso global no deberia recortar esta tabla');
});

// Las opciones salen de las horas extra que existen, no del equipo completo:
// ofrecer a alguien sin ningun turno solo lleva a una tabla vacia.
test('populateOvertimeTalentoFilter: solo lista a quien tiene horas extra en el proyecto elegido', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [
      { decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
      { decision_id: 2, employee_id: 2, cost_center_id: 2, canonical_name: 'Arturo', project_name: 'BETA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
      { decision_id: 3, employee_id: 3, cost_center_id: 1, canonical_name: 'Bruno', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'no' },
    ],
  });
  document.getElementById('cst-f-centro').innerHTML = '<option value="1">ALFA</option>';
  document.getElementById('cst-f-centro').value = '1';

  run('populateOvertimeTalentoFilter()');
  const opciones = [...document.getElementById('cst-overtime-filtro-talento').options].map((o) => o.textContent);
  assert.deepStrictEqual(opciones, ['Todos', 'Alicia'], 'Arturo es de otro proyecto y Bruno no tiene hora aprobada');
});

// Si la persona elegida desaparece de las opciones (cambio de proyecto), el
// filtro no puede quedarse recortando por alguien que ya no esta en la lista.
test('populateOvertimeTalentoFilter: conserva la seleccion si sigue disponible, y vuelve a "Todos" si no', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [
      { decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia', project_name: 'ALFA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
      { decision_id: 2, employee_id: 2, cost_center_id: 2, canonical_name: 'Arturo', project_name: 'BETA', week_number: 1, extra_hours: 1, extra_cost_potential: 1, pm_decision: 'si' },
    ],
  });
  const filtro = document.getElementById('cst-overtime-filtro-talento');
  const centro = document.getElementById('cst-f-centro');
  centro.innerHTML = '<option value="">Todos</option><option value="1">ALFA</option><option value="2">BETA</option>';

  run('populateOvertimeTalentoFilter()');
  filtro.value = '1';

  centro.value = '1';
  run('populateOvertimeTalentoFilter()');
  assert.strictEqual(filtro.value, '1', 'Alicia sigue teniendo horas extra en ALFA');

  centro.value = '2';
  run('populateOvertimeTalentoFilter()');
  assert.strictEqual(filtro.value, '', 'Alicia no tiene horas en BETA: el filtro vuelve a Todos');
});

test('renderOvertimeTable: sin filas aprobadas muestra el mensaje vacio con colspan correcto', () => {
  const { document, run, setState } = montarCosteo();
  setState({ overtime: [] });
  run('renderOvertimeTable()');
  const celda = document.querySelector('#cst-overtime-tbody td');
  assert.match(document.getElementById('cst-overtime-tbody').textContent, /Sin horas extra registradas/);
  assert.strictEqual(celda.getAttribute('colspan'), '7', '7 columnas desde que se quitaron Decisión PM y Aprobación');
});

// Fecha/turno y tipo de hora (2 sep 2026, a pedido explicito): las trae
// listOvertimeDecisions ya calculadas (desglose_turno), el front solo pinta.
test('renderOvertimeTable: con fecha/turno y desglose, pinta la fecha, el rango de horas y los badges', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si', fecha: '2026-08-10', hora_inicio: '22:00:00', hora_fin: '23:00:00',
      desglose_turno: [{ categoria: 'Nocturno festivo', horas: 1 }],
    }],
  });
  run('renderOvertimeTable()');
  const fila = document.getElementById('cst-overtime-tbody');
  assert.match(fila.textContent, /22:00.*23:00/s, 'deberia mostrar el rango de horas');
  const badge = fila.querySelector('.cst-overtime-tipo-badge');
  assert.ok(badge, 'deberia pintar un badge de tipo de hora');
  assert.match(badge.textContent, /Nocturno festivo/);
  assert.ok(badge.classList.contains('cat-nocturno-festivo'));
});

test('renderOvertimeTable: sin fecha (fila vieja, de antes del alta manual unica), muestra guion en vez de romper', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si', fecha: null, hora_inicio: null, hora_fin: null, desglose_turno: null,
    }],
  });
  run('renderOvertimeTable()');
  const celdas = [...document.querySelectorAll('#cst-overtime-tbody td')];
  // columnas: 0 talento, 1 proyecto, 2 semana, 3 fecha/turno, 4 tipo de hora
  assert.strictEqual(celdas[3].textContent.trim(), '—');
  assert.strictEqual(celdas[4].textContent.trim(), '—');
});

test('formatTipoHoraHTML: la etiqueta "fin de semana" lleva un title explicando que no hay recargo', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    overtime: [{
      decision_id: 1, employee_id: 1, cost_center_id: 1, canonical_name: 'Alicia',
      project_name: 'ALFA', week_number: 2, extra_hours: 4, extra_cost_potential: 80000,
      pm_decision: 'si', fecha: '2026-08-08', hora_inicio: '14:00:00', hora_fin: '18:00:00',
      desglose_turno: [{ categoria: 'Diurno fin de semana', horas: 4 }],
    }],
  });
  run('renderOvertimeTable()');
  const badge = document.querySelector('.cst-overtime-tipo-badge.cat-diurno-finde');
  assert.ok(badge);
  assert.match(badge.getAttribute('title') || '', /se paga igual que un día hábil/);
});

// Mini-historial del modal de alta (17 sep 2026, a pedido explícito): al
// registrar varias horas extra seguidas sin cerrar el modal, cada alta entra
// a overtimeRegistradosSesion y se pinta con su Eliminar.
test('registrarEnSesion: agrega la fila al mini-historial con su botón Eliminar y oculta la sección al quedar vacía', () => {
  const { document, run } = montarCosteo();
  const seccion = document.getElementById('cst-overtime-sesion');
  assert.ok(seccion, 'el modal real trae el mini-historial');
  assert.strictEqual(seccion.hidden, true, 'la sección arranca oculta');

  run(`registrarEnSesion({ decision_id: 77, talento: '<b>Alicia</b>', centro: 'ALFA', turno: '2026-08-29 18:00 → 21:00', horas: 3, estado: 'aprobada' })`);
  assert.strictEqual(seccion.hidden, false, 'con filas la sección debe verse');

  const item = seccion.querySelector('.cst-overtime-sesion-item');
  assert.ok(item, 'debe pintar una fila por registro');
  assert.strictEqual(item.querySelectorAll('b').length, 0, 'el nombre va escapado');
  assert.match(item.textContent, /<b>Alicia<\/b>/);
  assert.match(item.textContent, /ALFA/);
  assert.match(item.textContent, /3\.00 h/);
  assert.ok(item.querySelector('[data-overtime-sesion-delete="77"]'), 'botón Eliminar con el decision_id');

  run('overtimeRegistradosSesion.length = 0; renderOvertimeSesion()');
  assert.strictEqual(seccion.hidden, true, 'sin filas la sección vuelve a ocultarse');
  assert.strictEqual(seccion.querySelectorAll('.cst-overtime-sesion-item').length, 0);
});

// ---------------------------------------------------------------
// renderHistorialTable (costeo-overtime.js)
// ---------------------------------------------------------------

test('renderHistorialTable: escapa la descripcion (texto libre escrito por usuarios)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    historial: [{
      log_id: 1, created_at: '2026-08-20 10:00:00', user_name: 'Ana',
      project_name: 'ALFA', entity_type: 'gasto', action: 'crear',
      description: 'Registró gasto "<img src=x onerror=alert(1)>"',
    }],
  });
  run('renderHistorialTable()');
  const tbody = document.getElementById('cst-historial-tbody');
  assert.strictEqual(tbody.querySelectorAll('img').length, 0);
  assert.match(tbody.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('renderHistorialTable: sin user_name muestra "Sistema" (accion automatica)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    historial: [{ log_id: 1, created_at: '2026-08-20 10:00:00', user_name: null, project_name: null, entity_type: 'centro_costo', action: 'crear', description: 'x' }],
  });
  run('renderHistorialTable()');
  assert.match(document.getElementById('cst-historial-tbody').textContent, /Sistema/);
});

// El ENUM de entity_type completo (sql/18 + sql/22 + sql/27) tiene que
// tener texto legible — si falta un tipo aquí, la columna "Tipo" muestra
// el slug crudo de la base ("plan_recursos") en vez de "Plan de Recursos".
test('renderHistorialTable: plan_recursos, tarifa_cargo y acceso se traducen, no quedan como slug crudo', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    historial: [
      { log_id: 1, created_at: '2026-08-20 10:00:00', user_name: 'Ana', project_name: 'ALFA', entity_type: 'plan_recursos', action: 'editar', description: 'x' },
      { log_id: 2, created_at: '2026-08-20 10:00:00', user_name: 'Ana', project_name: null, entity_type: 'tarifa_cargo', action: 'editar', description: 'x' },
      { log_id: 3, created_at: '2026-08-20 10:00:00', user_name: 'Ana', project_name: null, entity_type: 'acceso', action: 'editar', description: 'x' },
      { log_id: 4, created_at: '2026-08-20 10:00:00', user_name: 'Ana', project_name: null, entity_type: 'config', action: 'editar', description: 'x' },
      { log_id: 5, created_at: '2026-08-20 10:00:00', user_name: 'Ana', project_name: 'ALFA', entity_type: 'snapshot', action: 'crear', description: 'x' },
    ],
  });
  run('renderHistorialTable()');
  const texto = document.getElementById('cst-historial-tbody').textContent;
  assert.match(texto, /Plan de Recursos/);
  assert.match(texto, /Catálogo de Cargos/);
  assert.match(texto, /Acceso/);
  assert.match(texto, /Configuración/);
  assert.match(texto, /Snapshot/);
  assert.doesNotMatch(texto, /plan_recursos|tarifa_cargo\b/);
});

// ---------------------------------------------------------------
// renderAlertasGrid (costeo-alertas.js)
// ---------------------------------------------------------------

test('renderAlertasGrid: escapa el detalle de la alerta (puede incluir texto de un gasto)', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    alertas: [{
      tipo: 'Gasto atípico registrado', severidad: 'alta', categoria: 'Costo No Planeado',
      detalle: '"<img src=x onerror=alert(1)>" representa 10% del presupuesto',
      project_name: 'ALFA', cost_center_id: 1,
    }],
  });
  run('renderAlertasGrid()');
  const grid = document.getElementById('cst-alertas-grid');
  assert.strictEqual(grid.querySelectorAll('img').length, 0);
});

// ---------------------------------------------------------------
// renderTarifasCargoTable (costeo-equipo.js)
// ---------------------------------------------------------------

// La tarifa estándar por cargo se quitó (28 ago 2026, a pedido explícito):
// cada persona ya cobra distinto, así que un valor "estándar" no aportaba.
// La pantalla solo es un catálogo de nombres: Cargo, Personas, Última
// edición y Eliminar — nada de costo/hora ni "Definir tarifa".
test('renderTarifasCargoTable: solo Cargo, Personas, Última edición y Eliminar — sin tarifa ni "Definir tarifa"', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    tarifasCargo: [
      { role_catalog: 'qa', nombre_visible: 'QA', personas: 3, updated_at: '2026-08-20 10:00:00', updated_by_name: 'Ana' },
    ],
  });
  run('renderTarifasCargoTable()');
  const tbody = document.getElementById('cst-tarifas-cargo-tbody');
  assert.match(tbody.textContent, /QA/);
  assert.match(tbody.textContent, /3 personas/);
  // Formato unico de fecha desde el 4 sep 2026 (formatFecha en
  // costeo-core.js): "20 ago 2026", no el ISO crudo que se veia antes.
  assert.match(tbody.textContent, /20 ago 2026/);
  assert.strictEqual(tbody.querySelectorAll('[data-tc-editar]').length, 0, 'ya no deberia existir "Definir tarifa"');
  assert.strictEqual(tbody.querySelectorAll('[data-tc-eliminar]').length, 1);
  assert.doesNotMatch(tbody.textContent, /\$/, 'no deberia mostrar ningun monto');
});

test('renderTarifasCargoTable: sin "Última edición" todavia (cargo recien migrado) muestra "—", no vacio', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    tarifasCargo: [{ role_catalog: 'qa', nombre_visible: 'QA', personas: 0, updated_at: null, updated_by_name: null }],
  });
  run('renderTarifasCargoTable()');
  assert.match(document.getElementById('cst-tarifas-cargo-tbody').textContent, /—/);
});

// ---------------------------------------------------------------
// aplicarVisibilidadFiltros / filtrosQuery (costeo-indicadores.js)
//
// Qué filtro global (Centro de Costos / Recurso / Periodo) tiene sentido
// en cada panel — depende de qué datos consume esa pantalla, NO del rol
// (28 ago 2026, a pedido explícito: antes solo se ocultaban para admin/
// ceo, y un PM veía los 3 en TODAS partes, incluido Comercial — que lista
// PROYECTOS, no personas, así que Recurso ahí no tiene sentido).
// ---------------------------------------------------------------

function filtroHidden(document, wrapId) {
  return document.getElementById(wrapId).hidden;
}

// Indicadores (28 ago 2026, a pedido explícito): Recurso sale de acá
// también. La mayoría de los 13 indicadores pierde el sentido recortado a
// una sola persona ("Personas Trabajando" siempre daría 1, "Dependencia de
// una Sola Persona" siempre 100%).
test('aplicarVisibilidadFiltros: Indicadores oculta Recurso (deja de tener sentido para casi todo el panel) pero conserva Centro y Periodo', () => {
  const { document, run } = montarCosteo();
  run('aplicarVisibilidadFiltros(\'indicadores\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false);
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true);
  assert.strictEqual(filtroHidden(document, 'cst-filter-periodo-wrap'), false);
});

// Alertas (8 sep 2026, a pedido explícito): Recurso también sale de acá —
// mismo criterio que ya se le había aplicado a Indicadores el 28 ago 2026.
// Antes se conservaba a propósito (había alertas puntuales de una persona,
// como "sin costo/hora registrado"), pero se decidió sacarlo igual. Periodo
// salió después (11 sep 2026, también a pedido explícito): una alerta abierta
// lo está hoy, no "en Agosto" — recortarla por mes escondía avisos vigentes.
test('aplicarVisibilidadFiltros: Alertas oculta Recurso y Periodo, y deja el Proyecto del encabezado', () => {
  const { document, run } = montarCosteo();
  run('aplicarVisibilidadFiltros(\'alertas\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false);
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true);
  assert.strictEqual(filtroHidden(document, 'cst-filter-periodo-wrap'), true);
});

// Comercial: Recurso salió el 28 ago 2026 y Periodo el 7 sep 2026, los dos
// a pedido explícito — con el selector de Proyecto ya alcanza para mirar un
// proyecto puntual. El de Proyecto sí se ve: desde el 10 sep 2026 vive en
// el encabezado y este panel dejó de tener el suyo propio.
test('aplicarVisibilidadFiltros: Comercial oculta Recurso y Periodo, y deja el Proyecto del encabezado', () => {
  const { document, run } = montarCosteo();
  run('aplicarVisibilidadFiltros(\'comercial\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false);
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true);
  assert.strictEqual(filtroHidden(document, 'cst-filter-periodo-wrap'), true);
});

test('aplicarVisibilidadFiltros: al ocultar Recurso, tambien limpia su valor (no se cuela en la siguiente carga)', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-recurso').innerHTML = '<option value="7">Alicia</option>';
  document.getElementById('cst-f-recurso').value = '7';

  run('aplicarVisibilidadFiltros(\'comercial\')');

  assert.strictEqual(document.getElementById('cst-f-recurso').value, '', 'Recurso deberia limpiarse al ocultarse');
});

// El selector de Proyecto es el de "qué proyecto estoy mirando" y persiste
// por toda la app: ni se oculta ni se limpia al cambiar de pantalla. Antes
// se ocultaba en varias (y ya entonces conservaba su valor); desde el 10
// sep 2026 vive en el encabezado y se ve siempre.
test('aplicarVisibilidadFiltros: el Proyecto del encabezado se ve en TODAS las pantallas y conserva su valor', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-centro').innerHTML = '<option value="1">ALFA</option>';
  document.getElementById('cst-f-centro').value = '1';

  for (const panel of ['indicadores', 'alertas', 'centro-costos', 'comercial']) {
    run(`aplicarVisibilidadFiltros('${panel}')`);
    assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false, `${panel} no deberia ocultar Proyecto`);
  }

  // Incluso en una sub-pestaña que no usa ninguno de los otros filtros.
  run('subtabActivo = \'historial\'');
  run('aplicarVisibilidadFiltros(\'equipo-gastos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false);
  assert.strictEqual(document.getElementById('cst-f-centro').value, '1', 'Proyecto no deberia perder su valor');
});

// El "mostrando N registro(s)" se quito el 10 sep 2026 y con el la barra se
// quedaba como una franja blanca vacia debajo del encabezado. Hoy no le
// queda NINGUN control a la vista: Recurso, el unico que sigue dentro, esta
// oculto en todas las pantallas, y Periodo se mudo al panel de Indicadores
// el 11 sep 2026. Asi que la barra tiene que estar escondida siempre — si
// alguna vez vuelve a verse, es una franja blanca vacia.
test('aplicarVisibilidadFiltros: la barra global queda escondida en todas las pantallas', () => {
  const { document, run } = montarCosteo();
  const barra = document.querySelector('.cst-filters');

  for (const panel of ['indicadores', 'alertas', 'centro-costos', 'comercial']) {
    run(`aplicarVisibilidadFiltros('${panel}')`);
    assert.strictEqual(barra.hidden, true, `${panel} no deberia mostrar la barra vacia`);
  }
});

// Periodo se mudo al panel de Indicadores (11 sep 2026), a la misma fila de
// las tres vistas y al lado de "Graficos": es la unica pantalla que lo
// consume. Conserva sus ids para que filtrosQuery() y
// aplicarVisibilidadFiltros() lo sigan encontrando.
test('el filtro de Periodo vive junto a las pestanas de Indicadores, no en la barra global', () => {
  const { document } = montarCosteo();
  const wrap = document.getElementById('cst-filter-periodo-wrap');

  assert.ok(wrap, 'el control tiene que seguir existiendo');
  assert.strictEqual(wrap.closest('.cst-filters'), null, 'ya no cuelga de la barra global');
  assert.ok(wrap.closest('#cst-panel-indicadores'), 'ahora vive en Indicadores');
  assert.ok(document.getElementById('cst-f-periodo'), 'el select conserva su id');

  // Misma fila que Catalogo/Comparativo/Graficos, y FUERA de las tres vistas:
  // recorta los datos de las tres por igual, no solo los del catalogo.
  const fila = wrap.closest('.cst-ind-tabsrow');
  assert.ok(fila, 'deberia compartir fila con las pestanas');
  assert.ok(fila.querySelector('#cst-ind-tabs'), 'esa fila es la de las tres vistas');
  assert.strictEqual(wrap.closest('.cst-ind-view'), null, 'no debe quedar dentro de una sola vista');
});

test('aplicarVisibilidadFiltros: Centro de Costos, listado simple — sin Recurso ni Periodo', () => {
  const { document, run } = montarCosteo();
  run('aplicarVisibilidadFiltros(\'centro-costos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false);
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true);
  assert.strictEqual(filtroHidden(document, 'cst-filter-periodo-wrap'), true);
});

test('aplicarVisibilidadFiltros: "Equipo y Gastos" varia por sub-pestaña activa (subtabActivo), no es un solo bloque', () => {
  const { document, run } = montarCosteo();

  // Equipo del Proyecto: Recurso salio (11 sep 2026, a pedido explicito) —
  // esa tabla trae su propio filtro "Talento" adentro, que hace lo mismo.
  run('subtabActivo = \'equipo-proyecto\'');
  run('aplicarVisibilidadFiltros(\'equipo-gastos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false, 'equipo-proyecto: centro');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'equipo-proyecto: recurso');

  // Horas Extra: Recurso tambien salio (11 sep 2026) — su recorte por persona
  // lo hace ahora cst-overtime-filtro-talento, dentro de la tarjeta.
  run('subtabActivo = \'horas-extra\'');
  run('aplicarVisibilidadFiltros(\'equipo-gastos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'horas-extra: recurso');

  // Costo No Planeado: un gasto es del proyecto, no de una persona.
  run('subtabActivo = \'costo-no-planeado\'');
  run('aplicarVisibilidadFiltros(\'equipo-gastos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false, 'costo-no-planeado: centro');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'costo-no-planeado: recurso');

  // Catálogo de Cargos: catálogo de empresa, Recurso no aplica. Proyecto sí
  // se ve, como en todas partes desde que vive en el encabezado.
  run('subtabActivo = \'tarifas-cargo\'');
  run('aplicarVisibilidadFiltros(\'equipo-gastos\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false, 'tarifas-cargo: centro');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'tarifas-cargo: recurso');
});

test('switchEgSubtab: al cambiar de sub-pestaña desde la barra interna, la visibilidad de filtros se recalcula', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'leader' } });
  run('panelActivo = \'equipo-gastos\'');
  // switchEgSubtab() llama a marcarNavActivo(), que vive en costeo-nav.js —
  // no cargado aquí a propósito (dispara el arranque completo de la app,
  // ver el comentario junto a ARCHIVOS_EN_ORDEN). Se sustituye por un
  // no-op: lo que se prueba aquí es la visibilidad de filtros, no el
  // resaltado del sidebar.
  run('window.marcarNavActivo = function () {}');

  // Hoy las 7 sub-pestanas coinciden (ninguna usa ya Recurso ni Periodo
  // globales: Equipo del Proyecto y Horas Extra, las ultimas dos que los
  // leian, pasaron a su filtro de Talento propio el 11 sep 2026). Lo que se
  // prueba aqui sigue siendo que switchEgSubtab() RECALCULA la visibilidad
  // segun subtabActivo, para que vuelva a partirse solo si alguna difiere.
  run('switchEgSubtab(\'horas-extra\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'horas-extra deberia ocultar Recurso');

  run('switchEgSubtab(\'tarifas-cargo\')');
  assert.strictEqual(filtroHidden(document, 'cst-filter-recurso-wrap'), true, 'tarifas-cargo deberia ocultar Recurso');
  assert.strictEqual(filtroHidden(document, 'cst-filter-centro-wrap'), false, 'Proyecto se ve siempre, tambien aqui');
});

// Los banners de cabecera (titulo + descripcion por sub-pestaña, que salian
// de BANNER_POR_SUBTAB) se eliminaron de todos los paneles el 10 sep 2026 a
// pedido explicito: la pestaña activa ya dice donde estas. Las 3 pruebas que
// verificaban ese texto se fueron con el.
//
// Lo que switchEgSubtab() sigue debiendo hacer, y no estaba cubierto, es
// mostrar UN solo subpanel y marcar su pestaña: si al quitar el banner se
// hubiera roto esa parte, ninguna prueba lo habria visto.
test('switchEgSubtab: muestra solo el subpanel elegido y marca su pestaña', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' } });
  run('panelActivo = \'equipo-gastos\'');
  run('window.marcarNavActivo = function () {}');

  // El spread no sobra: run() devuelve el arreglo del contexto de jsdom, y
  // deepStrictEqual compara prototipos — un Array de otro realm nunca es
  // igual a uno de aquí, aunque el contenido coincida.
  const ids = [...run('EG_SUBPANELES')];

  for (const id of ids) {
    run(`switchEgSubtab('${id}')`);

    const visibles = ids.filter((sid) => !document.getElementById(`cst-subpanel-${sid}`).hidden);
    assert.deepStrictEqual(visibles, [id], `${id} deberia ser el unico subpanel visible`);

    const activas = [...document.querySelectorAll('#cst-tabbar .cst-tab.is-active')]
      .map((b) => b.dataset.subtab);
    assert.deepStrictEqual(activas, [id], `${id} deberia ser la unica pestaña marcada`);
  }
});

// ---------------------------------------------------------------
// Comercial: la pantalla compara COSTO ESTIMADO contra PRESUPUESTO y nada
// mas (11 sep 2026). El valor de contrato es una funcion que todavia no
// entra al sistema: el backend lo sigue calculando, pero aqui no se pinta ni
// decide nada.
// ---------------------------------------------------------------

const proyectoComercial = (extra) => ({
  cost_center_id: 1, project_name: 'ALFA', contract_value: 100000, costo_estimado: 60000,
  costo_recursos: 50000, costo_gastos: 10000, utilidad: 40000, margen_pct: 40,
  estado: 'sin_riesgo', budget: 100000, presupuesto_pct: 60, presupuesto_excedido_pct: null,
  ejecutado_total: 0, ritmo_gasto_semanal: 0, semanas_restantes: 1, ...extra,
});

test('renderComercial: la tabla no muestra contrato, utilidad ni margen', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, comercial: { proyectos: [proyectoComercial()] } });
  run('renderComercial()');

  const fila = document.querySelector('#cst-com-tbody tr');
  const celdas = [...fila.children].map((td) => td.textContent.trim());
  assert.strictEqual(celdas.length, 6, 'Proyecto, Presupuesto, Costo estimado, Ejecucion, Estado, Accion');
  assert.ok(celdas.includes('60%'), 'la ejecucion presupuestal si se muestra');
  const texto = document.getElementById('cst-com-tbody').textContent;
  assert.doesNotMatch(texto, /40%/, 'el margen no deberia aparecer');
});

// Sin presupuesto puesto no hay contra que comparar: la fila lo dice con un
// guion en vez de inventar un 0%.
// El % se muestra COMPLETO, sin topar: un proyecto al 416% no esta en la
// misma situacion que uno al 105%, y topando los dos se veian igual.
test('renderComercial: un proyecto que se paso del presupuesto muestra el % real, sin topar', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    comercial: { proyectos: [proyectoComercial({
      project_name: 'MIA', presupuesto_pct: 416.7, presupuesto_excedido_pct: 316.7, estado: 'perdida',
    })] },
  });
  run('renderComercial()');

  const celda = document.querySelector('#cst-com-tbody tr').children[3];
  assert.strictEqual(celda.textContent.trim(), '416.7%');
  assert.match(celda.getAttribute('title'), /416\.7% del presupuesto: excedido en 316\.7%/,
    'el numero real tiene que seguir disponible');
  assert.match(document.querySelector('#cst-com-tbody .cst-estado-pill').textContent, /Sobre ejecutado/,
    'la pastilla es la que distingue 101% de 416%');
});

test('renderComercial: un centro sin presupuesto muestra guion en Ejecucion, no 0%', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    comercial: { proyectos: [proyectoComercial({ budget: 0, presupuesto_pct: null, estado: 'no_aplica' })] },
  });
  run('renderComercial()');

  const celdas = [...document.querySelector('#cst-com-tbody tr').children].map((td) => td.textContent.trim());
  assert.strictEqual(celdas[3], '—');
  assert.strictEqual(document.getElementById('cst-com-sin-presupuesto').textContent, '1');
});

// Las cuatro tarjetas de estado sumaban 11 de 12: el que no tiene
// presupuesto no aparecia en ninguna.
test('renderComercial: las tarjetas de estado cubren TODO el portafolio', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    comercial: { proyectos: [
      proyectoComercial({ cost_center_id: 1, estado: 'sin_riesgo' }),
      proyectoComercial({ cost_center_id: 2, estado: 'en_riesgo' }),
      proyectoComercial({ cost_center_id: 3, estado: 'perdida' }),
      proyectoComercial({ cost_center_id: 4, estado: 'no_aplica', budget: 0, presupuesto_pct: null }),
    ] },
  });
  run('renderComercial()');

  const suma = ['cst-com-viables', 'cst-com-riesgo', 'cst-com-no-viables', 'cst-com-sin-presupuesto']
    .reduce((t, id) => t + Number(document.getElementById(id).textContent), 0);
  assert.strictEqual(suma, 4, 'las tarjetas tienen que sumar los 4 proyectos');
});

// El ranking ordena por ejecucion presupuestal, y deja fuera a los que no
// tienen presupuesto: en cero liderarian "con mas holgura" por un dato que
// falta, no por buena ejecucion.
test('renderRankingComercial: ordena por % ejecutado y excluye los que no tienen presupuesto', () => {
  const { document, run, setState } = montarCosteo();
  setState({
    user: { role: 'ceo' },
    comercial: { proyectos: [
      proyectoComercial({ cost_center_id: 1, project_name: 'HOLGADO', presupuesto_pct: 20 }),
      proyectoComercial({ cost_center_id: 2, project_name: 'MEDIO', presupuesto_pct: 80 }),
      proyectoComercial({ cost_center_id: 3, project_name: 'PASADO', presupuesto_pct: 150, estado: 'perdida' }),
      proyectoComercial({ cost_center_id: 4, project_name: 'JUSTO', presupuesto_pct: 99 }),
      proyectoComercial({ cost_center_id: 5, project_name: 'SIN-PPTO', presupuesto_pct: null, budget: 0, estado: 'no_aplica' }),
    ] },
  });
  run('renderComercial()');

  const top = document.getElementById('cst-com-ranking-top').textContent;
  const bottom = document.getElementById('cst-com-ranking-bottom').textContent;
  assert.match(top, /HOLGADO/);
  assert.match(top, /ejecutado/, 'el dato que acompana es el % ejecutado, no el margen');
  assert.match(bottom, /PASADO/, 'el mas sobre-ejecutado encabeza la lista de la derecha');
  assert.match(bottom, /150%/, 'el % se muestra completo, sin topar');
  assert.doesNotMatch(top + bottom, /SIN-PPTO/, 'sin presupuesto no entra al ranking');
});

// ---------------------------------------------------------------
// Paginacion (paginar / pintarPaginacion en costeo-core.js) — 20 filas por
// pagina en todas las listas del modulo, 11 sep 2026.
// ---------------------------------------------------------------

const gastosDePrueba = (n) => Array.from({ length: n }, (_, i) => ({
  expense_id: i + 1, project_name: 'ALFA', description: `G${i + 1}`, amount: 1000,
  expense_date: '2026-08-01', cost_center_id: 1, approval_status: 'aprobado',
}));

test('paginar: corta de a 20 y la segunda pagina trae el resto', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, gastos: gastosDePrueba(25) });
  run('renderGastosTable()');

  assert.strictEqual(document.querySelectorAll('[data-gasto-row]').length, 20, 'la primera pagina son 20');
  const nav = document.querySelector('.cst-paginacion[data-pag="gastos"]');
  assert.ok(nav && !nav.hidden, 'con 25 filas tiene que verse el control');
  assert.match(nav.textContent, /1.20 de 25/);

  nav.querySelector('[data-pag-ir="siguiente"]').click();
  assert.strictEqual(document.querySelectorAll('[data-gasto-row]').length, 5, 'la segunda trae las 5 que faltan');
  assert.match(document.querySelector('.cst-paginacion[data-pag="gastos"]').textContent, /21.25 de 25/);
});

// Una tabla de tres filas no puede cargar con una barra que no hace nada.
test('pintarPaginacion: con una sola pagina el control queda escondido', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, gastos: gastosDePrueba(8) });
  run('renderGastosTable()');

  const nav = document.querySelector('.cst-paginacion[data-pag="gastos"]');
  assert.ok(nav, 'el <nav> se crea igual, para no reordenar el DOM despues');
  assert.strictEqual(nav.hidden, true);
});

// Si la lista se encoge (un filtro, un borrado) por debajo de la pagina en la
// que estabas, hay que retroceder: si no, la tabla queda vacia sin explicar
// por que.
test('paginar: si la lista se encoge, retrocede a la ultima pagina que existe', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' }, gastos: gastosDePrueba(25) });
  run('renderGastosTable()');
  document.querySelector('[data-pag-ir="siguiente"]').click();
  assert.strictEqual(run("paginaActual.gastos"), 2);

  setState({ user: { role: 'ceo' }, gastos: gastosDePrueba(6) });
  run('renderGastosTable()');
  assert.strictEqual(run("paginaActual.gastos"), 1, 'deberia volver a la unica pagina que queda');
  assert.strictEqual(document.querySelectorAll('[data-gasto-row]').length, 6);
});

// Equipo del Proyecto se pagina por PERSONA: alguien con varios proyectos
// ocupa varias filas bajo un solo nombre y no se puede partir a la mitad.
test('paginar: Equipo del Proyecto cuenta personas, no filas', () => {
  const { document, run, setState } = montarCosteo();
  // 21 personas; la primera tiene 3 asignaciones (3 filas).
  const equipo = [];
  for (let i = 1; i <= 21; i++) {
    const veces = i === 1 ? 3 : 1;
    for (let j = 0; j < veces; j++) {
      equipo.push({
        team_member_id: `${i}-${j}`, employee_id: i, canonical_name: `P${i}`,
        role_catalog: 'dev', cost_center_id: 1, project_name: 'ALFA',
        hourly_cost: 1000, planned_hours: 10, is_active: 1,
      });
    }
  }
  setState({ user: { role: 'ceo' }, equipo, centros: [], tarifasCargo: [] });
  run('renderEquipoTable()');

  const nav = document.querySelector('.cst-paginacion[data-pag="equipo"]');
  assert.match(nav.textContent, /de 21/, 'el total son personas (21), no filas (23)');
  // 20 personas en la primera pagina, pero 22 filas: la primera aporta 3.
  assert.strictEqual(document.querySelectorAll('[data-equipo-row]').length, 22);
});

// ---------------------------------------------------------------
// Iconos SVG (ICONOS / icono() / pintarIconos en costeo-core.js) — 11 sep
// 2026, reemplazaron a los emojis de toda la interfaz.
// ---------------------------------------------------------------

test('pintarIconos: rellena todos los huecos del HTML estatico, sin dejar ninguno vacio', () => {
  const { document, run } = montarCosteo();
  const huecos = [...document.querySelectorAll('.cst-ico[data-ico]')];
  assert.ok(huecos.length >= 20, `deberia haber huecos de icono en el HTML (hay ${huecos.length})`);

  run('pintarIconos()');

  const vacios = huecos.filter((el) => !el.querySelector('svg')).map((el) => el.dataset.ico);
  assert.deepStrictEqual(vacios, [], 'todo data-ico del HTML tiene que existir en ICONOS');
});

// El SVG toma color y tamano del texto que lo rodea (currentColor + em): sin
// eso, un icono en la banda azul saldria negro y habria que fijarle el color
// caso por caso, que es justo lo que pasaba con los emojis.
test('icono(): devuelve un SVG en currentColor, y cadena vacia si el nombre no existe', () => {
  const { run } = montarCosteo();
  const svg = run("icono('alertas')");
  assert.match(svg, /<svg /);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /aria-hidden="true"/, 'es decorativo: no lo debe leer un lector de pantalla');
  assert.strictEqual(run("icono('no-existe')"), '');
});

// ---------------------------------------------------------------
// Barra de pestanas global (#cst-tabbar, 11 sep 2026) — las 4 pantallas
// propias (Indicadores, Alertas, Costo Planeado, Comercial) mas las 7
// sub-pestanas de Equipo y Gastos, visibles en todas las pantallas. Antes
// vivia DENTRO de Equipo y Gastos y solo listaba esas 7.
// ---------------------------------------------------------------

test('#cst-tabbar: un clic en una pestana de PANEL cambia de pantalla y deja subtabActivo en null', () => {
  const { document, window, run } = montarCosteo();
  const visitados = [];
  window.showPanel = (target) => visitados.push(target);
  run("subtabActivo = 'historial'");
  run('initEgSubtabs()');

  document.querySelector('#cst-tabbar .cst-tab[data-panel="comercial"]').click();

  assert.deepStrictEqual(visitados, ['comercial']);
  assert.strictEqual(run('subtabActivo'), null, 'una pantalla propia no tiene sub-pestana activa');
});

// El clic tiene que hacer las DOS cosas: traer el panel de Equipo y Gastos
// al frente (antes bastaba con cambiar de sub-pestana, porque la barra solo
// se veia estando ya dentro de ese panel) y abrir la sub-pestana.
test('#cst-tabbar: un clic en una pestana de SUB-PESTANA entra a Equipo y Gastos por ella', () => {
  const { document, window, run } = montarCosteo();
  const visitados = [];
  window.showPanel = (target) => visitados.push(target);
  run("panelActivo = 'indicadores'");
  run('window.marcarNavActivo = function () {}');
  run('initEgSubtabs()');

  document.querySelector('#cst-tabbar .cst-tab[data-subtab="horas-extra"]').click();

  assert.deepStrictEqual(visitados, ['equipo-gastos']);
  assert.strictEqual(run('subtabActivo'), 'horas-extra');
  assert.strictEqual(document.getElementById('cst-subpanel-horas-extra').hidden, false);
});

// Antes applyEgRoleView escondia la barra ENTERA para un PM (vivia dentro de
// Equipo y Gastos y el PM llegaba a cada sub-pestana desde el menu lateral).
// Ahora es la navegacion de toda la pantalla: esconderla entera lo dejaria
// sin ella en las 11, no solo en las dos que no le tocan.
test('applyEgRoleView: a un PM le esconde solo Accesos y Configuracion, no la barra entera', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'leader' } });
  run('applyEgRoleView()');

  const ocultas = [...document.querySelectorAll('#cst-tabbar .cst-tab')]
    .filter((b) => b.hidden)
    .map((b) => b.dataset.subtab || b.dataset.panel);
  assert.deepStrictEqual(ocultas, ['accesos', 'configuracion']);
  assert.strictEqual(document.getElementById('cst-tabbar').hidden, false, 'la barra sigue a la vista');
});

test('applyEgRoleView: un admin/ceo las ve todas, y sin quedarse en visibility:hidden', () => {
  const { document, run, setState } = montarCosteo();
  setState({ user: { role: 'ceo' } });
  run('applyEgRoleView()');

  const botones = [...document.querySelectorAll('#cst-tabbar .cst-tab')];
  assert.strictEqual(botones.length, 11, '4 pantallas propias + 7 sub-pestanas');
  assert.strictEqual(botones.some((b) => b.hidden), false, 'ninguna deberia estar oculta');
  // Arrancan en visibility:hidden por CSS para que un PM no las vea
  // parpadear: applyEgRoleView tiene que devolverlas a visible, no solo
  // quitarles el atributo hidden.
  const ceoOnly = botones.filter((b) => b.hasAttribute('data-ceo-only'));
  assert.strictEqual(ceoOnly.length, 2);
  assert.strictEqual(ceoOnly.every((b) => b.style.visibility === 'visible'), true);
});

// ---------------------------------------------------------------
// Alertas sin corregir (costeo-alertas.js) — hasta el 10 sep 2026 vivían en
// un bloque aparte encima de la barra de filtros, lo que partía la pantalla
// en dos listas de alertas. Ahora son una pestaña más de la misma grilla.
// ---------------------------------------------------------------

const ESCALAMIENTOS = [
  { evento_id: 1, tipo: 'Presupuesto casi agotado', cost_center_id: 1, project_name: 'ALFA',
    severidad: 'critica', detalle: 'Va en 92%', dias_abierta: 7, nivel: 'ceo', es_ultimo_aviso: false },
  { evento_id: 2, tipo: 'Desviación presupuestal', cost_center_id: 2, project_name: 'BETA',
    severidad: 'alta', detalle: 'Gasta más rápido', dias_abierta: 5, nivel: 'pm', es_ultimo_aviso: true },
];

function montarAlertas(role) {
  const ctx = montarCosteo();
  ctx.setState({
    user: { role },
    alertas: [{ tipo: 'Vencimiento próximo', categoria: 'plazo', severidad: 'media',
                detalle: 'Faltan 5 días', cost_center_id: 1, project_name: 'ALFA' }],
    escalamientos: ESCALAMIENTOS,
  });
  return ctx;
}

// El backend marca cada alerta con dias_abierta/nivel cuando tiene un
// escalamiento abierto (anotarDiasAbierta), y el front resalta esas dentro
// de la lista completa en vez de mandarlas a una lista aparte.
function montarAlertasAnotadas(role) {
  const ctx = montarCosteo();
  ctx.setState({
    user: { role },
    alertas: [
      { tipo: 'Vencimiento próximo', categoria: 'plazo', severidad: 'critica',
        detalle: 'Sin escalar', cost_center_id: 1, project_name: 'ALFA' },
      { tipo: 'Presupuesto casi agotado', categoria: 'presupuesto', severidad: 'media',
        detalle: 'Va en 92%', cost_center_id: 1, project_name: 'ALFA',
        dias_abierta: 7, nivel: 'ceo', es_ultimo_aviso: false },
      { tipo: 'Desviación presupuestal', categoria: 'presupuesto', severidad: 'baja',
        detalle: 'Gasta rápido', cost_center_id: 1, project_name: 'ALFA',
        dias_abierta: 4, nivel: 'pm', es_ultimo_aviso: false },
    ],
    escalamientos: [],
  });
  return ctx;
}

test('todas: las alertas sin corregir van primero, y entre ellas la mas vieja arriba', () => {
  const { document, run } = montarAlertasAnotadas('leader');
  run('alertasFiltroActivo = "todas"');
  run('renderAlertasGrid()');

  const titulos = [...document.querySelectorAll('#cst-alertas-grid .cst-alert-card h4')]
    .map((h) => h.textContent);
  assert.deepStrictEqual(titulos, ['Presupuesto casi agotado', 'Desviación presupuestal', 'Vencimiento próximo']);
});

test('todas: la alerta sin corregir lleva el cuadro con los dias; la que no, no', () => {
  const { document, run } = montarAlertasAnotadas('leader');
  run('alertasFiltroActivo = "todas"');
  run('renderAlertasGrid()');

  const cards = [...document.querySelectorAll('#cst-alertas-grid .cst-alert-card')];
  assert.match(cards[0].querySelector('.cst-alert-dias').textContent, /7 días sin corregir/);
  assert.ok(cards[0].classList.contains('is-sin-corregir'));
  assert.strictEqual(cards[2].querySelector('.cst-alert-dias'), null, 'la no escalada no deberia llevarlo');
});

// Un CEO no deberia ver resaltadas las de 3-5 dias: siguen siendo del PM.
// Si el resaltado y el contador de la pestaña usaran reglas distintas, la
// pestaña diria un numero y la lista resaltaria otro.
test('todas: para admin/ceo solo se resaltan las que ya escalaron a su nivel', () => {
  const { document, run } = montarAlertasAnotadas('ceo');
  run('alertasFiltroActivo = "todas"');
  run('renderAlertasGrid()');

  const cards = [...document.querySelectorAll('#cst-alertas-grid .cst-alert-card')];
  const conBadge = cards.filter((c) => c.querySelector('.cst-alert-dias'));
  assert.strictEqual(conBadge.length, 1, 'solo la de nivel ceo');
  assert.match(conBadge[0].textContent, /Presupuesto casi agotado/);
});

test('alertas sin corregir: la pestaña muestra los escalamientos, no la grilla normal', () => {
  const { document, run } = montarAlertas('leader');
  run('alertasFiltroActivo = "sin-corregir"');
  run('renderAlertasGrid()');

  const grid = document.getElementById('cst-alertas-grid');
  assert.match(grid.textContent, /Presupuesto casi agotado/);
  assert.match(grid.textContent, /7 días sin corregir/);
  assert.ok(!grid.textContent.includes('Vencimiento próximo'), 'no debe mezclar las alertas normales');
});

// El backend manda a admin/ceo TODOS los escalamientos; el recorte a los de
// 6+ dias (nivel 'ceo') lo hace el front — las de 3-5 dias siguen siendo
// del PM. Es la regla que antes vivia en renderEscalamientos.
test('alertas sin corregir: admin/ceo solo ve las escaladas a su nivel', () => {
  const { document, run } = montarAlertas('ceo');
  run('alertasFiltroActivo = "sin-corregir"');
  run('renderAlertasGrid()');

  const grid = document.getElementById('cst-alertas-grid');
  assert.match(grid.textContent, /Presupuesto casi agotado/, 'la de nivel ceo si');
  assert.ok(!grid.textContent.includes('Desviación presupuestal'), 'la de nivel pm no');
});

test('alertas sin corregir: un leader ve tambien las suyas de nivel pm, con el aviso de ultimo dia', () => {
  const { document, run } = montarAlertas('leader');
  run('alertasFiltroActivo = "sin-corregir"');
  run('renderAlertasGrid()');

  const grid = document.getElementById('cst-alertas-grid');
  assert.match(grid.textContent, /Desviación presupuestal/);
  assert.match(grid.textContent, /Último día/);
});

test('alertas sin corregir: el filtro global de Proyecto tambien recorta esta pestaña', () => {
  const { document, run } = montarAlertas('leader');
  document.getElementById('cst-f-centro').innerHTML =
    '<option value="">Todos los proyectos</option><option value="1">ALFA</option>';
  document.getElementById('cst-f-centro').value = '1';
  run('alertasFiltroActivo = "sin-corregir"');
  run('renderAlertasGrid()');

  const grid = document.getElementById('cst-alertas-grid');
  assert.match(grid.textContent, /Presupuesto casi agotado/, 'ALFA si');
  assert.ok(!grid.textContent.includes('Desviación presupuestal'), 'BETA no');
});

// Estas alertas perdieron el bloque destacado que tenian arriba: sin el
// contador en la pestaña, saber si hay algo pendiente exigiria entrar.
test('alertas sin corregir: la pestaña lleva el contador de cuantas hay', () => {
  const { document, run } = montarAlertas('leader');
  run('renderAlertasGrid()');
  const badge = document.getElementById('cst-alertas-sin-corregir-count');
  assert.strictEqual(badge.textContent, '2');
  assert.strictEqual(badge.hidden, false);
});

test('alertas sin corregir: sin escalamientos, el contador se esconde', () => {
  const { document, run, setState } = montarAlertas('leader');
  setState({ escalamientos: [] });
  run('renderAlertasGrid()');
  assert.strictEqual(document.getElementById('cst-alertas-sin-corregir-count').hidden, true);
});

// Los KPIs del encabezado son del portafolio completo: se calculaban DESPUES
// de pintar la grilla, asi que la salida temprana de esta pestaña los habria
// dejado con el valor de la vez anterior.
test('alertas sin corregir: los KPIs del encabezado se actualizan igual en esta pestaña', () => {
  const { document, run } = montarAlertas('leader');
  run('alertasFiltroActivo = "sin-corregir"');
  run('renderAlertasGrid()');
  assert.strictEqual(document.getElementById('cst-kpi-alertas').textContent, '1');
  assert.strictEqual(document.getElementById('cst-nav-alertas-badge').textContent, '1');
});

// ---------------------------------------------------------------
// actualizarLogoProyecto (costeo-indicadores.js) — al elegir un proyecto en
// el filtro del encabezado, el logo de la izquierda pasa a ser el suyo. Los
// que todavia no tienen logo propio se quedan con el de GTC.
// ---------------------------------------------------------------

function montarConProyecto(nombre) {
  const ctx = montarCosteo();
  ctx.document.getElementById('cst-f-centro').innerHTML =
    `<option value="">Todos los proyectos</option><option value="7">${nombre}</option>`;
  ctx.document.getElementById('cst-f-centro').value = '7';
  ctx.run('actualizarLogoProyecto()');
  return ctx.document.querySelector('.cst-header-left .brand-logo');
}

test('actualizarLogoProyecto: al elegir MIA, el logo del encabezado pasa a ser el de MIA', () => {
  const img = montarConProyecto('MIA');
  assert.match(img.getAttribute('src'), /MIA/);
  assert.strictEqual(img.alt, 'MIA');
});

test('actualizarLogoProyecto: un proyecto sin logo propio se queda con el de GTC', () => {
  const img = montarConProyecto('Transversales');
  assert.strictEqual(img.getAttribute('src'), '/img/logo_gtc.png');
  assert.strictEqual(img.alt, 'GTC Corporation');
});

test('actualizarLogoProyecto: "Todos los proyectos" muestra el logo de GTC', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-centro').innerHTML = '<option value="">Todos los proyectos</option>';
  document.getElementById('cst-f-centro').value = '';
  run('actualizarLogoProyecto()');
  assert.strictEqual(
    document.querySelector('.cst-header-left .brand-logo').getAttribute('src'),
    '/img/logo_gtc.png'
  );
});

// El nombre del proyecto lo escribe una persona al crear el centro, asi que
// no se puede depender de que coincida en mayusculas ni tildes.
test('actualizarLogoProyecto: el cruce del nombre ignora mayusculas, tildes y espacios', () => {
  for (const variante of ['SUECO CRM', 'sueco crm', 'Sueco  CRM']) {
    assert.match(montarConProyecto(variante).getAttribute('src'), /SUECO/, variante);
  }
});

// Los archivos vienen como los entrega diseño: con espacios y tildes. Un
// src sin codificar no resuelve en todos los navegadores.
test('actualizarLogoProyecto: la ruta del logo va codificada (sin espacios crudos)', () => {
  const src = montarConProyecto('MIA').getAttribute('src');
  assert.ok(!src.includes(' '), `el src no deberia traer espacios crudos: ${src}`);
  assert.match(src, /%20/);
});

// Si el mapa apunta a un archivo que ya no esta, el usuario veria el icono
// de imagen rota en el encabezado.
test('actualizarLogoProyecto: si el archivo no carga, cae al logo de GTC', () => {
  const img = montarConProyecto('MIA');
  assert.strictEqual(typeof img.onerror, 'function', 'deberia dejar un fallback enganchado');
  img.onerror();
  assert.strictEqual(img.getAttribute('src'), '/img/logo_gtc.png');
});

test('populateCentroFilter: la opcion por defecto dice "Todos los proyectos"', () => {
  const { document, run, setState } = montarCosteo();
  setState({ centros: [{ cost_center_id: 7, project_name: 'MIA' }] });
  run('populateCentroFilter()');
  const select = document.getElementById('cst-f-centro');
  assert.strictEqual(select.options[0].textContent, 'Todos los proyectos');
  assert.strictEqual(select.options[1].textContent, 'MIA');
});

test('filtrosQuery: incluirRecurso:false (Comercial) omite employee_id aunque Recurso tenga un valor puesto', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-recurso').innerHTML = '<option value="7">Alicia</option>';
  document.getElementById('cst-f-recurso').value = '7';
  document.getElementById('cst-f-periodo').innerHTML = '<option value="Agosto">Agosto</option>';
  document.getElementById('cst-f-periodo').value = 'Agosto';

  const normal = run('filtrosQuery()');
  const sinRecurso = run('filtrosQuery({ incluirRecurso: false })');

  assert.match(normal, /employee_id=7/, 'sin la opcion, si deberia incluir employee_id');
  assert.doesNotMatch(sinRecurso, /employee_id/, 'con incluirRecurso:false, NO deberia mandar employee_id');
  assert.match(sinRecurso, /month=Agosto/, 'Periodo si deberia seguir aplicando');
});

// (11 sep 2026, a pedido explicito) Alertas ya no muestra Periodo, y
// recargarPorFiltros() recarga Indicadores/Alertas/Comercial juntas: sin
// incluirPeriodo:false, el mes elegido en Indicadores se colaria igual en la
// carga de Alertas y escondería avisos vigentes por un recorte que esa
// pantalla no muestra en ningun lado.
test('filtrosQuery: incluirPeriodo:false (Alertas) omite month aunque Periodo tenga un valor puesto', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-recurso').innerHTML = '<option value="7">Alicia</option>';
  document.getElementById('cst-f-recurso').value = '7';
  document.getElementById('cst-f-periodo').innerHTML = '<option value="Agosto">Agosto</option>';
  document.getElementById('cst-f-periodo').value = 'Agosto';

  const sinPeriodo = run('filtrosQuery({ incluirPeriodo: false })');
  assert.doesNotMatch(sinPeriodo, /month/, 'con incluirPeriodo:false, NO deberia mandar month');
  assert.match(sinPeriodo, /employee_id=7/, 'Recurso si deberia seguir aplicando');

  const ninguno = run('filtrosQuery({ incluirRecurso: false, incluirPeriodo: false })');
  assert.strictEqual(ninguno, '', 'como lo llama loadAlertas: sin ninguno de los dos, query vacio');
});

// Periodo por mes completo, sin semanas (8 sep 2026, a pedido explicito: se
// quito el segundo nivel de semana que habia antes — value pasa de
// "Agosto:2" a directo "Agosto"). filtrosQuery debe mandar SOLO month; el
// backend ya agregaba el mes completo cuando no llega week (ver
// baseWhere/buildFilterClause en src/queries/_common.js).
test('filtrosQuery: Periodo por mes (value "Agosto", sin semana) manda month, nunca week', () => {
  const { document, run } = montarCosteo();
  document.getElementById('cst-f-periodo').innerHTML = '<option value="Agosto">Agosto</option>';
  document.getElementById('cst-f-periodo').value = 'Agosto';

  const qs = run('filtrosQuery()');
  assert.match(qs, /month=Agosto/, 'debe mandar el mes');
  assert.doesNotMatch(qs, /week=/, 'ya no existe semana en el filtro de Periodo');
});

// (8 sep 2026, a pedido explicito): elegir un mes en Periodo YA NO muestra
// el aviso "Viendo solo...". Tenia sentido cuando Periodo filtraba por
// SEMANA (una semana si es "una parte recortada" del proyecto) — con
// Periodo por MES completo, ese aviso ya no aporta nada.
test('renderAvisoFiltro: elegir un mes en Periodo NO muestra el aviso (ya no es "una parte recortada")', () => {
  const { document, run } = montarCosteo();
  run('panelActivo = \'indicadores\'');
  document.getElementById('cst-f-periodo').innerHTML = '<option value="Agosto">Agosto</option>';
  document.getElementById('cst-f-periodo').value = 'Agosto';
  run('renderAvisoFiltro()');

  const aviso = document.getElementById('cst-filtro-aviso');
  assert.strictEqual(aviso.hidden, true, 'Periodo solo ya no debe disparar el aviso');
});

test('renderAvisoFiltro: elegir un Recurso SI sigue mostrando el aviso', () => {
  const { document, run } = montarCosteo();
  run('panelActivo = \'indicadores\'');
  document.getElementById('cst-f-recurso').innerHTML = '<option value="7">Alicia</option>';
  document.getElementById('cst-f-recurso').value = '7';
  run('renderAvisoFiltro()');

  const aviso = document.getElementById('cst-filtro-aviso');
  assert.strictEqual(aviso.hidden, false);
  assert.match(aviso.innerHTML, /<b>Alicia<\/b>/);
});

// ---------------------------------------------------------------
// irAAgregarAlEquipoReal / "+ Agregar al equipo" en el Simulador
// (costeo-alertas.js) — 28 ago 2026, a pedido explícito: un rol que se
// suma con "+ Agregar rol" en el simulador es solo un ensayo. Este botón
// lo lleva al formulario REAL de Equipo del Proyecto con el Centro de
// Costos, el Cargo y el Costo/hora ya puestos, para no tener que volver a
// escribirlos.
// ---------------------------------------------------------------

function montarSimuladorConProyecto() {
  const contexto = montarCosteo();
  const { run, setState } = contexto;
  setState({
    user: { role: 'ceo' },
    centros: [{ cost_center_id: 1, project_name: 'Sistema de costos' }],
    tarifasCargo: [{ role_catalog: 'analista_datos', nombre_visible: 'Analista de Datos', hourly_cost: 8000 }],
    comercial: {
      horas_semana_legal: 46,
      proyectos: [{
        cost_center_id: 1, project_name: 'Sistema de costos', contract_value: 10000000,
        margen_pct: 90, budget: 1000000, ejecutado_total: 0, semanas_restantes: 1,
        equipo_por_cargo: [],
      }],
      resumen: { utilidad_total: 0, proyectos_con_contrato: 1, viables: 1, riesgo: 0, no_viables: 0 },
    },
  });
  // showPanel/marcarNavActivo viven en costeo-nav.js, no cargado aquí a
  // propósito (arrastraría el arranque completo — ver el comentario junto
  // a ARCHIVOS_EN_ORDEN). Se sustituyen por stubs mínimos: lo que se
  // prueba aquí es el prellenado del formulario, no el resaltado del
  // sidebar ni el bootstrap de la página.
  run('window.showPanel = function (t) { panelActivo = t; }');
  run('window.marcarNavActivo = function () {}');
  run('populateEquipoGastoCentroSelect()');
  run('populateEquipoRoleSelect()');
  run(`document.getElementById('cst-sim-proyecto').innerHTML = '<option value="1">Sistema de costos</option>'`);
  run(`document.getElementById('cst-sim-proyecto').value = '1'`);
  run('initSimulador()'); // engancha los listeners de clic (+Agregar rol, +Agregar al equipo...)
  run('renderSimulador()');
  return contexto;
}

test('"+ Agregar al equipo" solo aparece en filas nuevas (agregadas a mano), no en el equipo real', () => {
  const { document, run, setState } = montarSimuladorConProyecto();
  // Un centro con equipo REAL (no agregado a mano) no debe ofrecer el botón.
  setState({
    comercial: {
      horas_semana_legal: 46,
      proyectos: [{
        cost_center_id: 1, project_name: 'Sistema de costos', contract_value: 10000000,
        margen_pct: 90, budget: 1000000, ejecutado_total: 0, semanas_restantes: 1,
        equipo_por_cargo: [{ role_catalog: 'qa', personas: 1, costo_hora: 9000 }],
      }],
      resumen: { utilidad_total: 0, proyectos_con_contrato: 1, viables: 1, riesgo: 0, no_viables: 0 },
    },
  });
  run('simulador = null'); // fuerza a resetSimulador() a recargar desde el nuevo state.comercial
  run('renderSimulador()');
  assert.strictEqual(document.querySelectorAll('[data-sim="rol-contratar"]').length, 0, 'el equipo real no deberia ofrecer "+ Agregar al equipo"');

  run(`document.querySelector('[data-sim="rol-add"]').click()`);
  assert.strictEqual(document.querySelectorAll('[data-sim="rol-contratar"]').length, 1, 'una fila nueva si deberia ofrecerlo');
});

test('"+ Agregar al equipo": prellena Centro, Cargo y Costo/hora en el formulario real de Equipo del Proyecto', async () => {
  const { window, document, run, setState } = montarSimuladorConProyecto();
  // Ya no hay costo/hora tecleado a mano ni tarifa estándar del catálogo (3
  // sep 2026, a pedido explícito): el único origen del costo/hora es el
  // salario real de una persona elegida — se mockea la misma llamada que
  // hace costoHoraDeEmpleado (costeo-core.js).
  window.fetch = async (url) => {
    if (String(url).includes('/api/costeo/equipo/salario-conocido/')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ monthly_salary: 1680000, costo_hora: 8000 }) };
    }
    throw new Error(`fetch inesperado en esta prueba: ${url}`);
  };
  // state.employees es lo que renderSimulador lee para armar el <select> de
  // "Persona real" (ver opcionesPersonaSim en costeo-alertas.js) — se llena
  // a mano en vez de por loadEmployeesOptions() para no depender de otro
  // fetch más en esta prueba.
  setState({ employees: [{ employee_id: 77, canonical_name: 'Camila Restrepo', is_active: 1 }] });
  // El select de Talento del modal real de Equipo del Proyecto lo llena
  // loadEmployeesOptions() (otro fetch, no mockeado aquí) — se pobla a mano
  // para poder comprobar que irAAgregarAlEquipoReal() sí le asigna el valor.
  run(`document.getElementById('cst-equipo-employee').innerHTML = '<option value="">Ninguno</option><option value="77">Camila Restrepo</option>'`);

  run(`document.querySelector('[data-sim="rol-add"]').click()`);
  run(`{
    const sel = document.querySelector('select[data-sim-input="role_catalog"][data-i="0"]');
    sel.value = 'analista_datos';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  run(`{
    const sel = document.querySelector('select[data-sim-input="employee_id"][data-i="0"]');
    sel.value = '77';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await new Promise((r) => setTimeout(r, 0));
  // Elegir la persona autocompletó el costo/hora con su salario real (8000).

  run(`document.querySelector('[data-sim="rol-contratar"]').click()`);

  assert.strictEqual(run('panelActivo'), 'equipo-gastos');
  assert.strictEqual(run('subtabActivo'), 'equipo-proyecto');
  assert.strictEqual(document.getElementById('cst-equipo-centro').value, '1');
  assert.strictEqual(document.getElementById('cst-equipo-role').value, 'analista_datos');
  assert.strictEqual(document.getElementById('cst-equipo-hourly-cost').value, '8000');
  assert.strictEqual(document.getElementById('cst-equipo-employee').value, '77', 'la persona elegida en el simulador deberia llevarse tambien');
});

test('"+ Agregar al equipo": pide elegir el cargo primero si la fila nueva quedo sin completar', () => {
  const { run } = montarSimuladorConProyecto();
  let alertado = '';
  run('window.alert = function (m) { globalThis.__alertado = m; }');

  run(`document.querySelector('[data-sim="rol-add"]').click()`);
  run(`document.querySelector('[data-sim="rol-contratar"]').click()`);

  alertado = run('globalThis.__alertado');
  assert.match(alertado, /cargo/i);
  // No debio navegar: sigue en Comercial.
  assert.strictEqual(run('panelActivo'), 'indicadores');
});


// ---------------------------------------------------------------
// formatFecha / formatFechaHora (costeo-core.js) — formato unico de
// fecha en toda la pantalla de Costeo (4 sep 2026)
// ---------------------------------------------------------------
//
// Antes convivian cuatro formatos para el MISMO tipo de dato: el ISO
// crudo ('2026-08-20') en Costo Planeado, Costo No Planeado y el
// catalogo de cargos; '20 ago 2026' en Horas Extra; y '20 de agosto de
// 2026' en los snapshots. Se unifico en un solo helper.

test('formatFecha: usa el formato corto unico "20 ago 2026"', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run(`formatFecha('2026-08-20')`), '20 ago 2026');
});

// Regresion del desfase de zona horaria: `new Date('2026-01-01')` sin
// hora se interpreta como MEDIANOCHE UTC, y al pintarla en horario local
// de Colombia (UTC-5) se corre al 31 de diciembre. El 'T00:00:00' que
// agrega formatFecha es lo que lo evita; sin el, un proyecto que empieza
// el 1 de enero se mostraba empezando el 31 de diciembre del año
// anterior.
test('formatFecha: no se corre un dia por zona horaria (UTC-5)', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run(`formatFecha('2026-01-01')`), '01 ene 2026');
  assert.strictEqual(run(`formatFecha('2026-12-31')`), '31 dic 2026');
});

test('formatFecha: acepta un DATETIME completo y se queda con la fecha', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run(`formatFecha('2026-08-20 10:00:00')`), '20 ago 2026');
});

test('formatFecha: null, vacio y basura dan "—", nunca "Invalid Date" ni "NaN"', () => {
  const { run } = montarCosteo();
  for (const valor of ['null', 'undefined', `''`, `'no-es-fecha'`]) {
    const salida = run(`formatFecha(${valor})`);
    assert.strictEqual(salida, '—', `formatFecha(${valor}) devolvio "${salida}"`);
  }
});

test('formatFecha: los 12 meses salen en su abreviatura en espanol', () => {
  const { run } = montarCosteo();
  const esperados = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  esperados.forEach((mes, i) => {
    const mm = String(i + 1).padStart(2, '0');
    assert.strictEqual(run(`formatFecha('2026-${mm}-15')`), `15 ${mes} 2026`);
  });
});

test('formatFechaHora: agrega la hora, para el historial de auditoria', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run(`formatFechaHora('2026-08-20 14:05:00')`), '20 ago 2026, 14:05');
});

test('formatFechaHora: null y basura dan "—"', () => {
  const { run } = montarCosteo();
  assert.strictEqual(run(`formatFechaHora(null)`), '—');
  assert.strictEqual(run(`formatFechaHora('no-es-fecha')`), '—');
});

// ---------------------------------------------------------------
// applyBrandUser (sidebar.js) — el subtitulo del sidebar dice QUIEN entro.
// Con varias cuentas rotando sobre el mismo navegador (CEO, admin, un PM por
// proyecto) y pantallas que muestran datos distintos segun el scope de cada
// una, leer un numero creyendo que es del portafolio cuando es de un solo
// proyecto es un error caro y silencioso.
// ---------------------------------------------------------------

test('applyBrandUser: pinta el nombre de quien inicio sesion', () => {
  const { document, run } = montarCosteo();
  const span = document.getElementById('cst-brand-user');
  assert.strictEqual(span.textContent, 'MONITOREO DE COSTOS', 'el HTML arranca con el texto del modulo');

  run('applyBrandUser({ full_name: "Mónica Bastidas", email: "monica@ejemplo.test", role: "leader" })');
  assert.strictEqual(span.textContent, 'Mónica Bastidas');
});

test('applyBrandUser: sin full_name se cae al correo, no deja el hueco sin identificar', () => {
  const { document, run } = montarCosteo();
  run('applyBrandUser({ full_name: "   ", email: "sin_nombre@ejemplo.test", role: "admin" })');
  assert.strictEqual(document.getElementById('cst-brand-user').textContent, 'sin_nombre@ejemplo.test');
});

test('applyBrandUser: sin usuario deja el texto del HTML en vez de vaciarlo', () => {
  const { document, run } = montarCosteo();
  run('applyBrandUser(null)');
  assert.strictEqual(
    document.getElementById('cst-brand-user').textContent, 'MONITOREO DE COSTOS',
    'si /api/auth/me no responde, el hueco no puede quedar en blanco'
  );
});
