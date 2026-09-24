'use strict';

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');

// Devuelve TODOS los meses con datos en cualquier snapshot historico.
// Para cada mes, se considera unicamente el snapshot mas reciente DE ESE MES
// (asi vemos historicos aunque el snapshot vigente solo tenga el mes en curso).
async function getAvailableMonths(scope) {
  const { clause, params } = projectScopeClause(scope, 't.project_folder');
  const rows = await query(
    `SELECT DISTINCT t.month_name, t.month_number, t.year_number
       FROM mp_task_facts t
       INNER JOIN (
         SELECT month_name, MAX(snapshot_date) AS max_snap
           FROM mp_task_facts
          GROUP BY month_name
       ) latest
         ON t.month_name = latest.month_name
        AND t.snapshot_date = latest.max_snap
      WHERE 1=1
        ${clause}
      ORDER BY t.year_number, t.month_number`,
    params
  );
  return rows;
}

async function getAvailableWeeks(scope, monthName) {
  // Si no llega el mes, hacemos fallback al mes más reciente con datos.
  // Esto permite que el dropdown ya venga poblado en la primera carga, sin
  // depender de que el frontend dispare un segundo fetch tras auto-seleccionar
  // el mes (era el bug que tenía vacío el dropdown SEMANA al login).
  if (!monthName) {
    const latest = await query(
      `SELECT month_name FROM mp_task_facts
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
        ORDER BY year_number DESC, month_number DESC
        LIMIT 1`,
      []
    );
    if (!latest.length) return [];
    monthName = latest[0].month_name;
  }
  const { clause, params } = projectScopeClause(scope, 'project_folder');
  const sql = `
    SELECT DISTINCT week_number
      FROM mp_task_facts
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name = ?)
       AND month_name = ?
       AND week_number IS NOT NULL
       ${clause}
     ORDER BY week_number`;
  const rows = await query(sql, [monthName, monthName, ...params]);
  return rows.map((r) => r.week_number);
}

async function getAvailableProjects(scope, monthName) {
  if (scope.allowedProjects && scope.allowedProjects.length === 0) return [];

  if (scope.allowedProjects === null) {
    const rows = monthName
      ? await query(
          `SELECT DISTINCT project_folder
             FROM mp_task_facts
            WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name = ?)
              AND month_name = ?
              AND project_folder IS NOT NULL
            ORDER BY project_folder`,
          [monthName, monthName]
        )
      : await query(
          `SELECT DISTINCT project_folder
             FROM mp_task_facts
            WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
              AND project_folder IS NOT NULL
            ORDER BY project_folder`,
          []
        );
    return rows.map((r) => r.project_folder);
  }

  if (!monthName) return scope.allowedProjects.slice();
  const placeholders = scope.allowedProjects.map(() => '?').join(',');
  const rows = await query(
    `SELECT DISTINCT project_folder
       FROM mp_task_facts
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name = ?)
        AND month_name = ?
        AND project_folder IN (${placeholders})
      ORDER BY project_folder`,
    [monthName, monthName, ...scope.allowedProjects]
  );
  return rows.map((r) => r.project_folder);
}

async function getAvailableEmployees(scope, monthName, projectFolder) {
  const { clause, params } = projectScopeClause(scope, 't.project_folder');
  const conditions = [];
  const args = [];
  if (monthName) {
    conditions.push('t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name = ?)');
    conditions.push('t.month_name = ?');
    args.push(monthName, monthName);
  } else {
    conditions.push('t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)');
  }
  if (projectFolder) {
    conditions.push('t.project_folder = ?');
    args.push(projectFolder);
  }
  const sql = `
    SELECT DISTINCT e.employee_id, e.canonical_name
      FROM mp_task_facts t
      JOIN mp_employees e ON t.employee_id = e.employee_id
     WHERE ${conditions.join(' AND ')}
       ${clause}
       AND e.is_active = 1
     ORDER BY e.canonical_name`;
  return query(sql, [...args, ...params]);
}

async function getAvailableLeaders(scope) {
  if (scope.role !== 'ceo' && scope.role !== 'admin') return [];
  const rows = await query(
    `SELECT DISTINCT pmo_canonical_name, pmo_email
       FROM mp_project_owners
      WHERE is_active = 1
      ORDER BY pmo_canonical_name`,
    []
  );
  return rows;
}

// Snapshot del mes seleccionado (no del global). Asi cuando ves Mayo,
// el pill arriba muestra cuando fue la ultima ingesta de ese mes.
async function getCurrentSnapshot(monthName) {
  const sql = monthName
    ? 'SELECT MAX(snapshot_date) AS snapshot FROM mp_task_facts WHERE month_name = ?'
    : 'SELECT MAX(snapshot_date) AS snapshot FROM mp_task_facts';
  const params = monthName ? [monthName] : [];
  const rows = await query(sql, params);
  return rows[0] && rows[0].snapshot ? rows[0].snapshot : null;
}

module.exports = {
  getAvailableMonths,
  getAvailableWeeks,
  getAvailableProjects,
  getAvailableEmployees,
  getAvailableLeaders,
  getCurrentSnapshot,
};
