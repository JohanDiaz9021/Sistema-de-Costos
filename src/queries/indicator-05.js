'use strict';

/**
 * Indicador #5 — % ACTIVIDADES TERMINADAS  [DIARIO]
 * Dona: Terminado, En Progreso, Pendiente, Bloqueado.
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
    `SELECT t.task_status AS status, COUNT(*) AS cnt
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.task_status IS NOT NULL
        AND ${notCancelledClause('t')}
      GROUP BY t.task_status`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  const buckets = { Terminado: 0, 'En Progreso': 0, Pendiente: 0, Bloqueado: 0, Otro: 0 };
  let total = 0;
  for (const r of rows) {
    const k = buckets.hasOwnProperty(r.status) ? r.status : 'Otro';
    buckets[k] += Number(r.cnt);
    total += Number(r.cnt);
  }
  const pct = total > 0 ? (buckets.Terminado / total) * 100 : 0;
  return { buckets, total, completed_pct: Number(pct.toFixed(0)) };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  const status = filters.status ? String(filters.status) : null;

  const sql = `
    SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
           t.task_status, t.budgeted_hours, t.total_executed_hours,
           t.estimated_delivery_date, t.actual_delivery_date
      FROM mp_task_facts t
      JOIN mp_employees e ON e.employee_id = t.employee_id
     WHERE ${where.clause}
       ${scopeF.clause}
       ${flt.clause}
       AND e.is_active = 1
       ${status ? 'AND t.task_status = ?' : ''}
     ORDER BY t.task_status, t.project_folder, t.activity
     LIMIT 500`;
  const params = [...where.params, ...scopeF.params, ...flt.params];
  if (status) params.push(status);
  const rows = await query(sql, params);
  return { rows };
}

module.exports = { aggregate, drilldown };
