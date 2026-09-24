'use strict';

/**
 * Indicador #10 — RECURSOS COMPARTIDOS ENTRE PROYECTOS  [DIARIO]
 *
 * 🔧 v2: usa t.project_name (lo que el usuario marca en cada tarea), NO
 * t.project_folder (que es siempre la carpeta de SharePoint del Excel).
 * Sin este fix daba siempre 1 (todas las tareas viven en una sola carpeta),
 * lo que llevaba al falso "Sin recursos compartidos".
 *
 * Se excluye "Management" del conteo porque es un meta-proyecto transversal
 * (dailies, planeación, reuniones) que casi todos tienen.
 *
 * El conteo de proyectos por empleado SIEMPRE considera TODOS los proyectos
 * del empleado en el snapshot vigente — ignora el scope del PMO y el filtro
 * de proyecto. Eso es lo que hace al indicador util: un lider puede ver que
 * un recurso "suyo" tambien esta repartido en otros proyectos.
 */

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');
const { resolveScope, buildFilterClause, baseWhere, notCancelledClause } = require('./_common');

// Solo excluimos "Management" (dailies, planeación semanal, reuniones cross-equipo).
// "Transversales" SÍ es un proyecto real (carpeta SharePoint con asignaciones legítimas),
// por eso se mantiene en el conteo.
const EXCLUDED_PROJECT_NAMES = ['management'];

async function aggregate(scope, filters) {
  scope = await resolveScope(scope, filters.leader);
  const where = baseWhere(filters, 't');
  const whereInner = baseWhere(filters, 't2');
  const scopeF = projectScopeClause(scope, 't.project_folder');
  const flt = buildFilterClause(filters, 't');

  const excludeClause = EXCLUDED_PROJECT_NAMES
    .map(() => '?')
    .join(',');
  const excludeFilter = `AND LOWER(TRIM(t2.project_name)) NOT IN (${excludeClause})`;

  const rows = await query(
    `SELECT e.employee_id, e.canonical_name,
            (SELECT COUNT(DISTINCT TRIM(t2.project_name))
               FROM mp_task_facts t2
              WHERE ${whereInner.clause}
                AND t2.employee_id = e.employee_id
                AND t2.project_name IS NOT NULL
                AND TRIM(t2.project_name) <> ''
                AND ${notCancelledClause('t2')}
                ${excludeFilter}) AS project_count,
            (SELECT GROUP_CONCAT(DISTINCT TRIM(t2.project_name) ORDER BY TRIM(t2.project_name) SEPARATOR ', ')
               FROM mp_task_facts t2
              WHERE ${whereInner.clause}
                AND t2.employee_id = e.employee_id
                AND t2.project_name IS NOT NULL
                AND TRIM(t2.project_name) <> ''
                AND ${notCancelledClause('t2')}
                ${excludeFilter}) AS projects_list,
            SUM(COALESCE(t.total_executed_hours, 0)) AS total_hours
       FROM mp_task_facts t
       JOIN mp_employees e ON t.employee_id = e.employee_id
      WHERE ${where.clause}
        ${scopeF.clause}
        ${flt.clause}
        AND e.is_active = 1
        AND t.project_name IS NOT NULL
        AND TRIM(t.project_name) <> ''
        AND ${notCancelledClause('t')}
      GROUP BY e.employee_id, e.canonical_name
      HAVING project_count > 1
      ORDER BY project_count DESC, total_hours DESC`,
    [
      ...whereInner.params, ...EXCLUDED_PROJECT_NAMES,
      ...whereInner.params, ...EXCLUDED_PROJECT_NAMES,
      ...where.params, ...scopeF.params, ...flt.params,
    ]
  );
  return {
    rows: rows.map((r) => ({
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      project_count: Number(r.project_count) || 0,
      projects_list: r.projects_list || '',
      total_hours: Number(Number(r.total_hours || 0).toFixed(1)),
    })),
  };
}

async function drilldown(scope, filters) {
  // Drilldown intencionalmente SIN scope ni filtro de proyecto: el sentido
  // del #10 es ver donde esta repartido el recurso, incluso en proyectos
  // fuera del scope del lider que abre el detalle.
  // 🔧 v2: por project_name (lo que el usuario marca en cada tarea), no por carpeta.
  const where = baseWhere(filters, 't');
  if (!filters.employee_id) return { rows: [] };

  const rows = await query(
    `SELECT TRIM(t.project_name) AS project_name,
            SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted,
            SUM(COALESCE(t.total_executed_hours, 0)) AS executed,
            COUNT(*) AS tasks
       FROM mp_task_facts t
      WHERE ${where.clause}
        AND t.employee_id = ?
        AND t.project_name IS NOT NULL
        AND TRIM(t.project_name) <> ''
      GROUP BY TRIM(t.project_name)
      ORDER BY executed DESC`,
    [...where.params, filters.employee_id]
  );
  return {
    rows: rows.map((r) => ({
      project_name: r.project_name,
      project_folder: r.project_name, // alias for frontend compat
      budgeted: Number(Number(r.budgeted).toFixed(1)),
      executed: Number(Number(r.executed).toFixed(1)),
      tasks: Number(r.tasks),
    })),
  };
}

module.exports = { aggregate, drilldown };
