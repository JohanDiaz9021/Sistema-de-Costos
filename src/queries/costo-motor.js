'use strict';

/**
 * 2.4 — Funciones base compartidas del motor de Costeo (sección 11 spec).
 *
 * Cada función recibe un cost_center_id y devuelve un número (costo total
 * para ese centro). Son bloques reutilizables: cualquier indicador de
 * Costeo las importa en vez de repetir la query.
 */

const { query } = require('../db');
const { getLegalHoursPerWeek } = require('./costo-weekly-hours');
// baseWhere viene de costo-common.js, NO de _common.js (31 ago 2026): el de
// _common.js filtra contra mp_task_facts, la tabla del RPA de Planeación.
// Costeo tiene su propia tabla (mp_costeo_task_facts, sin RPA) y su propio
// baseWhere con snapshot POR EMPLEADO — ver el comentario en costo-common.js.
const { baseWhere } = require('./costo-common');
const { buildFilterClause } = require('./_common');
const { memo, filtersKey } = require('../lib/request-cache');
const { loadHolidaysSet, diasConHorasYFestivo, separarHorasFestivas } = require('../capacity');

// Filtros vacíos: es lo que se aplica cuando el usuario no eligió nada.
const SIN_FILTROS = { month: null, week: null, project: null, employee_id: null, leader: null };

// El filtro de Periodo llega como nombre de mes ("Agosto"), que es lo que
// guarda mp_costeo_task_facts. Las tablas propias de Costeo usan
// month_number, así que hay que traducirlo. Se resuelve contra los datos y
// no con una tabla fija de nombres para no depender del idioma.
//
// Devuelve TAMBIÉN el año: sin él, filtrar "Agosto" sumaba los gastos de
// agosto de todos los años juntos (ver costoNoPlaneadoTotal). Se toma el año
// más reciente que tenga datos de ese mes, y el ORDER BY lo hace
// determinista — antes el LIMIT 1 sin orden dejaba la fila al azar.
async function mesYAnio(monthName) {
  if (!monthName) return null;
  return memo(`mesYAnio:${monthName}`, async () => {
    const rows = await query(
      `SELECT month_number, year_number
         FROM mp_costeo_task_facts
        WHERE month_name = ? AND month_number IS NOT NULL AND year_number IS NOT NULL
        ORDER BY year_number DESC
        LIMIT 1`,
      [monthName]
    );
    return rows.length ? { month: Number(rows[0].month_number), year: Number(rows[0].year_number) } : null;
  });
}

// Compatibilidad: el resto del motor solo necesita el número de mes.
async function mesANumero(monthName) {
  const r = await mesYAnio(monthName);
  return r ? r.month : null;
}

// Rango [primer día del mes, primer día del mes siguiente) para filtrar
// columnas DATE. Reemplaza a MONTH(expense_date) = ?, que (a) ignoraba el año
// y mezclaba agosto de 2025 con el de 2026, y (b) al aplicar una función
// sobre la columna impedía usar cualquier índice de expense_date.
function rangoMes(mesYAnioObj) {
  if (!mesYAnioObj) return null;
  const desde = `${mesYAnioObj.year}-${String(mesYAnioObj.month).padStart(2, '0')}-01`;
  return { desde };
}

// Suma, por talento/semana, min(hEjec, horas_legales) * tarifa_hora.
// Es el costo de las horas dentro del límite legal (no incluye extra).
async function costoLaboralEjecutado(cost_center_id, filters = SIN_FILTROS) {
  const legalHours = await getLegalHoursPerWeek();

  // baseWhere() NO es opcional aquí, y no está solo por el filtro de mes.
  //
  // mp_costeo_task_facts guarda un snapshot por carga de Excel: la misma
  // persona/proyecto/semana se repite en cada subida. Esta query no
  // filtraba por snapshot_date, así que sumaba las mismas horas una vez por
  // snapshot y multiplicaba el costo laboral — medido: $2.263.200 reportados
  // contra $856.900 reales, 2,6x, y el factor crece con cada carga que pasa.
  // weeklyAggregate() sí filtraba, así que las horas salían bien mientras el
  // dinero salía inflado, y los dos números no cuadraban entre sí.
  //
  // baseWhere() resuelve el snapshot correcto de CADA empleado (el último
  // que él mismo subió, no un corte global — ver costo-common.js) y
  // buildFilterClause() agrega semana y talento.
  const where = baseWhere(filters, 't');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.employee_id, t.week_number, t.month_number, t.year_number,
            SUM(COALESCE(t.hours_monday,0))    AS h_mon,
            SUM(COALESCE(t.hours_tuesday,0))   AS h_tue,
            SUM(COALESCE(t.hours_wednesday,0)) AS h_wed,
            SUM(COALESCE(t.hours_thursday,0))  AS h_thu,
            SUM(COALESCE(t.hours_friday,0))    AS h_fri,
            SUM(COALESCE(t.hours_saturday,0))  AS h_sat,
            ep.hourly_cost
       FROM mp_costeo_task_facts t
       -- El costo se atribuye por el PROYECTO DE LA TAREA (t.project_name, la
       -- columna "Proyecto" del Excel), no por la carpeta de la persona
       -- (t.project_folder, que es su equipo en SharePoint). Antes se cruzaba
       -- por la carpeta y el gasto caía en el centro equivocado: alguien de
       -- la carpeta "Document Online" que reporta horas al proyecto
       -- "Management" se las cobraba a Document Online. Peor aún, las
       -- carpetas QA y UX no tienen centro, así que esas filas no llegaban
       -- a ningún lado.
       --
       -- El OR existe porque el "Proyecto" del Excel unas veces coincide con
       -- cc.project_name ("SUECO CRM") y otras con cc.project_folder
       -- ("Sistema de costos" -> centro "Costos"). Esto puede colisionar si
       -- dos centros comparten ese valor (ver POST /centros, que ahora lo
       -- rechaza al crear) — no hay ambigüedad conocida en los datos reales.
       JOIN mp_centro_costo cc
              ON cc.project_name = t.project_name
              OR cc.project_folder = t.project_name
       JOIN mp_employees e ON e.employee_id = t.employee_id AND e.is_active = 1
       LEFT JOIN mp_equipo_proyecto ep
              ON ep.cost_center_id = cc.cost_center_id
             AND ep.employee_id = t.employee_id
             AND ep.is_active = 1
      WHERE cc.cost_center_id = ?
        AND ${where.clause}
        ${flt.clause}
        AND t.week_number IS NOT NULL
      GROUP BY t.employee_id, t.week_number, t.month_number, t.year_number, ep.hourly_cost`,
    [cost_center_id, ...where.params, ...flt.params]
  );

  const years = [...new Set(rows.map((r) => Number(r.year_number)))];
  const sets = await Promise.all(years.map((y) => loadHolidaysSet(y)));
  const holidaysSet = new Set();
  for (const s of sets) for (const fecha of s) holidaysSet.add(fecha);

  return sumarCostoLegal(rows, legalHours, holidaysSet);
}

// Suma min(horasNormales, horas_legales) * tarifa_hora por fila. Separada de
// la query de arriba para poder probarla como unitaria pura, con filas
// armadas a mano.
//
// Las horas de un festivo NUNCA cuentan aquí (quedan fuera de horasNormales,
// ver capacity.js:separarHorasFestivas) — no porque no se paguen, sino porque
// ya se pagan por otro camino: entran como "extra festiva" al flujo de horas
// extra (costo-weekly-hours.js -> mp_overtime_decisions -> costoExtraAprobado).
// Contarlas también aquí las pagaría dos veces.
function sumarCostoLegal(rows, legalHours, holidaysSet) {
  let total = 0;
  for (const r of rows) {
    const hourlyCost = Number(r.hourly_cost) || 0;
    const dias = diasConHorasYFestivo(r, Number(r.year_number), Number(r.month_number), Number(r.week_number), holidaysSet);
    const { horasNormales } = separarHorasFestivas(dias);
    const horasLegales = Math.min(horasNormales, legalHours);
    total += horasLegales * hourlyCost;
  }
  return Number(total.toFixed(2));
}

// Suma extra_cost_final de mp_overtime_decisions donde el PM/aprobador ya
// aceptó pagar la hora extra (approval_status = 'aprobado').
async function costoExtraAprobado(cost_center_id, filters = SIN_FILTROS) {
  const cond = [];
  const params = [cost_center_id];
  if (filters.employee_id) { cond.push('AND employee_id = ?'); params.push(filters.employee_id); }
  if (filters.week) { cond.push('AND week_number = ?'); params.push(filters.week); }
  // Mes Y año: week_number es la semana del MES (sql/21), asi que month_number
  // por si solo repite en cada año y mezclaba el costo extra aprobado de
  // agosto de 2025 con el de 2026 en el mismo total.
  const periodo = await mesYAnio(filters.month);
  // Se pidió un mes explícito y mesYAnio() no lo encontró en
  // mp_costeo_task_facts (p.ej. "Junio", que solo tiene datos en Planeación,
  // no en Costeo) — 0, no "mostrar todos los meses sin filtrar". Sin este
  // corte, `if (periodo)` de abajo simplemente no agregaba la condición de
  // mes/año, y la query devolvía las horas extra de TODA la historia
  // mezcladas bajo el nombre de un mes que en realidad no tenía nada (8 sep
  // 2026, reportado por el usuario: "Junio" mostraba horas que no eran de
  // junio).
  if (filters.month && !periodo) return 0;
  if (periodo) {
    cond.push('AND month_number = ?'); params.push(periodo.month);
    cond.push('AND year_number = ?'); params.push(periodo.year);
  }

  const rows = await query(
    `SELECT SUM(extra_cost_final) AS total
       FROM mp_overtime_decisions
      WHERE cost_center_id = ? AND approval_status = 'aprobado'
        ${cond.join(' ')}`,
    params
  );
  return Number(rows[0]?.total) || 0;
}

// Suma amount de mp_costo_no_planeado (licencias, viaticos, terceros, etc).
//
// Solo los APROBADOS (sql/28). Un gasto no planeado lo solicita el PM y
// nace 'pendiente': hasta que admin/ceo lo aprueba no es dinero
// comprometido, y un rechazado no lo es nunca. La guarda vive aqui, en la
// unica query que convierte esa tabla en presupuesto ejecutado — no en un
// if del frontend.
//
// Un gasto no planeado es del PROYECTO, no de una persona: la tabla no tiene
// employee_id y no hay forma de repartirlo. Por eso, cuando se filtra por
// talento, este componente vale 0 en vez de sumar el gasto completo — de lo
// contrario el costo atribuido a esa persona incluiría licencias y viáticos
// que no son suyos. El frontend lo advierte al filtrar por recurso.
async function costoNoPlaneadoTotal(cost_center_id, filters = SIN_FILTROS) {
  if (filters.employee_id) return 0;

  const params = [cost_center_id];
  let cond = '';
  const periodo = await mesYAnio(filters.month);
  // Mismo corte que costoExtraAprobado de arriba: un mes explícito que no
  // resuelve (sin datos en mp_costeo_task_facts) es 0, no "todo sin filtro".
  if (filters.month && !periodo) return 0;
  const rango = rangoMes(periodo);
  if (rango) {
    cond = ' AND expense_date >= ? AND expense_date < DATE_ADD(?, INTERVAL 1 MONTH)';
    params.push(rango.desde, rango.desde);
  }

  const rows = await query(
    `SELECT SUM(amount) AS total
       FROM mp_costo_no_planeado
      WHERE cost_center_id = ? AND approval_status = 'aprobado' ${cond}`,
    params
  );
  return Number(rows[0]?.total) || 0;
}

// Ejecutado total del centro (= acumulado previo + laboral + extra aprobado +
// no planeado) junto con los componentes que lo forman.
//
// Quien necesite el total Y sus partes debe pedir este desglose, no llamar a
// ejecutadoTotal() en paralelo con las tres funciones de arriba: eso corría
// las mismas tres queries dos veces (8 por centro en vez de 4), y con
// connectionLimit: 10 el costo se nota apenas hay varios centros visibles.
// Memoizado por peticion: computeIndicadoresDesde() lo pide para cada centro
// y GET /alertas repetia el mismo desglose que GET /indicadores-17 acababa de
// calcular. Son 4 queries por llamada, asi que el ahorro es directo.
async function desgloseEjecutado(cost_center_id, filters = SIN_FILTROS) {
  return memo(
    `desglose:${cost_center_id}:${filtersKey(filters)}`,
    () => desgloseEjecutadoUncached(cost_center_id, filters)
  );
}

// "Costo anterior" (mp_centro_costo.previous_cost) se sumaba aquí: era el
// gasto acumulado del proyecto ANTES de que el sistema lo midiera. Se retiró
// (ago 2026) porque ningún centro lo usaba — los 12 estaban en $0 — y un
// campo que suma al Ejecutado sin que nadie sepa qué es se presta a inflar
// el gasto por error. La columna sigue en la tabla, sin que nada la lea.
async function desgloseEjecutadoUncached(cost_center_id, filters = SIN_FILTROS) {
  const [laboral, extra, noPlaneado] = await Promise.all([
    costoLaboralEjecutado(cost_center_id, filters),
    costoExtraAprobado(cost_center_id, filters),
    costoNoPlaneadoTotal(cost_center_id, filters),
  ]);
  return {
    laboral,
    extra,
    noPlaneado,
    total: Number((laboral + extra + noPlaneado).toFixed(2)),
  };
}

async function ejecutadoTotal(cost_center_id) {
  const { total } = await desgloseEjecutado(cost_center_id);
  return total;
}

module.exports = {
  mesANumero,
  mesYAnio,
  rangoMes,
  costoLaboralEjecutado,
  costoExtraAprobado,
  costoNoPlaneadoTotal,
  desgloseEjecutado,
  ejecutadoTotal,
  sumarCostoLegal,
};
