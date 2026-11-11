'use strict';

const express = require('express');
const {
  getAvailableMonths,
  getAvailableWeeks,
  getAvailableProjects,
  getPlanningFolders,
  getAvailableEmployees,
  getAvailableLeaders,
  getCurrentSnapshot,
} = require('../queries/filters');
const { resolveScope } = require('../queries/_common');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const monthName = req.query.month ? String(req.query.month) : null;
    const projectFolder = req.query.project ? String(req.query.project) : null;
    const leaderEmail = req.query.leader ? String(req.query.leader) : null;

    // Si se filtra por lider (cualquier rol: en Planeacion req.scope ya llega
    // sin filtro de proyectos, ver scopePlaneacion), resolvemos el scope intersectando con los proyectos
    // de ese lider para que los demas dropdowns se cascadeen correctamente.
    const effectiveScope = leaderEmail ? await resolveScope(req.scope, leaderEmail) : req.scope;

    // ?carpetas=1 lo pide solo el formulario de "Nuevo centro" de Costeo,
    // para autocompletar la carpeta de SharePoint. El resto de pantallas no
    // lo necesita y se ahorra la consulta.
    const conCarpetas = req.query.carpetas === '1';

    const [months, projects, employees, leaders, snapshot, carpetas] = await Promise.all([
      getAvailableMonths(req.scope),
      getAvailableProjects(effectiveScope),
      getAvailableEmployees(effectiveScope, monthName, projectFolder),
      getAvailableLeaders(),
      getCurrentSnapshot(monthName),
      conCarpetas ? getPlanningFolders(effectiveScope, monthName) : null,
    ]);

    // Siempre pedimos semanas: cuando monthName es null, getAvailableWeeks
    // hace fallback al mes más reciente para que el dropdown llegue poblado.
    const weeks = await getAvailableWeeks(effectiveScope, monthName);

    res.json({
      snapshot,
      months,
      weeks,
      projects,
      ...(carpetas ? { carpetas } : {}),
      employees,
      leaders,
      scope: {
        role: req.scope.role,
        allowedProjects: effectiveScope.allowedProjects,
        // Lista original (sin filtro de lider) para que el frontend sepa el alcance natural.
        baseProjects: req.scope.allowedProjects,
      },
      user: req.session.user,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
