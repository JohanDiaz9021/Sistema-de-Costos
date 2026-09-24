'use strict';

/**
 * Indicador #2 — % ENTREGA A TIEMPO  [SEMANAL]
 * COUNT(actual_delivery_date <= estimated_delivery_date AND status='Terminado')
 *   / COUNT(status='Terminado' AND actual_delivery_date NOT NULL) * 100
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
        SUM(CASE WHEN t.task_status = 'Terminado'
                      AND t.actual_delivery_date IS NOT NULL
                      AND t.estimated_delivery_date IS NOT NULL
                      AND t.actual_delivery_date <= t.estimated_delivery_date
                 THEN 1 ELSE 0 END) AS on_time,
        SUM(CASE WHEN t.task_status = 'Terminado'
                      AND t.actual_delivery_date IS NOT NULL
                 THEN 1 ELSE 0 END) AS finished
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const r = rows[0] || { on_time: 0, finished: 0 };
  const onTime = Number(r.on_time) || 0;
  const finished = Number(r.finished) || 0;
  const pct = finished > 0 ? (onTime / finished) * 100 : null;
  return {
    on_time: onTime,
    finished,
    pct: pct === null ? null : Math.round(pct),
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
            DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) AS days_diff,
            CASE WHEN t.actual_delivery_date <= t.estimated_delivery_date
                 THEN 'A tiempo' ELSE 'Tarde' END AS resultado
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
