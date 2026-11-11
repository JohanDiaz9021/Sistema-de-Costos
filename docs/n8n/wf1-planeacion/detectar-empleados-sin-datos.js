/* global $, $input, $getWorkflowStaticData -- globales del nodo Code de n8n */
// =============================================================
// Detectar empleados sin datos — v4 (2026-10-01)
// 🔧 v4: solo se reporta NO_DATA_INGESTED a quien SÍ tiene carpeta en algún
//   Equipo de SharePoint en esta corrida (la que procesó "Filtrar carpetas
//   válidas1"). "Buscar empleados sin tareas" lista a TODOS los activos del
//   catálogo sin tareas, así que antes salían también:
//     - quienes tienen la carpeta dentro de "Backup" (ya no planean),
//     - las excepciones de "Filtrar carpetas válidas1" (no llenan planeación).
//   A ellos no hay nada que pedirles. Si a alguien que SÍ debería planear le
//   falta la carpeta, eso se ve en SharePoint, no en este aviso.
// 🔧 v3 (2026-09-01): filtrar items vacíos que emite "Buscar empleados sin
//   tareas" por tener alwaysOutputData=true (correo fantasma "para undefined").
// =============================================================

const ctx = $('Generar contexto ejecución2').first().json;
const staticData = $getWorkflowStaticData('global');
if (!staticData.validationErrors) staticData.validationErrors = [];

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Carpetas de persona que se procesaron en esta corrida (fuera de Backup, no
// exceptuadas, activas). folderToProject lo llena "Filtrar carpetas válidas1".
const carpetasProcesadas = new Set(Object.keys(staticData.folderToProject || {}).map(normalizeName));

// Nombres y alias de cada empleado, para reconocer su carpeta aunque se llame
// distinto al nombre canónico ("Juan Canabal" ↔ "Juan Esteban Canabal").
const nombresPorId = {};
for (const emp of $('Cargar catálogo empleados (early)1').all().map(i => i.json)) {
  const nombres = [normalizeName(emp.canonical_name)];
  let aliases = emp.aliases;
  if (typeof aliases === 'string') {
    try { aliases = JSON.parse(aliases); } catch (e) { aliases = []; }
  }
  if (Array.isArray(aliases)) for (const a of aliases) nombres.push(normalizeName(a));
  nombresPorId[emp.employee_id] = nombres.filter(Boolean);
}

function tieneCarpeta(emp) {
  const nombres = nombresPorId[emp.employee_id] || [normalizeName(emp.canonical_name)];
  return nombres.some(n => carpetasProcesadas.has(n));
}

// v3: filtrar items vacíos que emite "Buscar empleados sin tareas" por tener
// alwaysOutputData=true.
const sinTareas = $input.all().map(i => i.json).filter(item => item && item.employee_id != null && item.canonical_name);
const missing = sinTareas.filter(tieneCarpeta);
const sinCarpeta = sinTareas.filter(e => !tieneCarpeta(e));

console.log(`⚠️ Empleados activos sin datos (con carpeta): ${missing.length}`);
missing.forEach(s => console.log(`   - ${s.canonical_name}`));
if (sinCarpeta.length) {
  console.log(`⏭️ Sin tareas pero sin carpeta en ningún Equipo (Backup / excepción) — no se reportan: ${sinCarpeta.map(s => s.canonical_name).join(', ')}`);
}

const buildMessage = (name) => `No se ingresó ninguna tarea para ${name}. Posibles causas: (1) archivo no encontrado en SharePoint, (2) formato del Excel incorrecto (ej. falta fila vacía separadora entre semanas), (3) nombre del archivo distinto del esperado. Revisar el archivo.`;

for (const sf of missing) {
  staticData.validationErrors.push({
    employee_id: sf.employee_id,
    employee_folder_name: sf.canonical_name,
    project_folder: sf.project_folder,
    file_name: null,
    error_type: 'NO_DATA_INGESTED',
    error_message: buildMessage(sf.canonical_name)
  });
}

if (missing.length === 0) {
  return [{ json: { sqlQuery: 'SELECT 1', skipInsert: true } }];
}

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return v;
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

const valuesRows = missing.map(sf =>
  `(${sqlValue(ctx.snapshotDate)},${sqlValue(ctx.executionId)},${sqlValue(sf.canonical_name)},${sqlValue(sf.employee_id)},${sqlValue(sf.project_folder)},NULL,'NO_DATA_INGESTED','critical',${sqlValue(buildMessage(sf.canonical_name))},0)`
).join(',\n');

const sqlQuery = `INSERT INTO mp_validation_errors (snapshot_date, execution_id, employee_folder_name, employee_id, project_folder, file_name, error_type, severity, error_message, notified) VALUES ${valuesRows}`;

return [{ json: { sqlQuery, insertCount: missing.length, skipInsert: false } }];
