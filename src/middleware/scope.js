'use strict';

const { query } = require('../db');

// Resuelve el alcance (proyectos visibles) del usuario logueado.
// CEO/admin -> allowedProjects = null (sin filtro, ve todo).
// Leader    -> allowedProjects = [project_folder, ...] segun mp_project_owners.
async function attachScope(req, res, next) {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: 'No autenticado' });

    if (user.role === 'ceo' || user.role === 'admin') {
      req.scope = { role: user.role, allowedProjects: null };
      return next();
    }

    const rows = await query(
      'SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active = 1',
      [user.email]
    );
    const projects = rows.map((r) => r.project_folder);
    req.scope = { role: user.role, allowedProjects: projects };

    if (projects.length === 0) {
      // Lider sin proyectos asignados: permitimos seguir, pero las queries devolveran vacio
      console.warn(`[scope] usuario ${user.email} sin proyectos asignados en mp_project_owners`);
    }
    next();
  } catch (err) {
    next(err);
  }
}

// project_folder, o alias.columna (t.project_folder, cc.project_folder).
// columnAlias hoy solo recibe literales hardcoded en el código, nunca input
// del usuario -- esta validacion es para que eso siga siendo cierto si
// alguien lo cambia sin darse cuenta: columnAlias se interpola directo en
// el SQL (no puede ir como placeholder, MySQL no parametriza nombres de
// columna), asi que una cadena con espacios/comillas/`;` ahi seria
// inyeccion SQL.
const COLUMN_ALIAS_VALIDO = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

// Helper para inyectar el filtro de proyectos en una clausula WHERE.
// Devuelve { clause, params } listo para concatenar a SQL.
// Si allowedProjects === null -> no filtra (CEO/admin).
function projectScopeClause(scope, columnAlias = 'project_folder') {
  if (!COLUMN_ALIAS_VALIDO.test(columnAlias)) {
    throw new Error(`projectScopeClause: columnAlias invalido: ${columnAlias}`);
  }
  if (!scope || scope.allowedProjects === null) {
    return { clause: '', params: [] };
  }
  if (scope.allowedProjects.length === 0) {
    return { clause: ` AND 1=0 `, params: [] };
  }
  const placeholders = scope.allowedProjects.map(() => '?').join(',');
  return {
    clause: ` AND ${columnAlias} IN (${placeholders}) `,
    params: scope.allowedProjects.slice(),
  };
}

module.exports = { attachScope, projectScopeClause };
