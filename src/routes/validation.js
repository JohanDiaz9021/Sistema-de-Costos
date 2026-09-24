'use strict';

const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Endpoints exclusivos del CEO (9 sep 2026, a pedido explícito: el admin de
// Accesos gestiona PMs y proyectos, no la ingesta técnica del RPA). Antes
// eran de admin/ceo por igual — era la ÚNICA diferencia real entre esos dos
// roles en todo el sistema; el resto de rutas admin/ceo se mantiene sin
// tocar. Los líderes tampoco ven errores de ingestión.
//
// IMPORTANTE: el schema real de mp_validation_errors viene del WF1 de n8n.
// Sus columnas son:
//   error_id, snapshot_date, execution_id, employee_folder_name, employee_id,
//   project_folder, file_name, error_type (ENUM 30 valores), severity, error_message,
//   notified (tinyint), created_at
//
// Usamos `notified` como bandera de "reconocido" para no agregar columnas nuevas.

// GET /api/validation/errors?days=30&ack=0&type=...&severity=...&limit=200
router.get('/errors', requireRole('ceo'), async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const ack = req.query.ack === undefined ? null : Number(req.query.ack);
    const type = req.query.type ? String(req.query.type).trim() : null;
    const severity = req.query.severity ? String(req.query.severity).trim() : null;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));

    const where = ['e.created_at >= (NOW() - INTERVAL ? DAY)'];
    const params = [days];
    if (ack === 0 || ack === 1) { where.push('e.notified = ?'); params.push(ack); }
    if (type) { where.push('e.error_type = ?'); params.push(type); }
    if (severity) { where.push('e.severity = ?'); params.push(severity); }
    params.push(limit);

    // Incluimos los overrides (falsos positivos) para que el frontend pueda
    // mostrar tachados / filtrar / etc. Solo nos quedamos con el último override
    // activo por error_id.
    const rows = await query(
      `SELECT e.error_id, e.created_at AS detected_at, e.snapshot_date, e.execution_id,
              e.employee_folder_name, e.employee_id, e.project_folder, e.file_name,
              e.error_type, e.severity, e.error_message, e.week_number,
              e.notified AS acknowledged,
              emp.canonical_name AS employee_canonical,
              ov.override_id, ov.reverted_by_email, ov.reverted_at, ov.reason AS override_reason
         FROM mp_validation_errors e
         LEFT JOIN mp_employees emp ON emp.employee_id = e.employee_id
         LEFT JOIN mp_validation_overrides ov
                ON ov.error_id = e.error_id AND ov.active = 1
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT ?`,
      params
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

// GET /api/validation/errors/summary?days=7
router.get('/errors/summary', requireRole('ceo'), async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 7));
    const [byType, bySeverity, unack] = await Promise.all([
      query(
        `SELECT error_type, COUNT(*) AS n
           FROM mp_validation_errors
          WHERE created_at >= (NOW() - INTERVAL ? DAY)
          GROUP BY error_type
          ORDER BY n DESC
          LIMIT 20`, [days]
      ),
      query(
        `SELECT severity, COUNT(*) AS n
           FROM mp_validation_errors
          WHERE created_at >= (NOW() - INTERVAL ? DAY)
          GROUP BY severity`, [days]
      ),
      query(
        `SELECT COUNT(*) AS n
           FROM mp_validation_errors
          WHERE notified = 0
            AND created_at >= (NOW() - INTERVAL ? DAY)`, [days]
      ),
    ]);
    res.json({
      days,
      by_type: byType,
      by_severity: bySeverity,
      unacknowledged: unack[0] ? unack[0].n : 0,
    });
  } catch (err) { next(err); }
});

// POST /api/validation/errors/:id/ack — marca como reconocido (notified=1)
router.post('/errors/:id/ack', requireRole('ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const r = await query(
      `UPDATE mp_validation_errors SET notified = 1 WHERE error_id = ? AND notified = 0`,
      [id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Error no encontrado o ya reconocido' });
    res.json({ acknowledged: 1 });
  } catch (err) { next(err); }
});

// POST /api/validation/errors/:id/revert — marca un error como falso positivo.
// El registro original NO se borra; solo se inserta una fila en mp_validation_overrides.
// Si ya existe override activo, no inserta otro.
router.post('/errors/:id/revert', requireRole('ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
    const adminEmail = req.session.user.email;

    const [exists] = await query(
      `SELECT error_id FROM mp_validation_errors WHERE error_id = ?`, [id]
    );
    if (!exists) return res.status(404).json({ error: 'Error no encontrado' });

    const [activeOverride] = await query(
      `SELECT override_id FROM mp_validation_overrides WHERE error_id = ? AND active = 1`, [id]
    );
    if (activeOverride) return res.json({ already_reverted: true, override_id: activeOverride.override_id });

    const r = await query(
      `INSERT INTO mp_validation_overrides
        (error_id, reverted_by_email, reason, active)
       VALUES (?, ?, ?, 1)`,
      [id, adminEmail, reason]
    );
    res.json({ reverted: 1, override_id: r.insertId });
  } catch (err) { next(err); }
});

// POST /api/validation/errors/:id/unrevert — deshace la reversión.
// Marca el override activo como inactivo (active=0) y registra quién/cuándo.
router.post('/errors/:id/unrevert', requireRole('ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const adminEmail = req.session.user.email;

    const r = await query(
      `UPDATE mp_validation_overrides
          SET active = 0, undone_by_email = ?, undone_at = NOW()
        WHERE error_id = ? AND active = 1`,
      [adminEmail, id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'No había override activo para este error' });
    res.json({ unreverted: 1 });
  } catch (err) { next(err); }
});

// GET /api/validation/runs?days=14
router.get('/runs', requireRole('ceo'), async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
    const rows = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at,
              status, skip_reason, files_processed, files_rejected, rows_inserted,
              triggered_by
         FROM mp_ingestion_runs
        WHERE run_date >= (CURDATE() - INTERVAL ? DAY)
        ORDER BY run_date DESC, workflow_name`,
      [days]
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

module.exports = router;
