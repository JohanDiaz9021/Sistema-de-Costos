'use strict';

/**
 * 2.3 — Agregación semanal hEjec/hExtra/costoLegal/costoExtraPotencial.
 *
 * Fuente única: mp_costeo_task_facts.hours_monday..hours_saturday (31 ago
 * 2026: tabla propia de Costeo, poblada solo por la carga manual de Excel
 * — costo-task-facts-upload.js — nunca por el RPA de Planeación, que llena
 * una tabla aparte). Se suman por talento/proyecto/semana, se comparan
 * contra el parámetro de horas legales de mp_costeo_config, y se costean
 * con la tarifa hora del talento en mp_equipo_proyecto (vía
 * mp_centro_costo, puente project_folder -> cost_center_id).
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, getConfigNumber } = require('./costo-common');
const { getParametrosNomina, factorRecargo } = require('./costo-recargos');
const { memo, filtersKey } = require('../lib/request-cache');
const { loadHolidaysSet, diasConHorasYFestivo, separarHorasFestivas } = require('../capacity');

// Es un umbral de configuracion: no cambia a mitad de una peticion, pero se
// pedia una vez por centro y por indicador (decenas de veces por pantalla).
async function getLegalHoursPerWeek() {
  return memo('legalHours', () => getConfigNumber('weekly_legal_hours'));
}

// Recargos aplicables por esta vía (sql/33, tabla de GTC). Aquí las horas
// llegan como un TOTAL POR DÍA desde el Excel (mp_costeo_task_facts no
// tiene hora de inicio/fin), así que de los tres componentes solo se
// pueden decidir dos: si el día es festivo y si la hora es extra. El
// recargo nocturno necesita saber a qué hora se trabajó, y eso solo existe
// en el alta manual de horas extra (costo-overtime.js).
async function getRecargosHoraExtra() {
  return getParametrosNomina();
}

// La query mas cara del modulo (agregado sobre todo mp_costeo_task_facts). Antes se
// ejecutaba una vez por centro de costos aunque el resultado fuera identico:
// computeIndicadores17 la llama con UNRESTRICTED_SCOPE y filtra en JS, asi que
// con 20 centros eran 20 escaneos completos iguales. Memoizada por
// (scope, filtros) queda en uno solo por peticion.
async function weeklyAggregate(scope, filters) {
  const scopeKey = !scope || scope.allowedProjects === null
    ? 'all'
    : scope.allowedProjects.slice().sort().join('|');
  return memo(`weeklyAggregate:${scopeKey}:${filtersKey(filters)}`, () => weeklyAggregateUncached(scope, filters));
}

async function weeklyAggregateUncached(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  const legalHours = await getLegalHoursPerWeek();
  const recargos = await getRecargosHoraExtra();

  const rows = await query(
    `SELECT t.employee_id, e.canonical_name, e.contract_type, t.project_folder, cc.cost_center_id,
            t.week_number, t.month_number, t.year_number,
            SUM(COALESCE(t.hours_monday,0))    AS h_mon,
            SUM(COALESCE(t.hours_tuesday,0))   AS h_tue,
            SUM(COALESCE(t.hours_wednesday,0)) AS h_wed,
            SUM(COALESCE(t.hours_thursday,0))  AS h_thu,
            SUM(COALESCE(t.hours_friday,0))    AS h_fri,
            SUM(COALESCE(t.hours_saturday,0))  AS h_sat,
            ep.hourly_cost
       FROM mp_costeo_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
       -- Mismo criterio que costoLaboralEjecutado (costo-motor.js): se
       -- atribuye por el proyecto de LA TAREA (t.project_name), no por la
       -- carpeta de la persona — si no, "Personas Trabajando", "Costo Real
       -- por Hora", etc. de un proyecto nunca reflejan a alguien cuya
       -- carpeta de SharePoint es distinta del proyecto al que dedicó horas.
       JOIN mp_centro_costo cc ON cc.project_name = t.project_name OR cc.project_folder = t.project_name
       LEFT JOIN mp_equipo_proyecto ep
              ON ep.cost_center_id = cc.cost_center_id
             AND ep.employee_id = t.employee_id
             AND ep.is_active = 1
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.week_number IS NOT NULL
      GROUP BY t.employee_id, e.canonical_name, e.contract_type, t.project_folder, cc.cost_center_id,
               t.week_number, t.month_number, t.year_number, ep.hourly_cost`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  const holidaysSet = await cargarFestivosDeLasFilas(rows);
  return rows.map((r) => mapearFilaSemanal(r, { legalHours, recargos, holidaysSet }));
}

// Carga en un solo Set los festivos de TODOS los años que aparezcan en las
// filas (normalmente uno solo). Se resuelve después de la query principal
// porque ahí es donde se sabe qué años hay que pedir.
async function cargarFestivosDeLasFilas(rows) {
  const years = [...new Set(rows.map((r) => Number(r.year_number)))];
  const sets = await Promise.all(years.map((y) => loadHolidaysSet(y)));
  const holidaysSet = new Set();
  for (const s of sets) for (const fecha of s) holidaysSet.add(fecha);
  return holidaysSet;
}

// Cálculo puro por fila, separado de la query de arriba para poder probarlo
// como unitaria sin tocar la base de datos.
//
// Las horas de un festivo (lunes a sábado; domingo no se captura — ver
// capacity.js) NUNCA cuentan para el límite legal semanal, sea cual sea el
// total de la semana: un festivo no es jornada ordinaria. El resto de las
// horas (día hábil, no festivo) se topa contra legalHours como siempre.
function mapearFilaSemanal(r, { legalHours, recargos, holidaysSet }) {
  const hourlyCost = Number(r.hourly_cost) || 0;
  const dias = diasConHorasYFestivo(r, Number(r.year_number), Number(r.month_number), Number(r.week_number), holidaysSet);
  const { horasNormales, horasFestivas } = separarHorasFestivas(dias);

  const horasLegales = Math.min(horasNormales, legalHours);
  const horasExtraDiurna = Math.max(horasNormales - legalHours, 0);

  const hEjec = horasNormales + horasFestivas;
  const hExtra = horasExtraDiurna + horasFestivas;

  // Factores de la tabla de GTC (costo-recargos.js). Las extra de día hábil
  // van a 1,25 (extra diurna): sin hora de inicio/fin no hay forma de saber
  // si alguna cayó de noche, y cobrar 1,75 "por si acaso" inflaría el costo
  // de todos. Las horas de festivo van a 1,90 (dominical/festivo en jornada
  // ordinaria), que es el renglón que corresponde cuando lo único que se
  // sabe del día es que fue festivo — no cuentan contra el tope legal
  // semanal, así que no son "extra" en el sentido de la tabla.
  const contractType = r.contract_type || 'planta';
  const costoLegal = horasLegales * hourlyCost;
  const costoExtraDiurna = horasExtraDiurna * hourlyCost * factorRecargo({ extra: true }, recargos, contractType);
  const costoExtraFestiva = horasFestivas * hourlyCost * factorRecargo({ festivo: true }, recargos, contractType);

  return {
    employee_id: r.employee_id,
    canonical_name: r.canonical_name,
    project_folder: r.project_folder,
    cost_center_id: r.cost_center_id,
    week_number: Number(r.week_number),
    month_number: Number(r.month_number),
    year_number: Number(r.year_number),
    h_ejec: Number(hEjec.toFixed(2)),
    h_extra: Number(hExtra.toFixed(2)),
    costo_legal: Number(costoLegal.toFixed(2)),
    costo_extra_potencial: Number((costoExtraDiurna + costoExtraFestiva).toFixed(2)),
  };
}

module.exports = { weeklyAggregate, getLegalHoursPerWeek, getRecargosHoraExtra, mapearFilaSemanal };
