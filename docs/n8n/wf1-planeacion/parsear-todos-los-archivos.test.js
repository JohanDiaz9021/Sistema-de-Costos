'use strict';

/**
 * Prueba del nodo Code "Parsear todos los archivos" de WF1 (Planeación), v20.
 *
 * Corre el código REAL del nodo con los globales de n8n simulados, sobre las
 * filas del archivo real de Emily Tench (septiembre 2026): plantilla nueva con
 * la columna "Tipo de Actividad", dos bloques semanales con su encabezado
 * repetido y un valor de "Proyecto" que ya no está en el desplegable.
 *
 * Correr con:  node --test docs/n8n/wf1-planeacion/parsear-todos-los-archivos.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'parsear-todos-los-archivos.js'), 'utf8');

// ---------------------------------------------------------------------------
// Proyecto padre de cada valor del desplegable
// ---------------------------------------------------------------------------

function cargarHelpers() {
  const desde = SRC.indexOf('function normalizeText');
  const hasta = SRC.indexOf('function getMonthWeekNumber');
  assert.ok(desde > 0 && hasta > desde, 'no se encontraron los helpers en el nodo');
  return new Function(`${SRC.slice(desde, hasta)}; return { proyectoPadre, proyectoPrincipal, normalizarPlantilla };`)();
}
const { proyectoPadre, proyectoPrincipal } = cargarHelpers();
const EQUIPO = 'Equipo 4';

// El desplegable (hoja "Proyectos" del Excel, 30 sep 2026) y el nombre EXACTO
// del proyecto en mp_project_owners — de ahí sale el PM.
const DESPLEGABLE = [
  ['Management', 'Management'],
  ...['CRM', 'Sueco eventos', 'Notificaciones', 'Colaboradores y terceros', 'Tickets', 'Seguridad', 'Sueco project',
    'Auditoria', 'Formularios dinámicas'].map((m) => [`${m} (Transversales)`, 'Transversales']),
  ...['Comunicaciones', 'Configuracion documental', 'Estructura documental', 'Almacenamiento', 'Archivo fisico',
    'Gestion de formularios', 'Flujos documentales'].map((m) => [`${m} (Document Online)`, 'Document Online']),
  ...['Administracion', 'Tablas generales', 'Admisiones', 'Planes de Estudio', 'Programacion academica', 'Calificaciones',
    'Historia academica', 'Gestion economica', 'Matricula', 'Grados', 'Normativa', 'Reportes'].map((m) => [`${m} (Sescol)`, 'SESCOL']),
  ...['Gestion financiera', 'Gestion administrativa', 'Gestion comercial', 'Gestion de proveedores',
    'Gestion publica y municipal', 'Talento humano inteligente'].map((m) => [`${m} (MIA)`, 'MIA']),
  ['Sistema de Costos', 'sistema-de-costos'],
];

test('cada valor del desplegable resuelve a su proyecto padre', () => {
  assert.strictEqual(DESPLEGABLE.length, 36); // 35 del desplegable + Sistema de Costos
  for (const [valor, esperado] of DESPLEGABLE) {
    assert.strictEqual(proyectoPadre(valor, EQUIPO), esperado, `"${valor}"`);
  }
});

test('mayúsculas, tildes y espacios de más no cambian el resultado', () => {
  assert.strictEqual(proyectoPadre('  gestión FINANCIERA   (mia) ', EQUIPO), 'MIA');
  assert.strictEqual(proyectoPadre('Admisiones (SESCOL)', EQUIPO), 'SESCOL');
  assert.strictEqual(proyectoPadre('management', EQUIPO), 'Management');
});

test('un proyecto nuevo (fuera de la lista) se reconoce por su propio nombre', () => {
  // Sin paréntesis: el valor completo (proyecto recién creado, aún sin módulos).
  assert.strictEqual(proyectoPadre('Automatización de captura de leads', EQUIPO), 'Automatización de captura de leads');
  assert.strictEqual(proyectoPadre('  Automatización  de captura de leads ', EQUIPO), 'Automatización de captura de leads');
  // Con paréntesis: lo de adentro — el mismo proyecto cuando le agregan módulos.
  assert.strictEqual(proyectoPadre('Formularios (Automatización de captura de leads)', EQUIPO), 'Automatización de captura de leads');
  assert.strictEqual(proyectoPadre('Algo (Otro)', EQUIPO), 'Otro');
  // Muy largo: se recorta al largo de la columna.
  assert.strictEqual(proyectoPadre('x'.repeat(150), EQUIPO).length, 100);
});

test('Infraestructura: módulos y la forma mal escrita "infraestrucutra" son el mismo proyecto', () => {
  assert.strictEqual(proyectoPadre('Soporte Servidores (Infraestructura)', EQUIPO), 'Infraestructura');
  assert.strictEqual(proyectoPadre('Proyecto (infraestrucutra)', EQUIPO), 'Infraestructura');
  assert.strictEqual(proyectoPadre('Infraestrucutra', EQUIPO), 'Infraestructura');
});

test('solo la celda vacía cae a la etiqueta del Equipo', () => {
  assert.strictEqual(proyectoPadre('', EQUIPO), EQUIPO);
  assert.strictEqual(proyectoPadre('   ', EQUIPO), EQUIPO);
  assert.strictEqual(proyectoPadre(null, EQUIPO), EQUIPO);
});

test('proyecto principal: el de más tareas, Management solo si no hay otro', () => {
  const t = (p) => ({ project_folder: p });
  assert.strictEqual(proyectoPrincipal([t('Management'), t('Management'), t('MIA')], EQUIPO), 'MIA');
  assert.strictEqual(proyectoPrincipal([t('MIA'), t('SESCOL'), t('SESCOL')], EQUIPO), 'SESCOL');
  assert.strictEqual(proyectoPrincipal([t('Management')], EQUIPO), 'Management');
  assert.strictEqual(proyectoPrincipal([t(EQUIPO)], EQUIPO), null);
  assert.strictEqual(proyectoPrincipal([], EQUIPO), null);
});

// ---------------------------------------------------------------------------
// El nodo completo, sobre la hoja de Emily
// ---------------------------------------------------------------------------

function serie(iso) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}

// contexto: pisa el día analizado (snapshotDate y su mes).
// ahora: instante "real" de la corrida (ISO en UTC); sin él se usa el reloj.
function correrNodo(values, { semanaInicio, contexto, ahora } = {}) {
  const ctx = { snapshotDate: '2026-09-30', monthName: 'Septiembre', monthNumber: 9, yearNumber: 2026, ...contexto };
  const fileCtx = {
    fileId: 'f1', fileName: '2026_1234567890_Emily_Tench.xlsx', employeeFolderName: 'Emily Tench',
    projectFolder: 'Equipo 2', targetSheetName: 'Septiembre',
  };
  const staticData = {};
  const nodos = { 'Guardar Drive ID1': ctx, 'Resolver hoja del mes1': fileCtx };
  // Como en n8n: pedir un nodo que no se ejecutó lanza error.
  const $ = (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node '${nombre}' hasn't been executed`);
    return {
      first: () => ({ json: nodos[nombre] }),
      all: () => [{ json: nodos[nombre] }],
      itemMatching: () => ({ json: nodos[nombre] }),
    };
  };
  // Por defecto, el corte real del nodo; semanaInicio = null procesa todas las semanas.
  const marca = "const SEMANA_INICIO = '2026-09-28';";
  assert.ok(SRC.includes(marca), 'no se encontró SEMANA_INICIO en el nodo');
  let fuente = semanaInicio === undefined ? SRC : SRC.replace(marca, `const SEMANA_INICIO = ${semanaInicio === null ? 'null' : "'" + semanaInicio + "'"};`);
  if (ahora) {
    const reloj = 'const _physicalNowUtc = new Date();';
    assert.ok(fuente.includes(reloj), 'no se encontró el reloj del nodo');
    fuente = fuente.replace(reloj, `const _physicalNowUtc = new Date('${ahora}');`);
  }
  const nodo = new Function('$', '$input', '$getWorkflowStaticData', 'console', fuente);
  nodo($, { all: () => [{ json: { values } }] }, () => staticData, { log() {} });
  return staticData;
}

const ENCABEZADO_NUEVO = ['# Consec.', 'Semana', '▼ Proyecto', 'Actividad', 'Tipo de Actividad', '▼ P / NP', 'Horas Presupues\ntadas',
  'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', '▼ Estado', 'Cumplimie\nnto', 'Desfase', 'Esfuerzo %',
  '▼ A Cargo De', 'Observaci\nones', 'Motivo de Ajuste', 'Tarea No Programada'];
const SUBTITULO_NUEVO = ['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'Tipo de actividades de Proyectos',
  'P=Planeada NP=No planeada', 'Horas planificadas', 'Es la fecha límite', '', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado',
  'Total ejecutado (auto)'];
const BANNER = ['IDENTIFICACIÓN', '', '', '', '', '', 'TIEMPOS Y EJECUCIÓN'];

// Una fila como la entrega Graph: [consec, semana, proyecto, actividad, tipo, P/NP, horas, estimada, entrega,
// L, M, X, J, V, S, TT, estado, cumpl, desfase, esfuerzo, aCargo]
function fila(consec, semana, proyecto, actividad, tipo, horas, estimada, entrega, dias, estado) {
  const seis = [...dias, null, null, null, null, null, null].slice(0, 6); // L, M, X, J, V, S
  const tt = Number(seis.reduce((s, d) => s + (d || 0), 0).toFixed(2));
  return [consec, semana, proyecto, actividad, tipo, 'P', horas, serie(estimada), entrega ? serie(entrega) : '',
    ...seis.map((d) => d ?? ''), tt, estado, '', '', '', 'Jonathan Anaya', '', '', ''];
}

const BLOQUE_1 = [
  fila(1, 4, 'Management', 'Planeación semanal', '', 0.5, '2026-09-21', '2026-09-25', [1], 'Terminado'),
  fila(2, 4, 'Management', 'Daily', '', 1, '2026-09-25', '2026-09-25', [null, 0.2, 0.2, 0.1, 0.1], 'En Progreso'),
  fila(3, 4, 'Management', 'Demo', '', 1, '2026-09-25', '2026-09-25', [], 'En Progreso'),
  fila(4, 4, 'Management', 'Llenado de Redmine', '', 0.5, '2026-09-25', '2026-09-25', [0.1, 0.1, 0.1, 0.1, 0.1], 'En Progreso'),
  fila(5, 4, 'Management', 'Pausas activas', '', 0.4, '2026-09-25', '2026-09-25', [0.1, 0.1, 0.1, 0.1, 0.1], 'En Progreso'),
  fila(6, 4, 'Proyecto Agente Desarrollo IA', 'Proyecto agente desarrollo IA', '', 35.1, '2026-09-25', '2026-09-25', [6.5, 7.8, 7, 7.2, 7.7], 'En Progreso'),
  fila(7, 4, 'Management', 'Reuniones equipo desarrollo proyecto IA y mesa técnica', '', 2, '2026-09-25', '2026-09-25', [0.2, 0.2], 'En Progreso'),
  fila(8, 4, 'Management', 'Reuniones Johan IA', '', 0.5, '2026-09-25', '2026-09-25', [0.1, 0.1, 0.1], 'En Progreso'),
  fila(9, 4, 'Management', 'Reunión Bancoomeva y gerencia', '', 1, '2026-09-23', '2026-09-23', [null, null, null, 1, 1], 'Terminado'),
];
const BLOQUE_2 = [
  fila(1, 5, 'Management', 'Planeación semanal', 'Reunion Administrativas', 0.5, '2026-09-28', '2026-09-28', [0.1], 'Terminado'),
  fila(2, 5, 'Management', 'Daily', 'Reunion Administrativas', 1, '2026-10-02', null, [null, 0.1, 0.1], 'En Progreso'),
  fila(3, 5, 'Management', 'Demo', 'Reunion Administrativas', 1, '2026-10-02', null, [], 'En Progreso'),
  fila(4, 5, 'Management', 'Llenado de Redmine', 'Reunion Administrativas', 0.5, '2026-10-02', null, [0.1, 0.1, 0.1], 'En Progreso'),
  fila(5, 5, 'Management', 'Pausas activas', 'Reunion Administrativas', 0.4, '2026-10-02', null, [0.1, 0.1, 0.1], 'En Progreso'),
  fila(6, 5, 'Proyecto Agente Desarrollo IA', 'Proyecto agente desarrollo IA', 'Desarrollo', 36.1, '2026-10-02', null, [7.2, 8, 8.1], 'En Progreso'),
  fila(7, 5, 'Management', 'Reuniones equipo desarrollo proyecto IA y mesa técnica', 'Reunion Administrativas', 2, '2026-10-02', null, [0.5, 0.2], 'En Progreso'),
  fila(8, 5, 'Management', 'Reuniones Johan IA', 'Reunion Proyectos', 0.5, '2026-10-02', null, [null, null, 0.1], 'En Progreso'),
];

const HOJA_EMILY = [
  ['', '', '', 'Planeación Semanal'],
  ['', ''], ['', ''], ['', ''], ['', ''],
  ['Nombre del talento:', 'Emily Del Carmen Tench Pérez', 'Líder de equipo:', 'Jonathan Anaya'],
  BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
  ...BLOQUE_1,
  ['Cumplimiento', '', '', '', '', '', 42],
  [],
  BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
  ...BLOQUE_2,
  ['Cumplimiento', '', '', '', '', '', 42],
];

test('plantilla nueva con "Tipo de Actividad": lee las 17 tareas de Emily sin errores falsos', () => {
  const staticData = correrNodo(HOJA_EMILY, { semanaInicio: null }); // sin corte: todas las semanas
  const emp = staticData.successfulEmployees[0];

  assert.strictEqual(emp.leaderName, 'Jonathan Anaya');
  assert.strictEqual(emp.tasks.length, 17, 'las filas de encabezado repetidas no deben contar como tareas');
  assert.ok(emp.tasks.every((t) => t.planned_type === 'P'), 'P/NP debe salir de su columna, no de "Tipo de Actividad"');
  assert.deepStrictEqual([...new Set(emp.tasks.map((t) => t.task_status))].sort(), ['En Progreso', 'Terminado']);

  const ia = emp.tasks.find((t) => t.week_number === 4 && t.activity === 'Proyecto agente desarrollo IA');
  assert.strictEqual(ia.budgeted_hours, 35.1);
  assert.strictEqual(ia.estimated_delivery_date, '2026-09-25');
  assert.strictEqual(ia.hours_monday, 6.5);
  assert.strictEqual(ia.hours_friday, 7.7);
  assert.strictEqual(Number(ia.total_executed_hours.toFixed(1)), 36.2);
  assert.strictEqual(emp.tasks.find((t) => t.week_number === 5 && t.activity === 'Daily').estimated_delivery_date, '2026-10-02');

  // Los errores masivos del 30 sep no pueden volver.
  const tipos = new Set(staticData.validationErrors.map((e) => e.error_type));
  for (const t of ['MISSING_LEADER', 'INVALID_STATUS', 'MISSING_STATUS', 'MISSING_BUDGETED_HOURS', 'MISSING_PLANNED_TYPE',
    'MISSING_PROJECT', 'MISSING_ACTIVITY', 'TT_INCONSISTENT', 'ESTIMATED_DATE_MISMATCH_WEEK', 'MISSING_WEEK_PLANNING']) {
    assert.ok(!tipos.has(t), `no debería haber ${t}: ${JSON.stringify(staticData.validationErrors.filter((e) => e.error_type === t).slice(0, 2))}`);
  }
});

test('el proyecto de cada fila sale del módulo; uno fuera de la lista queda con su propio nombre', () => {
  const emp = correrNodo(HOJA_EMILY).successfulEmployees[0];
  const proyectos = new Set(emp.tasks.map((t) => t.project_folder));
  assert.deepStrictEqual([...proyectos].sort(), ['Management', 'Proyecto Agente Desarrollo IA']);
  assert.strictEqual(emp.tasks.find((t) => t.project_name === 'Proyecto Agente Desarrollo IA').project_folder, 'Proyecto Agente Desarrollo IA');
  assert.strictEqual(emp.equipoFolder, 'Equipo 2');
});

test('una persona con módulos de varios proyectos: cada fila y cada error al proyecto de su módulo', () => {
  const hoja = [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', 'Jaider Bermudez', 'Líder de equipo:', ''], // líder vacío: error de TODO el archivo
    BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
    fila(1, 5, 'Gestion financiera (MIA)', 'Conciliación', 'Desarrollo', 4, '2026-10-02', null, [1, 1], 'En Progreso'),
    fila(2, 5, 'Talento humano inteligente (MIA)', 'Nómina', 'Desarrollo', 4, '2026-10-02', null, [1], ''), // sin estado
    fila(3, 5, 'Admisiones (Sescol)', 'Inscripción', 'Desarrollo', 4, '2026-10-02', null, [1], 'En Progreso'),
    fila(4, 5, 'Management', 'Scrum daily', 'Daily', 1, '2026-10-02', null, [0.2], 'En Progreso'),
    ['Cumplimiento'],
  ];
  const staticData = correrNodo(hoja);
  const emp = staticData.successfulEmployees[0];

  assert.deepStrictEqual(Object.fromEntries(emp.tasks.map((t) => [t.activity, t.project_folder])),
    { 'Conciliación': 'MIA', 'Nómina': 'MIA', 'Inscripción': 'SESCOL', 'Scrum daily': 'Management' });
  assert.strictEqual(emp.proyectoPrincipal, 'MIA');

  const de = (tipo) => staticData.validationErrors.filter((e) => e.error_type === tipo).map((e) => e.project_folder);
  assert.deepStrictEqual(de('MISSING_STATUS'), ['MIA']);   // error de una fila → su proyecto
  assert.deepStrictEqual(de('MISSING_LEADER'), ['MIA']);   // error del archivo → proyecto principal
  assert.ok(staticData.validationErrors.every((e) => e.project_folder !== 'Equipo 2'));
});

test('la plantilla anterior (sin "Tipo de Actividad") se sigue leyendo igual', () => {
  const quitarTipo = (f) => [...f.slice(0, 4), ...f.slice(5)];
  const hoja = HOJA_EMILY.map((f, i) => (i < 6 ? f : quitarTipo(f)));
  const emp = correrNodo(hoja, { semanaInicio: null }).successfulEmployees[0];
  assert.strictEqual(emp.tasks.length, 17);
  assert.ok(emp.tasks.every((t) => t.planned_type === 'P'));
  assert.strictEqual(emp.tasks[5].budgeted_hours, 35.1);
});

test('si "Guardar Drive ID1" no corrió, usa la copia sin sufijo', () => {
  // El simulador de correrNodo solo conoce los nombres con sufijo; aquí se
  // comprueba que el nodo prueba primero esos y cae a los viejos si faltan.
  assert.match(SRC, /nodoEjecutado\(\['Guardar Drive ID1', 'Guardar Drive ID'\]\)/);
  assert.match(SRC, /nodoEjecutado\(\['Resolver hoja del mes1', 'Resolver hoja del mes'\]\)/);
});

test('corte 28-sep: solo se procesa la semana 5 de septiembre; las tablas anteriores se ignoran', () => {
  const staticData = correrNodo(HOJA_EMILY); // corte real del nodo
  const emp = staticData.successfulEmployees[0];
  assert.strictEqual(emp.tasks.length, 8);
  assert.ok(emp.tasks.every((t) => t.week_number === 5));
  const ia = emp.tasks.find((t) => t.activity === 'Proyecto agente desarrollo IA');
  assert.strictEqual(ia.budgeted_hours, 36.1);
  assert.strictEqual(ia.estimated_delivery_date, '2026-10-02');
  // Ningún error puede venir de la semana 4.
  assert.ok(staticData.validationErrors.every((e) => e.week_number !== 4),
    JSON.stringify(staticData.validationErrors.filter((e) => e.week_number === 4).slice(0, 2)));
});

test('los errores traen las filas del Excel: consecutivo repetido y tarea duplicada', () => {
  const hoja = [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', 'Emily Del Carmen Tench Pérez', 'Líder de equipo:', 'Jonathan Anaya'],
    BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
    fila(1, 5, 'Management', 'Daily', 'Daily', 1, '2026-10-02', null, [0.2], 'En Progreso'),           // fila 10
    fila(2, 5, 'Management', 'Demo', 'Demo', 1, '2026-10-02', null, [0.2], 'En Progreso'),             // fila 11
    fila(2, 5, 'Management', 'Daily', 'Daily', 1, '2026-10-02', null, [0.2], 'En Progreso'),           // fila 12: consec 2 repetido + tarea duplicada
    ['Cumplimiento'],
  ];
  const errores = correrNodo(hoja).validationErrors;
  const de = (tipo) => errores.find((e) => e.error_type === tipo);
  assert.deepStrictEqual(de('DUPLICATE_CONSECUTIVE').filas, [11, 12]);
  assert.deepStrictEqual(de('DUPLICATE_TASK').filas, [10, 12]);
});

test('hoja mezclada: semanas en plantilla anterior y la semana 5 en la nueva (caso Juan José Vera)', () => {
  // Semana 4 con la plantilla ANTERIOR (sin "Tipo de Actividad") y semana 5
  // con la NUEVA, en la misma hoja. Antes solo se medía el primer encabezado
  // y la semana 5 se leía corrida: horas como estado y como fecha 1899-12-31.
  const quitarTipo = (f) => [...f.slice(0, 4), ...f.slice(5)];
  const hoja = [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', 'Emily Del Carmen Tench Pérez', 'Líder de equipo:', 'Jonathan Anaya'],
    BANNER, quitarTipo(ENCABEZADO_NUEVO), quitarTipo(SUBTITULO_NUEVO),
    ...BLOQUE_1.map(quitarTipo),
    ['Cumplimiento', '', '', '', '', '', 42],
    [],
    BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
    ...BLOQUE_2,
    ['Cumplimiento', '', '', '', '', '', 42],
  ];
  const staticData = correrNodo(hoja, { semanaInicio: null });
  const emp = staticData.successfulEmployees[0];
  assert.strictEqual(emp.tasks.length, 17);
  assert.ok(emp.tasks.every((t) => t.planned_type === 'P'));
  assert.deepStrictEqual([...new Set(emp.tasks.map((t) => t.task_status))].sort(), ['En Progreso', 'Terminado']);
  const ia5 = emp.tasks.find((t) => t.week_number === 5 && t.activity === 'Proyecto agente desarrollo IA');
  assert.strictEqual(ia5.budgeted_hours, 36.1);
  assert.strictEqual(ia5.estimated_delivery_date, '2026-10-02');
  assert.strictEqual(ia5.hours_monday, 7.2);
  const ia4 = emp.tasks.find((t) => t.week_number === 4 && t.activity === 'Proyecto agente desarrollo IA');
  assert.strictEqual(ia4.budgeted_hours, 35.1);
  const tipos = new Set(staticData.validationErrors.map((e) => e.error_type));
  for (const t of ['INVALID_STATUS', 'MISSING_PLANNED_TYPE', 'MISSING_BUDGETED_HOURS', 'ESTIMATED_DATE_MISMATCH_WEEK', 'MISSING_WEEK_PLANNING']) {
    assert.ok(!tipos.has(t), `no debería haber ${t}`);
  }
});

test('encabezado solo con "Consecutivo" y "P=Planeada NP=No planeada", columna E vacía (hoja real de Juan Vera)', () => {
  const quitarTipo = (f) => [...f.slice(0, 4), ...f.slice(5)];
  const sinTipo = (f) => [...f.slice(0, 4), '', ...f.slice(5)];
  const hoja = [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', 'Emily Del Carmen Tench Pérez', 'Líder de equipo:', 'Jonathan Anaya'],
    // Semana 4: plantilla anterior completa.
    BANNER, quitarTipo(ENCABEZADO_NUEVO), quitarTipo(SUBTITULO_NUEVO),
    ...BLOQUE_1.map(quitarTipo),
    ['Cumplimiento'],
    [],
    // Semana 5: plantilla nueva, solo la fila de subtítulos como encabezado.
    BANNER, SUBTITULO_NUEVO,
    ...BLOQUE_2.map(sinTipo),
    ['Cumplimiento'],
  ];
  const staticData = correrNodo(hoja); // corte real: solo semana 5
  const emp = staticData.successfulEmployees[0];
  assert.strictEqual(emp.tasks.length, 8);
  assert.ok(emp.tasks.every((t) => t.planned_type === 'P'));
  assert.deepStrictEqual([...new Set(emp.tasks.map((t) => t.task_status))].sort(), ['En Progreso', 'Terminado']);
  const ia = emp.tasks.find((t) => t.activity === 'Proyecto agente desarrollo IA');
  assert.strictEqual(ia.budgeted_hours, 36.1);
  assert.strictEqual(ia.estimated_delivery_date, '2026-10-02');
  const tipos = new Set(staticData.validationErrors.map((e) => e.error_type));
  for (const t of ['INVALID_STATUS', 'MISSING_PLANNED_TYPE', 'MISSING_BUDGETED_HOURS', 'ESTIMATED_DATE_MISMATCH_WEEK', 'TASK_OVERDUE_IN_PLANNING', 'MISSING_WEEK_PLANNING']) {
    assert.ok(!tipos.has(t), `no debería haber ${t}`);
  }
});

// ---------------------------------------------------------------------------
// v23: corrida de recuperación (el sábado falla y se corre a mano el lunes)
// ---------------------------------------------------------------------------

const OCTUBRE_VIERNES_16 = { snapshotDate: '2026-10-16', monthName: 'Octubre', monthNumber: 10, yearNumber: 2026 };

function hojaCon(...filas) {
  return [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', 'Emily Del Carmen Tench Pérez', 'Líder de equipo:', 'Jonathan Anaya'],
    BANNER, ENCABEZADO_NUEVO, SUBTITULO_NUEVO,
    ...filas,
    ['Cumplimiento'],
  ];
}

// Semana 2 de octubre (12 al 16): lo que se debe reportar.
const OCT_SEMANA_2 = [
  fila(1, 2, 'Management', 'Daily', 'Daily', 1, '2026-10-16', null, [0.2, 0.2, 0.2, 0.2, 0.2], 'En Progreso'),
  fila(2, 2, 'Gestion financiera (MIA)', 'Conciliación', 'Desarrollo', 8, '2026-10-16', null, [2, 2, 2, 2], 'En Progreso'),
];
// Semana 3 (19 al 23), planeada el lunes 19 — con errores a propósito, que el
// reporte del viernes NO debe mostrar.
const OCT_SEMANA_3 = [
  fila(1, 3, 'Management', 'Daily', 'Daily', 1, '2026-10-23', null, [], 'En Progreso'),
  fila(2, 3, 'Gestion financiera (MIA)', 'Conciliación', 'Desarrollo', 8, '2026-10-23', null, [], ''), // sin estado
  fila(2, 3, 'Management', 'Demo', 'Demo', 1, '2026-10-23', null, [], 'En Progreso'),                  // consecutivo repetido
];

const tipos = (staticData) => new Set(staticData.validationErrors.map((e) => e.error_type));
const semanas = (staticData) => [...new Set(staticData.successfulEmployees[0].tasks.map((t) => t.week_number))].sort();

test('recuperación lunes 19-oct: reporta el viernes 16 (semana 2) y no lee la semana 3', () => {
  const sd = correrNodo(hojaCon(...OCT_SEMANA_2, ...OCT_SEMANA_3), {
    contexto: OCTUBRE_VIERNES_16, ahora: '2026-10-19T19:43:00Z', // lunes 14:43 en Colombia
  });
  assert.deepStrictEqual(semanas(sd), [2]);
  assert.strictEqual(sd.currentMonthWeek, 2);
  for (const t of ['WEEK_NUMBER_MISMATCH', 'MISSING_STATUS', 'DUPLICATE_CONSECUTIVE', 'MISSING_WEEK_PLANNING']) {
    assert.ok(!tipos(sd).has(t), `no debería haber ${t}: ${JSON.stringify(sd.validationErrors.filter((e) => e.error_type === t))}`);
  }
  assert.ok(sd.validationErrors.every((e) => e.week_number !== 3));
});

test('recuperación: una semana que todavía no empieza (la 4, estando en la 3) sí sale como futura', () => {
  const sd = correrNodo(hojaCon(...OCT_SEMANA_2, ...OCT_SEMANA_3,
    fila(1, 4, 'Management', 'Daily', 'Daily', 1, '2026-10-30', null, [], 'En Progreso')), {
    contexto: OCTUBRE_VIERNES_16, ahora: '2026-10-19T19:43:00Z',
  });
  const futura = sd.validationErrors.filter((e) => e.error_type === 'WEEK_NUMBER_MISMATCH');
  assert.strictEqual(futura.length, 1);
  assert.match(futura[0].error_message, /1 tarea con semana 4/);
  assert.doesNotMatch(futura[0].error_message, /semana 3/);
});

test('recuperación automática martes 18-ago (lunes 17 festivo): reporta el viernes 14 sin marcar la semana 3', () => {
  const sd = correrNodo(hojaCon(
    fila(1, 2, 'Management', 'Daily', 'Daily', 1, '2026-08-14', null, [0.2, 0.2, 0.2, 0.2, 0.2], 'En Progreso'),
    fila(1, 3, 'Management', 'Daily', 'Daily', 1, '2026-08-21', null, [], 'En Progreso'),
  ), {
    semanaInicio: null,
    contexto: { snapshotDate: '2026-08-14', monthName: 'Agosto', monthNumber: 8, yearNumber: 2026 },
    ahora: '2026-08-18T14:23:00Z',
  });
  assert.deepStrictEqual(semanas(sd), [2]);
  assert.ok(!tipos(sd).has('WEEK_NUMBER_MISMATCH'));
});

test('corrida normal del sábado 17 (analiza el viernes 16): nada cambia, la semana 3 sigue siendo futura', () => {
  const sd = correrNodo(hojaCon(...OCT_SEMANA_2, ...OCT_SEMANA_3), {
    contexto: OCTUBRE_VIERNES_16, ahora: '2026-10-17T11:00:00Z', // sábado 6:00 en Colombia
  });
  assert.deepStrictEqual(semanas(sd), [2, 3]);
  assert.ok(tipos(sd).has('WEEK_NUMBER_MISMATCH'));
});

test('día normal (miércoles 14 analiza martes 13): una semana 3 puesta por error se sigue detectando', () => {
  const sd = correrNodo(hojaCon(...OCT_SEMANA_2, ...OCT_SEMANA_3), {
    contexto: { ...OCTUBRE_VIERNES_16, snapshotDate: '2026-10-13' }, ahora: '2026-10-14T11:00:00Z',
  });
  assert.deepStrictEqual(semanas(sd), [2, 3]);
  assert.ok(tipos(sd).has('WEEK_NUMBER_MISMATCH'));
  assert.ok(tipos(sd).has('MISSING_STATUS'), 'los errores de las filas de la semana 3 se siguen reportando');
});
