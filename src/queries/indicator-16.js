'use strict';

/**
 * Indicador #16 — ACTIVIDAD DIARIA POR RECURSO  [DIARIO]
 *
 * Heatmap: filas = recursos, columnas = Lun..Sáb, celda = horas ejecutadas
 * sumadas en el mes filtrado. Excluye filas de permiso/festivo.
 *
 * Las columnas reales en mp_task_facts son hours_monday..hours_saturday
 * (decimal 5,2, default 0). Ya las pobla el WF1 actual.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');
const { notPermisoClause } = require('./_permiso');

const DAYS = [
  { col: 'hours_monday',    label: 'Lun', cap_env: 'WORK_HOURS_MONDAY',  default_cap: 8 },
  { col: 'hours_tuesday',   label: 'Mar', cap_env: 'WORK_HOURS_TUE_FRI', default_cap: 9 },
  { col: 'hours_wednesday', label: 'Mié', cap_env: 'WORK_HOURS_TUE_FRI', default_cap: 9 },
  { col: 'hours_thursday',  label: 'Jue', cap_env: 'WORK_HOURS_TUE_FRI', default_cap: 9 },
  { col: 'hours_friday',    label: 'Vie', cap_env: 'WORK_HOURS_TUE_FRI', default_cap: 9 },
  { col: 'hours_saturday',  label: 'Sáb', cap_env: 'WORK_HOURS_SAT',     default_cap: 0 },
];

function dayCapacity(env, def) {
  const v = parseFloat(process.env[env]);
  return Number.isFinite(v) ? v : def;
}

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const dayCols = DAYS.map((d) =>
    `SUM(CASE WHEN ${notPermisoClause('t.activity')}
              THEN COALESCE(t.${d.col}, 0) ELSE 0 END) AS ${d.col}`
  ).join(',\n            ');

  const rows = await query(
    `SELECT e.employee_id, e.canonical_name, e.contract_type,
            ${dayCols},
            COUNT(*) AS task_count
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${notCancelledClause('t')}
      GROUP BY e.employee_id, e.canonical_name, e.contract_type
      ORDER BY e.canonical_name`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  const dayCaps = DAYS.map((d) => dayCapacity(d.cap_env, d.default_cap));

  const employees = rows.map((r) => ({
    employee_id: r.employee_id,
    canonical_name: r.canonical_name,
    contract_type: r.contract_type || 'planta',
    days: DAYS.map((d, idx) => {
      const h = Number(r[d.col]) || 0;
      const cap = dayCaps[idx];
      return {
        label: d.label,
        hours: Number(h.toFixed(2)),
        capacity_ref: cap,
        intensity: cap > 0 ? Math.min(1, h / cap) : (h > 0 ? 1 : 0),
        overload: cap > 0 && h > cap * 1.25,
        empty: h === 0,
      };
    }),
    task_count: Number(r.task_count) || 0,
  }));

  return {
    days: DAYS.map((d) => d.label),
    day_capacities: dayCaps,
    employees,
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  if (!filters.employee_id) return { rows: [] };

  const rows = await query(
    `SELECT t.week_number, t.project_folder, t.activity, t.task_status,
            COALESCE(t.hours_monday,0)    AS h_mon,
            COALESCE(t.hours_tuesday,0)   AS h_tue,
            COALESCE(t.hours_wednesday,0) AS h_wed,
            COALESCE(t.hours_thursday,0)  AS h_thu,
            COALESCE(t.hours_friday,0)    AS h_fri,
            COALESCE(t.hours_saturday,0)  AS h_sat,
            COALESCE(t.total_executed_hours,0) AS total
       FROM mp_task_facts t
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
      ORDER BY t.week_number, t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
