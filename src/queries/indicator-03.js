'use strict';

/**
 * Indicador #3 — ACTIVIDADES VENCIDAS SIN CERRAR  [DIARIO]
 * Cuenta tareas con estimated_delivery_date < HOY y status NO terminal.
 * Estados terminales (no se cuentan como "sin cerrar"):
 *   - 'Terminado' → la tarea se completó
 *   - 'Cancelado' → la tarea ya no se va a hacer
 * Solo cuenta si la fecha estimada cae en día hábil (lun-vie no festivo).
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere } = require('./_common');

// MySQL DAYOFWEEK: 1=Domingo, 2=Lunes ... 6=Viernes, 7=Sabado.
// Excluimos festivos via LEFT JOIN mp_holidays.
function whereOverdue(alias) {
  return `
    ${alias}.estimated_delivery_date IS NOT NULL
    AND ${alias}.estimated_delivery_date < CURDATE()
    AND ${alias}.task_status NOT IN ('Terminado', 'Cancelado')
    AND DAYOFWEEK(${alias}.estimated_delivery_date) BETWEEN 2 AND 6
    AND NOT EXISTS (
      SELECT 1 FROM mp_holidays h WHERE h.holiday_date = ${alias}.estimated_delivery_date
    )
  `;
}

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${whereOverdue('t')}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { total: rows[0]?.total || 0 };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, e.canonical_name AS assigned_to,
            t.estimated_delivery_date, t.task_status, t.observations,
            DATEDIFF(CURDATE(), t.estimated_delivery_date) AS days_overdue
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND ${whereOverdue('t')}
      ORDER BY days_overdue DESC, t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
