'use strict';

const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');

function parseFilters(q) {
  return {
    month: q.month ? String(q.month) : null,
    week: q.week ? Number(q.week) : null,
    project: q.project ? String(q.project) : null,
    employee_id: q.employee_id ? Number(q.employee_id) : null,
    leader: q.leader ? String(q.leader) : null,
  };
}

// Filtros de los drilldown, que además de los globales aceptan dos claves
// propias de un indicador concreto (hallazgo QA-07, corregido 2 sep 2026):
//
//   status -> indicador 5, para "ver solo las tareas bloqueadas".
//   tipo   -> indicador 13, para "ver solo los imprevistos internos".
//
// Antes la ruta hacía `parseFilters({ ...req.query, status: req.query.status })`,
// que PARECE preservarlas pero no: parseFilters tiene una lista fija de
// salida y descarta cualquier otra clave. El efecto para el usuario era
// silencioso y engañoso — hacía clic en "solo bloqueadas" y recibía la
// lista COMPLETA sin filtrar, sin ningún aviso de que el filtro no se
// aplicó (podía leer 40 tareas bloqueadas donde en realidad había 3).
//
// Van aquí y no en parseFilters() a propósito: fuera del drilldown estas
// dos claves no significan nada —peor, en Costeo `status` es el estado del
// centro de costos, que es otra cosa— así que arrastrarlas por todos los
// endpoints solo invitaría a confundirlas.
function parseDrilldownFilters(q) {
  return {
    ...parseFilters(q),
    status: q.status ? String(q.status) : null,
    tipo: q.tipo ? String(q.tipo) : null,
  };
}

// Aplica al scope un filtro adicional de lider seleccionado por el CEO (intersecta proyectos).
async function resolveScope(scope, leaderEmail) {
  if (!leaderEmail) return scope;
  const rows = await query(
    'SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active = 1',
    [leaderEmail]
  );
  const leaderProjects = rows.map((r) => r.project_folder);
  let allowed;
  if (scope.allowedProjects === null) {
    allowed = leaderProjects;
  } else {
    allowed = scope.allowedProjects.filter((p) => leaderProjects.includes(p));
  }
  return { role: scope.role, allowedProjects: allowed };
}

// El filtro "Proyecto" es un PROYECTO DE SISTEMA DE COSTOS (mp_centro_costo),
// no la carpeta de SharePoint (6 nov 2026, a pedido explícito: "deberían
// aparecer los que están en Sistema de Costos"). Antes filtraba por
// t.project_folder, que es el EQUIPO de la persona ("Transversales",
// "Management"…), y la lista mostraba esas carpetas.
//
// Una fila pertenece al proyecto si su columna "Proyecto" del Excel
// (t.project_name) es el nombre del centro o su carpeta, tal cual o
// ignorando lo que va entre paréntesis: "Notificaciones (Transversales)" es
// del centro "Notificaciones". Es la misma regla de WF-COSTEO
// (docs/n8n/wf-costeo/03-resolver-y-filtrar.js, centroParaProyecto), así un
// proyecto suma las mismas filas en Planeación y en Costeo. La collation
// utf8mb4_general_ci ya ignora mayúsculas y tildes ("Digno" = "DIGNO").
//
// Lleva UN placeholder: el project_name del centro elegido.
function centroProyectoClause(alias = 't') {
  return `EXISTS (SELECT 1 FROM mp_centro_costo cc_filtro
             WHERE cc_filtro.project_name = ?
               AND (${alias}.project_name IN (cc_filtro.project_name, cc_filtro.project_folder)
                    OR TRIM(SUBSTRING_INDEX(${alias}.project_name, '(', 1))
                       IN (cc_filtro.project_name, cc_filtro.project_folder)))`;
}

// Construye las clausulas adicionales (week/project/employee) en WHERE y devuelve params.
function buildFilterClause(filters, alias = 't') {
  const clauses = [];
  const params = [];
  if (filters.week) { clauses.push(`${alias}.week_number = ?`); params.push(filters.week); }
  if (filters.project) { clauses.push(centroProyectoClause(alias)); params.push(filters.project); }
  if (filters.employee_id) { clauses.push(`${alias}.employee_id = ?`); params.push(filters.employee_id); }
  return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

// WHERE base de la mayoria de queries del dashboard.
// Soporta historico: cuando filtras un mes, usamos el ultimo snapshot que
// tenga datos de ese mes (no el snapshot global). Esto permite ver meses
// anteriores aunque el WF mas reciente solo haya cargado el mes actual.
function baseWhere(filters, alias = 't') {
  if (filters.month) {
    return {
      clause: `${alias}.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name = ?) AND ${alias}.month_name = ?`,
      params: [filters.month, filters.month],
    };
  }
  return {
    clause: `${alias}.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)`,
    params: [],
  };
}

// Cláusula para excluir tareas canceladas del cálculo de indicadores.
// Las canceladas se conservan en mp_task_facts (para preservar historial y drilldown),
// pero no cuentan como presupuesto ni ejecutado porque nunca se van a completar.
function notCancelledClause(alias = 't') {
  return `(${alias}.task_status IS NULL OR LOWER(TRIM(${alias}.task_status)) <> 'cancelado')`;
}

module.exports = {
  parseFilters, parseDrilldownFilters, resolveScope,
  buildFilterClause, centroProyectoClause, baseWhere, notCancelledClause,
};
