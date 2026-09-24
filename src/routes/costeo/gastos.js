'use strict';

/**
 * Costo No Planeado (3.5) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { projectScopeClause } = require('../../middleware/scope');
const { query } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit, describirCambios, formatMoneda } = require('../../queries/costo-audit');
const { EXPENSE_CATEGORIES, canWriteCenter } = require('./_shared');

const router = express.Router();

// Cuántas partidas de Costo No Planeado tiene HOY un centro — se llama antes
// Y después de crear/eliminar una, para dejar en el historial "Gastos: 2 →
// 3 partidas" (7 sep 2026, a pedido explícito del dueño de la empresa: antes
// del/después de cada cambio, no solo "se agregó un gasto"). Cuenta todas
// las partidas sin filtrar por approval_status: lo que el dueño quiere ver
// es cuántas se registraron, no solo las aprobadas.
async function contarGastos(costCenterId) {
  const [{ n }] = await query(
    'SELECT COUNT(*) AS n FROM mp_costo_no_planeado WHERE cost_center_id = ?',
    [costCenterId]
  );
  return n;
}

// Validación compartida entre POST y PUT (4 sep 2026). Antes cada verbo
// tenía la suya y habían divergido: el POST exigía descripción no vacía y
// monto > 0, pero el PUT no repetía ninguna de las dos condiciones, así que
// un `PUT {amount: -500000}` se guardaba tal cual.
//
// Un gasto negativo no es un dato raro que se note: RESTA del presupuesto
// ejecutado (costoNoPlaneadoTotal lo suma sin filtrar el signo) y con eso
// ensucia en silencio el indicador #1, el ritmo de gasto (#5) y la alerta
// "Presupuesto casi agotado" — sin que quede ninguna marca de que la fila
// es inválida. Vive acá arriba, en un solo lugar, para que las dos rutas no
// puedan volver a separarse.

// Texto limpio, o null si no sirve como descripción.
function normalizarDescripcion(valor) {
  const texto = String(valor ?? '').trim();
  return texto || null;
}

// Monto como número, o null si no es dinero válido. Rechaza NaN, Infinity,
// 0 y negativos — el mismo criterio que ya tenía el POST.
function normalizarMonto(valor) {
  const monto = Number(valor);
  return Number.isFinite(monto) && monto > 0 ? monto : null;
}

const ERROR_DESCRIPCION = 'description no puede quedar vacía';
const ERROR_MONTO = 'amount debe ser un número mayor que 0';

// ---------------------------------------------------------------
// Costo No Planeado (3.5) — leader crea, edita y elimina en sus propios
// centros (canWriteCenter); admin/ceo sin restricción.
//
// Aprobación (sql/28, 28 ago 2026): lo que registra el PM es una
// SOLICITUD. Nace 'pendiente' y solo suma al presupuesto ejecutado
// cuando admin/ceo la aprueba (la guarda del dinero está en
// costoNoPlaneadoTotal, no aquí). Rechazada, nunca cuenta.
// ---------------------------------------------------------------

router.get('/gastos', async (req, res, next) => {
  try {
    const costCenterId = req.query.cost_center_id ? Number(req.query.cost_center_id) : null;
    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');
    const rows = await query(
      `SELECT g.expense_id, g.cost_center_id, g.description, g.amount, g.expense_date, g.category,
              g.approval_status, g.approved_at, g.rejection_note,
              cc.project_name, cc.project_folder,
              u.full_name AS approved_by_name
         FROM mp_costo_no_planeado g
         JOIN mp_centro_costo cc ON cc.cost_center_id = g.cost_center_id
         LEFT JOIN mp_dashboard_users u ON u.user_id = g.approved_by
        WHERE 1=1 ${scopeF.clause}
          ${costCenterId ? 'AND g.cost_center_id = ?' : ''}
        ORDER BY g.expense_date DESC`,
      costCenterId ? [...scopeF.params, costCenterId] : scopeF.params
    );
    res.json({ gastos: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/gastos', async (req, res, next) => {
  try {
    const cost_center_id = Number(req.body.cost_center_id);
    const description = normalizarDescripcion(req.body.description);
    const amount = normalizarMonto(req.body.amount);
    const expense_date = req.body.expense_date ? String(req.body.expense_date) : null;
    const category = EXPENSE_CATEGORIES.includes(req.body.category) ? req.body.category : 'otro';

    if (!cost_center_id || !description || amount === null || !expense_date) {
      return res.status(400).json({ error: 'cost_center_id, description, amount (> 0) y expense_date son obligatorios' });
    }
    if (!(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para registrar gastos en ese centro de costos' });
    }

    const antesCount = await contarGastos(cost_center_id);
    const result = await query(
      // approval_status explícito aunque el DEFAULT de sql/28 ya sea
      // 'pendiente': que se lea aquí evita que un cambio de DEFAULT
      // convierta en silencio una solicitud en dinero aprobado.
      `INSERT INTO mp_costo_no_planeado (cost_center_id, description, amount, expense_date, category, created_by, approval_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`,
      [cost_center_id, description, amount, expense_date, category, req.session.user.user_id || null]
    );
    await logAudit({
      costCenterId: cost_center_id, entityType: 'gasto', entityId: result.insertId, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Solicitó gasto "${description}" por ${formatMoneda(amount)} (${category}) — pendiente de aprobación · Gastos: ${antesCount} → ${antesCount + 1} partidas`,
    });
    res.status(201).json({ expense_id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// El PM también puede editar los gastos no planeados de su(s) proyecto(s).
router.put('/gastos/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const actual = await query('SELECT * FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
    if (!actual.length) return res.status(404).json({ error: 'Gasto no encontrado' });
    if (!(await canWriteCenter(req.scope, actual[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }
    // Una vez que admin/ceo resolvió la solicitud, el PM ya no la puede
    // tocar: si pudiera, cambiaría el monto DESPUÉS de aprobado y se
    // saltaría la aprobación sin dejar rastro. Quien aprueba (admin/ceo)
    // sí puede corregir, y eso queda en el historial de auditoría.
    const esAprobador = ['admin', 'ceo'].includes(req.session.user.role);
    if (!esAprobador && actual[0].approval_status !== 'pendiente') {
      return res.status(409).json({
        error: `Este gasto ya fue ${actual[0].approval_status === 'aprobado' ? 'aprobado' : 'rechazado'}; no se puede editar. Registra uno nuevo si hace falta corregirlo.`,
      });
    }

    const fields = [];
    const params = [];
    if (req.body.description !== undefined) {
      const description = normalizarDescripcion(req.body.description);
      if (description === null) return res.status(400).json({ error: ERROR_DESCRIPCION });
      fields.push('description = ?'); params.push(description);
    }
    if (req.body.amount !== undefined) {
      const amount = normalizarMonto(req.body.amount);
      if (amount === null) return res.status(400).json({ error: ERROR_MONTO });
      fields.push('amount = ?'); params.push(amount);
    }
    if (req.body.category !== undefined) {
      if (!EXPENSE_CATEGORIES.includes(req.body.category)) return res.status(400).json({ error: 'category inválida' });
      fields.push('category = ?'); params.push(req.body.category);
    }
    if (!fields.length) return res.json({ updated: 0 });

    params.push(id);
    const result = await query(`UPDATE mp_costo_no_planeado SET ${fields.join(', ')} WHERE expense_id = ?`, params);
    if (result.affectedRows) {
      const desc = describirCambios(actual[0], req.body, {
        description: 'Descripción', amount: 'Monto', category: 'Categoría',
      }, { amount: formatMoneda });
      await logAudit({
        costCenterId: actual[0].cost_center_id, entityType: 'gasto', entityId: id, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: desc,
      });
    }
    res.json({ updated: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

// Aprobación / rechazo del gasto no planeado (sql/28) — solo admin/ceo, y
// solo desde 'pendiente': una solicitud ya resuelta no se vuelve a
// resolver (mismo criterio que las horas extra). El UPDATE lleva la guarda
// de estado adentro, así que dos clics simultáneos no pueden aprobar dos
// veces ni pisar un rechazo con una aprobación.
router.post('/gastos/:id/aprobacion', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const approved = !!req.body.approved;
    const note = req.body.note ? String(req.body.note).trim().slice(0, 255) : null;
    if (!approved && !note) {
      return res.status(400).json({ error: 'Al rechazar un gasto es obligatorio explicar el motivo.' });
    }

    const rows = await query(
      'SELECT cost_center_id, description, amount, approval_status FROM mp_costo_no_planeado WHERE expense_id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Gasto no encontrado' });

    const estado = approved ? 'aprobado' : 'rechazado';
    const result = await query(
      `UPDATE mp_costo_no_planeado
          SET approval_status = ?, approved_by = ?, approved_at = NOW(), rejection_note = ?
        WHERE expense_id = ? AND approval_status = 'pendiente'`,
      [estado, req.session.user.user_id || null, approved ? null : note, id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ error: 'Este gasto ya fue aprobado o rechazado antes; no se puede volver a resolver.' });
    }

    await logAudit({
      costCenterId: rows[0].cost_center_id, entityType: 'gasto', entityId: id,
      action: approved ? 'aprobar' : 'rechazar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${approved ? 'Aprobó' : 'Rechazó'} el gasto "${rows[0].description}" por ${formatMoneda(rows[0].amount)}${!approved && note ? ` (${note})` : ''}`,
    });
    res.json({ approval_status: estado });
  } catch (err) {
    next(err);
  }
});

router.delete('/gastos/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    // Mismo control de scope que el resto de endpoints de escritura del
    // módulo (equipo, centros, gastos POST/PUT) — hoy admin/ceo bypassean
    // scope de todas formas, pero se deja consistente con el patrón general.
    const rows = await query('SELECT cost_center_id, description, amount, approval_status FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Gasto no encontrado' });
    if (!(await canWriteCenter(req.scope, rows[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }
    // Mismo criterio que el PUT: borrar un gasto ya aprobado le quitaría
    // dinero al ejecutado sin pasar por quien lo aprobó.
    if (!['admin', 'ceo'].includes(req.session.user.role) && rows[0].approval_status !== 'pendiente') {
      return res.status(409).json({
        error: `Este gasto ya fue ${rows[0].approval_status === 'aprobado' ? 'aprobado' : 'rechazado'}; solo el Administrador o el CEO pueden eliminarlo.`,
      });
    }
    const antesCount = await contarGastos(rows[0].cost_center_id);
    const result = await query('DELETE FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
    if (result.affectedRows) {
      await logAudit({
        costCenterId: rows[0].cost_center_id, entityType: 'gasto', entityId: id, action: 'eliminar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Eliminó gasto "${rows[0].description}" por ${formatMoneda(rows[0].amount)} · Gastos: ${antesCount} → ${antesCount - 1} partidas`,
      });
    }
    res.json({ deleted: !!result.affectedRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
