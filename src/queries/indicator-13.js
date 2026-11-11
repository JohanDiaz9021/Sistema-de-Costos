'use strict';

/**
 * Indicador #13 — % IMPREVISTOS INTERNOS VS EXTERNOS  [SEMANAL]
 * De los adjustment_type_1/2/3 no vacios: % Interno vs % Externo.
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
    `SELECT tipo, COUNT(*) AS cnt FROM (
        SELECT TRIM(t.adjustment_type_1) AS tipo FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_type_1 IS NOT NULL AND t.adjustment_type_1 <> ''
        UNION ALL
        SELECT TRIM(t.adjustment_type_2) FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_type_2 IS NOT NULL AND t.adjustment_type_2 <> ''
        UNION ALL
        SELECT TRIM(t.adjustment_type_3) FROM mp_task_facts t
         JOIN mp_employees e ON t.employee_id = e.employee_id
         WHERE ${where.clause} ${scopeF.clause} ${flt.clause}
           AND e.is_active = 1
           AND t.adjustment_type_3 IS NOT NULL AND t.adjustment_type_3 <> ''
     ) u
     GROUP BY tipo`,
    [
      ...where.params, ...scopeF.params, ...flt.params,
      ...where.params, ...scopeF.params, ...flt.params,
      ...where.params, ...scopeF.params, ...flt.params,
    ]
  );

  let interno = 0, externo = 0, otro = 0;
  for (const r of rows) {
    const k = (r.tipo || '').toLowerCase();
    const c = Number(r.cnt) || 0;
    if (k === 'interno') interno += c;
    else if (k === 'externo') externo += c;
    else otro += c;
  }
  const total = interno + externo + otro;
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return {
    interno, externo, otro, total,
    interno_pct: pct(interno),
    externo_pct: pct(externo),
    otro_pct: pct(otro),
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  const tipo = filters.tipo ? String(filters.tipo) : null;

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
            t.adjustment_type_1, t.adjustment_reason_1,
            t.adjustment_type_2, t.adjustment_reason_2,
            t.adjustment_type_3, t.adjustment_reason_3
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND (
          (t.adjustment_type_1 IS NOT NULL AND t.adjustment_type_1 <> '') OR
          (t.adjustment_type_2 IS NOT NULL AND t.adjustment_type_2 <> '') OR
          (t.adjustment_type_3 IS NOT NULL AND t.adjustment_type_3 <> '')
        )
        ${tipo ? `AND (
          LOWER(t.adjustment_type_1) = LOWER(?) OR
          LOWER(t.adjustment_type_2) = LOWER(?) OR
          LOWER(t.adjustment_type_3) = LOWER(?))` : ''}
      ORDER BY t.project_folder, t.activity
      LIMIT 500`,
    [
      ...where.params, ...scopeF.params, ...flt.params,
      ...(tipo ? [tipo, tipo, tipo] : []),
    ]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
