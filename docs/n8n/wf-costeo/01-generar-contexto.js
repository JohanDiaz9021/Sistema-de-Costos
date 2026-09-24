// =============================================================
// WF-COSTEO — Nodo "Generar contexto ejecución" (n8n, tipo Code)
// -------------------------------------------------------------
// Reemplaza al del WF1. El original leía la fecha del nodo "Chequear
// festivo ayer", que en WF-COSTEO no existe (ese nodo escribía en el
// registro de corridas del WF1 y se borró a propósito). Aquí la fecha
// se calcula sola: HOY en hora de Colombia.
//
// La salida conserva EXACTAMENTE los mismos campos que el original
// (snapshotDate, monthName, monthNumber, yearNumber, siteId,
// projectFolder, folderPath...) porque los nodos siguientes —"Guardar
// Drive ID", "Listar carpetas empleados", "Resolver hoja del mes"— los
// leen por nombre.
//
// ALCANCE: todos los equipos de "Planeación <año>". La cadena completa
// se probó primero solo con el Equipo 3 (21 sep 2026) y funcionó.
//
// OJO: si un nombre de esta lista no existe EXACTO en SharePoint (una
// tilde, un espacio doble), Graph responde 404 en "Listar carpetas
// empleados" y la corrida se detiene. Al crear o renombrar un equipo en
// SharePoint hay que actualizar esta lista.
// =============================================================

const EQUIPOS = [
  // projectFolder: etiqueta interna; hoy solo sirve para los registros
  //                (el proyecto de cada hora sale de la columna
  //                "Proyecto" del Excel, no de aquí).
  // folderPath:    ruta REAL de la carpeta del equipo en SharePoint,
  //                escrita exactamente igual (tildes incluidas).
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

// Festivo: si "Revisar festivo" (el nodo MySQL de antes) dice 'si', la
// corrida termina aquí sin tocar nada. Devolver una lista vacía es la
// forma de n8n de decir "no sigas": los nodos siguientes no se ejecutan.
// Los fines de semana ni siquiera llegan: los descarta el horario del
// Schedule Trigger (cron 0 7 * * 1-5).
let esFestivo = false;
try {
  esFestivo = $('Revisar festivo').first().json.festivo === 'si';
} catch (e) {
  // Sin el nodo (p. ej. probando a mano desde aquí) se asume día hábil.
}
if (esFestivo) {
  console.log('🎌 Hoy es festivo: no se cargan horas.');
  return [];
}

// Hoy en Colombia (UTC-5, sin horario de verano). Con la hora UTC del
// servidor, una corrida después de las 7:00 p.m. quedaría fechada mañana.
const ahoraUtc = new Date();
const hoyColombia = new Date(ahoraUtc.getTime() - 5 * 60 * 60 * 1000);
const snapshotDate = hoyColombia.toISOString().slice(0, 10);

const [yStr, mStr, dStr] = snapshotDate.split('-');
const yearNumber = Number(yStr);
const monthNumber = Number(mStr);
const day = Number(dStr);

const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const monthName = monthNames[monthNumber - 1];

const executionId = `costeo_${yStr}${mStr}${dStr}_${ahoraUtc.getTime()}`;

// Los nodos heredados del WF1 ("Filtrar carpetas válidas", "Resolver hoja
// del mes") guardan listas aquí; se vacían en cada corrida para que no
// arrastren datos de la anterior.
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
staticData.folderToProject = {};

return EQUIPOS.map((e) => ({
  json: {
    executionId,
    snapshotDate,
    monthName,
    monthNumber,
    yearNumber,
    startTime: ahoraUtc.toISOString(),
    siteId: 'COLOCAR_SITE_ID', // #colocar credenciales
    projectFolder: e.projectFolder,
    folderPath: `Planeación ${yearNumber}/${e.folderPath}`,
  },
}));
