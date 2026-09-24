// =============================================================
// Generar contexto de ejecución — MULTI-PROYECTO v9 (22 sep 2026)
// 🔧 v9: SharePoint se reorganizó de "una carpeta por proyecto"
//        (CRM, MIA, SESCOL...) a "una carpeta por Equipo/líder"
//        (Equipo 1 - Juan Carlos Diaz, Equipo 2 - Jonathan Anaya...).
//        La lista PROJECT_FOLDERS de la v8 ya no existe en SharePoint —
//        los 10 nombres daban 404 en "Listar carpetas empleados1".
//        Confirmado en SharePoint (22 sep 2026): "Planeación 2026" solo
//        tiene las 9 carpetas de Equipo, ninguna carpeta suelta por
//        proyecto.
//
//        ⚠️ PENDIENTE, NO RESUELTO AQUÍ: projectFolder ya NO es un
//        nombre de proyecto real (antes: "CRM", "MIA"...); ahora es la
//        etiqueta del Equipo/líder. Todo lo que más adelante en el
//        flujo use projectFolder para saber A QUÉ PROYECTO pertenece
//        una persona (folderToProject, "Cargar project owners",
//        "Construir correos líderes"...) va a recibir un valor
//        incorrecto hasta que se corrija por separado — el proyecto
//        real de cada tarea hay que leerlo de la columna "Proyecto"
//        DENTRO del Excel, fila por fila, no de la carpeta. Es el mismo
//        cambio que ya tiene WF-COSTEO (ver centroParaProyecto en
//        03-resolver-y-filtrar.js). No activar el envío de correos de
//        este flujo hasta resolver eso.
// 🔧 v8: Agregado 'UX' (PMO Johana Aldana, empleado Thomas Medina Trujillo).
//        Se descartó 'IA & Automatización' — Johan Sebastian Diaz Caicedo
//        pasa a Habilitador con líder Mónica Bastidas.
// 🔧 v7: (revertido) Se había agregado 'IA & Automatización'.
// 🔧 v6: snapshotDate = último día laboral anterior a hoy (leído desde
//        "Chequear festivo ayer" como last_working_day).
// 🔧 v5: Agregado 'Habilitador' al array de proyectos.
// =============================================================

// Misma lista que ya usa WF-COSTEO (01-generar-contexto.js), la única
// verificada contra SharePoint real al 22 sep 2026. projectFolder aquí es
// la etiqueta del EQUIPO, no de un proyecto — ver la advertencia de arriba.
const EQUIPOS = [
  { projectFolder: 'Equipo 1', folderPath: 'Equipo 1 - Juan Carlos Diaz' },
  { projectFolder: 'Equipo 2', folderPath: 'Equipo 2 - Jonathan Anaya' },
  { projectFolder: 'Equipo 3', folderPath: 'Equipo 3 - Monica Bastidas' },
  { projectFolder: 'Equipo 4', folderPath: 'Equipo 4 - Cesar Arbelaez' },
  { projectFolder: 'Equipo 5', folderPath: 'Equipo 5 - Juan Carlos Diaz - Monica Bastidas' },
  { projectFolder: 'Equipo 6', folderPath: 'Equipo 6 - Jonathan Ariza' },
  { projectFolder: 'Equipo 7', folderPath: 'Equipo 7 - Monica Bastidas' },
  { projectFolder: 'Equipo 8', folderPath: 'Equipo 8 - Monica Bastidas' },
  { projectFolder: 'Equipo 9', folderPath: 'Equipo 9 - Monica Bastidas - Cesar Arbelaez' },
];

// 🆕 v6: leer el último día laboral calculado en el nodo anterior.
// Formato esperado: 'YYYY-MM-DD' (viene tal cual de MySQL).
const prev = $('Chequear festivo ayer').first().json;
const rawLastWD = prev.last_working_day;
if (!rawLastWD) {
  throw new Error('No se pudo determinar el último día laboral. Verifica el nodo "Chequear festivo ayer".');
}

// MySQL puede devolver Date object o string 'YYYY-MM-DD'. Normalizamos a string.
let snapshotDate;
if (rawLastWD instanceof Date) {
  const yy = rawLastWD.getUTCFullYear();
  const mm = String(rawLastWD.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(rawLastWD.getUTCDate()).padStart(2, '0');
  snapshotDate = `${yy}-${mm}-${dd}`;
} else {
  snapshotDate = String(rawLastWD).slice(0, 10);
}

const [yStr, mStr, dStr] = snapshotDate.split('-');
const year = Number(yStr);
const monthNumber = Number(mStr);
const day = Number(dStr);
const month0 = monthNumber - 1;

const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const monthName = monthNames[month0];
const yearNumber = year;

const nowUtc = new Date();
const executionId = `mp_ingesta_${year}${String(monthNumber).padStart(2,'0')}${String(day).padStart(2,'0')}_${nowUtc.getTime()}`;

console.log(`🚀 Iniciando — ${executionId}`);
console.log(`📅 Último día laboral analizado: ${snapshotDate} (${monthName} ${yearNumber})`);
console.log(`   Nota: hoy (Colombia) es ${new Date(nowUtc.getTime() - 5*60*60*1000).toISOString().slice(0,10)} — se analiza el día laboral anterior.`);
console.log(`📂 Procesando ${EQUIPOS.length} equipos: ${EQUIPOS.map(e => e.projectFolder).join(', ')}`);

// Reset staticData
const staticData = $getWorkflowStaticData('global');
staticData.snapshotDate = snapshotDate;
staticData.foldersWithoutFile = [];
staticData.parsingErrors = [];
staticData.unresolvedEmployees = [];
staticData.successfulEmployees = [];
staticData.invalidFolders = [];
staticData.validationErrors = [];
staticData.nameInconsistencies = [];
staticData.resolvedEmployees = [];
staticData.folderToProject = {};  // mapa global folder → projectFolder
console.log(`🧹 staticData reiniciado`);

return EQUIPOS.map(e => ({
  json: {
    executionId,
    snapshotDate,
    monthName,
    monthNumber,
    yearNumber,
    startTime: nowUtc.toISOString(),
    siteId: 'COLOCAR_SITE_ID', // #colocar credenciales
    projectFolder: e.projectFolder,
    folderPath: `Planeación ${yearNumber}/${e.folderPath}`
  }
}));
