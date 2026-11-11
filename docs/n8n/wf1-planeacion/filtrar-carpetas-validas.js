/* global $, $input, $getWorkflowStaticData -- globales del nodo Code de n8n */
// =============================================================
// Filtrar carpetas válidas — MULTI-PROYECTO v6 (2026-10-01)
// 🔧 v6: EXCEPCIONES — personas con carpeta en SharePoint que NO deben
//        procesarse (no llenan planeación). Se saltan en silencio, igual que
//        un empleado inactivo: sin tareas, sin errores y sin "no se cargó
//        ninguna tarea" (ver "Detectar empleados sin datos" v4).
// 🔧 v5: skip silencioso de empleados inactivos.
// - Itera las N salidas de "Listar carpetas empleados" (una por Equipo)
// - Para cada carpeta de empleado: ignora Backup/Copia de seguridad
// - Valida contra catálogo:
//     · Activo  → procesa
//     · Inactivo o en EXCEPCIONES → ignora silenciosamente (no flag)
//     · No existe → flag EMPLOYEE_NOT_IN_CATALOG
// - Propaga projectFolder a cada folder emitido
// - Pobla staticData.folderToProject SIEMPRE
// =============================================================

// Nombre (o alias) de la persona tal como está en el catálogo; mayúsculas y
// tildes no importan. Para agregar a alguien: una línea más.
const EXCEPCIONES = [
  'Juan Esteban Canabal',
  'Rafael Argotty', // ya no trabaja en GTC (2026-10-27)
];

const allFolderResponses = $('Listar carpetas empleados1').all();
const allCtx = $('Guardar Drive ID1').all();
const catalog = $input.all().map(i => i.json);

console.log(`🔄 Procesando ${allFolderResponses.length} proyectos`);
console.log(`📇 Catálogo total (activos+inactivos): ${catalog.length}`);

if (catalog.length === 0) {
  return [];
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

function nombresDe(emp) {
  const nombres = [];
  if (emp.canonical_name) nombres.push(normalizeName(emp.canonical_name));
  let aliases = emp.aliases;
  if (typeof aliases === 'string') {
    try { aliases = JSON.parse(aliases); } catch (e) { aliases = []; }
  }
  if (Array.isArray(aliases)) {
    for (const a of aliases) nombres.push(normalizeName(a));
  }
  return nombres;
}

// Una excepción cubre todos los nombres y alias de esa persona en el catálogo
// (su carpeta puede llamarse "Juan Canabal" aunque la excepción diga el
// nombre completo).
const exceptuados = new Set(EXCEPCIONES.map(normalizeName));
for (const emp of catalog) {
  const nombres = nombresDe(emp);
  if (nombres.some(n => exceptuados.has(n))) nombres.forEach(n => exceptuados.add(n));
}

const activeNamesNormalized = new Set();
const inactiveNamesNormalized = new Set();
for (const emp of catalog) {
  const isActive = Number(emp.is_active) === 1;
  const target = isActive ? activeNamesNormalized : inactiveNamesNormalized;
  for (const n of nombresDe(emp)) target.add(n);
}

console.log(`   · Activos: ${activeNamesNormalized.size} · Inactivos: ${inactiveNamesNormalized.size} · Excepciones: ${EXCEPCIONES.length}`);

const staticData = $getWorkflowStaticData('global');
if (!staticData.invalidFolders) staticData.invalidFolders = [];
if (!staticData.folderToProject) staticData.folderToProject = {};

const IGNORED = /^(backup|copia de seguridad)$/i;
const validFolders = [];

for (let i = 0; i < allFolderResponses.length; i++) {
  const folderResponse = allFolderResponses[i].json;
  const ctx = (allCtx[i] && allCtx[i].json) || {};
  const projectFolder = ctx.projectFolder;
  const items = folderResponse.value || [];
  const folders = items.filter(it => it.folder);

  console.log(`📂 [${projectFolder}] Carpetas en SharePoint: ${folders.length}`);

  for (const f of folders) {
    const cleanName = String(f.name || '').trim();
    if (IGNORED.test(cleanName)) {
      console.log(`   🚫 Ignorada (backup): ${projectFolder}/${cleanName}`);
      continue;
    }
    const folderNameNorm = normalizeName(cleanName);

    if (exceptuados.has(folderNameNorm)) {
      console.log(`   ⏭️ Excepción (no llena planeación, ignorado): ${projectFolder}/${cleanName}`);
      continue;
    }

    if (activeNamesNormalized.has(folderNameNorm)) {
      console.log(`   ✅ ${projectFolder}/${cleanName}`);
      staticData.folderToProject[cleanName] = projectFolder;
      validFolders.push({
        ...ctx,
        employeeFolderName: cleanName,
        employeeFolderId: f.id,
        employeeFolderPath: `${ctx.folderPath}/${cleanName}`,
        projectFolder
      });
    } else if (inactiveNamesNormalized.has(folderNameNorm)) {
      console.log(`   ⏸️ Carpeta de empleado INACTIVO (ignorado silenciosamente): ${projectFolder}/${cleanName}`);
      // No se procesa ni se reporta — es intencional que esté inactivo.
    } else {
      console.log(`   ⚠️ No en catálogo: "${projectFolder}/${cleanName}"`);
      staticData.invalidFolders.push({ employeeFolderName: cleanName, projectFolder });
    }
  }
}

console.log(`\n✅ Total carpetas válidas: ${validFolders.length}`);
console.log(`🗺️  folderToProject mapeado: ${Object.keys(staticData.folderToProject).length} carpetas`);

if (validFolders.length === 0) {
  return [{ json: { noFolders: true } }];
}

return validFolders.map(f => ({ json: f }));
