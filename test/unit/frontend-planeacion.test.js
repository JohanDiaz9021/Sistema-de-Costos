'use strict';

/**
 * Pruebas de COMPONENTE del frontend de PLANEACION (public/index.html).
 *
 * Hermana de frontend-componentes.test.js, que hace lo mismo con Costeo
 * (public/costeo.html). Esta capa faltaba por completo: index.html y sus
 * archivos (app.js, filters.js, tooltips.js, sidebar.js…) no tenian NINGUNA
 * prueba — solo los cubria la suite e2e de refilon, y esa vive en Costeo.
 *
 * Diferencia importante con el arnes de Costeo: los archivos de Planeacion
 * son IIFE que solo exponen lo suyo en `window` (GTC_FILTERS, GTC_MODAL,
 * GTC_TOOLTIPS…), no globales sueltas. Asi que aqui NO hace falta un `run()`
 * que evalue en el contexto: se llama a `window.GTC_*` y punto.
 *
 * Lo que NO se cubre a proposito: indicators.js. Es el archivo mas grande
 * (1.174 lineas) pero cada renderer termina en `echarts.init(...)`, una
 * libreria que viene de un CDN y que jsdom no carga. Probarlo de verdad
 * pedria un doble de echarts entero, y lo que quedaria verificado seria el
 * doble, no el grafico. Esa parte la cubre la capa e2e, con navegador real.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const JS = path.join(RAIZ, 'public', 'js');

// Mismo orden que los <script> de index.html. echarts (el <script> del CDN)
// no se puede cargar aqui, asi que indicators.js se queda fuera: al ejecutarse
// solo define su IIFE, pero cualquier render posterior reventaria buscando
// `echarts`, y no aporta nada tenerlo cargado sin poder usarlo.
const ARCHIVOS_EN_ORDEN = [
  'safe-html.js',
  'iconos.js',
  'sidebar.js',
  'tooltips.js',
  'filters.js',
  'employees-admin.js',
  'validation-admin.js',
  'app.js',
];

// Respuesta minima pero VALIDA de /api/filters: loadFilters() la recorre
// entera (months, weeks, projects, employees, leaders, scope) y revienta si
// falta cualquiera de esas listas.
function datosDeFiltros({ role = 'ceo' } = {}) {
  return {
    snapshot: '2026-09-08',
    user: { full_name: 'Carmen CEO', email: 'ceo@ejemplo.test', role },
    scope: { role, allowedProjects: null },
    months: [
      { month_name: 'Agosto', year_number: 2026 },
      { month_name: 'Septiembre', year_number: 2026 },
    ],
    weeks: [1, 2, 3, 4],
    projects: ['ALFA', 'BETA'],
    employees: [
      { employee_id: 1, canonical_name: 'Alicia Alfa' },
      { employee_id: 2, canonical_name: 'Bruno Beta' },
    ],
    leaders: [
      { pmo_email: 'ana@ejemplo.test', pmo_canonical_name: 'Ana Líder' },
    ],
  };
}

const json = (cuerpo, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => cuerpo,
});

/**
 * Monta el index.html REAL en jsdom, ejecuta los scripts del front contra su
 * `window` y espera a que termine el arranque (app.js lanza un `start()`
 * asincrono en cuanto se evalua: pide la sesion y luego los filtros).
 *
 * Devuelve { window, document, peticiones, cerrar }.
 */
async function montarPlaneacion({ role = 'ceo' } = {}) {
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');

  // jsdom grita "Not implemented: navigation" cuando el front hace
  // window.location.href = '/login'. Es ruido esperado en un DOM simulado,
  // no un fallo: se silencia solo eso y se deja pasar el resto.
  const consolaVirtual = new VirtualConsole();
  consolaVirtual.on('jsdomError', (err) => {
    if (!/Not implemented: navigation/.test(err.message)) throw err;
  });

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: consolaVirtual,
  });

  const peticiones = [];
  dom.window.fetch = async (url) => {
    peticiones.push(String(url));
    if (String(url).startsWith('/api/auth/me')) return json({ user: datosDeFiltros({ role }).user });
    if (String(url).startsWith('/api/filters')) return json(datosDeFiltros({ role }));
    // Cualquier otra cosa se responde vacia en vez de reventar: los init de
    // employees-admin/validation-admin piden lo suyo al arrancar y no son el
    // objeto de estas pruebas.
    return json({}, 200);
  };
  dom.window.alert = () => {};
  dom.window.confirm = () => true;

  for (const archivo of ARCHIVOS_EN_ORDEN) {
    const src = fs.readFileSync(path.join(JS, archivo), 'utf8');
    vm.runInContext(src, dom.window, { filename: archivo });
  }

  // app.js arranca solo. Se le dan varios turnos al bucle de eventos para que
  // la cadena sesion -> filtros termine antes de que la prueba afirme nada.
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

  return {
    window: dom.window,
    document: dom.window.document,
    peticiones,
    // app.js deja vivo un setInterval de 5 minutos (auto-refresh). Sin cerrar
    // la ventana, ese temporizador impide que el proceso de pruebas termine.
    cerrar: () => dom.window.close(),
  };
}

// ---------------------------------------------------------------
// GTC_FILTERS (filters.js) — el query string que arma TODA peticion de
// indicadores. Es justo donde vivio el hallazgo QA-07: un filtro que el
// front creia estar mandando y que en realidad se perdia por el camino.
// ---------------------------------------------------------------

test('GTC_FILTERS: al arrancar carga los desplegables y preselecciona el ultimo mes', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    // El ultimo mes de la lista es el mas reciente: es el que debe quedar
    // puesto, para que el dashboard abra mostrando el periodo vigente.
    assert.strictEqual(document.getElementById('f-month').value, 'Septiembre');
    assert.strictEqual(window.GTC_FILTERS.state().month, 'Septiembre');

    const proyectos = [...document.getElementById('f-project').options].map((o) => o.textContent);
    assert.deepStrictEqual(proyectos, ['Todos', 'ALFA', 'BETA']);
  } finally { cerrar(); }
});

test('GTC_FILTERS.toQuery: manda employee_id (no "employee") — el nombre que espera el backend', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    document.getElementById('f-employee').value = '2';
    document.getElementById('f-employee').dispatchEvent(new window.Event('change', { bubbles: true }));

    const q = window.GTC_FILTERS.toQuery();
    assert.strictEqual(q.get('employee_id'), '2', 'el backend lee employee_id; "employee" se ignoraria en silencio');
    assert.strictEqual(q.get('employee'), null);
  } finally { cerrar(); }
});

test('GTC_FILTERS.toQuery: omite los filtros vacios en vez de mandarlos en blanco', async () => {
  const { window, cerrar } = await montarPlaneacion();
  try {
    // Recien montado solo hay mes (se preselecciona); el resto esta vacio.
    const q = window.GTC_FILTERS.toQuery();
    assert.strictEqual(q.get('month'), 'Septiembre');
    for (const clave of ['week', 'project', 'employee_id', 'leader']) {
      assert.strictEqual(q.get(clave), null, `${clave} vacio no deberia viajar en la URL`);
    }
  } finally { cerrar(); }
});

test('GTC_FILTERS: el filtro de Lider solo se muestra a ceo/admin', async () => {
  const ceo = await montarPlaneacion({ role: 'ceo' });
  try {
    assert.strictEqual(ceo.document.getElementById('filter-leader-wrap').hidden, false);
  } finally { ceo.cerrar(); }

  // Un leader no puede recortar por OTRO leader: ya esta recortado a lo suyo.
  const leader = await montarPlaneacion({ role: 'leader' });
  try {
    assert.strictEqual(leader.document.getElementById('filter-leader-wrap').hidden, true);
  } finally { leader.cerrar(); }
});

test('GTC_FILTERS: cambiar un filtro emite filters:change con el estado nuevo', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    // Es el evento del que cuelgan TODOS los indicadores (indicators.js
    // escucha 'filters:change'): si deja de emitirse, la pantalla se queda
    // con los datos del filtro anterior sin ninguna senal de error.
    const detalles = [];
    document.addEventListener('filters:change', (e) => detalles.push(e.detail));

    document.getElementById('f-week').value = '3';
    document.getElementById('f-week').dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(detalles.length >= 1, 'cambiar un filtro debio emitir el evento');
    assert.strictEqual(detalles[detalles.length - 1].week, '3');
  } finally { cerrar(); }
});

// ---------------------------------------------------------------
// GTC_MODAL (app.js) — el modal de drilldown. Pinta con innerHTML, asi que
// es la misma superficie de XSS que en Costeo obligo a meter escapeHtml en
// todas las tablas. Aqui se fija el contrato: el TITULO nunca interpreta
// HTML, y el cuerpo acepta un Node (la via segura para datos de usuario).
// ---------------------------------------------------------------

test('GTC_MODAL.open: el titulo se pinta como TEXTO, aunque traiga etiquetas', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    window.GTC_MODAL.open('<img src=x onerror=alert(1)>', '<p>contenido</p>');

    const titulo = document.getElementById('drill-title');
    assert.strictEqual(titulo.querySelectorAll('img').length, 0, 'el titulo no debio crear un <img> real');
    assert.strictEqual(titulo.textContent, '<img src=x onerror=alert(1)>');
    assert.strictEqual(document.getElementById('drill-modal').hidden, false);
  } finally { cerrar(); }
});

test('GTC_MODAL.open: acepta un Node y lo inserta tal cual (via segura para datos del usuario)', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    const fila = document.createElement('p');
    // textContent, no innerHTML: asi es como un renderer debe meter texto
    // que viene de la base sin arriesgarse a ejecutarlo.
    fila.textContent = '<script>alert(1)</script>';
    window.GTC_MODAL.open('Detalle', fila);

    const cuerpo = document.getElementById('drill-body');
    assert.strictEqual(cuerpo.querySelectorAll('script').length, 0, 'no debio crear una etiqueta <script>');
    assert.strictEqual(cuerpo.textContent, '<script>alert(1)</script>');
  } finally { cerrar(); }
});

test('GTC_MODAL: abrir dos veces reemplaza el contenido, no lo acumula', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    window.GTC_MODAL.open('Primero', '<p>uno</p>');
    window.GTC_MODAL.open('Segundo', '<p>dos</p>');

    const cuerpo = document.getElementById('drill-body');
    assert.strictEqual(cuerpo.querySelectorAll('p').length, 1, 'el drilldown anterior debio limpiarse');
    assert.strictEqual(cuerpo.textContent, 'dos');
    assert.strictEqual(document.getElementById('drill-title').textContent, 'Segundo');
  } finally { cerrar(); }
});

test('GTC_MODAL.close y el boton de cerrar esconden el modal', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    window.GTC_MODAL.open('Detalle', '<p>x</p>');
    window.GTC_MODAL.close();
    assert.strictEqual(document.getElementById('drill-modal').hidden, true);

    window.GTC_MODAL.open('Detalle', '<p>x</p>');
    document.getElementById('drill-close').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.strictEqual(document.getElementById('drill-modal').hidden, true, 'el boton X tambien debe cerrarlo');
  } finally { cerrar(); }
});

// ---------------------------------------------------------------
// GTC_TOOLTIPS (tooltips.js) — los textos de ayuda de cada indicador.
// ---------------------------------------------------------------

// Es una prueba de CONSISTENCIA entre dos archivos que se editan por
// separado: el boton "i" de cada tarjeta vive en index.html y su texto en
// tooltips.js. Agregar un indicador nuevo y olvidar el texto deja un boton
// que al pulsarlo no dice nada, y eso no se nota mirando el codigo.
test('cada boton de ayuda de index.html tiene su texto en tooltips.js', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    const botones = [...document.querySelectorAll('[data-tip]')].map((b) => b.dataset.tip);
    assert.ok(botones.length > 0, 'index.html deberia tener botones de ayuda');

    const sinTexto = botones.filter((n) => !window.GTC_TOOLTIPS[n]);
    assert.deepStrictEqual(sinTexto, [], `estos indicadores tienen boton "i" pero ningun texto: ${sinTexto}`);
  } finally { cerrar(); }
});

// ---------------------------------------------------------------
// applyRoleNav (sidebar.js) — que ve cada rol en el menu lateral. Es
// cosmetico (el backend igual responde 403 a un PM que llame a mano un
// endpoint de admin), pero un menu que ofrece pantallas prohibidas manda a
// la gente contra una pared.
// ---------------------------------------------------------------

// Se afirma SIN `if (elemento)` de por medio a proposito: un `if` convierte
// "el atributo ya no existe" en una prueba que pasa sin verificar nada, que
// es la peor forma de fallar. Si alguien renombra data-ceo-only, esto se cae
// aqui y no seis meses despues.
function entradasDelMenu(document) {
  const soloCeo = [...document.querySelectorAll('.cst-nav .cst-nav-item[data-ceo-only]')];
  const soloPm = [...document.querySelectorAll('.cst-nav .cst-nav-item[data-pm-only]')];
  assert.ok(soloCeo.length > 0, 'index.html deberia tener entradas exclusivas de ceo/admin');
  assert.ok(soloPm.length > 0, 'index.html deberia tener entradas exclusivas de PM');
  return { soloCeo, soloPm };
}

test('applyRoleNav: un ceo ve las entradas de admin y ninguna de las exclusivas de PM', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    vm.runInContext('applyRoleNav("ceo")', window);
    const { soloCeo, soloPm } = entradasDelMenu(document);

    assert.ok(soloCeo.every((e) => e.hidden === false), 'el ceo deberia ver TODAS las entradas de admin');
    assert.ok(soloPm.every((e) => e.hidden === true), 'y ninguna de las exclusivas del PM');
  } finally { cerrar(); }
});

test('applyRoleNav: un leader ve lo suyo y NINGUNA entrada de admin', async () => {
  const { window, document, cerrar } = await montarPlaneacion();
  try {
    vm.runInContext('applyRoleNav("leader")', window);
    const { soloCeo, soloPm } = entradasDelMenu(document);

    assert.ok(soloCeo.every((e) => e.hidden === true), 'un leader no deberia ver Accesos ni Configuracion');
    assert.ok(soloPm.every((e) => e.hidden === false), 'y si las suyas');
  } finally { cerrar(); }
});
