'use strict';

/**
 * Prueba del nodo Code "Parsear hojas" (02-parsear-hojas.js).
 *
 * Compara el parser portado a n8n contra el parser REAL de la carga manual
 * (src/queries/costo-task-facts-upload.js) sobre las MISMAS filas. Si los dos
 * no coinciden, el automatico y el manual darian numeros distintos, que es
 * justo lo que no puede pasar.
 *
 * Correr con:  node --test docs/n8n/wf-costeo/02-parsear-hojas.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const { parsearFilas } = require('../../../src/queries/costo-task-facts-upload');

// El archivo del nodo termina con codigo propio de n8n ($input, return al
// nivel superior) que no es evaluable aqui. Se corta en el marcador y se
// evalua solo la parte de funciones puras — la misma que corre en n8n.
function cargarParserDeN8n() {
  const src = fs.readFileSync(path.join(__dirname, '02-parsear-hojas.js'), 'utf8');
  const corte = src.indexOf('// ---- n8n:');
  assert.ok(corte > 0, 'no se encontro el marcador de la seccion de n8n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(0, corte)}; return { parsearHoja };`)();
}

const { parsearHoja } = cargarParserDeN8n();

// Cabecera real del template: seccion agrupada en la fila 1, encabezados en
// la 2, subtitulos en cursiva en la 3, datos desde la 4.
const FILA_SECCION = ['IDENTIFICACION', '', '', '', '', '', 'TIEMPOS Y EJECUCION', '', '', '', '', '', '', '', '', 'RESULTADO', '', '', ''];
const FILA_ENCABEZADO = ['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'A Cargo De', 'Observaciones'];
const FILA_SUBTITULO = ['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Elige responsable', 'Motivo'];

// Numero de serie de Excel, que es como Microsoft Graph devuelve las fechas
// en usedRange.values.
function serieExcel(iso) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Las mismas filas en los dos formatos: worksheet de ExcelJS y values de Graph. */
function construirHoja(filasDatos, nombreHoja = 'Septiembre') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(nombreHoja);
  ws.addRow(FILA_SECCION);
  ws.addRow(FILA_ENCABEZADO);
  ws.addRow(FILA_SUBTITULO);

  const values = [FILA_SECCION, FILA_ENCABEZADO, FILA_SUBTITULO];
  for (const f of filasDatos) {
    // ExcelJS recibe Date; Graph entrega el numero de serie.
    ws.addRow(f.map((v) => (v && v.fecha ? new Date(`${v.fecha}T00:00:00Z`) : v)));
    values.push(f.map((v) => (v && v.fecha ? serieExcel(v.fecha) : v)));
  }
  return { ws, values };
}

// Campos que deben coincidir exactamente entre los dos parsers.
const CAMPOS = [
  'week_number', 'project_name', 'activity', 'planned_type', 'budgeted_hours',
  'hours_monday', 'hours_tuesday', 'hours_wednesday', 'hours_thursday',
  'hours_friday', 'hours_saturday', 'total_executed_hours',
  'task_status', 'observations', 'month_number', 'year_number',
];

function comparar(filasDatos, nombreHoja) {
  const { ws, values } = construirHoja(filasDatos, nombreHoja);
  const dellApp = parsearFilas(ws);
  const deN8n = parsearHoja(values, ws.name);
  assert.strictEqual(deN8n.length, dellApp.length, 'distinta cantidad de filas');
  for (let i = 0; i < dellApp.length; i++) {
    for (const campo of CAMPOS) {
      assert.deepStrictEqual(deN8n[i][campo], dellApp[i][campo],
        `fila ${i}, campo ${campo}: n8n=${deN8n[i][campo]} app=${dellApp[i][campo]}`);
    }
  }
  return { dellApp, deN8n };
}

test('fila normal: n8n y la carga manual dan lo mismo', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'Reunion de arranque', 'P', 4, { fecha: '2026-08-28' }, { fecha: '2026-08-28' }, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily Tench', ''],
  ]);
  assert.strictEqual(deN8n[0].project_name, 'SURA');
  assert.strictEqual(deN8n[0].hours_monday, 4);
  assert.strictEqual(deN8n[0].month_number, 9);
  assert.strictEqual(deN8n[0].year_number, 2026);
});

test('semana 5 de septiembre con fecha de octubre sigue siendo de septiembre', () => {
  const { deN8n } = comparar([
    [1, 5, 'Notificaciones (Transversales)', 'A', 'P', 1, { fecha: '2026-10-02' }, { fecha: '2026-10-02' }, 0, 0, 0, 0, 1, 0, 1, 'Terminado', '', 'Thomas', ''],
  ], 'Septiembre');
  assert.strictEqual(deN8n[0].month_number, 9);
  assert.strictEqual(deN8n[0].year_number, 2026);
});

test('una semana que cruza de año conserva el año de la pestaña', () => {
  const diciembre = comparar([
    [1, 5, 'SURA', 'A', 'P', 1, { fecha: '2027-01-01' }, null, 0, 0, 0, 0, 1, 0, 1, 'Terminado', '', 'Ana', ''],
  ], 'Diciembre');
  assert.strictEqual(diciembre.deN8n[0].month_number, 12);
  assert.strictEqual(diciembre.deN8n[0].year_number, 2026);

  const enero = comparar([
    [1, 1, 'SURA', 'A', 'P', 1, { fecha: '2026-12-30' }, null, 0, 0, 1, 0, 0, 0, 1, 'Terminado', '', 'Ana', ''],
  ], 'Enero');
  assert.strictEqual(enero.deN8n[0].month_number, 1);
  assert.strictEqual(enero.deN8n[0].year_number, 2027);
});

test('el nombre de la pestaña se reconoce con mayúsculas y espacios', () => {
  const { deN8n } = comparar([
    [1, 2, 'SURA', 'A', 'P', 1, { fecha: '2026-10-13' }, null, 0, 1, 0, 0, 0, 0, 1, 'Terminado', '', 'Ana', ''],
  ], ' OCTUBRE ');
  assert.strictEqual(deN8n[0].month_number, 10);
});

test('si la hoja no se llama como un mes, el mes sale de la fecha', () => {
  const { deN8n } = comparar([
    [1, 2, 'SURA', 'A', 'P', 1, { fecha: '2026-10-13' }, null, 0, 1, 0, 0, 0, 0, 1, 'Terminado', '', 'Ana', ''],
  ], 'Semanal');
  assert.strictEqual(deN8n[0].month_number, 10);
  assert.strictEqual(deN8n[0].year_number, 2026);
});

test('varios proyectos en el mismo archivo', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'P', 4, { fecha: '2026-08-28' }, { fecha: '2026-08-28' }, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily', ''],
    [2, 4, 'Habilitador', 'B', 'P', 3, { fecha: '2026-08-28' }, { fecha: '2026-08-28' }, 0, 3, 0, 0, 0, 0, 3, 'Terminado', '100%', 'Emily', ''],
  ]);
  assert.deepStrictEqual(deN8n.map((f) => f.project_name), ['SURA', 'Habilitador']);
});

test('la fila de subtitulos en cursiva no entra como dato', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'P', 4, { fecha: '2026-08-28' }, { fecha: '2026-08-28' }, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily', ''],
  ]);
  assert.ok(!deN8n.some((f) => f.project_name === 'Elige proyecto'));
});

test('P/NP: cualquier cosa distinta de NP cae en P', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'NP', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
    [2, 4, 'SURA', 'B', '', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ]);
  assert.strictEqual(deN8n[0].planned_type, 'NP');
  assert.strictEqual(deN8n[1].planned_type, 'P');
});

test('sin fechas toma el mes de la pestaña y no inventa el año', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'P', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ]);
  assert.strictEqual(deN8n[0].month_number, 9);
  assert.strictEqual(deN8n[0].year_number, null);
});

test('sin fechas y sin pestaña de mes no inventa mes ni año', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'P', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ], 'Semanal');
  assert.strictEqual(deN8n[0].month_number, null);
  assert.strictEqual(deN8n[0].year_number, null);
});

test('la fecha en numero de serie de Graph sale como YYYY-MM-DD para MySQL', () => {
  const { deN8n } = comparar([
    [1, 4, 'SURA', 'A', 'P', 4, { fecha: '2026-09-15' }, { fecha: '2026-09-18' }, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ]);
  assert.strictEqual(deN8n[0].estimated_delivery_date, '2026-09-15');
  assert.strictEqual(deN8n[0].actual_delivery_date, '2026-09-18');
});

test('encabezado con el icono de filtro de Excel pegado igual se reconoce', () => {
  const values = [
    FILA_SECCION,
    FILA_ENCABEZADO.map((h) => (h === 'Proyecto' ? '🔽 Proyecto' : (h === 'Semana' ? 'Semana 🔽' : h))),
    FILA_SUBTITULO,
    [1, 4, 'SURA', 'A', 'P', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ];
  const filas = parsearHoja(values);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].project_name, 'SURA');
});

test('hoja auxiliar sin columna Proyecto se salta sin romper', () => {
  assert.deepStrictEqual(parsearHoja([['Control de Cambios'], ['Fecha', 'Quien']]), []);
  assert.deepStrictEqual(parsearHoja([]), []);
});

test('hoja con columna Proyecto pero SIN columna Semana no entra como datos', () => {
  // Caso real: hojas de referencia con la lista de proyectos validos.
  const values = [
    ['Proyecto', 'Responsable'],
    ['SURA', 'Emily'],
    ['MIA', 'Juan'],
  ];
  assert.deepStrictEqual(parsearHoja(values), []);
});

test('el encabezado puede estar muy abajo (bloques por semana arriba)', () => {
  const values = [];
  for (let i = 0; i < 40; i++) values.push(['resumen', i]);
  values.push(FILA_ENCABEZADO, FILA_SUBTITULO,
    [1, 9, 'MIA', 'A', 'P', 2, null, null, 2, 0, 0, 0, 0, 0, 2, 'En curso', '', 'Ana', '']);
  const filas = parsearHoja(values);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].project_name, 'MIA');
});

// ---------------------------------------------------------------
// La parte de n8n (10 nov 2026): en el lienzo real el nodo anterior se llama
// "Resolver hoja del mes1". Con el nombre fijo sin el 1, itemMatching()
// fallaba en todas las hojas y la corrida terminaba "bien" sin ninguna fila.
// ---------------------------------------------------------------
function correrNodoN8n({ nodosExistentes, respuestas, contexto }) {
  const src = fs.readFileSync(path.join(__dirname, '02-parsear-hojas.js'), 'utf8');
  const sinExport = src.slice(0, src.lastIndexOf('module.exports'));
  const $ = (nombre) => {
    if (!nodosExistentes.includes(nombre)) throw new Error(`Referenced node doesn't exist: ${nombre}`);
    return { all: () => contexto.map((json) => ({ json })), itemMatching: (i) => ({ json: contexto[i] }) };
  };
  const $input = { all: () => respuestas.map((json) => ({ json })) };
  // eslint-disable-next-line no-new-func
  return new Function('$', '$input', 'console', sinExport)($, $input, { log() {} });
}

const VALUES_UNA_FILA = [FILA_ENCABEZADO, FILA_SUBTITULO,
  [1, 9, 'MIA', 'A', 'P', 2, null, null, 2, 0, 0, 0, 0, 0, 2, 'En curso', '', 'Ana', '']];
const CTX_HOJA = { employeeFolderName: 'Ana', fileName: 'ana.xlsx', targetSheetName: 'Septiembre', projectFolder: 'Equipo 1' };

test('n8n: encuentra el nodo aunque se llame "Resolver hoja del mes1"', () => {
  const salida = correrNodoN8n({
    nodosExistentes: ['Resolver hoja del mes1'],
    respuestas: [{ values: VALUES_UNA_FILA }],
    contexto: [CTX_HOJA],
  });
  const filas = salida.filter((i) => !i.json.resumen_parseo);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].json.persona, 'Ana');
  assert.strictEqual(filas[0].json.month_number, 9);
});

test('n8n: si ninguna hoja encuentra su archivo, falla con un error claro en vez de seguir vacio', () => {
  assert.throws(() => correrNodoN8n({
    nodosExistentes: ['Resolver hoja del mes'],
    respuestas: [{ values: VALUES_UNA_FILA }],
    contexto: [],
  }), /Ninguna de las 1 hojas encontró su archivo/);
});

test('n8n: sin ningun nodo de hojas en el lienzo, el error dice cuales se buscaron', () => {
  assert.throws(() => correrNodoN8n({
    nodosExistentes: [],
    respuestas: [{ values: VALUES_UNA_FILA }],
    contexto: [CTX_HOJA],
  }), /Resolver hoja del mes1/);
});
