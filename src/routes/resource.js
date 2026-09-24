'use strict';

const express = require('express');
const { query } = require('../db');
const { projectScopeClause } = require('../middleware/scope');

const router = express.Router();

// Skeleton: detalle de un recurso (todas sus tareas del mes seleccionado).
// Se enriquece con drilldowns en el Bloque 2.
router.get('/:employeeId(\\d+)', async (req, res, next) => {
  try {
    const employeeId = Number(req.params.employeeId);
    const monthName = req.query.month ? String(req.query.month) : null;
    if (!monthName) return res.status(400).json({ error: 'Falta el filtro month' });

    const { clause, params } = projectScopeClause(req.scope, 'project_folder');

    const rows = await query(
      `SELECT t.fact_id, t.project_folder, t.week_number, t.activity, t.planned_type,
              t.budgeted_hours, t.total_executed_hours, t.task_status,
              t.estimated_delivery_date, t.actual_delivery_date,
              t.assigned_to, t.observations
         FROM mp_task_facts t
        WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
          AND t.employee_id = ?
          AND t.month_name = ?
          ${clause}
        ORDER BY t.week_number, t.project_folder, t.fact_id`,
      [employeeId, monthName, ...params]
    );

    const employeeRows = await query(
      'SELECT employee_id, canonical_name, email FROM mp_employees WHERE employee_id = ? LIMIT 1',
      [employeeId]
    );

    res.json({
      employee: employeeRows[0] || null,
      tasks: rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
