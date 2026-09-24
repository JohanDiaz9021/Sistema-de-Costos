'use strict';

/**
 * Indicador #7 — HORAS EJECUTADAS vs PRESUPUESTADAS  [DIARIO]
 * Por semana (default). Si filtra por una sola semana, agrupa por proyecto.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  // Si hay semana especifica seleccionada -> agrupar por proyecto. Si no -> por semana.
  const groupByProject = !!filters.week;
  const groupCol = groupByProject ? 't.project_folder' : 't.week_number';
  const labelAlias = groupByProject ? 'project' : 'week';

  const rows = await query(
    `SELECT ${groupCol} AS ${labelAlias},
            SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted,
            SUM(COALESCE(t.total_executed_hours, 0)) AS executed
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${groupCol} IS NOT NULL
        AND ${notCancelledClause('t')}
      GROUP BY ${groupCol}
      ORDER BY ${groupCol}`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  const series = rows.map((r) => ({
    label: groupByProject ? r.project : `Semana ${r.week}`,
    budgeted: Number(r.budgeted) || 0,
    executed: Number(r.executed) || 0,
  }));
  const totalBudgeted = series.reduce((a, x) => a + x.budgeted, 0);
  const totalExecuted = series.reduce((a, x) => a + x.executed, 0);
  const ratio = totalBudgeted > 0 ? (totalExecuted / totalBudgeted) * 100 : 0;

  // Lista compañera: ratio ejec/presup por proyecto (siempre, sin importar el agrupamiento principal).
  // Se muestra como mini-lista debajo del grafico principal para llenar el espacio
  // y ofrecer una segunda lectura util.
  const byProjectRows = await query(
    `SELECT t.project_folder                            AS project,
            SUM(COALESCE(t.budgeted_hours, 0))          AS budgeted,
            SUM(COALESCE(t.total_executed_hours, 0))    AS executed
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.project_folder IS NOT NULL
        AND ${notCancelledClause('t')}
      GROUP BY t.project_folder
      ORDER BY budgeted DESC
      LIMIT 10`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  const byProject = byProjectRows.map((r) => {
    const b = Number(r.budgeted) || 0;
    const x = Number(r.executed) || 0;
    return {
      project: r.project,
      budgeted: Number(b.toFixed(1)),
      executed: Number(x.toFixed(1)),
      ratio_pct: b > 0 ? Math.round((x / b) * 100) : 0,
    };
  });

  return {
    groupBy: groupByProject ? 'project' : 'week',
    series,
    totals: {
      budgeted: Number(totalBudgeted.toFixed(2)),
      executed: Number(totalExecuted.toFixed(2)),
      ratio_pct: Number(ratio.toFixed(1)),
    },
    byProject,
  };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.week_number, t.activity, e.canonical_name AS assigned_to,
            t.budgeted_hours, t.total_executed_hours, t.task_status
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
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
