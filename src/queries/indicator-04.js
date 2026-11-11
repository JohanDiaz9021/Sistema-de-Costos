'use strict';

/**
 * Indicador #4 — DIAS DE DESFASE PROMEDIO  [SEMANAL]
 * Solo tareas Terminado con actual_delivery_date no nulo.
 * Promedio de (actual - estimated). Positivo = entrego tarde.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere } = require('./_common');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT
        AVG(DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date)) AS avg_days,
        COUNT(*) AS finished,
        SUM(CASE WHEN t.actual_delivery_date <= t.estimated_delivery_date THEN 1 ELSE 0 END) AS on_time,
        SUM(CASE WHEN t.actual_delivery_date  > t.estimated_delivery_date THEN 1 ELSE 0 END) AS late
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.task_status = 'Terminado'
        AND t.actual_delivery_date IS NOT NULL
        AND t.estimated_delivery_date IS NOT NULL`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const r = rows[0] || {};
  const avg = r.avg_days === null || r.avg_days === undefined ? null : Number(r.avg_days);
  return {
    avg_days: avg === null ? null : Number(avg.toFixed(1)),
    finished: Number(r.finished) || 0,
    on_time: Number(r.on_time) || 0,
    late: Number(r.late) || 0,
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
            t.estimated_delivery_date, t.actual_delivery_date,
            DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) AS days_diff
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND t.task_status = 'Terminado'
        AND t.actual_delivery_date IS NOT NULL
        AND t.estimated_delivery_date IS NOT NULL
      ORDER BY days_diff DESC
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
