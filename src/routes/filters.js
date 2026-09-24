'use strict';

const express = require('express');
const {
  getAvailableMonths,
  getAvailableWeeks,
  getAvailableProjects,
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

    // Si el CEO/admin filtra por lider, resolvemos el scope intersectando con los proyectos
    // de ese lider para que los demas dropdowns se cascadeen correctamente.
    const effectiveScope = leaderEmail ? await resolveScope(req.scope, leaderEmail) : req.scope;

    const [months, projects, employees, leaders, snapshot] = await Promise.all([
      getAvailableMonths(req.scope),
      getAvailableProjects(effectiveScope, monthName),
      getAvailableEmployees(effectiveScope, monthName, projectFolder),
      getAvailableLeaders(req.scope),
      getCurrentSnapshot(monthName),
    ]);

    // Siempre pedimos semanas: cuando monthName es null, getAvailableWeeks
    // hace fallback al mes más reciente para que el dropdown llegue poblado.
    const weeks = await getAvailableWeeks(effectiveScope, monthName);

    res.json({
      snapshot,
      months,
      weeks,
      projects,
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
