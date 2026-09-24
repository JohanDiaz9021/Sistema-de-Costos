'use strict';

/**
 * Pruebas end-to-end: navegador real (Chrome), servidor real, base real.
 *
 * Es la unica capa que ejercita el FRONTEND. Todo lo demas de esta suite
 * habla HTTP directo, asi que un error de renderizado (un innerHTML sin
 * escapar, un panel que no carga) pasaria inadvertido.
 *
 * Se usa la API de Playwright con node:test como runner, en vez de
 * @playwright/test, para no meter un segundo corredor de pruebas en el
 * proyecto: `npm run test:e2e` se comporta igual que las otras dos capas.
 *
 * Navegador: `channel: 'chrome'` usa el Chrome ya instalado en la
 * maquina. Evita el `npx playwright install` (cientos de MB) y prueba
 * contra el mismo navegador que usa la gente de GTC.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../helpers/db');
const fixtures = require('../helpers/fixtures');
const { arrancarServidor } = require('../helpers/servidor');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  // playwright no instalado: las pruebas se saltan con un motivo claro.
}

let navegador = null;
let servidor = null;
let url = null;
let listo = false;
let motivoSalto = '';

test.before(async () => {
  if (!chromium) {
    motivoSalto = 'playwright no esta instalado (npm i -D playwright)';
    return;
  }
  if (!(await db.esperarBase(15, 1000))) {
    motivoSalto = 'base de prueba no disponible (docker compose -f docker-compose.test.yml up -d)';
    return;
  }
  await db.prepararEsquema();
  await db.resetearDatos();
  await fixtures.sembrar();

  servidor = await arrancarServidor();
  url = servidor.url;

  try {
    navegador = await chromium.launch({ channel: 'chrome' });
  } catch (err) {
    // Sin Chrome del sistema se intenta el chromium propio de Playwright.
    try {
      navegador = await chromium.launch();
    } catch {
      motivoSalto = `no hay navegador utilizable: ${err.message.split('\n')[0]}`;
      return;
    }
  }
  listo = true;
});

// En CI saltarse las pruebas NO es aceptable: node:test devuelve exit 0 con
// todo saltado, asi que un navegador que no instalo o una base caida se
// verian exactamente igual que un exito (es el hallazgo QA-05, que para la
// base ya cubre test/helpers/verificar-base.js — el navegador no tenia
// equivalente). En local se sigue saltando, para que `npm run test:e2e` no
// estorbe en una maquina sin Docker ni Chrome.
test('el entorno e2e esta disponible (en CI no puede saltarse)', (t) => {
  if (listo) return;
  const motivo = motivoSalto || 'entorno e2e no disponible';
  if (process.env.CI) assert.fail(`el entorno e2e no arranco y esto es CI: ${motivo}`);
  t.skip(motivo);
});

test.after(async () => {
  if (navegador) await navegador.close();
  if (servidor) await servidor.cerrar();
  await db.cerrarPool();
});

/** Abre una pestaña limpia y la cierra al terminar, pase lo que pase. */
async function conPagina(fn) {
  const contexto = await navegador.newContext({ ignoreHTTPSErrors: true });
  const pagina = await contexto.newPage();

  // Cualquier error de JS del front revienta la prueba: sin esto, una
  // pantalla en blanco por un ReferenceError se veria como "el selector
  // no aparecio", que no dice nada.
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));

  try {
    return await fn(pagina, erroresJs);
  } finally {
    await contexto.close();
  }
}

async function entrar(pagina, usuario) {
  await pagina.goto(`${url}/login`, { waitUntil: 'domcontentloaded' });
  await pagina.fill('input[name="email"]', usuario.email);
  await pagina.fill('input[name="password"]', fixtures.CLAVE);
  await Promise.all([
    pagina.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }),
    pagina.click('#login-btn'),
  ]);
}

function e2e(nombre, fn) {
  test(nombre, async (t) => {
    if (!listo) return t.skip(motivoSalto || 'entorno e2e no disponible');
    await conPagina(fn);
  });
}

// ---------------------------------------------------------------
// 1. CEO: login -> indicadores -> exporta PDF
// ---------------------------------------------------------------

e2e('CEO entra, ve los indicadores cargados y descarga el PDF', async (pagina, erroresJs) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);

  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });

  // Los KPI arrancan en '—' y se llenan cuando responde la API. Si se
  // quedan en el guion, el panel no cargo.
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );

  const ejecutado = await pagina.textContent('#cst-kpi-ejecutado');
  const presupuesto = await pagina.textContent('#cst-kpi-presupuesto');
  assert.match(ejecutado, /^\$/, `KPI de ejecutado sin formato: "${ejecutado}"`);
  assert.match(presupuesto, /^\$/, `KPI de presupuesto sin formato: "${presupuesto}"`);
  assert.ok(!/NaN|undefined/.test(ejecutado + presupuesto), 'los KPI muestran NaN/undefined');

  // Las tarjetas de indicadores estan pintadas: una por cada indicador del
  // catalogo. Se compara contra INDICATOR_DEFS (la lista real del front) y
  // no contra un numero fijo — el catalogo se ha recortado varias veces a
  // pedido (se retiraron indicadores que ya no se usaban), y un umbral
  // escrito a mano deja la prueba en rojo por un cambio deliberado en vez
  // de por un fallo (paso: esperaba >= 10 y quedaron 8).
  // Se pasa como CADENA y no como funcion: INDICATOR_DEFS es un `const` de
  // nivel superior de costeo-indicadores.js, o sea que vive en el ambito del
  // script y NO es una propiedad de window (window.INDICATOR_DEFS es
  // undefined). Ademas, escrito como funcion, eslint lo marcaria como
  // variable no definida: este archivo se lintea como Node, y esa linea
  // corre dentro del navegador.
  const esperadas = await pagina.evaluate('INDICATOR_DEFS.length');
  const tarjetas = await pagina.locator('#cst-indicators-grid .cst-ind-card').count();
  assert.ok(esperadas > 0, 'el catalogo de indicadores no deberia estar vacio');
  assert.strictEqual(tarjetas, esperadas, `se esperaba una tarjeta por indicador (${esperadas}) y hay ${tarjetas}`);

  // Descarga real del PDF.
  const [descarga] = await Promise.all([
    pagina.waitForEvent('download', { timeout: 30000 }),
    pagina.click('#cst-export-pdf'),
  ]);
  const nombre = descarga.suggestedFilename();
  assert.match(nombre, /\.pdf$/, `el archivo descargado no es un PDF: ${nombre}`);

  const ruta = await descarga.path();
  const bytes = require('node:fs').readFileSync(ruta);
  assert.strictEqual(bytes.subarray(0, 4).toString(), '%PDF', 'el archivo no tiene cabecera de PDF');

  const { textoDePdf } = require('../helpers/pdf');
  const texto = textoDePdf(bytes);
  assert.match(texto, /Indicadores/i, 'el PDF descargado no trae el reporte');

  assert.deepStrictEqual(erroresJs, [], `errores de JS en la pagina:\n${erroresJs.join('\n')}`);
});

// ---------------------------------------------------------------
// 2. PM: ve solo lo suyo, registra un gasto, y el cambio se refleja
// ---------------------------------------------------------------

e2e('un PM solo ve su proyecto en el selector de centros', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });

  await pagina.waitForFunction(
    () => document.querySelectorAll('#cst-f-centro option').length > 0,
    { timeout: 25000 }
  );

  const opciones = await pagina.locator('#cst-f-centro option').allTextContents();
  const textoPagina = await pagina.content();

  assert.ok(opciones.some((o) => /Alfa/i.test(o)), `el PM no ve su propio proyecto: ${opciones}`);
  for (const ajeno of ['Proyecto Beta', 'Proyecto Gamma']) {
    assert.ok(!opciones.some((o) => o.includes(ajeno)), `el selector muestra "${ajeno}"`);
    assert.ok(!textoPagina.includes(ajeno), `la pagina del PM menciona "${ajeno}"`);
  }
});

// El encabezado tenía un breadcrumb, un título ("Todos los proyectos") y
// un subtítulo con el conteo de centros; se quitaron el 10 sep 2026 a
// pedido explícito y quedó solo el logo con los KPIs. La prueba que
// verificaba el texto del breadcrumb se fue con él.
//
// Lo que sí sigue importando es que quitarlos no dejara JS roto:
// renderHeader() escribía en #cst-header-sub sin comprobar que existiera.
e2e('el encabezado sin breadcrumb ni título no rompe el JS de ninguna pantalla', async (pagina, erroresJs) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);

  for (const ruta of [
    '/costeo?panel=comercial',
    '/costeo?panel=alertas',
    '/costeo?panel=equipo-gastos&subtab=historial',
    '/costeo?panel=indicadores',
  ]) {
    await pagina.goto(`${url}${ruta}`, { waitUntil: 'networkidle' });
    assert.strictEqual(
      await pagina.locator('#cst-breadcrumb').count(), 0,
      `el breadcrumb sigue en el DOM en ${ruta}`
    );
    // Los KPIs viven en el mismo encabezado: si el borrado se hubiera
    // llevado de más, esto lo caza.
    assert.strictEqual(
      await pagina.locator('#cst-kpi-presupuesto').count(), 1,
      `se perdieron los KPIs del encabezado en ${ruta}`
    );
  }

  assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
});

// "Ayuda visible" era un botón muerto: existía en el menú desde siempre y
// no tenía ningún listener (31 ago 2026).
e2e('"Ayuda visible" apaga y enciende los textos de ayuda, y recuerda la preferencia', async (pagina, erroresJs) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);

  // Comercial es hoy la ÚNICA pantalla con textos de ayuda: entre el 10 y el
  // 11 sep 2026 se eliminaron, todos a pedido explícito, los de Historial,
  // Costo No Planeado, Catálogo de Cargos, Accesos y Configuración — y con
  // el de Costo No Planeado se fue .cst-gasto-aviso, que era el "aviso que NO
  // se apaga" con el que se comprobaba la otra mitad de este caso. Si algún
  // día también salen los de Comercial, este e2e se queda sin sujeto: lo que
  // corresponde entonces es borrarlo junto con el botón, no buscarle otro.
  //
  // .first(): el panel tiene tres .cst-module-desc (Top 3, Simulador y tabla
  // de viabilidad) y el localizador sería ambiguo sin esto.
  await pagina.goto(`${url}/costeo?panel=comercial`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-help-btn', { timeout: 10000 });
  const ayuda = pagina.locator('#cst-panel-comercial .cst-module-desc').first();
  assert.strictEqual(await ayuda.isVisible(), true, 'la ayuda arranca encendida');

  await pagina.click('#cst-help-btn');
  await pagina.waitForFunction(() => document.body.classList.contains('is-ayuda-oculta'), { timeout: 5000 });
  assert.strictEqual(await ayuda.isVisible(), false, 'la ayuda debió apagarse');

  // Y sigue apagada al cambiar de pantalla, no solo en la que se apagó.
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-help-btn', { timeout: 10000 });
  assert.strictEqual(
    await pagina.evaluate(() => document.body.classList.contains('is-ayuda-oculta')), true,
    'la ayuda debió seguir apagada en otra pantalla'
  );

  await pagina.goto(`${url}/costeo?panel=comercial`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-help-btn', { timeout: 10000 });

  await pagina.click('#cst-help-btn');
  await pagina.waitForFunction(() => !document.body.classList.contains('is-ayuda-oculta'), { timeout: 5000 });
  assert.strictEqual(await ayuda.isVisible(), true, 'y volver al encenderla');

  // Se deja apagada para comprobar abajo que la preferencia persiste.
  await pagina.click('#cst-help-btn');
  await pagina.waitForFunction(() => document.body.classList.contains('is-ayuda-oculta'), { timeout: 5000 });

  // La preferencia sobrevive a recargar la página.
  await pagina.reload({ waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-help-btn', { timeout: 10000 });
  assert.strictEqual(
    await pagina.evaluate(() => document.body.classList.contains('is-ayuda-oculta')), true,
    'debió recordar que la ayuda estaba apagada'
  );

  assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
});

e2e('el filtro Recurso no se muestra en ningun panel; Periodo solo en Indicadores', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);

  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.querySelectorAll('#cst-f-centro option').length > 0,
    { timeout: 25000 }
  );
  // Casi ningún indicador tiene sentido recortado a una sola persona
  // ("Personas Trabajando" siempre daría 1) — Periodo si se conserva.
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-recurso-wrap'), true,
    'Indicadores ya no deberia mostrar Recurso'
  );
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-periodo-wrap'), false,
    'Indicadores si conserva Periodo'
  );

  // Alertas fue el ultimo panel que conservaba Recurso (habia alertas
  // puntuales de una persona, como "sin costo/hora registrado"), y se quito
  // tambien a pedido explicito el 8 sep 2026 (commit 8942b5b). Periodo salio
  // el 11 sep 2026, igual de explicito: una alerta abierta lo esta hoy, no
  // "en Agosto" — recortarla por mes escondia avisos vigentes. Con los dos
  // fuera, la barra entera de filtros desaparece de esta pantalla.
  await pagina.goto(`${url}/costeo?panel=alertas`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-alertas-grid', { state: 'visible', timeout: 25000 });
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-recurso-wrap'), true,
    'Alertas tampoco deberia mostrar Recurso'
  );
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-periodo-wrap'), true,
    'Alertas ya no deberia mostrar Periodo'
  );

  await pagina.goto(`${url}/costeo?panel=comercial`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-com-table', { state: 'visible', timeout: 25000 });
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-recurso-wrap'), true,
    'Comercial lista proyectos, no personas: Recurso no deberia verse'
  );
  // El selector de Proyecto se ve SIEMPRE, en todas las pantallas: se movio
  // al encabezado y dejo de ocultarse por panel (ver el comentario de
  // aplicarVisibilidadFiltros en costeo-indicadores.js, y las ~8 aserciones
  // de frontend-componentes.test.js que lo fijan panel por panel).
  //
  // Esta linea exigia lo contrario y se quedo vieja cuando se hizo ese
  // cambio: era el unico sitio del repo que seguia esperando que se
  // ocultara, y hacia fallar `npm run test:e2e` de forma permanente.
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-centro-wrap'), false,
    'el selector de Proyecto vive en el encabezado y no se oculta en ningun panel'
  );
  // Comercial no deja NINGUNO de los tres filtros globales: tiene su propio
  // selector de Proyecto dentro del panel, y recortar por periodo el margen
  // de un contrato (que es del proyecto entero) no significaba nada. Mismo
  // criterio que fija aplicarVisibilidadFiltros en las pruebas unitarias.
  assert.strictEqual(
    await pagina.isHidden('#cst-filter-periodo-wrap'), true,
    'Comercial tampoco deberia mostrar Periodo'
  );
});

// 28 ago 2026, a pedido explícito: "+ Agregar rol" en el Simulador es solo
// un ensayo — este botón lo lleva al formulario REAL de Equipo del
// Proyecto con Centro/Cargo/Costo-hora ya puestos, para poder contratar de
// verdad a quien estaba simulando.
e2e('Simulador: "+ Agregar al equipo" lleva el rol simulado al formulario real de Equipo del Proyecto', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);
  await pagina.goto(`${url}/costeo?panel=comercial`, { waitUntil: 'networkidle' });

  await pagina.waitForFunction(
    () => document.querySelectorAll('#cst-sim-proyecto option').length > 1,
    { timeout: 25000 }
  );
  await pagina.selectOption('#cst-sim-proyecto', { label: 'Proyecto Alfa' });
  await pagina.waitForSelector('.cst-sim-table', { state: 'visible', timeout: 25000 });

  await pagina.click('[data-sim="rol-add"]');
  await pagina.waitForSelector('[data-sim="rol-contratar"]', { state: 'visible', timeout: 25000 });
  // La fila nueva es la última (ALFA ya trae equipo real antes que ella) —
  // se ubica por posición, no por índice fijo, para no depender de cuántos
  // roles reales tenga el fixture.
  const filaNueva = pagina.locator('.cst-sim-table tbody tr').last();
  await filaNueva.locator('select[data-sim-input="role_catalog"]').selectOption({ label: 'QA' });

  // El costo/hora ya NO se escribe suelto: sale del salario de una persona
  // real (sql/33/34). Primero se elige la persona; como las fixtures cargan
  // hourly_cost pero nunca monthly_salary, esa persona queda "sin salario
  // conocido" y la celda ofrece escribir el salario mensual, que es el
  // camino que de verdad usa un PM cuando contrata a alguien nuevo.
  await filaNueva.locator('select[data-sim-input="employee_id"]')
    .selectOption({ label: fixtures.EMPLEADOS.arturoAlfa.nombre });

  const salarioInput = filaNueva.locator('input[data-sim-input="monthly_salary"]');
  await salarioInput.waitFor({ state: 'visible', timeout: 25000 });
  const SALARIO = 2000000;
  await salarioInput.fill(String(SALARIO));
  await salarioInput.dispatchEvent('change');

  // El costo/hora que debe llegar al formulario real es el que calcula el
  // front: salario / horas de liquidación del mes (configurable, por eso se
  // lee de la página en vez de escribirlo aquí).
  // Cadena, por lo mismo que INDICATOR_DEFS arriba: `state` es del ambito
  // del script del front, no de window.
  const horasMes = await pagina.evaluate('state.horasMes || 210');
  const costoHoraEsperado = String(Math.round(SALARIO / horasMes));

  await filaNueva.locator('[data-sim="rol-contratar"]').click();

  // Termina en Equipo del Proyecto, con el formulario real prellenado.
  await pagina.waitForSelector('#cst-subpanel-equipo-proyecto', { state: 'visible', timeout: 25000 });
  const centroSeleccionado = await pagina.locator('#cst-equipo-centro option:checked').textContent();
  assert.match(centroSeleccionado, /Alfa/i, `deberia quedar en el Centro de Costos que se estaba simulando: ${centroSeleccionado}`);
  assert.strictEqual(await pagina.inputValue('#cst-equipo-role'), 'qa');
  assert.strictEqual(
    await pagina.inputValue('#cst-equipo-hourly-cost'), costoHoraEsperado,
    'el costo/hora deberia venir prellenado con el que calculo el simulador desde el salario'
  );
});

// sql/28 — el gasto que registra el PM es una SOLICITUD: queda 'pendiente'
// y NO mueve el ejecutado hasta que el CEO la aprueba (la aprobación desde
// el navegador va en la prueba de abajo).
e2e('un PM registra un gasto, queda Pendiente y NO mueve el ejecutado hasta aprobarlo', async (pagina, erroresJs) => {
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);

  // Ejecutado ANTES, leido del KPI.
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );
  const soloDigitos = (s) => Number(String(s).replace(/[^\d]/g, ''));
  const antes = soloDigitos(await pagina.textContent('#cst-kpi-ejecutado'));

  // Registrar el gasto desde el formulario real.
  //
  // OJO con el `&subtab=`: el panel "equipo-gastos" tiene sub-pestañas y
  // abre por defecto la que corresponda al rol (defaultEgSubtab). Sin
  // pedir la de Costo No Planeado explicitamente, #cst-form-gasto existe
  // en el DOM pero esta oculto, y waitForSelector espera 25s a un
  // elemento que nunca se muestra.
  await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=costo-no-planeado`, { waitUntil: 'networkidle' });
  // Y ademas hay que ABRIR el modal: el formulario dejo de estar suelto en
  // la pagina y hoy vive dentro de #cst-gasto-modal-overlay, detras del
  // boton "+ Solicitar gasto" (mismo patron que "+ Nuevo centro" y
  // "+ Crear acceso", ver initModales). Estando en el DOM pero oculto,
  // esperarlo directamente agotaba los 25s.
  await pagina.click('[data-modal-abrir="cst-gasto-modal-overlay"]');
  await pagina.waitForSelector('#cst-form-gasto', { state: 'visible', timeout: 25000 });
  await pagina.waitForFunction(
    () => document.querySelectorAll('#cst-gasto-centro option').length > 0,
    { timeout: 25000 }
  );

  const MONTO = 333333;
  await pagina.selectOption('#cst-gasto-centro', String(fixtures.CENTROS.alfa.id));
  await pagina.fill('#cst-gasto-desc', 'Gasto desde el navegador');
  await pagina.fill('#cst-gasto-amount', String(MONTO));
  await pagina.fill('#cst-gasto-date', '2026-08-22');
  await pagina.click('#cst-form-gasto button[type="submit"]');

  // Aparece en la tabla, marcado como Pendiente.
  await pagina.waitForFunction(
    () => document.getElementById('cst-gastos-tbody')?.textContent.includes('Gasto desde el navegador'),
    { timeout: 25000 }
  );
  const estado = await pagina.textContent('#cst-gastos-tbody .cst-gasto-estado');
  assert.strictEqual(estado.trim(), 'Pendiente', 'el gasto del PM deberia nacer pendiente de aprobacion');

  // El PM no puede aprobar su propio gasto: ese boton no existe para el.
  assert.strictEqual(
    await pagina.locator('[data-gasto-aprobar]').count(), 0,
    'el PM no deberia ver el boton de aprobar'
  );

  // Y llego a la base de verdad, pendiente.
  const filas = await db.query(
    'SELECT amount, approval_status FROM mp_costo_no_planeado WHERE description = ?', ['Gasto desde el navegador']
  );
  assert.strictEqual(filas.length, 1, 'el gasto no se guardo en la base');
  assert.strictEqual(Number(filas[0].amount), MONTO);
  assert.strictEqual(filas[0].approval_status, 'pendiente');

  // El ejecutado NO se movio: un gasto pendiente todavia no es dinero.
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );
  const sinAprobar = soloDigitos(await pagina.textContent('#cst-kpi-ejecutado'));
  assert.strictEqual(sinAprobar, antes, `el ejecutado se movio con el gasto sin aprobar: ${antes} -> ${sinAprobar}`);

  // Aprobado (aqui por SQL; la aprobacion desde el navegador va en la
  // prueba siguiente), el mismo gasto SI suma al ejecutado.
  await db.query(
    "UPDATE mp_costo_no_planeado SET approval_status = 'aprobado' WHERE description = ?",
    ['Gasto desde el navegador']
  );
  await pagina.reload({ waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );
  const despues = soloDigitos(await pagina.textContent('#cst-kpi-ejecutado'));
  assert.strictEqual(despues - antes, MONTO, `el ejecutado paso de ${antes} a ${despues}`);

  assert.deepStrictEqual(erroresJs, [], `errores de JS:\n${erroresJs.join('\n')}`);

  await db.resetearDatos();
  await fixtures.sembrar();
});

e2e('el CEO aprueba desde el navegador un gasto pendiente y el estado pasa a Aprobado', async (pagina, erroresJs) => {
  const DESC = 'Gasto pendiente para aprobar';
  const insert = await db.query(
    `INSERT INTO mp_costo_no_planeado (cost_center_id, description, amount, expense_date, category, created_by, approval_status)
     VALUES (?, ?, 777777, '2026-08-23', 'otro', ?, 'pendiente')`,
    [fixtures.CENTROS.alfa.id, DESC, fixtures.USUARIOS.liderAlfa.id]
  );
  const id = insert.insertId;

  try {
    await entrar(pagina, fixtures.USUARIOS.ceo);
    await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=costo-no-planeado`, { waitUntil: 'networkidle' });
    await pagina.waitForSelector(`[data-gasto-aprobar="${id}"]`, { state: 'visible', timeout: 25000 });

    await pagina.click(`[data-gasto-aprobar="${id}"]`);
    // Aprobar mueve dinero, asi que pasa por el modal de confirmacion.
    await pagina.waitForSelector('#cst-confirm-accept', { state: 'visible', timeout: 25000 });
    await pagina.click('#cst-confirm-accept');

    await pagina.waitForFunction(
      (expenseId) => {
        const pill = document.querySelector(`tr[data-gasto-row="${expenseId}"] .cst-gasto-estado`);
        return !!pill && pill.textContent.trim() === 'Aprobado';
      },
      id,
      { timeout: 25000 }
    );

    const [fila] = await db.query(
      'SELECT approval_status, approved_by FROM mp_costo_no_planeado WHERE expense_id = ?', [id]
    );
    assert.strictEqual(fila.approval_status, 'aprobado');
    assert.strictEqual(fila.approved_by, fixtures.USUARIOS.ceo.id);

    assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
  } finally {
    await db.query('DELETE FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  }
});

e2e('el PM decide pagar una hora extra y queda aprobada de una vez, sin paso de admin (26 ago 2026)', async (pagina) => {
  // Auto-aprobación: la decisión del PM YA es la aprobación final, sin
  // segundo paso de admin/ceo. Verifica que el ejecutado suba con solo la
  // decisión del PM, y que un intento posterior de aprobar (por si algún
  // cliente viejo del front todavía lo llama) no vuelva a escribir el costo.
  const id = fixtures.OVERTIME.alfaSinDecidir.id;
  const potencial = fixtures.OVERTIME.alfaSinDecidir.potencial;
  const soloDigitos = (s) => Number(String(s).replace(/[^\d]/g, ''));

  await entrar(pagina, fixtures.USUARIOS.liderAlfa);
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );
  const antes = soloDigitos(await pagina.textContent('#cst-kpi-ejecutado'));

  const decision = await pagina.evaluate(async (decisionId) => {
    const r = await fetch(`/api/costeo/overtime/${decisionId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'si', motivo: 'interno', calidad: false }),
    });
    return { status: r.status, body: await r.json() };
  }, id);
  assert.strictEqual(decision.status, 200, 'el PM no pudo decidir su propia hora extra');
  assert.strictEqual(decision.body.approval_status, 'aprobado', 'decidir "si" debe dejarla aprobada de una vez');

  // Ya no queda nada por aprobar: admin/ceo intentando /approve sobre una
  // fila que la decisión del PM ya cerró debe rechazarse, no repetir el costo.
  const intentoAdmin = await conPagina(async (paginaAdmin) => {
    await entrar(paginaAdmin, fixtures.USUARIOS.admin);
    return paginaAdmin.evaluate(async (decisionId) => {
      const r = await fetch(`/api/costeo/overtime/${decisionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      return r.status;
    }, id);
  });
  assert.strictEqual(intentoAdmin, 409, 'no debería quedar nada por aprobar tras la decisión del PM');

  await pagina.reload({ waitUntil: 'networkidle' });
  await pagina.waitForFunction(
    () => document.getElementById('cst-kpi-ejecutado')?.textContent.trim() !== '—',
    { timeout: 25000 }
  );
  const despues = soloDigitos(await pagina.textContent('#cst-kpi-ejecutado'));
  assert.strictEqual(despues - antes, potencial, `el ejecutado pasó de ${antes} a ${despues}`);

  await db.resetearDatos();
  await fixtures.sembrar();
});

e2e('en Horas Extra, solo se listan las filas aprobadas, en verde, sin columna de Acciones (31 ago 2026)', async (pagina, erroresJs) => {
  // Para Ana (ALFA) hay 2 filas con pm_decision 'si' (alfaAprobada semana
  // 2, alfaPendiente semana 3 -- esta última es una fila vieja con
  // approval_status='pendiente' de antes del 26 ago 2026, y justamente por
  // eso prueba que la pill ya no depende de esa columna). alfaSinDecidir
  // (semana 4, pm_decision='pendiente') NO debe verse.
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);
  await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=horas-extra`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-overtime-tbody tr', { timeout: 20000 });

  // Las columnas "Decisión PM" y "Aprobación" desaparecieron de la tabla:
  // desde que solo se listan filas ya aprobadas, repetir "Sí paga" y
  // "Aprobado" en cada fila no aportaba nada, y en su lugar entraron los
  // datos del alta manual (fecha/turno y tipo de hora). Que esas dos
  // columnas NO vuelvan lo cubre tambien renderOvertimeTable en
  // test/unit/frontend-componentes.test.js.
  const encabezados = await pagina.locator('#cst-overtime-table thead th').allTextContents();
  assert.deepStrictEqual(encabezados, ['Talento', 'Proyecto', 'Semana', 'Fecha y turno', 'Tipo de hora', 'Extra', 'Costo']);
  assert.strictEqual(await pagina.locator('[data-overtime-decide], [data-overtime-edit], [data-overtime-delete]').count(), 0);

  const filas = pagina.locator('#cst-overtime-tbody tr');
  await filas.first().waitFor({ timeout: 10000 });
  const semanas = await filas.locator('td:nth-child(3)').allTextContents();
  assert.deepStrictEqual(semanas.sort(), ['2', '3'], `esperaba solo las semanas 2 y 3 (aprobadas): ${semanas}`);

  // La que NO esta aprobada (semana 4, pm_decision 'pendiente') es la que
  // de verdad importa: si algun dia se colara, esta tabla estaria mostrando
  // como pagadas horas que nadie aprobo.
  assert.ok(!semanas.includes('4'), `la semana 4 no esta aprobada y no deberia listarse: ${semanas}`);

  assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
});

e2e('en Horas Extra, el admin ve la columna Acciones con Eliminar en cada fila aprobada (17 sep 2026)', async (pagina, erroresJs) => {
  // Para el admin no hay restricción de Pendiente: es la vía para quitar un
  // registro hecho por error (a pedido explícito). El líder/PM no ve estos
  // botones — lo cubre la prueba de arriba (con Ana).
  await entrar(pagina, fixtures.USUARIOS.admin);
  await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=horas-extra`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-overtime-tbody tr', { timeout: 20000 });

  const encabezados = await pagina.locator('#cst-overtime-table thead th').allTextContents();
  assert.deepStrictEqual(
    encabezados,
    ['Talento', 'Proyecto', 'Semana', 'Fecha y turno', 'Tipo de hora', 'Extra', 'Costo', 'Acciones'],
    `encabezados inesperados: ${encabezados}`
  );

  // alfaAprobada (2), alfaPendiente-decidida (3) y betaAprobada (2): las 3
  // filas con pm_decision='si' del fixture deben tener su botón Eliminar.
  const botones = pagina.locator('#cst-overtime-tbody [data-overtime-delete]');
  const cuantos = await botones.count();
  assert.strictEqual(cuantos, 3, `el admin debería ver 3 filas aprobadas con Eliminar: ${cuantos}`);
  const textos = await botones.allTextContents();
  assert.ok(textos.every((t) => t === 'Eliminar'), `botones inesperados: ${textos}`);

  assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
});

e2e('en Horas Extra, el modal no se cierra al registrar y el mini-historial permite eliminar (17 sep 2026)', async (pagina, erroresJs) => {
  // A pedido explícito: registrar varias horas extra seguidas sin que el
  // modal se cierre con cada alta, y corregir un error desde el
  // mini-historial "Registrados en esta sesión". Ana (líder ALFA) registra a
  // mano y borra lo suyo (approved_by = quien registró), aunque el alta
  // manual ya nazca aprobada.
  await entrar(pagina, fixtures.USUARIOS.liderAlfa);
  await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=horas-extra`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#cst-overtime-tbody tr', { timeout: 20000 });

  await pagina.click('#cst-btn-nueva-overtime');
  await pagina.waitForSelector('#cst-overtime-modal-overlay', { state: 'visible', timeout: 20000 });

  // ALFA / Alicia, turno 18:00 → 21:00 del 29 ago 2026 (semana 5): no choca
  // con ninguna fila sembrada (las fixtures están en semanas 2, 3 y 4).
  await pagina.selectOption('#cst-overtime-centro', fixtures.CENTROS.alfa.id.toString());
  await pagina.selectOption('#cst-overtime-employee', fixtures.EMPLEADOS.aliceAlfa.id.toString());
  await pagina.fill('#cst-overtime-inicio-fecha', '2026-08-29');
  await pagina.selectOption('#cst-overtime-inicio-hora', '18');
  await pagina.selectOption('#cst-overtime-inicio-min', '00');
  await pagina.fill('#cst-overtime-fin-fecha', '2026-08-29');
  await pagina.selectOption('#cst-overtime-fin-hora', '21');
  await pagina.selectOption('#cst-overtime-fin-min', '00');

  await Promise.all([
    pagina.waitForResponse((r) => r.url().includes('/api/costeo/overtime') && r.request().method() === 'POST' && r.status() === 201, { timeout: 20000 }),
    pagina.click('#cst-form-overtime button[type="submit"]'),
  ]);

  // El modal SIGUE abierto y el mini-historial muestra la fila con Eliminar.
  await pagina.waitForSelector('#cst-overtime-modal-overlay', { state: 'visible', timeout: 20000 });
  const seccion = pagina.locator('#cst-overtime-sesion');
  await seccion.waitFor({ state: 'visible', timeout: 10000 });
  let items = pagina.locator('#cst-overtime-sesion-list .cst-overtime-sesion-item');
  assert.strictEqual(await items.count(), 1, 'una sola alta en el mini-historial');
  assert.match(await items.first().textContent(), /Alicia/);
  assert.strictEqual(await items.first().locator('[data-overtime-sesion-delete]').count(), 1);

  // Eliminar la fila desde el mini-historial: desaparece y el modal sigue abierto.
  await pagina.click('#cst-overtime-sesion-list [data-overtime-sesion-delete]');
  await pagina.waitForSelector('#cst-confirm-overlay', { state: 'visible', timeout: 10000 });
  await Promise.all([
    pagina.waitForResponse((r) => /\/api\/costeo\/overtime\/\d+/.test(r.url()) && r.request().method() === 'DELETE' && r.ok(), { timeout: 20000 }),
    pagina.click('#cst-confirm-accept'),
  ]);
  await pagina.waitForFunction(
    () => document.getElementById('cst-overtime-sesion-list').childElementCount === 0,
    { timeout: 10000 }
  );
  assert.strictEqual(await seccion.isHidden(), true, 'sin filas la sección se oculta');
  assert.strictEqual(
    await pagina.locator('#cst-overtime-modal-overlay').isVisible(), true,
    'el modal debe seguir abierto para seguir registrando'
  );

  assert.deepStrictEqual(erroresJs, [], `errores de JS: ${erroresJs.join(' | ')}`);
});

// ---------------------------------------------------------------
// 3. XSS almacenado (regresion)
// ---------------------------------------------------------------

e2e('REGRESION XSS: un gasto con <img onerror> se muestra escapado, no se ejecuta', async (pagina, erroresJs) => {
  // Fue un XSS almacenado real: las tablas pintaban con innerHTML sin
  // escapar, asi que un PM podia guardar esto y el codigo se ejecutaba en
  // el navegador del CEO — la cuenta con mas permisos.
  const PAYLOAD = '<img src=x onerror="window.__XSS_EJECUTADO=true">';

  await db.query(
    `INSERT INTO mp_costo_no_planeado (cost_center_id, description, amount, expense_date, category, created_by)
     VALUES (?, ?, ?, ?, 'otro', ?)`,
    [fixtures.CENTROS.alfa.id, PAYLOAD, 4242, '2026-08-21', fixtures.USUARIOS.ceo.id]
  );

  try {
    await entrar(pagina, fixtures.USUARIOS.ceo);
    await pagina.goto(`${url}/costeo?panel=equipo-gastos&subtab=costo-no-planeado`, { waitUntil: 'networkidle' });
    await pagina.waitForFunction(
      () => (document.getElementById('cst-gastos-tbody')?.textContent || '').includes('onerror'),
      { timeout: 25000 }
    );

    // 1) El payload NO se ejecuto.
    const ejecutado = await pagina.evaluate(() => window.__XSS_EJECUTADO === true);
    assert.strictEqual(ejecutado, false, 'EL XSS SE EJECUTO: el onerror corrio en el navegador');

    // 2) No se creo ninguna etiqueta <img> a partir del dato.
    const imgs = await pagina.evaluate(
      () => document.querySelectorAll('#cst-gastos-tbody img').length
    );
    assert.strictEqual(imgs, 0, 'el payload se convirtio en una etiqueta <img> real');

    // 3) Se ve como TEXTO: el usuario lee lo que escribio.
    const texto = await pagina.textContent('#cst-gastos-tbody');
    assert.ok(texto.includes(PAYLOAD), `el gasto no se muestra literal: ${texto.slice(0, 200)}`);

    // 4) En el HTML aparece escapado.
    const html = await pagina.innerHTML('#cst-gastos-tbody');
    assert.ok(html.includes('&lt;img'), 'el payload no quedo escapado en el HTML');
    assert.ok(!html.includes('<img src=x'), 'el payload quedo crudo en el HTML');

    assert.deepStrictEqual(erroresJs, [], `errores de JS:\n${erroresJs.join('\n')}`);
  } finally {
    await db.query('DELETE FROM mp_costo_no_planeado WHERE description = ?', [PAYLOAD]);
  }
});

e2e('REGRESION XSS: tambien en el nombre de un proyecto y en el historial', async (pagina) => {
  // Otros dos caminos por donde el mismo dato llega a innerHTML.
  const PAYLOAD = '<svg onload="window.__XSS2=true">';

  await db.query('UPDATE mp_centro_costo SET project_name = ? WHERE cost_center_id = ?', [
    PAYLOAD, fixtures.CENTROS.gamma.id,
  ]);

  try {
    await entrar(pagina, fixtures.USUARIOS.ceo);
    await pagina.goto(`${url}/costeo?panel=centro-costos`, { waitUntil: 'networkidle' });
    await pagina.waitForTimeout(2000);

    assert.strictEqual(
      await pagina.evaluate(() => window.__XSS2 === true), false,
      'EL XSS SE EJECUTO desde el nombre del proyecto'
    );
    assert.strictEqual(
      await pagina.evaluate(() => document.querySelectorAll('svg[onload]').length), 0,
      'el payload se convirtio en un <svg> real'
    );
  } finally {
    await db.resetearDatos();
    await fixtures.sembrar();
  }
});

// ---------------------------------------------------------------
// 4. Sesion: cookie manipulada o ausente -> /login
// ---------------------------------------------------------------

e2e('sin sesion, /costeo redirige a /login', async (pagina) => {
  await pagina.goto(`${url}/costeo`, { waitUntil: 'domcontentloaded' });
  assert.match(pagina.url(), /\/login$/, `deberia estar en /login y esta en ${pagina.url()}`);
  await pagina.waitForSelector('#login-form');
});

e2e('con la cookie manipulada, la app devuelve al login', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });

  // Se corrompe la firma de la cookie sin borrarla.
  const contexto = pagina.context();
  const cookies = await contexto.cookies();
  const sesion = cookies.find((c) => c.name === 'gtc.sid');
  assert.ok(sesion, 'no se encontro la cookie de sesion');

  await contexto.clearCookies();
  await contexto.addCookies([{ ...sesion, value: `${sesion.value.slice(0, -4)}XXXX` }]);

  await pagina.goto(`${url}/costeo`, { waitUntil: 'domcontentloaded' });
  assert.match(pagina.url(), /\/login$/, 'una cookie con firma invalida siguio dando acceso');
});

e2e('tras cerrar sesion, volver atras en el navegador no da acceso', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });

  await pagina.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));

  // El HTML puede venir de la cache del navegador, pero la API ya no
  // responde: es lo que decide si el usuario ve datos o no.
  const estado = await pagina.evaluate(async () => (await fetch('/api/costeo/centros')).status);
  assert.strictEqual(estado, 401, 'la API siguio respondiendo tras el logout');

  await pagina.goto(`${url}/costeo`, { waitUntil: 'domcontentloaded' });
  assert.match(pagina.url(), /\/login$/, 'tras el logout deberia redirigir a /login');
});

e2e('la cookie de sesion no es accesible desde JavaScript (HttpOnly)', async (pagina) => {
  await entrar(pagina, fixtures.USUARIOS.ceo);
  const visible = await pagina.evaluate(() => document.cookie);
  assert.ok(!visible.includes('gtc.sid'), `la cookie es legible desde JS: ${visible}`);
});

e2e('la CSP bloquea un script inline inyectado en la pagina', async (pagina) => {
  // Segunda linea de defensa del XSS: aunque algo se colara, el navegador
  // se niega a ejecutarlo.
  await entrar(pagina, fixtures.USUARIOS.ceo);
  await pagina.goto(`${url}/costeo?panel=indicadores`, { waitUntil: 'networkidle' });

  const ejecutado = await pagina.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__CSP_BURLADA = true;';
    document.body.appendChild(s);
    return window.__CSP_BURLADA === true;
  });
  assert.strictEqual(ejecutado, false, 'la CSP permitio ejecutar un script inline');
});
