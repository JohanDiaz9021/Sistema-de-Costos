/* global $, $input, $getWorkflowStaticData -- globales del nodo Code de n8n */
// =============================================================
// PARSEAR Y ACUMULAR — v23 (2026-10-19)
// 🔧 v23: corrida de recuperación (ej. el sábado falla y se corre a mano el
//   lunes): la semana que empezó después del último día laboral analizado no
//   se lee, para que el reporte del viernes no marque la semana nueva como
//   "semana FUTURA". Ver ES_RECUPERACION más abajo.
// 🔧 v20: dos cambios del Excel de Planeación (sep 2026):
//   1) La plantilla agregó la columna E "Tipo de Actividad". Todo lo que
//      está de E en adelante se corrió una posición y este parser, que lee
//      por posición fija, rechazaba el 100% de las filas (0 tareas cargadas
//      y miles de errores falsos el 30 sep). normalizarPlantilla() quita las
//      columnas que sobran para que las filas queden como en la plantilla
//      anterior; el resto del código no cambia. Si el archivo trae la
//      plantilla anterior, no toca nada.
//   2) La columna "Proyecto" ahora trae MÓDULOS con el proyecto entre
//      paréntesis ("Gestion financiera (MIA)"), y SharePoint se organiza por
//      Equipo ("Equipo 4"), no por proyecto. proyectoPadre() lleva cada
//      módulo a su proyecto (MIA, SESCOL...), con el mismo nombre que usa
//      mp_project_owners — de ahí sale a qué PM le llega cada cosa. Cada
//      tarea y cada error de validación quedan marcados con el proyecto de
//      SU fila; los errores de todo el archivo (líder vacío, semana sin
//      planear...) van al proyecto principal de la persona.
//   Además: la plantilla dice "Líder de equipo:" donde antes decía "A cargo
//   de", y las filas de encabezado repetidas (un bloque por semana) ya no se
//   leen como tareas.
// 🔧 v17 (2026-08-05)
// 🔧 v17: EXECUTED_HOURS_IN_FUTURE ahora usa el DÍA FÍSICO REAL (Colombia)
//        como corte, no el día del snapshot. Corrige el caso "RPA se ejecuta
//        manual a mediodía y flagea las horas que la gente ya logueó del día
//        actual como si fueran futuras". El día actual NUNCA se flagea; solo
//        los días estrictamente POSTERIORES al día físico real.
// 🔧 v16: mensaje diferenciado cuando Graph API falla al listar hojas.
// =============================================================

// El flujo tiene DOS copias de estos nodos: la vieja ("Guardar Drive ID") y la
// que corre hoy, con sufijo ("Guardar Drive ID1"). Se usa la primera que SÍ se
// ejecutó en esta corrida: pedir un nodo que no corrió revienta con
// "Node '...' hasn't been executed".
function nodoEjecutado(nombres) {
  for (const n of nombres) {
    try {
      if ($(n).first()) return n;
    } catch (e) { /* no existe o no se ejecutó en esta corrida */ }
  }
  throw new Error(`Ninguno de estos nodos se ejecutó en esta corrida: ${nombres.join(', ')}`);
}
const NODO_DRIVE = nodoEjecutado(['Guardar Drive ID1', 'Guardar Drive ID']);
const NODO_HOJA_MES = nodoEjecutado(['Resolver hoja del mes1', 'Resolver hoja del mes']);

const ctx = $(NODO_DRIVE).first().json;
const staticData = $getWorkflowStaticData('global');

staticData.successfulEmployees = [];
staticData.parsingErrors = [];
staticData.nameInconsistencies = [];
staticData.validationErrors = [];
if (!staticData.folderToProject) staticData.folderToProject = {};

const extractItems = $input.all();
const foldersWithFileAll = $(NODO_HOJA_MES).all().map(i => i.json);

console.log(`📊 Procesando ${foldersWithFileAll.length} archivos, ${extractItems.length} filas totales`);

// =============================================================
// HELPERS
// =============================================================

function excelSerialToDate(serial) {
  if (serial == null || serial === '') return null;
  if (typeof serial === 'string' && /^\d{4}-\d{2}-\d{2}/.test(serial)) {
    return serial.slice(0, 10);
  }
  const num = Number(serial);
  if (isNaN(num) || num < 1) return null;
  const excelEpoch = Date.UTC(1899, 11, 30);
  const ms = excelEpoch + num * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// 🆕 v20: PROYECTO PADRE de una fila. El desplegable "Proyecto" trae
// "Módulo (Proyecto)" — "Admisiones (Sescol)" → SESCOL — salvo "Management" y
// "Sistema de Costos", que van sin paréntesis. Devuelve el nombre EXACTO que
// usa mp_project_owners.project_folder.
// 🔧 v22 (2026-10-06): un proyecto que NO está en esta lista ya no cae a la
// etiqueta del Equipo ("Equipo 9"): se usa su propio nombre — lo que va entre
// paréntesis ("Formularios (Banco XYZ)" → "Banco XYZ") o, sin paréntesis, el
// valor completo ("Automatización de captura de leads"). Así los proyectos
// que los PM agregan a la hoja "Datos" se reconocen solos, sin tocar n8n. La
// etiqueta del Equipo solo queda para la celda vacía.
//
// Esta lista ya NO hay que ampliarla por cada proyecto nuevo: solo sirve para
// llevar un nombre del desplegable al nombre EXACTO que se usa en la base
// ("Sescol" → "SESCOL", "Sistema de Costos" → "sistema-de-costos"). La clave
// va en minúsculas y sin tildes.
const PROYECTOS_PADRE = new Map([
  ['management', 'Management'],
  ['transversales', 'Transversales'],
  ['document online', 'Document Online'],
  ['sescol', 'SESCOL'],
  ['mia', 'MIA'],
  ['sistema de costos', 'sistema-de-costos'],
  // Equipo 7 (13 oct 2026). Algunos Excel traen "infraestrucutra", mal
  // escrito: sin esta línea quedaba como un proyecto aparte.
  ['infraestructura', 'Infraestructura'],
  ['infraestrucutra', 'Infraestructura'],
]);

const PATRON_MODULO = /^(.+?)\s*\(([^()]+)\)\s*$/;

function proyectoPadre(valorExcel, carpetaEquipo) {
  const nombre = String(valorExcel ?? '').trim().replace(/\s+/g, ' ');
  if (!nombre) return carpetaEquipo;
  const m = nombre.match(PATRON_MODULO);
  const proyecto = (m ? m[2] : nombre).trim();
  // 100 = largo de mp_task_facts.project_folder.
  return PROYECTOS_PADRE.get(normalizeText(proyecto)) || proyecto.slice(0, 100);
}

// 🆕 v20: proyecto "principal" de un archivo, para los errores que no son de
// una fila (líder vacío, semana sin planear, consecutivos...). Es el proyecto
// con más tareas; Management (dailies, reuniones — lo tiene casi todo el
// mundo) solo gana si no hay otro. null si ninguna fila se reconoció.
function proyectoPrincipal(tasks, carpetaEquipo) {
  const cuenta = new Map();
  for (const t of tasks) {
    if (!t.project_folder || t.project_folder === carpetaEquipo) continue;
    cuenta.set(t.project_folder, (cuenta.get(t.project_folder) || 0) + 1);
  }
  const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
  const sinManagement = orden.find(([p]) => p !== 'Management');
  return (sinManagement || orden[0] || [null])[0];
}

// 🆕 v20: lleva una hoja de la plantilla NUEVA a las posiciones de la
// anterior, que es lo que el resto del código espera:
//   anterior: A Consec | B Semana | C Proyecto | D Actividad | E P/NP | F Horas ...
//   nueva:    A Consec | B Semana | C Proyecto | D Actividad | E Tipo de Actividad | F P/NP | G Horas ...
// Mide cuántas columnas se agregaron mirando dónde quedó "P/NP" en la fila
// de encabezados y las quita de las filas de esa tabla (las de arriba del
// primer encabezado — nombre, líder — no se tocan). Se identifica por el
// TEXTO del encabezado, no por la posición, así que si agregan otra columna
// antes de "P/NP" sigue funcionando.
// 🔧 v21: se mide CADA tabla (cada fila "# Consec.") por separado. Una misma
// hoja puede tener semanas en la plantilla anterior y la semana nueva en la
// plantilla nueva (Juan José Vera, 2 oct 2026): antes solo se miraba el
// primer encabezado y la semana 5 se leía corrida una columna (horas como
// estado, horas como fecha 1899-12-31, sin P/NP ni horas presupuestadas).
function normalizarPlantilla(values) {
  const clave = (v) => String(v ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  let sobran = 0;
  let vistoEncabezado = false;
  return values.map((fila) => {
    if (!Array.isArray(fila)) return fila;
    // Encabezado de una tabla: primera celda "# Consec." / "Consecutivo" y una
    // columna "P / NP" o "P=Planeada NP=No planeada" (hay hojas que solo
    // traen esta segunda versión del encabezado, p. ej. Juan José Vera).
    const esPnp = (v) => { const c = clave(v); return c === 'pnp' || c.startsWith('pplaneada'); };
    const idxPnp = clave(fila[0]).startsWith('consec') ? fila.findIndex(esPnp) : -1;
    if (idxPnp >= 0) {
      vistoEncabezado = true;
      sobran = idxPnp > 4 ? idxPnp - 4 : 0;
    }
    if (!vistoEncabezado || sobran === 0) return fila;
    return [...fila.slice(0, 4), ...fila.slice(4 + sobran)];
  });
}

function getMonthWeekNumber(dateInput, targetYear, targetMonth) {
  let date;
  if (dateInput instanceof Date) {
    date = new Date(Date.UTC(dateInput.getUTCFullYear(), dateInput.getUTCMonth(), dateInput.getUTCDate()));
  } else if (typeof dateInput === 'string') {
    date = new Date(dateInput + 'T00:00:00Z');
  } else {
    return null;
  }
  if (isNaN(date.getTime())) return null;

  const dow = date.getUTCDay() || 7;
  const monday = new Date(date.getTime() - (dow - 1) * 86400000);

  const monthCounts = {};
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday.getTime() + i * 86400000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthCounts[key] = (monthCounts[key] || 0) + 1;
  }

  const targetKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
  const daysInTargetMonth = monthCounts[targetKey] || 0;

  if (daysInTargetMonth < 3) return null;

  const firstDay = new Date(Date.UTC(targetYear, targetMonth - 1, 1));
  let weekCounter = 0;
  const firstDow = firstDay.getUTCDay() || 7;
  let currentMonday = new Date(firstDay.getTime() - (firstDow - 1) * 86400000);

  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0));
  while (currentMonday <= lastDay) {
    let daysInMonth = 0;
    for (let i = 0; i < 5; i++) {
      const d = new Date(currentMonday.getTime() + i * 86400000);
      if (d.getUTCFullYear() === targetYear && d.getUTCMonth() + 1 === targetMonth) {
        daysInMonth++;
      }
    }
    if (daysInMonth >= 3) {
      weekCounter++;
      if (currentMonday.getTime() === monday.getTime()) {
        return weekCounter;
      }
    }
    currentMonday = new Date(currentMonday.getTime() + 7 * 86400000);
  }

  return null;
}

// 🆕 v17: Resuelve la FECHA REAL de un día-de-semana específico (Lun=1..Sáb=6)
// dentro de una semana determinada del mes. Se usa para comparar contra el día
// físico real y así detectar horas ejecutadas en días que aún no han transcurrido.
function getDateOfWeekInMonth(year, month, weekNumInMonth, dayIdx) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = firstDay.getUTCDay() || 7;
  let currentMonday = new Date(firstDay.getTime() - (firstDow - 1) * 86400000);
  let weekCounter = 0;
  const lastDay = new Date(Date.UTC(year, month, 0));
  while (currentMonday <= lastDay) {
    let daysInMonth = 0;
    for (let i = 0; i < 5; i++) {
      const d = new Date(currentMonday.getTime() + i * 86400000);
      if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month) daysInMonth++;
    }
    if (daysInMonth >= 3) {
      weekCounter++;
      if (weekCounter === weekNumInMonth) {
        return new Date(currentMonday.getTime() + (dayIdx - 1) * 86400000);
      }
    }
    currentMonday = new Date(currentMonday.getTime() + 7 * 86400000);
  }
  return null;
}

// =============================================================
// CONSTANTES
// =============================================================

const ERROR_SEVERITY = {
  'NO_FILE': 'critical',
  'MISSING_MONTH_SHEET': 'critical',
  'DUPLICATE_MONTH_SHEET': 'warning',
  'INVALID_TALENT_AND_LEADER': 'critical',
  'NON_SEQUENTIAL_CONSECUTIVE': 'warning',
  'EMPTY_SHEET': 'critical',
  'PARSE_ERROR': 'critical',
  'EMPLOYEE_NOT_IN_CATALOG': 'critical',
  'MISSING_WEEK_PLANNING': 'critical',
  'NO_EMPLOYEE_NAME': 'warning',
  'NAME_MISMATCH': 'warning',
  'MISSING_LEADER': 'warning',
  'DUPLICATE_WEEK_TASKS': 'warning',
  'DUPLICATE_CONSECUTIVE': 'warning',
  'DUPLICATE_TASK': 'warning',
  'WEEK_NUMBER_MISMATCH': 'warning',
  'EXECUTED_HOURS_IN_FUTURE': 'warning',
  'TASK_OVERDUE_IN_PLANNING': 'warning',
  'MISSING_PROJECT': 'warning',
  'MISSING_ASSIGNEE': 'warning',
  'ZERO_BUDGETED_HOURS': 'warning',
  'ESTIMATED_DATE_MISMATCH_WEEK': 'warning',
  'MISSING_CONSECUTIVE': 'info',
  'MISSING_WEEK_NUMBER': 'info',
  'MISSING_ACTIVITY': 'info',
  'MISSING_PLANNED_TYPE': 'info',
  'MISSING_BUDGETED_HOURS': 'info',
  'MISSING_DELIVERY_DATE': 'info',
  'MISSING_STATUS': 'info',
  'INVALID_STATUS': 'info',
  'MISSING_OBSERVATIONS_BLOCKED': 'info',
  'EMPLOYEE_MISSING_EMAIL': 'critical',
  'TERMINATED_WITHOUT_DELIVERY_DATE': 'warning',
  'EXECUTED_HOURS_WITHOUT_ESTIMATE': 'warning',
  'TT_INCONSISTENT': 'warning'
};


// v20: `filas` = filas del Excel donde está el problema (números o rangos
// "138–157"). El correo del líder las muestra junto a cada hallazgo para que
// se encuentre el error sin buscar en toda la hoja.
function addValidationError(folderName, fileName, errorType, message, projectFolder, weekNumber, filas) {
  const severity = ERROR_SEVERITY[errorType] || 'info';
  const pf = projectFolder || (folderName && staticData.folderToProject[folderName]) || null;
  const wk = (weekNumber === undefined || weekNumber === null || isNaN(Number(weekNumber))) ? null : Number(weekNumber);
  staticData.validationErrors.push({
    employee_folder_name: folderName,
    file_name: fileName,
    error_type: errorType,
    severity: severity,
    error_message: message,
    project_folder: pf,
    week_number: wk,
    filas: Array.isArray(filas) && filas.length ? filas : null
  });
}


// =============================================================
// DATOS DEL SNAPSHOT
// =============================================================
// 🆕 v20: FECHA DE CORTE. Con la plantilla nueva (módulos + "Tipo de
// Actividad") se arranca de cero desde la semana 5 de septiembre 2026, que
// empieza el lunes 28-sep: las tablas de semanas anteriores (formato viejo) se
// IGNORAN — no se cargan como tareas ni generan errores. Una semana se procesa
// si su lunes cae en esta fecha o después. Para procesar todo, poner null.
const SEMANA_INICIO = '2026-09-28';

// ¿La semana declarada (número de semana del mes de planeación) empieza
// antes del corte? Sin número de semana no se puede saber: se procesa.
function semanaAntesDelCorte(semana) {
  if (!SEMANA_INICIO || semana === null || semana === undefined || semana === '' || isNaN(Number(semana))) return false;
  const lunes = getDateOfWeekInMonth(ctx.yearNumber, ctx.monthNumber, Number(semana), 1);
  return !!lunes && lunes < new Date(SEMANA_INICIO + 'T00:00:00Z');
}

const snapshotDate = new Date(ctx.snapshotDate + 'T00:00:00Z');
const snapshotDow = snapshotDate.getUTCDay() || 7;
const currentMonthWeek = getMonthWeekNumber(ctx.snapshotDate, ctx.yearNumber, ctx.monthNumber);
staticData.currentMonthWeek = currentMonthWeek; // exposed for email filter
const dowName = ['','lunes','martes','miércoles','jueves','viernes','sábado','domingo'][snapshotDow];

// 🆕 v17: DÍA FÍSICO REAL (Colombia UTC-5) truncado a medianoche. Se usa como
// corte para EXECUTED_HOURS_IN_FUTURE en vez del día del snapshot — así, si el
// RPA se ejecuta manualmente al mediodía, las horas que la gente ya logueó del
// día actual NO se marcan como futuras. El día actual siempre es válido.
const _physicalNowUtc = new Date();
const physicalTodayStr = new Date(_physicalNowUtc.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const physicalToday = new Date(physicalTodayStr + 'T00:00:00Z');
const physicalTodayDow = physicalToday.getUTCDay() || 7;
const physicalDayName = ['','lunes','martes','miércoles','jueves','viernes','sábado','domingo'][physicalTodayDow];

// 🆕 v23 (2026-10-19): CORRIDA DE RECUPERACIÓN. El reporte es siempre del
// último día laboral (el viernes, en la corrida del sábado). Si el sábado falla
// y se corre a mano el lunes, el Excel ya trae la semana NUEVA, que empezó ese
// lunes: el lunes 19-oct se analizó el viernes 16 (semana 2) y la semana 3 salió
// como "semana FUTURA" para 16 personas. Ya había pasado solo el martes 18-ago
// (lunes festivo, se analizó el viernes 14): 19 personas.
// Regla: si HOY ya está en una semana posterior a la del día analizado, las
// semanas que empezaron DESPUÉS del día analizado y hasta hoy no se leen — ni
// tareas ni errores, igual que las anteriores a SEMANA_INICIO. El reporte sale
// como habría salido el día siguiente al analizado. Una semana que todavía no
// empieza (la 4, estando en la 3) sí se sigue marcando como futura.
// En las corridas normales (mar-sáb) hoy y el día analizado caen en la misma
// semana, así que esto no cambia nada.
function lunesDe(fechaUtc) {
  const dow = fechaUtc.getUTCDay() || 7;
  return new Date(fechaUtc.getTime() - (dow - 1) * 86400000);
}
const LUNES_ANALIZADO = lunesDe(snapshotDate);
const LUNES_HOY = lunesDe(physicalToday);
const ES_RECUPERACION = LUNES_HOY > LUNES_ANALIZADO;

function semanaNuevaDeRecuperacion(semana) {
  if (!ES_RECUPERACION || semana === null || semana === undefined || semana === '' || isNaN(Number(semana))) return false;
  const lunes = getDateOfWeekInMonth(ctx.yearNumber, ctx.monthNumber, Number(semana), 1);
  return !!lunes && lunes > LUNES_ANALIZADO && lunes <= LUNES_HOY;
}

console.log(`📅 Snapshot: ${ctx.snapshotDate} (${dowName}) — Semana ${currentMonthWeek} de ${ctx.monthName}`);
console.log(`🕐 Hoy físico (Colombia): ${physicalTodayStr} (${physicalDayName}) — corte para EXECUTED_HOURS_IN_FUTURE`);
if (ES_RECUPERACION) {
  console.log(`♻️ Corrida de recuperación: se reporta hasta el ${ctx.snapshotDate}; las semanas que empezaron después no se leen.`);
}

// =============================================================
// AGRUPAR FILAS POR ARCHIVO — v18 (2026-08-31)
// 🔧 v18: adaptado para Graph API workbook endpoint (/usedRange).
//        Cada item de entrada corresponde a UN archivo (no a una fila).
//        item.json.values = matriz 2D [[celda,celda,...], ...] de la hoja.
//        Los errores de Graph vienen como {error: {code, message}} y se
//        capturan como PARSE_ERROR (mantiene comportamiento previo).
// =============================================================

const fileGroupsMap = {};
let filesWithError = 0;

for (let i = 0; i < extractItems.length; i++) {
  const item = extractItems[i];
  const respBody = item.json || {};

  let fileCtx;
  try {
    fileCtx = $(NODO_HOJA_MES).itemMatching(i).json;
  } catch (e) {
    fileCtx = null;
  }

  if (!fileCtx || !fileCtx.fileId) continue;

  // Detectar error de Graph API (ej. rango excede límite, hoja no existe)
  if (respBody.error) {
    console.log(`❌ Graph error en ${fileCtx.fileName}: ${respBody.error.message || respBody.error.code}`);
    addValidationError(
      fileCtx.employeeFolderName,
      fileCtx.fileName,
      'PARSE_ERROR',
      `Error al leer hoja "${fileCtx.targetSheetName}" vía Graph API: ${respBody.error.message || respBody.error.code}`,
      fileCtx.projectFolder
    );
    filesWithError++;
    continue;
  }

  const values = normalizarPlantilla(respBody.values || []);
  if (values.length === 0) {
    addValidationError(
      fileCtx.employeeFolderName,
      fileCtx.fileName,
      'EMPTY_SHEET',
      `La hoja "${fileCtx.targetSheetName}" está vacía o no devolvió filas.`,
      fileCtx.projectFolder
    );
    continue;
  }

  if (!fileGroupsMap[fileCtx.fileId]) {
    fileGroupsMap[fileCtx.fileId] = {
      ctx: fileCtx,
      rows: []
    };
  }
  for (const row of values) {
    fileGroupsMap[fileCtx.fileId].rows.push(row);
  }
}

if (filesWithError > 0) {
  console.log(`⚠️ ${filesWithError} archivos con error de Graph API`);
}

const fileGroups = Object.values(fileGroupsMap);
console.log(`📑 Archivos válidos para procesar: ${fileGroups.length} de ${extractItems.length}`);


// =============================================================
// PROCESAR CADA ARCHIVO
// =============================================================
for (const group of fileGroups) {
  const sheetRows = group.rows;
  const fileCtx = group.ctx;
  const fileName = fileCtx.fileName || 'archivo_sin_nombre';
  const folderName = fileCtx.employeeFolderName || '';
  // Desde la reorganización de SharePoint esto es el EQUIPO ("Equipo 4"), no el
  // proyecto: el proyecto sale de cada fila (proyectoPadre, v20).
  const projectFolder = fileCtx.projectFolder || null;
  // Todo error agregado desde aquí es de este archivo (ver el ajuste de
  // proyecto al final del loop).
  const erroresDesde = staticData.validationErrors.length;

  if (folderName && projectFolder) {
    staticData.folderToProject[folderName] = projectFolder;
  }

  console.log(`\n📄 [${projectFolder}] ${fileName}`);
  console.log(`   📁 Carpeta: ${folderName} | ${sheetRows.length} filas`);

  const employeeName = folderName;

  if (!employeeName) {
    addValidationError(folderName, fileName, 'PARSE_ERROR', 'Carpeta sin nombre identificable', projectFolder);
    continue;
  }

  let leaderName = null;
  let nameFromExcel = null;

  // v20: solo las filas ANTERIORES al encabezado de la tabla. Las primeras 10
  // filas ya incluyen ese encabezado, que tiene una columna "A Cargo De": con
  // el campo "Líder de equipo" vacío, el parser tomaba como líder el texto del
  // encabezado vecino ("Observaciones") y el error MISSING_LEADER no salía.
  const idxEncabezado = sheetRows.findIndex((r) => normalizeText((r || [])[0]).replace(/[^a-z]/g, '').startsWith('consec'));
  const searchRows = sheetRows.slice(0, idxEncabezado >= 0 ? Math.min(10, idxEncabezado) : Math.min(10, sheetRows.length));

  // v20: la plantilla nueva dice "Líder de equipo:" donde antes decía "A cargo de".
  const FIELD_LABELS = ['nombre del talento', 'a cargo de', 'lider de equipo', 'identifica'];

  const BASURA_VALUES = ['n/a', 'na', 'no aplica', 'no aplica.', 'x', 'xx', 'xxx',
                         'pendiente', 'sin asignar', 'sin definir', 'tbd', 'tba',
                         '-', '--', '---', '.', '..', '...', 'ninguno', 'ninguna',
                         'pendiete', 'pendient', 'pediente', '?', '??', '???'];

  function isFieldLabel(text) {
    const lower = normalizeText(text);
    return FIELD_LABELS.some(label => lower.includes(label));
  }

  function isValidName(text) {
    if (!text) return false;
    const clean = String(text).trim();
    if (clean.length < 3) return false;
    if (BASURA_VALUES.includes(clean.toLowerCase())) return false;
    if (/^[\d\s\-\.\,]+$/.test(clean)) return false;
    if (!/[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}/.test(clean)) return false;
    return true;
  }

  function extractValueAfterLabel(row, startIdx, maxLookahead = 4) {
    const end = Math.min(row.length, startIdx + 1 + maxLookahead);
    for (let j = startIdx + 1; j < end; j++) {
      const val = String(row[j] || '').trim();
      if (!val) continue;
      if (isFieldLabel(val)) {
        return null;
      }
      return val;
    }
    return null;
  }

  for (const row of searchRows) {
    for (let i = 0; i < row.length; i++) {
      const cell = normalizeText(row[i]);

      if (cell.includes('nombre del talento') && !nameFromExcel) {
        const val = extractValueAfterLabel(row, i);
        if (val) nameFromExcel = val;
      }

      if ((cell.includes('a cargo de') || cell.includes('lider de equipo')) && !leaderName) {
        const val = extractValueAfterLabel(row, i);
        if (val) leaderName = val;
      }
    }
  }

  const nameIsValid = nameFromExcel && isValidName(nameFromExcel);
  const leaderIsValid = leaderName && isValidName(leaderName);

  if (!nameIsValid && !leaderIsValid) {
    const nombreMostrar = nameFromExcel ? `"${nameFromExcel}"` : '(vacío)';
    const liderMostrar = leaderName ? `"${leaderName}"` : '(vacío)';
    addValidationError(folderName, fileName, 'INVALID_TALENT_AND_LEADER',
      `Tu archivo tiene ambos campos clave sin diligenciar correctamente: "Nombre del talento" ${nombreMostrar} y "Líder de equipo" ${liderMostrar}. Por favor escribe tu nombre completo en la celda B6 y el nombre completo de tu líder junto a "Líder de equipo:" (fila 6).`, projectFolder);
  } else {
    if (!nameIsValid) {
      if (!nameFromExcel) {
        addValidationError(folderName, fileName, 'NO_EMPLOYEE_NAME',
          `La celda B6 ("Nombre del talento") está vacía en el archivo. Por favor diligénciala con tu nombre completo.`, projectFolder);
      } else {
        addValidationError(folderName, fileName, 'NO_EMPLOYEE_NAME',
          `La celda B6 ("Nombre del talento") tiene un valor que no parece un nombre real: "${nameFromExcel}". Por favor diligénciala con tu nombre completo.`, projectFolder);
      }
    } else {
      const folderNorm = normalizeName(folderName);
      const excelNorm = normalizeName(nameFromExcel);
      if (folderNorm !== excelNorm) {
        const folderWords = folderNorm.split(' ');
        const excelWords = excelNorm.split(' ');
        const sharedWords = folderWords.filter(w => excelWords.includes(w)).length;
        const isCompletelyDifferent = sharedWords < Math.min(folderWords.length, excelWords.length) / 2;

        if (isCompletelyDifferent) {
          addValidationError(folderName, fileName, 'NAME_MISMATCH',
            `El nombre en la celda B6 ("${nameFromExcel}") no coincide con el nombre de tu carpeta ("${folderName}"). Verifica si descargaste la plantilla correcta o si la carpeta está bien asignada.`, projectFolder);
        }
      }
    }

    if (!leaderIsValid) {
      if (!leaderName) {
        addValidationError(folderName, fileName, 'MISSING_LEADER',
          'El campo "Líder de equipo" (fila 6) está vacía. Por favor escribe el nombre completo de tu líder.', projectFolder);
      } else {
        addValidationError(folderName, fileName, 'MISSING_LEADER',
          `El campo "Líder de equipo" (fila 6) tiene un valor que no parece un nombre real: "${leaderName}". Por favor escribe el nombre completo de tu líder.`, projectFolder);
      }
    }
  }

  console.log(`   👤 Empleado: ${employeeName} | Líder: ${leaderName || '(falta)'}`);

  let dataStartIdx = -1;
  let foundHeader = false;

  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    const firstCell = String(row[0] || '').toLowerCase().trim();

    if (firstCell.includes('consec') || firstCell === 'consecutivo') {
      foundHeader = true;
      continue;
    }

    if (foundHeader) {
      const pCol = String(row[2] || '').trim();
      const aCol = String(row[3] || '').trim();
      const bCol = row[5];

      const hasProject = pCol && !pCol.startsWith('🔽') && pCol !== 'Elige proyecto';
      const hasActivity = aCol.length > 0;
      const hasBudget = bCol != null && bCol !== '' && !isNaN(Number(bCol)) && Number(bCol) > 0;

      if (hasProject && hasActivity && hasBudget) {
        dataStartIdx = i;
        break;
      }
    }
  }

  if (dataStartIdx === -1) {
    dataStartIdx = 9;
  }

  console.log(`   📍 Datos desde índice ${dataStartIdx}`);

  const tasks = [];
  let inconsistencyCount = 0;

  const visualBlocks = [];
  let currentBlockId = 0;

  const consecutivosVistos = {};
  const tareasUnicas = {};
  const semanaCounts = {};
  let filasAntesDelCorte = 0;
  let filasSemanaNueva = 0;

  for (let rowIdx = dataStartIdx; rowIdx < sheetRows.length; rowIdx++) {
    const row = sheetRows[rowIdx];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const consecutive = row[0];
    const weekNumber = row[1];
    const projectName = row[2];
    const activity = row[3];
    const plannedType = row[4];
    const budgetedHours = row[5];

    const projectStr = String(projectName || '').trim();
    const activityStr = String(activity || '').trim();
    const consecStr = String(consecutive || '').trim();
    const weekStr = String(weekNumber || '').trim();
    const plannedStr = String(plannedType || '').trim();
    const budgetStrCheck = String(budgetedHours || '').trim();
    const budgetNum = Number(budgetedHours);

    if (consecStr.toLowerCase() === 'cumplimiento' || projectStr.toLowerCase() === 'cumplimiento') {
      currentBlockId++;
      continue;
    }

    if (!consecStr && !weekStr && !projectStr && !activityStr && !plannedStr && !budgetStrCheck) {
      continue;
    }

    // v20: fila de encabezados repetida (un bloque por semana: "# Consec." y el
    // subtítulo "Consecutivo"): no es una tarea.
    if (normalizeText(consecStr).replace(/[^a-z]/g, '').startsWith('consec')) continue;

    if (projectStr.startsWith('🔽') || projectStr === 'Elige proyecto') continue;
    if (!activityStr) continue;

    // v20: semanas anteriores al corte (SEMANA_INICIO): ni tareas ni errores.
    if (semanaAntesDelCorte(weekNumber)) { filasAntesDelCorte++; continue; }
    // v23: corrida de recuperación — la semana que empezó después del día analizado no se lee.
    if (semanaNuevaDeRecuperacion(weekNumber)) { filasSemanaNueva++; continue; }

    // v20: proyecto padre de ESTA fila — a su PM le llegan sus errores y sus datos.
    const proyectoFila = proyectoPadre(projectStr, projectFolder);

    const taskRef = activityStr || projectStr || `Fila Excel ~${rowIdx + 6}`;
    const validations = [];
    const excelRowNum = rowIdx + 1;

    if (!projectStr) {
      validations.push({ type: 'MISSING_PROJECT', msg: 'Falta seleccionar proyecto' });
    }
    if (!activityStr) {
      validations.push({ type: 'MISSING_ACTIVITY', msg: 'Falta descripción de la actividad' });
    }
    if (budgetedHours == null || budgetedHours === '' || isNaN(budgetNum)) {
      validations.push({ type: 'MISSING_BUDGETED_HOURS', msg: 'Falta horas presupuestadas' });
    } else if (budgetNum === 0 && String(row[15] || '').toLowerCase().trim() !== 'cancelado') {
      validations.push({ type: 'ZERO_BUDGETED_HOURS', msg: 'La tarea tiene 0 horas presupuestadas. Si presupuestaste 0 por error, corrige el valor; si la tarea no requiere esfuerzo planeado, cámbiala a estado "Cancelado" con la razón en observaciones, o elimínala del bloque.' });
    }
    if (!consecutive || consecStr === '') {
      validations.push({ type: 'MISSING_CONSECUTIVE', msg: 'Falta consecutivo en la columna A' });
    }
    if (weekNumber == null || weekNumber === '') {
      validations.push({ type: 'MISSING_WEEK_NUMBER', msg: 'Falta número de semana' });
    }
    if (!plannedType || plannedStr === '') {
      validations.push({ type: 'MISSING_PLANNED_TYPE', msg: 'Falta marcar P (planeada) o NP (no planeada)' });
    }

    const estimatedDeliverySerial = row[6];
    if ((!estimatedDeliverySerial || estimatedDeliverySerial === '') && plannedStr.toUpperCase() === 'P') {
      validations.push({ type: 'MISSING_DELIVERY_DATE', msg: 'Tarea planeada (P) sin fecha estimada de entrega' });
    }

    // Movido arriba para poder usar declaredWeek en la validación ESTIMATED_DATE_MISMATCH_WEEK.
    const declaredWeek = weekNumber != null && weekNumber !== '' ? Number(weekNumber) : null;

    const taskStatus = row[15];

    const estimatedDateStr = excelSerialToDate(estimatedDeliverySerial);
    if (estimatedDateStr) {
      const estimDate = new Date(estimatedDateStr + 'T00:00:00Z');
      const statusLower = String(taskStatus || '').toLowerCase().trim();

      if (estimDate < snapshotDate && statusLower !== 'terminado' && statusLower !== 'cancelado') {
        const daysOverdue = Math.round((snapshotDate - estimDate) / 86400000);
        const statusTexto = statusLower
          ? `(estado actual: "${taskStatus}")`
          : '(sin estado)';
        validations.push({
          type: 'TASK_OVERDUE_IN_PLANNING',
          msg: `La fecha estimada de entrega (${estimatedDateStr}) ya pasó hace ${daysOverdue} ${daysOverdue === 1 ? 'día' : 'días'} y la tarea aún no está terminada ${statusTexto}. Marca la tarea como "Terminado" si ya la cerraste, o renegocia la fecha con tu líder.`
        });
      }

            // v19 (2026-09-02) FIX: la validación anterior comparaba primero el mes
      //   calendario del día vs el mes del snapshot y, si no coincidían, flageaba
      //   como MISMATCH sin más. Eso generaba falsos positivos en los boundaries
      //   de mes: el lunes 31-Ago es parte de la Semana 1 de Septiembre en
      //   calendario laboral (getMonthWeekNumber lo reconoce porque 4 días
      //   Mar-Vie caen en Sep), pero el chequeo estricto lo rechazaba por
      //   "estar en Agosto". Ahora primero preguntamos a getMonthWeekNumber
      //   si el día pertenece a alguna semana del mes de planeación (incluye
      //   días borde de meses adyacentes), y solo flageamos si NO pertenece
      //   O si pertenece pero a una semana distinta a la declarada.
      if (declaredWeek !== null) {
        const estimWeekInCurrentMonth = getMonthWeekNumber(estimatedDateStr, ctx.yearNumber, ctx.monthNumber);
        if (estimWeekInCurrentMonth !== null) {
          // La fecha SÍ pertenece a una semana del mes de planeación
          // (aunque el día individual esté en otro mes calendario, ej. Lun 31-Ago
          //  como parte de Semana 1 Sep).
          if (estimWeekInCurrentMonth !== declaredWeek) {
            validations.push({
              type: 'ESTIMATED_DATE_MISMATCH_WEEK',
              msg: `La fecha estimada de entrega (${estimatedDateStr}) corresponde a la Semana ${estimWeekInCurrentMonth} de ${ctx.monthName}, pero la tarea está declarada en la Semana ${declaredWeek}. Corrige la fecha estimada al día correcto de la Semana ${declaredWeek}, o cambia el número de semana en la columna B para que coincida.`
            });
          }
          // else: match → no flag
        } else {
          // La fecha NO pertenece a ninguna semana del mes de planeación actual.
          // Ejemplo real: planeación de Sep con fecha estimada en Julio o Agosto
          // que no cae en el boundary de Semana 1.
          validations.push({
            type: 'ESTIMATED_DATE_MISMATCH_WEEK',
            msg: `La fecha estimada de entrega (${estimatedDateStr}) corresponde a un mes distinto al de la planeación actual (${ctx.monthName} ${ctx.yearNumber}). Verifica el año y el mes de la fecha estimada.`
          });
        }
      }
     }


    if (!taskStatus || String(taskStatus).trim() === '') {
      validations.push({ type: 'MISSING_STATUS', msg: 'Falta estado de la tarea' });
    } else {
      const validStatuses = ['pendiente', 'en progreso', 'terminado', 'bloqueado', 'cancelado'];
      if (!validStatuses.includes(String(taskStatus).toLowerCase().trim())) {
        validations.push({ type: 'INVALID_STATUS', msg: `Estado "${taskStatus}" no es válido (debe ser Pendiente, En Progreso, Terminado, Bloqueado o Cancelado)` });
      }
    }

    const assignedTo = row[19];
    if (!assignedTo || String(assignedTo).trim() === '') {
      validations.push({ type: 'MISSING_ASSIGNEE', msg: 'Falta responsable de la tarea' });
    }

    const observations = row[20];
    if (String(taskStatus || '').toLowerCase().trim() === 'bloqueado' && (!observations || String(observations).trim() === '')) {
      validations.push({ type: 'MISSING_OBSERVATIONS_BLOCKED', msg: 'Tarea bloqueada sin observaciones que expliquen el bloqueo' });
    }

    const hoursMon = Number(row[8]) || 0;
    const hoursTue = Number(row[9]) || 0;
    const hoursWed = Number(row[10]) || 0;
    const hoursThu = Number(row[11]) || 0;
    const hoursFri = Number(row[12]) || 0;
    const hoursSat = Number(row[13]) || 0;

    if (declaredWeek !== null && currentMonthWeek !== null) {
      const hoursArr = [
        { day: 'Lunes',     val: hoursMon, idx: 1 },
        { day: 'Martes',    val: hoursTue, idx: 2 },
        { day: 'Miércoles', val: hoursWed, idx: 3 },
        { day: 'Jueves',    val: hoursThu, idx: 4 },
        { day: 'Viernes',   val: hoursFri, idx: 5 },
        { day: 'Sábado',    val: hoursSat, idx: 6 }
      ];

      // 🔧 v17: comparamos contra la FECHA REAL de cada día en la semana declarada
      // versus el HOY FÍSICO. Solo flageamos días estrictamente posteriores a hoy;
      // las horas del día actual son válidas (la gente pudo loguearlas en la mañana).
      const futureDaysWithHours = [];
      for (const h of hoursArr) {
        if (h.val <= 0) continue;
        const dayDate = getDateOfWeekInMonth(ctx.yearNumber, ctx.monthNumber, declaredWeek, h.idx);
        if (dayDate && dayDate > physicalToday) {
          futureDaysWithHours.push(`${h.day} (${h.val}h)`);
        }
      }

      if (futureDaysWithHours.length > 0) {
        validations.push({
          type: 'EXECUTED_HOURS_IN_FUTURE',
          msg: `Tiene horas ejecutadas en días que aún no han transcurrido (hoy es ${physicalDayName} ${physicalTodayStr}): ${futureDaysWithHours.join(', ')}. Las horas ejecutadas solo deben registrarse para días ya transcurridos.`
        });
      }
    }

    for (const v of validations) {
      addValidationError(folderName, fileName, v.type, `Tarea "${taskRef}" (fila ${excelRowNum}): ${v.msg}`, proyectoFila, declaredWeek, [excelRowNum]);
    }

    // Registramos el consecutivo AUNQUE la fila esté incompleta (sin proyecto, budget=0,
    // tarea cancelada, etc.), para que la validación de secuencia/duplicados refleje lo
    // que el usuario diligenció y NO reporte "faltan los números X, Y" cuando esas filas
    // sí existen pero tienen otro problema (que ya se emite por separado).
    const consecNum = parseInt(consecStr);
    if (!isNaN(consecNum) && declaredWeek !== null) {
      if (!consecutivosVistos[declaredWeek]) consecutivosVistos[declaredWeek] = {};
      const key = String(consecNum);
      if (!consecutivosVistos[declaredWeek][key]) consecutivosVistos[declaredWeek][key] = [];
      consecutivosVistos[declaredWeek][key].push({ row: excelRowNum, activity: activityStr });
    }

    if (!projectStr || !activityStr || isNaN(budgetNum) || budgetNum === 0) continue;

    if (declaredWeek !== null) {
      const taskKey = `${declaredWeek}|${normalizeText(projectStr)}|${normalizeText(activityStr)}`;
      if (!tareasUnicas[taskKey]) tareasUnicas[taskKey] = [];
      tareasUnicas[taskKey].push({ row: excelRowNum, activity: activityStr, project: projectStr });

      semanaCounts[declaredWeek] = (semanaCounts[declaredWeek] || 0) + 1;
    }

    const actualDeliverySerial = row[7];
    // El RPA nunca confía en col O del Excel — la fórmula =SUM(I:N) puede romperse.
    // Siempre recalcula la suma de horas diarias y la usa como totalExecuted.
    const _ttFromCol = Number(row[14]) || 0;
    const _ttRecalc = (Number(row[8])||0) + (Number(row[9])||0) + (Number(row[10])||0) + (Number(row[11])||0) + (Number(row[12])||0) + (Number(row[13])||0);
    const totalExecuted = _ttRecalc;


    let hasInconsistency = 0;
    const inconsistencyNotes = [];
    const statusLower = String(taskStatus || '').toLowerCase().trim();


    // -- Validators de auditoría Johana 2026-06-23 --
    if (Math.abs(_ttFromCol - _ttRecalc) > 0.01) {
      addValidationError(folderName, fileName, 'TT_INCONSISTENT',
        `Tarea "${taskRef}" (fila ${excelRowNum}): La columna TT muestra ${_ttFromCol}h, pero la suma real de las horas de lunes a sábado es ${_ttRecalc.toFixed(2)}h. Revisa la fórmula de TT en esta fila — probablemente se rompió al copiar/pegar. El sistema usó ${_ttRecalc.toFixed(2)}h para los indicadores.`,
        proyectoFila, declaredWeek, [excelRowNum]);
    }
    if (statusLower === 'terminado' && !actualDeliverySerial) {
      addValidationError(folderName, fileName, 'TERMINATED_WITHOUT_DELIVERY_DATE',
        `Tarea "${taskRef}" (fila ${excelRowNum}): Marcada como Terminado pero la columna "Fecha Entrega" está vacía. Sin esa fecha la tarea no cuenta en los indicadores de Entrega a tiempo, Días desfase ni Velocidad de cierre — por favor agrega la fecha real en que cerraste la tarea.`,
        proyectoFila, declaredWeek, [excelRowNum]);
    }
    if (_ttRecalc > 0 && (estimatedDeliverySerial === null || estimatedDeliverySerial === undefined || estimatedDeliverySerial === '')) {
      addValidationError(folderName, fileName, 'EXECUTED_HOURS_WITHOUT_ESTIMATE',
        `Tarea "${taskRef}" (fila ${excelRowNum}): Tiene ${_ttRecalc.toFixed(2)}h ejecutadas pero la columna "Fecha Estimada de Entrega" está vacía. Sin fecha estimada el sistema no puede ubicar la tarea en el calendario de cumplimiento — agrega la fecha estimada.`,
        proyectoFila, declaredWeek, [excelRowNum]);
    }


    if (totalExecuted > 0 && statusLower === 'pendiente') {
      hasInconsistency = 1;
      inconsistencyNotes.push('TT>0 pero estado=Pendiente');
    }
    if (statusLower === 'terminado' && !actualDeliverySerial) {
      hasInconsistency = 1;
      inconsistencyNotes.push('Estado "Terminado" sin Fecha Entrega');
    }
    if (statusLower === 'terminado' && totalExecuted > 0 && totalExecuted < budgetNum * 0.5) {
      hasInconsistency = 1;
      inconsistencyNotes.push(`Terminado con TT (${totalExecuted}h) < 50% del presupuesto`);
    }
    if (totalExecuted >= budgetNum && budgetNum > 0 && statusLower !== 'terminado' && statusLower !== 'bloqueado' && statusLower !== 'cancelado') {
      hasInconsistency = 1;
      inconsistencyNotes.push(`TT alcanzó presupuesto pero estado sigue "${taskStatus}"`);
    }
    if (plannedStr.toUpperCase() === 'P' && (weekNumber == null || weekNumber === '')) {
      hasInconsistency = 1;
      inconsistencyNotes.push('Tarea planeada sin número de semana');
    }
    if (!projectStr) {
      hasInconsistency = 1;
      inconsistencyNotes.push('Tarea sin proyecto');
    }
    if (!assignedTo || String(assignedTo).trim() === '') {
      hasInconsistency = 1;
      inconsistencyNotes.push('Tarea sin responsable');
    }
    if (statusLower === 'bloqueado' && (!observations || String(observations).trim() === '')) {
      hasInconsistency = 1;
      inconsistencyNotes.push('Bloqueada sin observaciones');
    }
    const dailyHours = [hoursMon, hoursTue, hoursWed, hoursThu, hoursFri, hoursSat];
    const maxDailyHour = Math.max(...dailyHours);
    if (maxDailyHour > 12) {
      hasInconsistency = 1;
      inconsistencyNotes.push(`Día con ${maxDailyHour}h (máx razonable: 12h)`);
    }
    if (budgetNum === 0 && totalExecuted > 0) {
      hasInconsistency = 1;
      inconsistencyNotes.push('Sin horas presupuestadas pero ejecutó horas');
    }

    if (hasInconsistency) inconsistencyCount++;

    const taskRecord = {
      snapshot_date: ctx.snapshotDate,
      project_folder: proyectoFila,
      employee_name: employeeName,
      leader_name: leaderName,
      month_name: ctx.monthName,
      month_number: ctx.monthNumber,
      year_number: ctx.yearNumber,
      week_number: weekNumber != null && weekNumber !== '' ? Number(weekNumber) : null,
      project_name: projectStr,
      activity: activityStr,
      planned_type: plannedType ? String(plannedType).trim().toUpperCase() : null,
      budgeted_hours: budgetNum,
      estimated_delivery_date: excelSerialToDate(estimatedDeliverySerial),
      actual_delivery_date: excelSerialToDate(actualDeliverySerial),
      hours_monday: hoursMon,
      hours_tuesday: hoursTue,
      hours_wednesday: hoursWed,
      hours_thursday: hoursThu,
      hours_friday: hoursFri,
      hours_saturday: hoursSat,
      total_executed_hours: totalExecuted,
      task_status: taskStatus ? String(taskStatus).trim() : null,
      assigned_to: assignedTo ? String(assignedTo).trim() : null,
      observations: observations ? String(observations).trim() : null,
      adjustment_reason_1: row[21] || null,
      unplanned_task_1: row[22] || null,
      adjustment_type_1: row[23] || null,
      adjustment_reason_2: row[24] || null,
      unplanned_task_2: row[25] || null,
      adjustment_type_2: row[26] || null,
      adjustment_reason_3: row[27] || null,
      unplanned_task_3: row[28] || null,
      adjustment_type_3: row[29] || null,
      has_inconsistency: hasInconsistency,
      inconsistency_notes: inconsistencyNotes.length ? inconsistencyNotes.join('; ') : null,
      _blockId: currentBlockId
    };

    tasks.push(taskRecord);

    if (!visualBlocks[currentBlockId]) {
      visualBlocks[currentBlockId] = {
        blockId: currentBlockId,
        declaredWeek: taskRecord.week_number,
        tasksCount: 0,
        startRow: rowIdx + 1
      };
    }
    visualBlocks[currentBlockId].tasksCount++;
  }

  // Validaciones POST-LOOP
  const weekToBlocks = {};
  for (const block of visualBlocks) {
    if (!block || !block.declaredWeek) continue;
    if (!weekToBlocks[block.declaredWeek]) weekToBlocks[block.declaredWeek] = [];
    weekToBlocks[block.declaredWeek].push(block);
  }

  for (const [week, blocks] of Object.entries(weekToBlocks)) {
    if (blocks.length > 1) {
      const totalTasks = blocks.reduce((s, b) => s + b.tasksCount, 0);
      const startRows = blocks.map(b => b.startRow).join(', ');

      addValidationError(
        folderName,
        fileName,
        'DUPLICATE_WEEK_TASKS',
        `Detectamos ${blocks.length} bloques de tareas (separados por "Cumplimiento") con la MISMA semana ${week}, ${totalTasks} tareas en total comenzando en filas ${startRows}. Esto suele pasar cuando se copia un bloque semanal y se olvida actualizar el número de semana. Revisa que cada bloque tenga el número de semana correcto.`,
        projectFolder,
        week,
        blocks.map(b => b.startRow)
      );
    }
  }

  for (const [semana, consecsMap] of Object.entries(consecutivosVistos)) {
    for (const [consec, occurrences] of Object.entries(consecsMap)) {
      if (occurrences.length > 1) {
        const rowsList = occurrences.map(o => o.row).join(', ');
        addValidationError(
          folderName,
          fileName,
          'DUPLICATE_CONSECUTIVE',
          `En la Semana ${semana} hay ${occurrences.length} tareas con el mismo consecutivo "${consec}" (en filas ${rowsList}). Cada tarea dentro de una semana debe tener un número de consecutivo único: 1, 2, 3, 4... Por favor numera las tareas correctamente.`,
          projectFolder,
          semana,
          occurrences.map(o => o.row)
        );
      }
    }
  }

  // Consecutivos NO secuenciales dentro de una semana
  for (const [semana, consecsMap] of Object.entries(consecutivosVistos)) {
    const hasDuplicates = Object.values(consecsMap).some(arr => arr.length > 1);
    if (hasDuplicates) continue;

    const consecNums = Object.keys(consecsMap)
      .map(c => parseInt(c, 10))
      .filter(n => !isNaN(n));

    if (consecNums.length < 2) continue;

    consecNums.sort((a, b) => a - b);
    const minNum = consecNums[0];
    const maxNum = consecNums[consecNums.length - 1];
    const expectedCount = maxNum - minNum + 1;

    if (consecNums.length < expectedCount) {
      const saltosDetectados = [];
      const consecsSet = new Set(consecNums);
      for (let n = minNum; n <= maxNum; n++) {
        if (!consecsSet.has(n)) saltosDetectados.push(n);
      }

      const consecsConFila = [];
      for (const [consec, occurrences] of Object.entries(consecsMap)) {
        consecsConFila.push({ num: parseInt(consec, 10), row: occurrences[0].row });
      }
      consecsConFila.sort((a, b) => a.row - b.row);
      const secuenciaReal = consecsConFila.map(c => c.num).join(', ');

      const saltosTexto = saltosDetectados.length <= 5
        ? saltosDetectados.join(', ')
        : `${saltosDetectados.slice(0, 5).join(', ')}... y ${saltosDetectados.length - 5} más`;

      addValidationError(
        folderName,
        fileName,
        'NON_SEQUENTIAL_CONSECUTIVE',
        `En la Semana ${semana} los consecutivos NO son secuenciales. Tienes ${consecNums.length} tareas con consecutivos: ${secuenciaReal}. Faltan los números: ${saltosTexto}. Los consecutivos deben ser una secuencia incremental sin saltos (1, 2, 3, 4, 5, ...). Por favor renumera las tareas correctamente (filas ${consecsConFila[0].row} a ${consecsConFila[consecsConFila.length - 1].row}).`,
        projectFolder,
        semana,
        [`${consecsConFila[0].row}–${consecsConFila[consecsConFila.length - 1].row}`]
      );
    }
  }


    for (const [key, occurrences] of Object.entries(tareasUnicas)) {
    if (occurrences.length > 1) {
      const rowsList = occurrences.map(o => o.row).join(', ');
      const first = occurrences[0];
      const taskWeek = Number((key.split('|')[0] || '').trim()) || null;
      addValidationError(
        folderName,
        fileName,
        'DUPLICATE_TASK',
        `La tarea "${first.activity}" del proyecto "${first.project}" aparece ${occurrences.length} veces en la misma semana (filas ${rowsList}). ¿Es la misma tarea duplicada accidentalmente?`,
        proyectoPadre(first.project, projectFolder),
        taskWeek,
        occurrences.map(o => o.row)
      );
    }
  }


  // 🔧 v13: SOLO flaguea semanas FUTURAS (no las pasadas, porque documentarlas es legítimo).
  if (currentMonthWeek !== null) {
    const semanasFuturas = Object.entries(semanaCounts).filter(([w]) => Number(w) > currentMonthWeek);

    if (semanasFuturas.length > 0) {
      const detalles = semanasFuturas
        .map(([w, count]) => `${count} tarea${count > 1 ? 's' : ''} con semana ${w}`)
        .join(', ');
      const totalAfectadas = semanasFuturas.reduce((s, [, c]) => s + c, 0);

      addValidationError(
        folderName,
        fileName,
        'WEEK_NUMBER_MISMATCH',
        `Detectamos ${totalAfectadas} tarea${totalAfectadas > 1 ? 's' : ''} con un número de semana FUTURA (aún no inicia): ${detalles}. La semana actual es la ${currentMonthWeek} de ${ctx.monthName}. Probablemente copiaste un bloque de planeación y se te olvidó actualizar el número de semana. Corrige la columna "Semana" a ${currentMonthWeek}.`,
        projectFolder
      );
    }
  }

  // Detectar si el empleado tiene archivo pero SIN planeación para la semana actual.
  // Captura el caso donde alguien copia el bloque de una semana pasada dos veces en vez
  // de crear el bloque de la semana actual (o simplemente no la planeó todavía).
  // week_number=null porque es file-level, así siempre pasa el filtro de semana del correo.
  if (currentMonthWeek !== null && !semanaCounts[currentMonthWeek]) {
    const semanasConTareas = Object.keys(semanaCounts).map(Number).sort((a, b) => a - b);
    const semanasTexto = semanasConTareas.length > 0
      ? `Solo hay planeación de la${semanasConTareas.length > 1 ? 's' : ''} semana${semanasConTareas.length > 1 ? 's' : ''} ${semanasConTareas.join(', ')}.`
      : `No encontramos tareas para ninguna semana de ${ctx.monthName}.`;
    addValidationError(
      folderName,
      fileName,
      'MISSING_WEEK_PLANNING',
      `No hay planeación para la semana ${currentMonthWeek} de ${ctx.monthName} (semana actual). ${semanasTexto} Agrega un bloque con las tareas de la semana ${currentMonthWeek} y asegúrate que la columna "Nº semana" tenga el valor ${currentMonthWeek}.`,
      projectFolder,
      null
    );
  }

  for (const t of tasks) {
    delete t._blockId;
  }

  // v20: los errores de este archivo que quedaron con la etiqueta del Equipo
  // (los de todo el archivo — líder, semana, consecutivos — y los de filas con
  // un módulo que no se reconoció) pasan al proyecto principal de la persona,
  // para que le lleguen a un PM real y no a "Equipo 4".
  const principal = proyectoPrincipal(tasks, projectFolder);
  if (principal) {
    for (let k = erroresDesde; k < staticData.validationErrors.length; k++) {
      const err = staticData.validationErrors[k];
      if (!err.project_folder || err.project_folder === projectFolder) err.project_folder = principal;
    }
  }
  const proyectosDelRecurso = [...new Set(tasks.map(t => t.project_folder))];
  console.log(`   🗂️ Proyectos: ${proyectosDelRecurso.join(', ') || '(ninguno)'} | principal: ${principal || '(sin reconocer)'}`);

  console.log(`   ✅ ${tasks.length} tareas | ${inconsistencyCount} inconsistencias | ${visualBlocks.filter(b => b).length} bloques visuales${filasAntesDelCorte ? ` | ${filasAntesDelCorte} filas ignoradas (antes del ${SEMANA_INICIO})` : ''}${filasSemanaNueva ? ` | ${filasSemanaNueva} filas de la semana nueva ignoradas (recuperación)` : ''}`);

  staticData.successfulEmployees.push({
    employeeName,
    leaderName,
    fileName,
    employeeFolderName: folderName,
    // El Equipo (por si algún nodo posterior lo usa); el proyecto real va en
    // proyectoPrincipal / proyectos.
    projectFolder,
    equipoFolder: projectFolder,
    proyectoPrincipal: principal,
    proyectos: proyectosDelRecurso,
    tasksCount: tasks.length,
    inconsistencyCount,
    tasks
  });
}

// =============================================================
// Reportar errores detectados por "Resolver hoja del mes"
// =============================================================

const missingMonthSheetFiles = staticData.missingMonthSheetFiles || [];
for (const f of missingMonthSheetFiles) {
  const sheetsInfo = f.allSheets && f.allSheets.length > 0
    ? ` (hojas que tiene: ${f.allSheets.map(s => `"${s}"`).join(', ')})`
    : '';
  console.log(`⚠️ Archivo sin hoja "${ctx.monthName}": ${f.fileName}${sheetsInfo} [reason=${f.reason}]`);

  // Diferenciar mensaje según por qué se marcó como "sin hoja del mes":
  //   - error_listing_sheets → Microsoft Graph rechazó la consulta (típicamente
  //     por bloqueo temporal del archivo o throttling). NO es culpa del usuario
  //     ni de la RPA; el archivo probablemente está bien.
  //   - no_matching_sheet → la API devolvió las hojas y ninguna se llama como el mes.
  //     Aquí sí es un problema real del archivo (pestaña mal nombrada).
  let msg;
  if (f.reason === 'error_listing_sheets') {
    msg = `El servicio Microsoft Graph (la API de SharePoint que usa el sistema para leer los archivos) rechazó la consulta para verificar las pestañas de tu archivo "${f.fileName}" durante la ejecución de esta madrugada. Esto suele ocurrir por bloqueos temporales del lado de Microsoft cuando el archivo está siendo sincronizado, editado o cuando hay saturación puntual del servicio. El archivo probablemente esté correcto — se reintentará automáticamente en la próxima ejecución. Como buena práctica, procura mantener el archivo cerrado durante la noche.`;
  } else {
    msg = `Tu archivo "${f.fileName}" sí está cargado, pero ninguna de sus pestañas se llama "${ctx.monthName}" (probamos ignorando mayúsculas, minúsculas y tildes)${sheetsInfo}. Por favor renombra la pestaña correspondiente a "${ctx.monthName}" y vuelve a guardar el archivo.`;
  }

  addValidationError(
    f.employeeFolderName,
    f.fileName,
    'MISSING_MONTH_SHEET',
    msg,
    f.projectFolder
  );
}

const duplicateMonthSheetFiles = staticData.duplicateMonthSheetFiles || [];
for (const f of duplicateMonthSheetFiles) {
  addValidationError(
    f.employeeFolderName,
    f.fileName,
    'DUPLICATE_MONTH_SHEET',
    `Tu archivo tiene ${f.duplicateSheets.length} pestañas distintas que se parecen a "${ctx.monthName}": ${f.duplicateSheets.map(s => `"${s}"`).join(', ')}. Esto puede confundir al sistema. Por favor deja solo una pestaña con el nombre "${ctx.monthName}" y elimina o renombra las otras.`,
    f.projectFolder
  );
}

staticData.missingMonthSheetFiles = [];
staticData.duplicateMonthSheetFiles = [];

const foldersWithoutFile = staticData.foldersWithoutFile || [];
for (const f of foldersWithoutFile) {
  addValidationError(f.employeeFolderName, null, 'NO_FILE',
    `La carpeta "${f.employeeFolderName}" no tiene ningún archivo .xlsx para el mes ${ctx.monthName}.`, f.projectFolder || null);
}

const invalidFolders = staticData.invalidFolders || [];
for (const f of invalidFolders) {
  addValidationError(
    f.employeeFolderName,
    null,
    'EMPLOYEE_NOT_IN_CATALOG',
    `La carpeta "${f.employeeFolderName}" en SharePoint del proyecto ${f.projectFolder || 'desconocido'} no coincide con ningún empleado activo del catálogo. Si es un empleado nuevo, agrégalo a la base de datos (mp_employees). Si el nombre de la carpeta tiene un typo, renómbrala.`,
    f.projectFolder || null
  );
}


console.log(`\n📦 TOTAL: ${staticData.successfulEmployees.length} empleados procesados`);
console.log(`🔍 VALIDACIONES: ${staticData.validationErrors.length} errores registrados`);

const errorsByType = {};
for (const err of staticData.validationErrors) {
  errorsByType[err.error_type] = (errorsByType[err.error_type] || 0) + 1;
}
console.log('Tipos de error:', JSON.stringify(errorsByType));

return [{
  json: {
    ...ctx,
    employeesParsed: staticData.successfulEmployees.length,
    parsingErrors: staticData.parsingErrors.length,
    validationErrorsCount: staticData.validationErrors.length,
    errorsByType
  }
}];
