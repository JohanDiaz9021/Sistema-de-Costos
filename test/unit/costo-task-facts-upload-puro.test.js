'use strict';

/**
 * parsearFilas() de src/queries/costo-task-facts-upload.js — lee el mismo
 * template que llena el RPA (secciones agrupadas en la fila 1, encabezados
 * reales en la fila 2, subtítulos en cursiva en la fila 3, datos desde la
 * fila 4). Se prueba con un worksheet armado a mano vía ExcelJS, sin tocar
 * la base ni el filesystem.
 */

const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const {
  parsearFilas, parsearHojasConDatos,
  filasConTotalDescuadrado, filtrarPorCentro,
} = require('../../src/queries/costo-task-facts-upload');

function hojaDePrueba(filasDeDatos) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Semanal');
  ws.addRow(['IDENTIFICACION', '', '', '', '', '', 'TIEMPOS Y EJECUCION', '', '', '', '', '', '', '', '', 'RESULTADO', '', '', '']);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'A Cargo De', 'Observaciones']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Elige responsable', 'Motivo']);
  for (const f of filasDeDatos) ws.addRow(f);
  return ws;
}

test('parsearFilas: lee proyecto, horas por dia y total de una fila normal', () => {
  const ws = hojaDePrueba([
    [1, 4, 'SURA', 'Reunion de arranque', 'P', 4, new Date('2026-08-28'), new Date('2026-08-28'), 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily Tench', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].project_name, 'SURA');
  assert.strictEqual(filas[0].week_number, 4);
  assert.strictEqual(filas[0].hours_monday, 4);
  assert.strictEqual(filas[0].total_executed_hours, 4);
  assert.strictEqual(filas[0].planned_type, 'P');
  assert.strictEqual(filas[0].task_status, 'Terminado');
  assert.strictEqual(filas[0].month_number, 8);
  assert.strictEqual(filas[0].year_number, 2026);
});

test('parsearFilas: una persona puede reportar a VARIOS proyectos distintos en el mismo archivo', () => {
  const ws = hojaDePrueba([
    [1, 4, 'SURA', 'A', 'P', 4, new Date('2026-08-28'), new Date('2026-08-28'), 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily', ''],
    [2, 4, 'Habilitador', 'B', 'P', 3, new Date('2026-08-28'), new Date('2026-08-28'), 0, 3, 0, 0, 0, 0, 3, 'Terminado', '100%', 'Emily', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.deepStrictEqual(filas.map((f) => f.project_name), ['SURA', 'Habilitador']);
});

test('parsearFilas: salta la fila de subtitulos en cursiva (Semana no es numero ahi)', () => {
  // hojaDePrueba() ya la agrega (fila 3) — si no se saltara, contaria como
  // una fila de datos con project_name="Elige proyecto".
  const ws = hojaDePrueba([
    [1, 4, 'SURA', 'A', 'P', 4, new Date('2026-08-28'), new Date('2026-08-28'), 4, 0, 0, 0, 0, 0, 4, 'Terminado', '100%', 'Emily', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.ok(!filas.some((f) => f.project_name === 'Elige proyecto'));
});

test('parsearFilas: P/NP distinto de "NP" siempre cae en "P"', () => {
  const ws = hojaDePrueba([
    [1, 4, 'SURA', 'A', 'NP', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
    [2, 4, 'SURA', 'B', '', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.strictEqual(filas[0].planned_type, 'NP');
  assert.strictEqual(filas[1].planned_type, 'P');
});

test('parsearFilas: sin fechas, month_number/year_number quedan null (no inventa una fecha)', () => {
  const ws = hojaDePrueba([
    [1, 4, 'SURA', 'A', 'P', 4, null, null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '', 'Emily', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.strictEqual(filas[0].month_number, null);
  assert.strictEqual(filas[0].year_number, null);
});

test('parsearFilas: sin encabezado "Proyecto" reconocible, lanza un error claro', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Vacia');
  ws.addRow(['A', 'B', 'C']);
  assert.throws(() => parsearFilas(ws), /Proyecto/);
});

test('parsearFilas: sin filas de datos debajo del encabezado, lanza un error claro', () => {
  const ws = hojaDePrueba([]);
  assert.throws(() => parsearFilas(ws), /filas de datos/);
});

// Regresion: una hoja auxiliar con columna "Proyecto" pero SIN columna
// "Semana" (ej. una lista de referencia de nombres válidos, no una hoja de
// horas) no debe leerse como si trajera datos reales. Antes de este fix,
// como valorCelda() devuelve null cuando la columna no existe y
// Number(null) es 0 (finito), CUALQUIER fila con "Proyecto" no vacío se
// colaba como fila válida.
test('parsearFilas: una hoja con "Proyecto" pero SIN columna "Semana" no cuela filas falsas', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Lista de proyectos validos');
  ws.addRow(['Proyecto']);
  ws.addRow(['ALFA']);
  ws.addRow(['BETA']);
  ws.addRow(['GAMMA']);
  assert.throws(() => parsearFilas(ws), /filas de datos/);
});

// La plantilla real de "Planeación Semanal" (31 ago 2026) trae columnas
// extra entre TT y "A Cargo De" (Desfase, Esfuerzo %) que este parser no
// lee — como la búsqueda de columnas es por texto de encabezado y no por
// posición fija, esas columnas de más no deberían romper nada. Esta prueba
// replica exactamente ese layout para confirmarlo.
function hojaPlantillaReal(filasDeDatos) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Planeación Semanal');
  ws.addRow(['IDENTIFICACION', '', '', '', '', 'TIEMPOS Y EJECUCION', '', '', '', '', '', '', '', '', 'RESULTADO', '', '', '', '', '']);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P / NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'Desfase', 'Esfuerzo %', 'A Cargo De']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada NP=No planeada', 'Horas planificadas', 'Fecha limite', 'fecha en que realmente se cerró la actividad.', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total ejecutado (auto)', 'Pendiente/En Proceso/Terminado/Bloqueado', 'Porcentaje de cumplimiento', 'Presup - TT (auto)', 'TT + Presup (auto)', 'Elige responsable']);
  for (const f of filasDeDatos) ws.addRow(f);
  return ws;
}

test('parsearFilas: la plantilla real de Planeación Semanal (con Desfase/Esfuerzo % de más) se lee igual', () => {
  const ws = hojaPlantillaReal([
    [1, 1, 'Management', 'Planeación semanal', 'P', 0.5, new Date('2026-08-31'), new Date('2026-08-31'), 0.5, 0, 0, 0, 0, 0, 0.5, 'Terminado', '100%', 0, '100%', 'Emily Tench'],
    [2, 1, 'Management', 'Llenado de Redmine', 'P', 2.5, new Date('2026-09-04'), null, 0.5, 0, 0, 0, 0, 0, 0.5, 'Pendiente', '0%', 2, '20%', 'Emily Tench'],
    [3, 1, 'Sistema de costos', 'Reunion con Emily', 'P', 1.0, new Date('2026-09-04'), null, 0.1, 0, 0, 0, 0, 0, 0.1, 'Pendiente', '0%', 0.9, '10%', 'Emily Tench'],
    [4, 1, 'Sistema de costos', 'Creación de horas extras', 'P', 1.0, new Date('2026-09-04'), new Date('2026-08-31'), 1, 0, 0, 0, 0, 0, 1, 'Pendiente', '100%', 0, '100%', 'Emily Tench'],
  ]);
  const filas = parsearFilas(ws);
  assert.strictEqual(filas.length, 4);

  const porProyecto = {};
  for (const f of filas) porProyecto[f.project_name] = (porProyecto[f.project_name] || 0) + f.hours_monday;
  assert.strictEqual(porProyecto['Management'], 1, 'Management: 0.5 + 0.5 = 1 hora el lunes');
  assert.strictEqual(Math.round(porProyecto['Sistema de costos'] * 100) / 100, 1.1, 'Sistema de costos: 0.1 + 1 = 1.1 horas el lunes');
});

// Bug real reportado por el usuario (31 ago 2026): "No se encontró la
// columna Proyecto" al subir un archivo válido. La causa: las columnas
// con filtro de Excel activado (AutoFilter) traen el ícono del
// desplegable pegado al texto — la celda real no es "Proyecto", es
// "🔽 Proyecto" — y la comparación exacta nunca encontraba nada.
test('parsearFilas: encabezados con el ícono de filtro de Excel pegado ("🔽 Proyecto") se reconocen igual', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Septiembre');
  ws.addRow(['# Consec.', 'Semana', '🔽 Proyecto', 'Actividad', '🔽 P / NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', '🔽 Estado', 'Cumplimiento', 'Desfase', 'Esfuerzo %', '🔽 A Cargo De']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada NP=No planeada', 'Horas planificadas', 'Fecha límite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Presup - TT', 'TT + Presup', 'Elige responsable']);
  ws.addRow([1, 1, 'Management', 'Planeación semanal', 'P', 0.5, null, null, 0.5, 0, 0, 0, 0, 0, 0.5, 'Terminado', '100%', 0, '100%', 'Emily Tench']);

  const filas = parsearFilas(ws);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].project_name, 'Management');
  assert.strictEqual(filas[0].hours_monday, 0.5);
  assert.strictEqual(filas[0].planned_type, 'P');
  assert.strictEqual(filas[0].task_status, 'Terminado');
});

// ---------------------------------------------------------------
// parsearHojasConDatos (31 ago 2026): el archivo real trae una hoja por
// MES (Agosto, Septiembre...) más pestañas auxiliares (Datos, Control de
// Cambios) sin datos de horas.
//
// Se leen TODAS las hojas con datos. Antes se elegía UNA sola (la última
// con datos) y eso causó un daño real: guardarHorasDesdeExcel() reemplaza
// todas las filas de esa persona en la fecha de corte, así que subir el
// Excel le borró a alguien sus 143.5h de agosto y lo dejó solo con las
// 4.7h de la pestaña "Septiembre".
// ---------------------------------------------------------------

function hojaConNombre(wb, nombre, { conDatos = true } = {}) {
  const ws = wb.addWorksheet(nombre);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Observaciones']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', 'Motivo']);
  if (conDatos) ws.addRow([1, 1, `Proyecto de ${nombre}`, 'Tarea', 'P', 1, null, null, 1, 0, 0, 0, 0, 0, 1, 'Terminado', '']);
  return ws;
}

test('parsearHojasConDatos: lee TODAS las hojas de meses, no solo una (no se pierde ningun mes)', () => {
  const wb = new ExcelJS.Workbook();
  hojaConNombre(wb, 'Agosto');
  hojaConNombre(wb, 'Septiembre');
  wb.addWorksheet('Datos');
  wb.addWorksheet('Control de Cambios');

  const { hojas, filas } = parsearHojasConDatos(wb);
  assert.deepStrictEqual(hojas, ['Agosto', 'Septiembre'], 'las auxiliares no aportan datos');
  assert.deepStrictEqual(
    filas.map((f) => f.project_name),
    ['Proyecto de Agosto', 'Proyecto de Septiembre'],
    'tienen que venir los dos meses, no uno solo'
  );
});

test('parsearHojasConDatos: una hoja de mes ya creada pero vacia no aporta nada ni estorba', () => {
  const wb = new ExcelJS.Workbook();
  hojaConNombre(wb, 'Septiembre');
  hojaConNombre(wb, 'Octubre', { conDatos: false });

  const { hojas, filas } = parsearHojasConDatos(wb);
  assert.deepStrictEqual(hojas, ['Septiembre']);
  assert.strictEqual(filas.length, 1);
});

// Regresion: "Datos" es el nombre real de una pestaña auxiliar del archivo
// (lista de referencia, con su propia columna "Proyecto" pero sin
// "Semana"). Sin el chequeo de la columna "Semana" ausente, sus filas se
// colarian como horas trabajadas.
test('parsearHojasConDatos: una hoja auxiliar con "Proyecto" pero sin "Semana" no aporta filas falsas', () => {
  const wb = new ExcelJS.Workbook();
  hojaConNombre(wb, 'Septiembre');
  const datos = wb.addWorksheet('Datos');
  datos.addRow(['Proyecto']);
  datos.addRow(['ALFA']);
  datos.addRow(['BETA']);

  const { hojas, filas } = parsearHojasConDatos(wb);
  assert.deepStrictEqual(hojas, ['Septiembre']);
  assert.deepStrictEqual(filas.map((f) => f.project_name), ['Proyecto de Septiembre']);
});

test('parsearHojasConDatos: con una sola hoja valida, devuelve sus filas', () => {
  const wb = new ExcelJS.Workbook();
  hojaConNombre(wb, 'Semanal');
  const { hojas, filas } = parsearHojasConDatos(wb);
  assert.deepStrictEqual(hojas, ['Semanal']);
  assert.strictEqual(filas.length, 1);
});

test('parsearHojasConDatos: con una sola hoja invalida, propaga el error puntual (dice que corregir)', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Vacia');
  ws.addRow(['A', 'B', 'C']);
  assert.throws(() => parsearHojasConDatos(wb), /Proyecto/);
});

test('parsearHojasConDatos: si ninguna hoja tiene datos, lanza un error con las hojas disponibles', () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Datos');
  wb.addWorksheet('Control de Cambios');

  assert.throws(
    () => parsearHojasConDatos(wb),
    /Ninguna hoja.*Proyecto.*Datos, Control de Cambios/s
  );
});

// ---------------------------------------------------------------
// Validaciones de la carga (10 sep 2026). Las dos nacen del mismo hueco:
// la carga daba "listo" y se quedaba callada aunque los datos no fueran a
// llegar a donde el usuario cree.
// ---------------------------------------------------------------

function filaHoras(dias, tt) {
  const [l = 0, m = 0, x = 0, j = 0, v = 0, s = 0] = dias;
  return {
    hours_monday: l, hours_tuesday: m, hours_wednesday: x,
    hours_thursday: j, hours_friday: v, hours_saturday: s,
    total_executed_hours: tt,
  };
}

test('filasConTotalDescuadrado: cuenta solo las filas donde el TT no cuadra con la suma de los dias', () => {
  const filas = [
    filaHoras([0.5, 0.5, 0.5, 0.5], 2),   // cuadra
    filaHoras([1], 5),                     // TT pisado a mano
    filaHoras([], 0),                      // planeada sin ejecutar: cuadra
  ];
  assert.strictEqual(filasConTotalDescuadrado(filas), 1);
});

test('filasConTotalDescuadrado: la coma flotante no cuenta como descuadre', () => {
  assert.strictEqual(filasConTotalDescuadrado([filaHoras([0.1, 0.2], 0.3)]), 0);
});

// El caso que motivó todo esto: el Excel de una persona trae Management y
// Sistema de costos, y subirlo AL centro de Sistema de costos solo puede
// leer las de Sistema de costos.
test('filtrarPorCentro: se queda solo con las filas del proyecto de ESE centro', () => {
  const centro = { project_name: 'Costos', project_folder: 'Sistema de costos' };
  const filas = [
    { project_name: 'Management', activity: 'Daily' },
    { project_name: 'Sistema de costos', activity: 'Reunion' },
    { project_name: 'Management', activity: 'Demo' },
  ];
  const { propias, ignoradas, proyectosIgnorados } = filtrarPorCentro(filas, centro);
  assert.deepStrictEqual(propias.map((f) => f.activity), ['Reunion']);
  assert.strictEqual(ignoradas.length, 2);
  assert.deepStrictEqual(proyectosIgnorados, ['Management']);
});

// El mismo criterio del JOIN que despues cobra las horas: el Excel unas
// veces escribe el project_name del centro y otras su project_folder.
test('filtrarPorCentro: reconoce el centro tanto por project_name como por project_folder', () => {
  const centro = { project_name: 'Costos', project_folder: 'Sistema de costos' };
  const porFolder = filtrarPorCentro([{ project_name: 'Sistema de costos' }], centro);
  const porNombre = filtrarPorCentro([{ project_name: 'Costos' }], centro);
  assert.strictEqual(porFolder.propias.length, 1);
  assert.strictEqual(porNombre.propias.length, 1);
});

test('filtrarPorCentro: no se le escapa una fila por como este escrita (mayusculas, tildes)', () => {
  const centro = { project_name: 'Costos', project_folder: 'Sistema de costos' };
  const { propias } = filtrarPorCentro(
    [{ project_name: 'SISTEMA DE COSTOS' }, { project_name: ' sistema de costos ' }],
    centro
  );
  assert.strictEqual(propias.length, 2);
});

// Un centro sin project_folder no puede terminar aceptandolo todo: si el
// Set de comparacion se armara sin filtrar los nulos, normalizarTexto(null)
// da '' y cualquier fila con proyecto vacio entraria.
test('filtrarPorCentro: un centro sin project_folder no traga filas ajenas', () => {
  const centro = { project_name: 'Costos', project_folder: null };
  const { propias, ignoradas } = filtrarPorCentro(
    [{ project_name: 'Costos' }, { project_name: 'Management' }],
    centro
  );
  assert.strictEqual(propias.length, 1);
  assert.strictEqual(ignoradas.length, 1);
});

// El archivo real apila un bloque por semana, asi que el primer
// encabezado puede quedar bastante mas abajo de la fila 2 del template.
test('parsearFilas: encuentra el encabezado aunque este muy por debajo de la fila 10', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Semanal');
  for (let i = 0; i < 40; i++) ws.addRow(['bloque de resumen previo']);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'A Cargo De', 'Observaciones']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Elige responsable', 'Motivo']);
  ws.addRow([1, 2, 'Sistema de costos', 'Reunion', 'P', 2, null, null, 0, 0.4, 0, 0.3, 0, 0, 0.7, 'Pendiente', '35%', 'Emily Tench', '']);

  const filas = parsearFilas(ws);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].project_name, 'Sistema de costos');
  assert.strictEqual(filas[0].total_executed_hours, 0.7);
});

// El encabezado repetido de la semana siguiente NO puede colarse como
// dato: se cae solo porque ahi "Semana" dice "N° semana", no un numero.
test('parsearFilas: un bloque de encabezado repetido mas abajo no se cuela como fila de datos', () => {
  const ws = hojaDePrueba([
    [1, 2, 'Management', 'Daily', 'P', 2, null, null, 0, 0.5, 0.5, 0.5, 0, 0, 1.5, 'Pendiente', '75%', 'Emily Tench', ''],
    ['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'A Cargo De', 'Observaciones'],
    ['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Elige responsable', 'Motivo'],
    [2, 3, 'Sistema de costos', 'Otra', 'P', 1, null, null, 1, 0, 0, 0, 0, 0, 1, 'Terminado', '100%', 'Emily Tench', ''],
  ]);
  const filas = parsearFilas(ws);
  assert.deepStrictEqual(filas.map((f) => f.project_name), ['Management', 'Sistema de costos']);
});

