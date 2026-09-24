'use strict';

/**
 * Indicador #15 — VELOCIDAD DE CIERRE  [SEMANAL]
 *
 * Por recurso, cuenta cuántas tareas terminadas cerraron:
 *   • antes de la fecha estimada (early, dias < 0)
 *   • a tiempo (on_time, dias = 0)
 *   • 1 a 3 dias tarde (late_1_3)
 *   • 4+ dias tarde (late_4plus)
 *
 * Se sigue calculando avg_days y finished_count para que el tooltip
 * de cada barra muestre el contexto.
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
    `SELECT e.employee_id, e.canonical_name,
            SUM(CASE WHEN DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) <  0 THEN 1 ELSE 0 END) AS early,
            SUM(CASE WHEN DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) =  0 THEN 1 ELSE 0 END) AS on_time,
            SUM(CASE WHEN DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS late_1_3,
            SUM(CASE WHEN DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) >= 4 THEN 1 ELSE 0 END) AS late_4plus,
            AVG(DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date)) AS avg_days,
            COUNT(*) AS finished_count
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND t.task_status = 'Terminado'
        AND t.actual_delivery_date IS NOT NULL
        AND t.estimated_delivery_date IS NOT NULL
      GROUP BY e.employee_id, e.canonical_name
      HAVING finished_count > 0
      ORDER BY finished_count DESC, late_4plus DESC`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  return {
    rows: rows.map((r) => ({
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      early: Number(r.early) || 0,
      on_time: Number(r.on_time) || 0,
      late_1_3: Number(r.late_1_3) || 0,
      late_4plus: Number(r.late_4plus) || 0,
      avg_days: r.avg_days === null ? null : Number(Number(r.avg_days).toFixed(1)),
      finished_count: Number(r.finished_count) || 0,
    })),
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  if (!filters.employee_id) return { rows: [] };

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, t.estimated_delivery_date,
            t.actual_delivery_date,
            DATEDIFF(t.actual_delivery_date, t.estimated_delivery_date) AS days_diff
       FROM mp_task_facts t
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
