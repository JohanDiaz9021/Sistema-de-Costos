'use strict';

/**
 * Indicador #18 — RECONOCIMIENTOS  [MENSUAL]
 *
 * Top performers del mes. Combina varias métricas en un score compuesto y
 * destaca los 3 mejores recursos. Adicionalmente otorga "badges" a quienes
 * cumplen criterios específicos (cumplimiento perfecto, cero bloqueadas, etc).
 *
 * Score por recurso (rango 0-100):
 *    + min(compliance_pct, 100) * 0.45
 *    + on_time_pct (0-100)      * 0.30
 *    − blocked_tasks * 8         (penaliza fuerte)
 *    − modified_dates * 4        (penaliza moderado)
 *    + bonus por cero permisos+entregar todo +5
 *
 * Requisitos para entrar al ranking:
 *    - Al menos 3 tareas en el mes (evita "ganadores" con 1 tarea perfecta).
 *    - Empleado activo.
 *
 * Badges otorgados independiente del ranking:
 *    🎯 perfect_compliance        compliance_pct >= 100
 *    ⚡ zero_blocked              blocked_tasks = 0
 *    📅 stable_dates              modified_dates = 0
 *    ✅ always_on_time            on_time_pct = 100 (con al menos 1 entregada)
 *    🚀 high_volume               total_tasks >= P75 del mes
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');
const { notPermisoClause } = require('./_permiso');

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  // 1) Métricas base por recurso, ya excluyendo permisos del cumplimiento.
  const baseRows = await query(
    `SELECT e.employee_id, e.canonical_name, e.contract_type,
            COUNT(*) AS total_tasks,
            SUM(CASE WHEN t.task_status = 'Terminado' THEN 1 ELSE 0 END) AS completed_tasks,
            SUM(CASE WHEN t.task_status = 'Bloqueado' THEN 1 ELSE 0 END) AS blocked_tasks,
            SUM(CASE WHEN t.task_status = 'Terminado'
                          AND t.actual_delivery_date IS NOT NULL
                          AND t.actual_delivery_date <= t.estimated_delivery_date
                     THEN 1 ELSE 0 END) AS on_time_count,
            SUM(CASE WHEN ${notPermisoClause('t.activity')}
                     THEN COALESCE(t.budgeted_hours, 0) ELSE 0 END)       AS budgeted,
            SUM(CASE WHEN ${notPermisoClause('t.activity')}
                     THEN COALESCE(t.total_executed_hours, 0) ELSE 0 END) AS executed
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND ${notCancelledClause('t')}
      GROUP BY e.employee_id, e.canonical_name, e.contract_type`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  // 2) Cuántas fechas estimadas movió cada uno (reusa la lógica del #17).
  const mvFilters = { ...filters };
  const mvWhere = ['t.activity IS NOT NULL'];
  const mvParams = [];
  if (mvFilters.month)   { mvWhere.push('t.month_name = ?'); mvParams.push(mvFilters.month); }
  if (mvFilters.week)    { mvWhere.push('t.week_number = ?'); mvParams.push(mvFilters.week); }
  if (mvFilters.project) { mvWhere.push('t.project_folder = ?'); mvParams.push(mvFilters.project); }

  const movedRows = await query(
    `SELECT employee_id, COUNT(*) AS modified_dates
       FROM (
         SELECT t.employee_id,
                COUNT(DISTINCT t.estimated_delivery_date) AS dd
           FROM mp_task_facts t
          WHERE ${mvWhere.join(' AND ')}
          GROUP BY t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
         HAVING dd > 1
       ) m
      GROUP BY employee_id`,
    mvParams
  );
  const movedMap = new Map(movedRows.map((r) => [r.employee_id, Number(r.modified_dates) || 0]));

  // 3) Calcular volumen P75 para badge high_volume
  const taskCounts = baseRows.map((r) => Number(r.total_tasks)).sort((a, b) => a - b);
  const p75 = taskCounts.length
    ? taskCounts[Math.floor(taskCounts.length * 0.75)]
    : 0;

  // 4) Ensamblar y rankear
  const candidates = baseRows
    .map((r) => {
      const total = Number(r.total_tasks) || 0;
      const completed = Number(r.completed_tasks) || 0;
      const blocked = Number(r.blocked_tasks) || 0;
      const onTime = Number(r.on_time_count) || 0;
      const budgeted = Number(r.budgeted) || 0;
      const executed = Number(r.executed) || 0;
      const modified = movedMap.get(r.employee_id) || 0;

      const compliance = budgeted > 0 ? (executed / budgeted) * 100 : 0;
      const onTimePct = completed > 0 ? (onTime / completed) * 100 : 0;

      let score =
        Math.min(compliance, 100) * 0.45 +
        onTimePct * 0.30 +
        (blocked * -8) +
        (modified * -4);

      const badges = [];
      if (compliance >= 100) badges.push({ key: 'perfect_compliance', label: '🎯 100% cumplimiento' });
      if (blocked === 0)     badges.push({ key: 'zero_blocked',       label: '⚡ Cero bloqueadas' });
      if (modified === 0)    badges.push({ key: 'stable_dates',       label: '📅 Fechas estables' });
      if (completed > 0 && onTimePct === 100) badges.push({ key: 'always_on_time', label: '✅ 100% a tiempo' });
      if (p75 > 0 && total >= p75)            badges.push({ key: 'high_volume',    label: '🚀 Alto volumen' });
      if (badges.length >= 4) score += 5; // combo bonus

      return {
        employee_id: r.employee_id,
        canonical_name: r.canonical_name,
        contract_type: r.contract_type || 'planta',
        total_tasks: total,
        completed_tasks: completed,
        blocked_tasks: blocked,
        modified_dates: modified,
        compliance_pct: Number(compliance.toFixed(1)),
        on_time_pct: Number(onTimePct.toFixed(0)),
        score: Number(score.toFixed(1)),
        badges,
      };
    })
    .filter((c) => c.total_tasks >= 3);   // mínimo de tareas para evitar falsos positivos

  candidates.sort((a, b) => b.score - a.score);

  const podium = candidates.slice(0, 3).map((c, i) => ({ ...c, position: i + 1 }));

  // "Menciones honoríficas": no están en el podium pero tienen >=3 badges
  const mentions = candidates
    .slice(3)
    .filter((c) => c.badges.length >= 3)
    .slice(0, 8);

  return { podium, mentions, p75_tasks: p75, total_eligible: candidates.length };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  if (!filters.employee_id) return { rows: [] };

  const rows = await query(
    `SELECT t.week_number, t.project_folder, t.activity, t.task_status,
            t.budgeted_hours, t.total_executed_hours,
            t.estimated_delivery_date, t.actual_delivery_date,
            CASE WHEN t.budgeted_hours > 0
                 THEN ROUND(t.total_executed_hours / t.budgeted_hours * 100, 1)
                 ELSE NULL END AS compliance_pct
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
