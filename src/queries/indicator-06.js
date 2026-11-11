'use strict';

/**
 * Indicador #6 — % ACTIVIDADES BLOQUEADAS  [DIARIO]
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
        SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS blocked,
        COUNT(*) AS total
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.task_status IS NOT NULL
        AND ${notCancelledClause('t')}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const r = rows[0] || { blocked: 0, total: 0 };
  const blocked = Number(r.blocked) || 0;
  const total = Number(r.total) || 0;
  const pct = total > 0 ? (blocked / total) * 100 : 0;
  return { blocked, total, pct: Number(pct.toFixed(1)) };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
            t.observations, t.estimated_delivery_date
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND t.task_status = 'Bloqueado'
      ORDER BY t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
