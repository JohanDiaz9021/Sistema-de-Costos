'use strict';

/**
 * Indicador #14 — CARGA DE TRABAJO POR RECURSO  [DIARIO]
 * Compara SUM(budgeted_hours) por recurso x semana contra la capacidad real
 * (44h/semana: lunes 8h, martes-viernes 9h, menos festivos).
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');
const { loadHolidaysSet, weekCapacity } = require('../capacity');

function monthNumberFromName(monthName) {
  if (!monthName) return null;
  const map = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
    'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12,
  };
  return map[String(monthName).trim().toLowerCase()] || null;
}

async function getMonthMeta(filters, scope) {
  // Pide (month_number, year_number) del snapshot vigente que coincida con el mes filtrado.
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const rows = await query(
    `SELECT t.month_number, t.year_number
       FROM mp_task_facts t
      WHERE ${where.clause}
        ${scopeF.clause}
      ORDER BY t.year_number DESC, t.month_number DESC
      LIMIT 1`,
    [...where.params, ...scopeF.params]
  );
  if (rows[0]) return { month_number: Number(rows[0].month_number), year_number: Number(rows[0].year_number) };
  // Fallback: deducir de nombre
  const m = monthNumberFromName(filters.month);
  return { month_number: m, year_number: new Date().getFullYear() };
}

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  // 🔧 v2: e.is_active = 1 para mantener mismo universo de recursos que el
  // indicador #16 "Actividad diaria por recurso". Antes #14 podía mostrar
  // empleados inactivos que tenían tareas históricas y eso confundía al
  // tester (#14 mostraba 8 vs #16 mostraba 19).
  const rows = await query(
    `SELECT e.employee_id, e.canonical_name, t.week_number,
            SUM(COALESCE(t.budgeted_hours, 0)) AS budgeted
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND t.week_number IS NOT NULL
        AND e.is_active = 1
        AND ${notCancelledClause('t')}
      GROUP BY e.employee_id, e.canonical_name, t.week_number
      ORDER BY e.canonical_name, t.week_number`,
    [...where.params, ...scopeF.params, ...flt.params]
  );

  if (rows.length === 0) {
    return { weeks: [], employees: [], matrix: [], capacities: {} };
  }

  const { month_number, year_number } = await getMonthMeta(filters, scope);
  const holidays = await loadHolidaysSet(year_number);

  const weeksSet = new Set();
  const employeesMap = new Map();
  for (const r of rows) {
    weeksSet.add(Number(r.week_number));
    if (!employeesMap.has(r.employee_id)) {
      employeesMap.set(r.employee_id, { employee_id: r.employee_id, canonical_name: r.canonical_name });
    }
  }
  const weeks = [...weeksSet].sort((a, b) => a - b);
  const employees = [...employeesMap.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));

  // matrix[empIndex][weekIndex] = { budgeted, capacity, overload }
  const matrix = employees.map((e) =>
    weeks.map((w) => ({ employee_id: e.employee_id, week: w, budgeted: 0, capacity: 0, overload: false }))
  );
  const empIndex = new Map(employees.map((e, i) => [e.employee_id, i]));
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));

  const capacities = {};
  for (const w of weeks) {
    capacities[w] = month_number ? weekCapacity(year_number, month_number, w, holidays) : 0;
  }

  for (const r of rows) {
    const ei = empIndex.get(r.employee_id);
    const wi = weekIndex.get(Number(r.week_number));
    if (ei === undefined || wi === undefined) continue;
    const budgeted = Number(r.budgeted) || 0;
    const capacity = capacities[Number(r.week_number)] || 0;
    matrix[ei][wi] = {
      employee_id: r.employee_id,
      week: Number(r.week_number),
      budgeted: Number(budgeted.toFixed(1)),
      capacity: Number(capacity.toFixed(1)),
      overload: budgeted > capacity && capacity > 0,
    };
  }

  return { weeks, employees, matrix, capacities, month_number, year_number };
}

async function drilldown(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');
  if (!filters.employee_id || !filters.week) return { rows: [] };

  const rows = await query(
    `SELECT t.fact_id, t.project_folder, t.activity, t.budgeted_hours,
            t.total_executed_hours, t.task_status
       FROM mp_task_facts t
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
      ORDER BY t.project_folder, t.activity
      LIMIT 500`,
    [...where.params, ...scopeF.params, ...flt.params]
  );
  return { rows };
}

module.exports = { aggregate, drilldown };
