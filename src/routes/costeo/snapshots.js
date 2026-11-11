'use strict';

/**
 * Snapshots historicos (5.1) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { requireRole } = require('../../middleware/auth');
const { computeIndicadores17, computeIndicadoresPortafolio } = require('../../queries/costo-indicadores-17');
const { createSnapshot, listSnapshots, getSnapshot, deleteSnapshot } = require('../../queries/costo-snapshot');
const { logAudit } = require('../../queries/costo-audit');
const { getCentrosVisibles } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------

router.post('/snapshot', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const centroId = req.body.centro ? Number(req.body.centro) : null;
    const centros = await getCentrosVisibles(req.scope);

    let costCenterId = null;
    let projectName;
    let ind17;

    if (centroId) {
      const centro = centros.find((c) => c.cost_center_id === centroId);
      if (!centro) return res.status(404).json({ error: 'Centro de costos no encontrado' });
      costCenterId = centro.cost_center_id;
      projectName = centro.project_name;
      ind17 = await computeIndicadores17(centro);
    } else {
      const activos = centros.filter((c) => c.status !== 'inactivo');
      ind17 = await computeIndicadoresPortafolio(activos);
      if (!ind17) return res.status(404).json({ error: 'No hay centros activos para el portafolio' });
      projectName = 'Todos los proyectos (portafolio)';
    }

    const snapshotId = await createSnapshot({
      costCenterId,
      projectName,
      ind17,
      userId: req.session.user.user_id || null,
    });

    await logAudit({
      costCenterId, entityType: 'snapshot', entityId: snapshotId, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Guardó un snapshot de "${projectName}"`,
    });

    res.status(201).json({ snapshot_id: snapshotId });
  } catch (err) {
    next(err);
  }
});

router.get('/snapshots', async (req, res, next) => {
  try {
    const centroId = req.query.centro ? Number(req.query.centro) : null;

    if (centroId) {
      const centros = await getCentrosVisibles(req.scope);
      if (!centros.find((c) => c.cost_center_id === centroId)) {
        return res.status(404).json({ error: 'Centro de costos no encontrado' });
      }
    } else if (req.scope.allowedProjects !== null) {
      // El portafolio ("Todos") solo tiene sentido para quien ve más de un
      // centro — mismo criterio que las alertas globales.
      return res.json({ snapshots: [] });
    }

    const snapshots = await listSnapshots(centroId);
    res.json({ snapshots });
  } catch (err) {
    next(err);
  }
});

router.get('/snapshots/:id', async (req, res, next) => {
  try {
    const snapshot = await getSnapshot(Number(req.params.id));
    if (!snapshot) return res.status(404).json({ error: 'Snapshot no encontrado' });

    if (snapshot.cost_center_id) {
      const centros = await getCentrosVisibles(req.scope);
      if (!centros.find((c) => c.cost_center_id === snapshot.cost_center_id)) {
        return res.status(404).json({ error: 'Snapshot no encontrado' });
      }
    } else if (req.scope.allowedProjects !== null) {
      return res.status(404).json({ error: 'Snapshot no encontrado' });
    }

    res.json({ snapshot });
  } catch (err) {
    next(err);
  }
});

router.delete('/snapshots/:id', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const snapshotId = Number(req.params.id);
    const snapshot = await getSnapshot(snapshotId);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot no encontrado' });

    if (snapshot.cost_center_id) {
      const centros = await getCentrosVisibles(req.scope);
      if (!centros.find((c) => c.cost_center_id === snapshot.cost_center_id)) {
        return res.status(404).json({ error: 'Snapshot no encontrado' });
      }
    } else if (req.scope.allowedProjects !== null) {
      return res.status(404).json({ error: 'Snapshot no encontrado' });
    }

    const deleted = await deleteSnapshot(snapshotId);
    if (!deleted) return res.status(404).json({ error: 'No se pudo eliminar el snapshot' });

    await logAudit({
      costCenterId: snapshot.cost_center_id, entityType: 'snapshot', entityId: snapshotId, action: 'eliminar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Eliminó el snapshot de "${snapshot.project_name}" del ${snapshot.snapshot_date}`,
    });

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
