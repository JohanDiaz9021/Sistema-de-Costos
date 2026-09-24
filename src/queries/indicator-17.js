'use strict';

/**
 * Indicador #17 — AUDITORÍA DE CAMBIOS EN FECHA ESTIMADA  [DIARIO]
 *
 * Identifica tareas cuya `estimated_delivery_date` fue movida entre snapshots.
 * Las personas pueden "ganar" cumplimiento corriendo la fecha hacia adelante
 * justo antes de que venza. Este indicador lo expone.
 *
 * Identidad de tarea (natural key):
 *   (employee_id, week_number, project_folder, activity)
 *
 * Para cada identidad:
 *   - MIN(snapshot_date)     → primera vez vista     (estimada original)
 *   - MAX(snapshot_date)     → última vez vista      (estimada actual)
 *   - first_estimated_date   → fecha estimada en el primer snapshot
 *   - last_estimated_date    → fecha estimada en el último snapshot
 *   - changes_count          → COUNT(DISTINCT estimated_delivery_date)
 *
 * Una tarea cuenta como "modificada" si changes_count >= 2.
 * `days_moved` = last_estimated_date - first_estimated_date (positivo = se postergó).
 *
 * No usa baseWhere (que filtra al último snapshot); aquí necesitamos
 * ver toda la historia dentro del mes filtrado.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause } = require('./_common');

function buildMonthFilter(filters, alias = 't') {
  // Para este indicador queremos TODOS los snapshots del mes filtrado
  // (no solo el último).
  const clauses = [];
  const params = [];
  if (filters.month) { clauses.push(`${alias}.month_name = ?`); params.push(filters.month); }
  if (filters.week)  { clauses.push(`${alias}.week_number = ?`); params.push(filters.week); }
  if (filters.project) { clauses.push(`${alias}.project_folder = ?`); params.push(filters.project); }
  if (filters.employee_id) { clauses.push(`${alias}.employee_id = ?`); params.push(filters.employee_id); }
  return { clause: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const mw = buildMonthFilter(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');

  // 🔧 v3: reescrito con CTE + ROW_NUMBER() para evitar 4 subqueries
  // correlacionadas que explotaban en O(N²) — con ~200 tareas modificadas y
  // 15 snapshots el query tomaba >100s y disparaba HTTP 524 en Cloudflare.
  // Ahora es un solo escaneo con window functions. Complejidad O(N log N).
  //
  // Nota: los mismos filtros se aplican DOS veces (una en el CTE `ranked` y
  // otra en `changes`) porque `changes` no necesita el join a mp_employees
  // ni el scope, pero sí necesita el mismo universo de filas. El planificador
  // los deduplica.
  // NOTA: MariaDB no soporta COUNT(DISTINCT) OVER, así que el count va en un
  // CTE aparte (`changes`) con GROUP BY normal y HAVING para filtrar >1.
  // El resultado se une con `ranked` para tomar la primera y última fila de
  // cada partición.
  const sql = `
    WITH ranked AS (
      SELECT t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name,
             t.snapshot_date, t.estimated_delivery_date, t.task_status, t.observations,
             e.canonical_name, e.contract_type,
             ROW_NUMBER() OVER (
               PARTITION BY t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
               ORDER BY t.snapshot_date ASC
             ) AS rn_first,
             ROW_NUMBER() OVER (
               PARTITION BY t.employee_id, t.week_number, t.project_folder, t.activity, t.month_name
               ORDER BY t.snapshot_date DESC
             ) AS rn_last
        FROM mp_task_facts t
        JOIN mp_employees e ON e.employee_id = t.employee_id
       WHERE ${mw.clause}
         ${scopeF.clause}
         AND t.activity IS NOT NULL
         AND e.is_active = 1
    ),
    changes AS (
      SELECT employee_id, week_number, project_folder, activity, month_name,
             COUNT(DISTINCT estimated_delivery_date) AS changes_count
        FROM ranked
       GROUP BY employee_id, week_number, project_folder, activity, month_name
      HAVING COUNT(DISTINCT estimated_delivery_date) > 1
    )
    SELECT l.employee_id, l.canonical_name, l.contract_type,
           l.week_number, l.project_folder, l.activity,
           c.changes_count,
           f.snapshot_date AS first_snap,
           l.snapshot_date AS last_snap,
           f.estimated_delivery_date AS first_estimated_date,
           l.estimated_delivery_date AS last_estimated_date,
           l.task_status AS last_task_status,
           l.observations AS last_observations
      FROM changes c
      JOIN ranked l ON l.employee_id = c.employee_id
                   AND l.week_number = c.week_number
                   AND l.project_folder = c.project_folder
                   AND l.activity = c.activity
                   AND l.month_name = c.month_name
                   AND l.rn_last = 1
      JOIN ranked f ON f.employee_id = c.employee_id
                   AND f.week_number = c.week_number
                   AND f.project_folder = c.project_folder
                   AND f.activity = c.activity
                   AND f.month_name = c.month_name
                   AND f.rn_first = 1
     ORDER BY l.canonical_name`;

  const rows = await query(sql, [...mw.params, ...scopeF.params]);

  const tasks = rows.map((r) => {
    const first = r.first_estimated_date;
    const last = r.last_estimated_date;
    let daysMoved = 0;
    if (first && last) {
      daysMoved = Math.round((new Date(last) - new Date(first)) / 86400000);
    }
    return {
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      contract_type: r.contract_type || 'planta',
      week_number: r.week_number,
      project_folder: r.project_folder,
      activity: r.activity,
      task_status: r.last_task_status,
      first_estimated_date: first,
      last_estimated_date: last,
      days_moved: daysMoved,
      changes_count: Number(r.changes_count) || 0,
      observations: r.last_observations || null,
    };
  });

  // Ordenar por mayor desplazamiento absoluto primero (más relevante para auditoría).
  tasks.sort((a, b) => Math.abs(b.days_moved) - Math.abs(a.days_moved)
    || a.canonical_name.localeCompare(b.canonical_name));

  // Resumen agregado por recurso (para el header con KPIs grandes).
  const byEmployee = new Map();
  for (const t of tasks) {
    const k = t.employee_id;
    if (!byEmployee.has(k)) {
      byEmployee.set(k, {
        employee_id: t.employee_id,
        canonical_name: t.canonical_name,
        contract_type: t.contract_type,
        tasks_modified: 0,
        total_days_moved: 0,
        pushed_forward: 0,
        pulled_back: 0,
        max_single_move: 0,
      });
    }
    const agg = byEmployee.get(k);
    agg.tasks_modified++;
    agg.total_days_moved += t.days_moved;
    if (t.days_moved > 0) agg.pushed_forward++;
    if (t.days_moved < 0) agg.pulled_back++;
    if (Math.abs(t.days_moved) > Math.abs(agg.max_single_move)) {
      agg.max_single_move = t.days_moved;
    }
  }
  const employees = Array.from(byEmployee.values())
    .sort((a, b) => b.tasks_modified - a.tasks_modified || b.total_days_moved - a.total_days_moved);

  const totals = {
    employees_affected: employees.length,
    total_tasks_modified: tasks.length,
    total_days_pushed: tasks.reduce((s, t) => s + Math.max(t.days_moved, 0), 0),
  };

  return { tasks, employees, totals };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const mw = buildMonthFilter(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');

  // Para el detalle: historia de cada tarea modificada del recurso.
  const sql = `
    SELECT t.employee_id, e.canonical_name,
           t.week_number, t.project_folder, t.activity, t.task_status,
           MIN(t.snapshot_date) AS first_snap,
           MAX(t.snapshot_date) AS last_snap,
           COUNT(DISTINCT t.estimated_delivery_date) AS distinct_dates,
           MIN(t.estimated_delivery_date) AS earliest_date,
           MAX(t.estimated_delivery_date) AS latest_date,
           GROUP_CONCAT(DISTINCT t.estimated_delivery_date ORDER BY t.snapshot_date) AS history
      FROM mp_task_facts t
      JOIN mp_employees e ON e.employee_id = t.employee_id
     WHERE ${mw.clause}
       ${scopeF.clause}
       AND t.activity IS NOT NULL
       AND e.is_active = 1
     GROUP BY t.employee_id, e.canonical_name, t.week_number, t.project_folder, t.activity, t.task_status, t.month_name
     HAVING distinct_dates > 1
     ORDER BY e.canonical_name, t.week_number, t.project_folder
     LIMIT 500`;

  const rows = await query(sql, [...mw.params, ...scopeF.params]);
  return { rows };
}

module.exports = { aggregate, drilldown };
