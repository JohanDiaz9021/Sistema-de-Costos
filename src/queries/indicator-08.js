'use strict';

/**
 * Indicador #8 — INDICADOR GENERAL POR RECURSO  [DIARIO]
 * Tabla consolidada: una fila por recurso.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');
const { notPermisoClause } = require('./_permiso');

function semaphore(compliancePct, blockedCount) {
  if (blockedCount > 0) return 'red';
  if (compliancePct === null || compliancePct === undefined) return 'grey';
  if (compliancePct >= 100) return 'green';
  if (compliancePct >= 80) return 'amber';
  return 'red';
}

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT e.employee_id, e.canonical_name, e.contract_type,
            SUM(CASE WHEN ${notPermisoClause('t.activity')}
                     THEN COALESCE(t.budgeted_hours, 0) ELSE 0 END)       AS budgeted,
            SUM(CASE WHEN ${notPermisoClause('t.activity')}
                     THEN COALESCE(t.total_executed_hours, 0) ELSE 0 END) AS executed,
            COUNT(*)                                  AS total_tasks,
            SUM(CASE WHEN t.task_status = 'Terminado' THEN 1 ELSE 0 END) AS completed_tasks,
            SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS blocked_tasks,
            SUM(CASE WHEN t.task_status = 'Terminado'
                          AND t.actual_delivery_date IS NOT NULL
                          AND t.actual_delivery_date <= t.estimated_delivery_date
                     THEN 1 ELSE 0 END) AS on_time_count
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

  const series = rows.map((r) => {
    const budgeted = Number(r.budgeted) || 0;
    const executed = Number(r.executed) || 0;
    const compliance = budgeted > 0 ? (executed / budgeted) * 100 : null;
    const completed = Number(r.completed_tasks) || 0;
    const blocked = Number(r.blocked_tasks) || 0;
    const total = Number(r.total_tasks) || 0;
    const onTime = Number(r.on_time_count) || 0;
    const completedPct = total > 0 ? (completed / total) * 100 : 0;
    const onTimePct = completed > 0 ? (onTime / completed) * 100 : null;
    return {
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      contract_type: r.contract_type || 'planta',
      budgeted: Number(budgeted.toFixed(1)),
      executed: Number(executed.toFixed(1)),
      compliance_pct: compliance === null ? null : Number(compliance.toFixed(1)),
      completed_pct: Number(completedPct.toFixed(1)),
      blocked_tasks: blocked,
      on_time_pct: onTimePct === null ? null : Number(onTimePct.toFixed(0)),
      total_tasks: total,
      semaphore: semaphore(compliance, blocked),
    };
  });
  return { rows: series };
}

async function drilldown(scope, filters) {
  // Reusa el endpoint /api/resource/:id, pero ofrecemos uno aqui para consistencia.
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  if (!filters.employee_id) return { rows: [] };

  const rows = await query(
    `SELECT t.fact_id, t.week_number, t.project_folder, t.activity,
            t.budgeted_hours, t.total_executed_hours, t.task_status,
            t.estimated_delivery_date, t.actual_delivery_date
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
