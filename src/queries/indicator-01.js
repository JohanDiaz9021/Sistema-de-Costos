'use strict';

/**
 * Indicador #1 — % CUMPLIMIENTO SEMANAL  [SEMANAL]
 * Por cada week_number del mes: SUM(executed) / SUM(budgeted) * 100.
 * Meta: 100% (linea horizontal en el visual).
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');
const { notPermisoClause } = require('./_permiso');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.week_number,
            SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted,
            SUM(COALESCE(t.total_executed_hours, 0)) AS executed
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.week_number IS NOT NULL
        AND ${notPermisoClause('t.activity')}
        AND ${notCancelledClause('t')}
      GROUP BY t.week_number
      ORDER BY t.week_number`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  const series = rows.map((r) => {
    const b = Number(r.budgeted) || 0;
    const x = Number(r.executed) || 0;
    return {
      week: Number(r.week_number),
      budgeted: Number(b.toFixed(2)),
      executed: Number(x.toFixed(2)),
      compliance_pct: b > 0 ? Number(((x / b) * 100).toFixed(1)) : null,
    };
  });
  return { series, target_pct: 100 };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.week_number, t.project_folder, e.canonical_name AS assigned_to, t.activity, t.task_status,
            t.budgeted_hours, t.total_executed_hours,
            CASE WHEN t.budgeted_hours > 0
                 THEN ROUND(t.total_executed_hours / t.budgeted_hours * 100, 1)
                 ELSE NULL END AS compliance_pct
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
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
