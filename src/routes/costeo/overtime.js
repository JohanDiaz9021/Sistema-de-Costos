'use strict';

/**
 * Horas extra (3.1 + 3.2) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { parseFilters } = require('../../queries/_common');
const { query } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const {
  syncOvertimeDecisions, createManualOvertime, listOvertimeDecisions, decideOvertime, approveOvertime, parseFechaHora,
  editOvertimeHours, deleteOvertimeDecision,
} = require('../../queries/costo-overtime');
const { logAudit } = require('../../queries/costo-audit');
const { canWriteCenter } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------
// Horas extra (3.1 + 3.2) — decisión (líder/admin/ceo, limitada a los
// centros donde tenga permiso) + aprobación (solo admin/ceo).
//
// Una hora extra solo suma dinero al ejecutado cuando el líder decidió
// "sí, pagar" Y admin/ceo la aprobó. Las dos guardas viven dentro del
// UPDATE, en costo-overtime.js, no en un if de JavaScript.
// ---------------------------------------------------------------

// Detectar horas extra nuevas ESCRIBE en mp_overtime_decisions, asi que va
// en un POST y no colgado del GET. Antes el GET sincronizaba y despues
// listaba: cualquier cosa que hiciera un GET (un prefetch del navegador, un
// health check, alguien recargando) mutaba datos, que es justo lo que la
// semantica de HTTP promete que no pasa.
//
// El front YA NO la llama sola (2 sep 2026, a pedido explicito: la hora
// extra se registra unicamente a mano desde la plataforma, el Excel de
// Planeacion dejo de generarlas por su cuenta). La ruta se deja intacta y
// probada por si algun dia hace falta un disparador manual/admin.
router.post('/overtime/sync', async (req, res, next) => {
  try {
    const filters = parseFilters(req.query);
    const detectadas = await syncOvertimeDecisions(req.scope, filters);
    res.json({ ok: true, detectadas });
  } catch (err) {
    next(err);
  }
});

router.get('/overtime', async (req, res, next) => {
  try {
    const rows = await listOvertimeDecisions(req.scope);
    res.json({ overtime: rows });
  } catch (err) {
    next(err);
  }
});

// Alta manual (24 ago 2026, con inicio+fin exactos desde el 26 ago 2026;
// única vía desde el 2 sep 2026) — el PM registra cada hora extra a mano
// desde la plataforma. El Excel de Planeación sigue subiéndose igual, pero
// ya no genera horas extra por su cuenta (ver el comentario de
// /overtime/sync arriba).
//
// Se piden inicio y fin (el front arma 'YYYY-MM-DDTHH:MM' desde fecha +
// hora 00..23 + minutos, tras quitar el datetime-local por su spinner de
// horas 1..12, 17 sep 2026), no
// una cantidad de horas a mano: la cantidad y el recargo
// (diurna/nocturna/festiva) salen del turno real (ver costearTurno en
// costo-overtime.js), no de lo que alguien tipeó. Con inicio Y fin trayendo
// su propia fecha no hace falta adivinar si el turno cruza medianoche.
router.post('/overtime', async (req, res, next) => {
  try {
    const employee_id = Number(req.body.employee_id);
    const cost_center_id = Number(req.body.cost_center_id);
    const inicioDt = parseFechaHora(req.body.inicio);
    const finDt = parseFechaHora(req.body.fin);

    if (!employee_id || !cost_center_id || !inicioDt || !finDt) {
      return res.status(400).json({ error: 'employee_id, cost_center_id, inicio y fin (fecha y hora válidas) son obligatorios' });
    }
    if (finDt.getTime() <= inicioDt.getTime()) {
      return res.status(400).json({ error: 'El fin del turno debe ser posterior al inicio' });
    }
    if (!(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para registrar horas extra en ese centro de costos' });
    }

    const result = await createManualOvertime({
      employeeId: employee_id, costCenterId: cost_center_id,
      inicioDt, finDt, decidedByUserId: req.session.user.user_id || null,
    });
    if (result.error === 'no_asignado') {
      return res.status(400).json({ error: 'Ese talento no está asignado a ese centro de costos — asígnalo primero en Equipo del Proyecto.' });
    }
    if (result.error === 'sin_tarifa') {
      return res.status(400).json({ error: 'Ese talento está en el equipo pero no tiene costo/hora definido: la hora extra costaría $0. Asígnale una tarifa en Equipo del Proyecto y vuelve a intentarlo.' });
    }
    if (result.error === 'sin_horas') {
      return res.status(400).json({ error: 'El turno indicado no genera horas extra.' });
    }
    if (result.error === 'ya_existe') {
      return res.status(409).json({ error: 'Esa misma hora extra (misma persona, centro, día y horario) ya está registrada.' });
    }

    const empRows = await query('SELECT canonical_name FROM mp_employees WHERE employee_id = ?', [employee_id]);
    await logAudit({
      costCenterId: cost_center_id, entityType: 'overtime', entityId: result.decision_id, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${empRows[0]?.canonical_name || 'talento #' + employee_id} — ${req.body.inicio} a ${req.body.fin}: registró hora extra a mano (aprobada automáticamente)`,
    });
    res.status(201).json({ decision_id: result.decision_id });
  } catch (err) {
    next(err);
  }
});

// admin/ceo tambien pueden decidir, no solo el lider. Antes era
// requireRole('leader') a secas, y una hora extra de un proyecto sin PM
// asignado (o con el PM desactivado) quedaba trabada para siempre: nadie
// podia decidirla, y sin decision tampoco se puede aprobar. El alcance sigue
// controlado por canWriteCenter mas abajo.
router.post('/overtime/:id/decision', requireRole('leader', 'admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const decision = req.body.decision;
    const note = req.body.note ? String(req.body.note).trim() : null;
    const motivo = ['interno', 'externo'].includes(req.body.motivo) ? req.body.motivo : null;
    const calidad = !!req.body.calidad;
    if (!['si', 'no'].includes(decision)) return res.status(400).json({ error: "decision debe ser 'si' o 'no'" });
    if (decision === 'no' && !note) return res.status(400).json({ error: 'pm_decision_note es obligatorio cuando decision es "no"' });

    const rows = await query(
      `SELECT od.cost_center_id, od.employee_id, od.week_number, od.year_number, e.canonical_name
         FROM mp_overtime_decisions od
         JOIN mp_employees e ON e.employee_id = od.employee_id
        WHERE od.decision_id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (!(await canWriteCenter(req.scope, rows[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const result = await decideOvertime(id, decision, note, motivo, calidad, req.session.user.user_id || null);
    if (!result) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (result.error === 'ya_resuelto') {
      return res.status(409).json({ error: 'Esta hora extra ya fue resuelta antes; no se puede volver a decidir sobre ella.' });
    }
    const r = rows[0];
    // "Sí, pagar" ya deja la fila aprobada (auto-aprobación, 26 ago 2026) —
    // el texto del historial lo dice explícito para que quede claro en la
    // auditoría que no hubo un segundo paso de por medio.
    const descDecision = decision === 'si' ? 'pagar (aprobado automáticamente)' : 'no pagar';
    await logAudit({
      costCenterId: r.cost_center_id, entityType: 'overtime', entityId: id, action: 'decidir',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${r.canonical_name} — semana ${r.week_number}/${r.year_number}: decidió "${descDecision}"${note ? ` (${note})` : ''}`,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/overtime/:id/approve', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const approved = !!req.body.approved;
    const rows = await query(
      `SELECT od.cost_center_id, od.week_number, od.year_number, e.canonical_name
         FROM mp_overtime_decisions od
         JOIN mp_employees e ON e.employee_id = od.employee_id
        WHERE od.decision_id = ?`,
      [id]
    );
    const result = await approveOvertime(id, approved, req.session.user.user_id || null);
    if (!result) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (result.error === 'no_aprobable') {
      return res.status(409).json({ error: 'Solo se puede aprobar/rechazar una hora extra que el líder ya haya decidido pagar ("Sí, pagar") y que no esté resuelta todavía.' });
    }
    if (rows.length) {
      const r = rows[0];
      await logAudit({
        costCenterId: r.cost_center_id, entityType: 'overtime', entityId: id, action: approved ? 'aprobar' : 'rechazar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `${r.canonical_name} — semana ${r.week_number}/${r.year_number}: ${approved ? 'aprobó' : 'rechazó'} el pago de hora extra`,
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Editar/eliminar mientras siga en Pendiente (sql/31, 28 ago 2026, a pedido
// explícito): "de la nada se soluciona y no se necesita la hora extra", o
// el número de horas está mal y hay que corregirlo — pero solo antes de
// que alguien decida algo sobre esa fila. admin/ceo/leader, igual que
// decidir (limitado a sus propios centros vía canWriteCenter).
router.put('/overtime/:id', requireRole('leader', 'admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const extraHours = Number(req.body.extra_hours);
    if (!(extraHours > 0)) {
      return res.status(400).json({ error: 'extra_hours debe ser un número mayor que 0' });
    }

    const rows = await query(
      `SELECT od.cost_center_id, od.week_number, od.year_number, e.canonical_name
         FROM mp_overtime_decisions od
         JOIN mp_employees e ON e.employee_id = od.employee_id
        WHERE od.decision_id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (!(await canWriteCenter(req.scope, rows[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const result = await editOvertimeHours(id, extraHours);
    if (!result) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (result.error === 'no_editable') {
      return res.status(409).json({ error: 'Esta hora extra ya fue decidida — solo se puede corregir mientras esté Pendiente.' });
    }

    const r = rows[0];
    await logAudit({
      costCenterId: r.cost_center_id, entityType: 'overtime', entityId: id, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${r.canonical_name} — semana ${r.week_number}/${r.year_number}: corrigió las horas extra a ${extraHours}h`,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Editar es solo mientras siga Pendiente, pero ELIMINAR ya no (17 sep
// 2026, a pedido explícito: "el CEO o admin pueden tener la opción de
// eliminar en caso de que se haya registrado una por error"). admin/ceo
// eliminan cualquier registro, incluso uno ya decidido/aprobado — la vía
// para corregir una hora extra registrada por error. Un líder (PM) solo
// puede eliminar mientras la fila siga Pendiente, EXCEPTO cuando él mismo
// registró la hora extra a mano (approved_by = quien la creó): aunque el
// alta manual ya nazca aprobada, puede borrarla desde el mini-historial de
// la sesión del modal (17 sep 2026, a pedido explícito). Todo limitado a
// sus propios centros vía canWriteCenter.
router.delete('/overtime/:id', requireRole('leader', 'admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rows = await query(
      `SELECT od.cost_center_id, od.week_number, od.year_number, od.pm_decision,
              od.approved_by, e.canonical_name
         FROM mp_overtime_decisions od
         JOIN mp_employees e ON e.employee_id = od.employee_id
        WHERE od.decision_id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (!(await canWriteCenter(req.scope, rows[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const esAdminCeo = req.session.user.role === 'admin' || req.session.user.role === 'ceo';
    const esCreador = !!rows[0].approved_by && rows[0].approved_by === req.session.user.user_id;
    const result = await deleteOvertimeDecision(id, esAdminCeo, esCreador, req.session.user.user_id);
    if (!result) return res.status(404).json({ error: 'Registro de horas extra no encontrado' });
    if (result.error === 'no_eliminable') {
      return res.status(409).json({ error: 'Esta hora extra ya fue decidida y no la registraste tú — solo la puede eliminar quien la registró a mano o un admin/CEO.' });
    }

    const r = rows[0];
    const estado = r.pm_decision === 'pendiente' ? 'pendiente' : 'ya decidida';
    await logAudit({
      costCenterId: r.cost_center_id, entityType: 'overtime', entityId: id, action: 'eliminar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${r.canonical_name} — semana ${r.week_number}/${r.year_number}: eliminó el registro de hora extra ${estado}`,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
