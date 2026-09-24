'use strict';

/**
 * Indicador #9 — SEMAFORO DE GESTION  [DIARIO]
 * Tres niveles: global del mes, por recurso, por tarea.
 * Logica: blocked>0 -> ROJO. Si no, compliance>=100 -> VERDE; 80-99 -> AMARILLO; <80 -> ROJO.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');

function classify(compliancePct, blockedCount) {
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

  // Global
  const globalRows = await query(
    `SELECT
        SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted,
        SUM(COALESCE(t.total_executed_hours, 0)) AS executed,
        SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS blocked
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${notCancelledClause('t')}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const g = globalRows[0] || { budgeted: 0, executed: 0, blocked: 0 };
  const gBudgeted = Number(g.budgeted) || 0;
  const gExecuted = Number(g.executed) || 0;
  const gBlocked = Number(g.blocked) || 0;
  const gCompliance = gBudgeted > 0 ? (gExecuted / gBudgeted) * 100 : null;

  // Por recurso
  // 🔧 Filtro e.is_active = 1: solo empleados activos. Mantiene el TOP 6
  //    coherente con el indicador #8 y los demás (no incluye gente que se fue).
  const resRows = await query(
    `SELECT e.employee_id, e.canonical_name,
            SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted,
            SUM(COALESCE(t.total_executed_hours, 0)) AS executed,
            SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS blocked
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${notCancelledClause('t')}
      GROUP BY e.employee_id, e.canonical_name
      ORDER BY e.canonical_name`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const byResource = resRows.map((r) => {
    const b = Number(r.budgeted) || 0;
    const x = Number(r.executed) || 0;
    const bl = Number(r.blocked) || 0;
    const c = b > 0 ? (x / b) * 100 : null;
    return {
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      compliance_pct: c === null ? null : Number(c.toFixed(1)),
      blocked: bl,
      semaphore: classify(c, bl),
    };
  });

  // Resumen por tarea (conteos por semaforo)
  const taskRows = await query(
    `SELECT
        SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS red_blocked,
        SUM(CASE WHEN t.task_status <> 'Bloqueado'
                      AND t.budgeted_hours > 0
                      AND (t.total_executed_hours / t.budgeted_hours) >= 1
                 THEN 1 ELSE 0 END) AS green_tasks,
        SUM(CASE WHEN t.task_status <> 'Bloqueado'
                      AND t.budgeted_hours > 0
                      AND (t.total_executed_hours / t.budgeted_hours) >= 0.8
                      AND (t.total_executed_hours / t.budgeted_hours) < 1
                 THEN 1 ELSE 0 END) AS amber_tasks,
        SUM(CASE WHEN t.task_status <> 'Bloqueado'
                      AND t.budgeted_hours > 0
                      AND (t.total_executed_hours / t.budgeted_hours) < 0.8
                 THEN 1 ELSE 0 END) AS red_low_tasks,
        SUM(CASE WHEN t.budgeted_hours IS NULL OR t.budgeted_hours = 0 THEN 1 ELSE 0 END) AS grey_tasks,
        COUNT(*) AS total
       FROM mp_task_facts t
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND ${notCancelledClause('t')}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const tr = taskRows[0] || {};
  const byTask = {
    red:   (Number(tr.red_blocked) || 0) + (Number(tr.red_low_tasks) || 0),
    amber: Number(tr.amber_tasks) || 0,
    green: Number(tr.green_tasks) || 0,
    grey:  Number(tr.grey_tasks) || 0,
    total: Number(tr.total) || 0,
  };

  return {
    global: {
      compliance_pct: gCompliance === null ? null : Number(gCompliance.toFixed(1)),
      blocked: gBlocked,
      semaphore: classify(gCompliance, gBlocked),
    },
    byResource,
    byTask,
  };
}

async function drilldown(scope, filters) {
  // Reusa indicator-08 drilldown si llega con employee_id, si no, tablero por tarea.
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, e.canonical_name AS assigned_to, t.activity, t.task_status,
            t.budgeted_hours, t.total_executed_hours,
            CASE WHEN t.budgeted_hours > 0
                 THEN ROUND(t.total_executed_hours / t.budgeted_hours * 100, 1)
                 ELSE NULL END AS compliance_pct
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
      ORDER BY t.task_status, t.project_folder
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
