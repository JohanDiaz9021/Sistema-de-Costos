'use strict';

/**
 * Historial de acciones (Bloque 4) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { listAuditLog } = require('../../queries/costo-audit');

const router = express.Router();

// ---------------------------------------------------------------
// Historial de acciones (Bloque 4, ago 2026) — quién hizo qué y cuándo en
// Centro de Costos, Equipo del Proyecto, Gastos no planeados y Horas Extra.
// Abierto a cualquier sesión válida: el scope normal (costCenterScopeClause)
// ya limita a un PM a ver solo el historial de sus propios centros, igual
// que el resto del módulo — no hace falta requireRole aquí.
// ---------------------------------------------------------------

router.get('/historial', async (req, res, next) => {
  try {
    const entityType = req.query.tipo ? String(req.query.tipo) : null;
    // cost_center_id: lo manda la ventana "Historial de cambios" de cada
    // tarjeta de Costo Planeado. El scope de arriba sigue aplicando, así que
    // pedir el id de un centro ajeno no devuelve nada (no es una vía para
    // saltarse los permisos de un PM).
    const costCenterId = req.query.cost_center_id ? Number(req.query.cost_center_id) : null;
    const rows = await listAuditLog(req.scope, { entityType, costCenterId, limit: 200 });
    res.json({ historial: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
