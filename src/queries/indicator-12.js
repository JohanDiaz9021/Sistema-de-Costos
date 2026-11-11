'use strict';

/**
 * Indicador #12 — TASA DE REESTIMACION  [SEMANAL]
 * COUNT(adjustment_reason_1 != vacio) / COUNT(total) * 100.
 * Adicionalmente, top motivos agrupando reason_1, _2 y _3.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere } = require('./_common');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const summary = await query(
    `SELECT
        SUM(CASE WHEN t.adjustment_reason_1 IS NOT NULL AND t.adjustment_reason_1 <> ''
                 THEN 1 ELSE 0 END) AS reestimated,
        COUNT(*) AS total
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const s = summary[0] || {};
  const re = Number(s.reestimated) || 0;
  const total = Number(s.total) || 0;

  // Top motivos: concatenamos reason_1/2/3 con UNION
  const reasons = await query(
    `SELECT motivo, COUNT(*) AS cnt FROM (
        SELECT TRIM(t.adjustment_reason_1) AS motivo FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_reason_1 IS NOT NULL AND t.adjustment_reason_1 <> ''
        UNION ALL
        SELECT TRIM(t.adjustment_reason_2) AS motivo FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_reason_2 IS NOT NULL AND t.adjustment_reason_2 <> ''
        UNION ALL
        SELECT TRIM(t.adjustment_reason_3) AS motivo FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_reason_3 IS NOT NULL AND t.adjustment_reason_3 <> ''
     ) u
     GROUP BY motivo
     ORDER BY cnt DESC
     LIMIT 10`,
    [
      ...where.params, ...scopeF.params, ...flt.params,
      ...where.params, ...scopeF.params, ...flt.params,
      ...where.params, ...scopeF.params, ...flt.params,
    ]
  );

  return {
    reestimated: re,
    total,
    pct: total > 0 ? Number(((re / total) * 100).toFixed(1)) : 0,
    top_reasons: reasons.map((r) => ({
      motivo: r.motivo || '(sin motivo)',
      count: Number(r.cnt) || 0,
    })),
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
            t.adjustment_reason_1, t.adjustment_type_1,
            t.adjustment_reason_2, t.adjustment_type_2,
            t.adjustment_reason_3, t.adjustment_type_3
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND t.adjustment_reason_1 IS NOT NULL AND t.adjustment_reason_1 <> ''
      ORDER BY t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
