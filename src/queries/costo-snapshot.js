'use strict';

/**
 * 5.1 — Snapshots históricos de los 17 indicadores. Un snapshot guarda el
 * JSON completo de computeIndicadores17()/computeIndicadoresPortafolio() tal
 * cual estaba en ese momento, para poder comparar "entonces vs. ahora" sin
 * que los números cambien cuando el motor recalcula.
 */

const { query } = require('../db');

async function createSnapshot({ costCenterId, projectName, ind17, userId }) {
  const result = await query(
    `INSERT INTO mp_costeo_snapshot (cost_center_id, project_name, snapshot_date, indicadores_json, created_by)
     VALUES (?, ?, CURDATE(), ?, ?)`,
    [costCenterId, projectName, JSON.stringify(ind17), userId]
  );
  return result.insertId;
}

// costCenterId null => snapshots del portafolio ("Todos los proyectos").
async function listSnapshots(costCenterId) {
  const clause = costCenterId ? 'cost_center_id = ?' : 'cost_center_id IS NULL';
  const params = costCenterId ? [costCenterId] : [];
  return query(
    `SELECT snapshot_id, project_name, snapshot_date, created_at
       FROM mp_costeo_snapshot
      WHERE ${clause}
      ORDER BY snapshot_date DESC, snapshot_id DESC
      LIMIT 12`,
    params
  );
}

async function getSnapshot(snapshotId) {
  const rows = await query('SELECT * FROM mp_costeo_snapshot WHERE snapshot_id = ?', [snapshotId]);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    snapshot_id: row.snapshot_id,
    cost_center_id: row.cost_center_id,
    project_name: row.project_name,
    snapshot_date: row.snapshot_date,
    created_at: row.created_at,
    ind17: typeof row.indicadores_json === 'string' ? JSON.parse(row.indicadores_json) : row.indicadores_json,
  };
}

async function deleteSnapshot(snapshotId) {
  const result = await query('DELETE FROM mp_costeo_snapshot WHERE snapshot_id = ?', [snapshotId]);
  return result.affectedRows > 0;
}

module.exports = { createSnapshot, listSnapshots, getSnapshot, deleteSnapshot };
