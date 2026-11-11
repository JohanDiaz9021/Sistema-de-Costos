'use strict';

/**
 * Indicador #11 — % TAREAS NO PLANEADAS  [SEMANAL]
 * COUNT(planned_type = 'NP') / COUNT(planned_type IS NOT NULL) * 100
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT
        SUM(CASE WHEN UPPER(t.planned_type) = 'NP' THEN 1 ELSE 0 END) AS unplanned,
        SUM(CASE WHEN UPPER(t.planned_type) = 'P'  THEN 1 ELSE 0 END) AS planned,
        SUM(CASE WHEN t.planned_type IS NOT NULL AND t.planned_type <> '' THEN 1 ELSE 0 END) AS total
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${notCancelledClause('t')}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const r = rows[0] || {};
  const unplanned = Number(r.unplanned) || 0;
  const planned = Number(r.planned) || 0;
  const total = Number(r.total) || 0;
  const pct = total > 0 ? (unplanned / total) * 100 : 0;
  return {
    unplanned,
    planned,
    total,
    pct: Number(pct.toFixed(1)),
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to, t.task_status,
            t.unplanned_task_1, t.unplanned_task_2, t.unplanned_task_3
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND UPPER(t.planned_type) = 'NP'
      ORDER BY t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
