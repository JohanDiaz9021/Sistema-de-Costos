'use strict';

/**
 * Fixtures de mp_task_facts para los 18 indicadores de Planeación.
 *
 * A diferencia de test/helpers/fixtures.js (pensadas para Costeo: pocas
 * filas, foco en dinero y aislamiento), estas cubren los CAMPOS que usan
 * los indicadores: budgeted_hours, task_status, fechas estimada/real,
 * planned_type, adjustment_reason/type 1-3, hours_monday..saturday, y
 * palabras clave de permiso.
 *
 * Todas las filas caen en el snapshot MAS RECIENTE de un unico dia
 * (SNAPSHOT), mes "Agosto" 2026, salvo donde se indica lo contrario — la
 * mayoria de indicadores usa baseWhere(), que solo mira el ultimo
 * snapshot del mes filtrado.
 *
 * Reutiliza los empleados y proyectos de test/helpers/fixtures.js: ALFA
 * (Alicia, Arturo, Carlos-inactivo) y BETA (Brenda) ya existen alli. No se
 * duplica esa siembra; esta se AGREGA encima con sembrarPlaneacion().
 */

const { query } = require('./db');
const base = require('./fixtures');

const SNAPSHOT = '2026-08-22';
const MES = 'Agosto';
const MES_NUM = 8;
const ANIO = 2026;

// fact_id fijos para poder referenciar filas por id en las pruebas.
const TAREAS = [
  // --- Cumplimiento normal, semana 2 (indicador #1, #7, #8) ---
  {
    fact_id: 1001, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'Desarrollo de endpoint', planned_type: 'P',
    budgeted_hours: 10, total_executed_hours: 10, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-10', actual_delivery_date: '2026-08-10',
    hours_monday: 8, hours_tuesday: 2,
  },
  {
    fact_id: 1002, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'QA de endpoint', planned_type: 'P',
    budgeted_hours: 8, total_executed_hours: 4, task_status: 'En Progreso',
    estimated_delivery_date: null, actual_delivery_date: null,
    hours_wednesday: 4,
  },

  // --- Entrega tarde (#2, #4, #15): 3 dias tarde ---
  {
    fact_id: 1003, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'Migracion de datos', planned_type: 'P',
    budgeted_hours: 5, total_executed_hours: 6, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-05', actual_delivery_date: '2026-08-08',
  },
  // --- Entrega a tiempo, exacta (#2, #15 on_time) ---
  {
    fact_id: 1004, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'Documentacion API', planned_type: 'P',
    budgeted_hours: 3, total_executed_hours: 3, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-06', actual_delivery_date: '2026-08-06',
  },
  // --- Entrega ANTICIPADA, 2 dias antes (#15 early) ---
  {
    fact_id: 1005, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'Revision de PR', planned_type: 'P',
    budgeted_hours: 2, total_executed_hours: 2, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-12', actual_delivery_date: '2026-08-10',
  },
  // --- Entrega MUY tarde, 5 dias (#15 late_4plus) ---
  {
    fact_id: 1006, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Refactor de reportes', planned_type: 'P',
    budgeted_hours: 6, total_executed_hours: 8, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-13', actual_delivery_date: '2026-08-18',
  },

  // --- Bloqueada (#5, #6, #8, #9) ---
  {
    fact_id: 1007, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Integracion con SharePoint', planned_type: 'P',
    budgeted_hours: 4, total_executed_hours: 0, task_status: 'Bloqueado',
    observations: 'Esperando credenciales del cliente',
  },

  // --- Vencida sin cerrar (#3): estimada ayer, no terminada, dia habil ---
  {
    fact_id: 1008, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Ajuste de permisos de usuario', planned_type: 'P',
    budgeted_hours: 3, total_executed_hours: 1, task_status: 'Pendiente',
    // Se calcula dinamicamente en sembrarPlaneacion() para que "ayer, dia
    // habil" sea siempre relativo a HOY (CURDATE()), no una fecha fija que
    // con el tiempo deja de ser "vencida".
    estimated_delivery_date: '__AYER_HABIL__',
  },
  // --- Vencida pero CANCELADA: no debe contar en #3 ni en cumplimiento ---
  {
    fact_id: 1009, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Feature descartada por el cliente', planned_type: 'P',
    budgeted_hours: 5, total_executed_hours: 0, task_status: 'Cancelado',
    estimated_delivery_date: '__AYER_HABIL__',
  },

  // --- No planeada (#11) ---
  {
    fact_id: 1010, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Soporte urgente de produccion', planned_type: 'NP',
    budgeted_hours: 2, total_executed_hours: 3, task_status: 'Terminado',
    unplanned_task_1: 'Caida del servicio de pagos',
  },

  // --- Reestimada, motivo externo (#12, #13) ---
  {
    fact_id: 1011, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Ajuste de alcance', planned_type: 'P',
    budgeted_hours: 8, total_executed_hours: 8, task_status: 'Terminado',
    adjustment_reason_1: 'Cliente cambio el alcance', adjustment_type_1: 'Externo',
  },
  // --- Reestimada, motivo interno (#12, #13) ---
  {
    fact_id: 1012, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Correccion de bug propio', planned_type: 'P',
    budgeted_hours: 4, total_executed_hours: 5, task_status: 'Terminado',
    adjustment_reason_1: 'Bug de estimacion inicial', adjustment_type_1: 'Interno',
  },

  // --- Permiso: no debe penalizar cumplimiento (#1, #8, #16), pero SI
  //     cuenta como tarea (#5) ---
  {
    fact_id: 1013, employee_id: base.EMPLEADOS.aliceAlfa.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 3, activity: 'Permiso médico', planned_type: 'P',
    budgeted_hours: 8, total_executed_hours: 0, task_status: 'Terminado',
    hours_thursday: 0,
  },

  // --- Cambio de fecha estimada entre dos snapshots (#17): se siembra
  //     en dos fechas de snapshot distintas para la MISMA identidad
  //     natural (employee, week, project, activity). Ver mas abajo. ---

  // --- Recurso compartido entre proyectos (#10): Arturo tambien tiene
  //     tareas en un proyecto BETA-adyacente dentro del mismo snapshot. ---
  {
    fact_id: 1014, employee_id: base.EMPLEADOS.arturoAlfa.id, project_folder: 'ALFA', project_name: 'SUECO CRM',
    week_number: 2, activity: 'Apoyo puntual a Beta', planned_type: 'P',
    budgeted_hours: 2, total_executed_hours: 2, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-11', actual_delivery_date: '2026-08-11',
  },

  // --- Brenda (BETA): para que el scope de Bruno tenga datos propios,
  //     y para #16 (heatmap por dia). ---
  {
    fact_id: 1015, employee_id: base.EMPLEADOS.brendaBeta.id, project_folder: 'BETA', project_name: 'BETA',
    week_number: 2, activity: 'Diseño de UI', planned_type: 'P',
    budgeted_hours: 9, total_executed_hours: 9, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-09', actual_delivery_date: '2026-08-09',
    hours_monday: 8, hours_tuesday: 1,
  },

  // --- Carlos (inactivo): NO debe aparecer en ningun indicador. ---
  {
    fact_id: 1016, employee_id: base.EMPLEADOS.carlosBaja.id, project_folder: 'ALFA', project_name: 'ALFA',
    week_number: 2, activity: 'Tarea de alguien que ya no esta', planned_type: 'P',
    budgeted_hours: 100, total_executed_hours: 100, task_status: 'Terminado',
    estimated_delivery_date: '2026-08-01', actual_delivery_date: '2026-08-01',
  },
];

// Filas adicionales para el #17 (auditoria de cambio de fecha estimada):
// misma identidad natural (empleado, semana, proyecto, actividad, mes) en
// DOS snapshots distintos, con estimated_delivery_date diferente. #17 no
// usa baseWhere() (mira TODOS los snapshots del mes), a diferencia de casi
// todos los demas indicadores.
//
// HALLAZGO (ago 2026): estas dos fechas estaban fijas en el calendario
// ('2026-08-20'/'2026-08-25'). El indicador #3 (vencidas) cuenta CUALQUIER
// tarea no terminal cuya fecha estimada ya paso, sin importar de que
// fixture venga -- cuando el calendario real alcanzo esas fechas fijas,
// fact 1102 ('En Progreso', ya no terminal) empezo a colarse como "vencida"
// de Alicia en la prueba de #3, con un falso 1 en vez de 0. Igual que
// fechaAyerHabil() para #3, estas se calculan relativas a HOY para que
// nunca queden atras del calendario real -- se mantiene el mismo salto de
// 5 dias entre las dos (eso es lo que #17 verifica en days_moved).
const DIAS_FUTURA_1 = 20;
const DIAS_FUTURA_2 = 25; // 5 dias despues de la anterior -- ver days_moved en el test de #17
const HISTORIA_FECHA_MOVIDA = [
  {
    fact_id: 1101, snapshot_date: '2026-08-15', employee_id: base.EMPLEADOS.aliceAlfa.id,
    project_folder: 'ALFA', project_name: 'ALFA', week_number: 4, activity: 'Entrega final del modulo',
    planned_type: 'P', task_status: 'En Progreso', estimated_delivery_date: `__FUTURA_${DIAS_FUTURA_1}__`,
  },
  {
    fact_id: 1102, snapshot_date: SNAPSHOT, employee_id: base.EMPLEADOS.aliceAlfa.id,
    project_folder: 'ALFA', project_name: 'ALFA', week_number: 4, activity: 'Entrega final del modulo',
    planned_type: 'P', task_status: 'En Progreso', estimated_delivery_date: `__FUTURA_${DIAS_FUTURA_2}__`,
  },
];

function fechaAyerHabil() {
  // Retrocede desde ayer hasta encontrar un dia habil (lun-vie). No
  // considera festivos de mp_holidays a proposito: la ventana es amplia
  // (task_status queda 'Pendiente' indefinidamente) y sumar un dia mas o
  // menos no cambia lo que la prueba verifica (que la tarea cuenta como
  // vencida). Devuelve 'YYYY-MM-DD'.
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Fecha relativa a HOY + `dias` (sin ajustar dia habil: #17 no filtra por
// eso). Se usa para HISTORIA_FECHA_MOVIDA -- ver el comentario ahi arriba.
function fechaFutura(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function insertarFila(f, snapshotDate) {
  const ayerHabil = fechaAyerHabil();
  const resolverFecha = (v) => {
    if (v === '__AYER_HABIL__') return ayerHabil;
    if (v === `__FUTURA_${DIAS_FUTURA_1}__`) return fechaFutura(DIAS_FUTURA_1);
    if (v === `__FUTURA_${DIAS_FUTURA_2}__`) return fechaFutura(DIAS_FUTURA_2);
    return v;
  };

  await query(
    `INSERT INTO mp_task_facts
       (fact_id, snapshot_date, employee_id, project_folder, project_name, month_name, month_number, year_number,
        week_number, activity, planned_type, budgeted_hours, total_executed_hours, task_status,
        estimated_delivery_date, actual_delivery_date, observations,
        adjustment_reason_1, adjustment_type_1, unplanned_task_1,
        hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      f.fact_id, snapshotDate, f.employee_id, f.project_folder, f.project_name || f.project_folder,
      MES, MES_NUM, ANIO, f.week_number, f.activity, f.planned_type,
      f.budgeted_hours ?? 0, f.total_executed_hours ?? 0, f.task_status ?? null,
      resolverFecha(f.estimated_delivery_date ?? null), f.actual_delivery_date ?? null, f.observations ?? null,
      f.adjustment_reason_1 ?? null, f.adjustment_type_1 ?? null, f.unplanned_task_1 ?? null,
      f.hours_monday ?? 0, f.hours_tuesday ?? 0, f.hours_wednesday ?? 0, f.hours_thursday ?? 0, f.hours_friday ?? 0, f.hours_saturday ?? 0,
    ]
  );
}

/**
 * Siembra encima de lo que ya puso test/helpers/fixtures.js (usuarios,
 * empleados, centros). Asume que sembrar() de fixtures.js ya corrio (o
 * corre junto en el mismo test.before): esta función SOLO agrega filas de
 * mp_task_facts, no toca usuarios/empleados/centros.
 */
async function sembrarPlaneacion() {
  for (const f of TAREAS) await insertarFila(f, SNAPSHOT);
  for (const f of HISTORIA_FECHA_MOVIDA) await insertarFila(f, f.snapshot_date);
}

module.exports = {
  SNAPSHOT, MES, MES_NUM, ANIO,
  TAREAS, HISTORIA_FECHA_MOVIDA,
  DIAS_FUTURA_1, DIAS_FUTURA_2,
  sembrarPlaneacion,
  fechaAyerHabil,
  fechaFutura,
};
