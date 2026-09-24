'use strict';

const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');
const sharepoint = require('../services/sharepoint');

const router = express.Router();

const VALID_PROJECTS = ['CRM', 'Document Online', 'Infraestructura', 'MIA', 'QA', 'SESCOL', 'Transversales'];
const VALID_CONTRACT_TYPES = ['planta', 'prestacion_servicios'];

// CRUD de mp_employees. Solo admin/ceo pueden crear/editar/desactivar.
// Cualquier usuario autenticado puede listar (utilidad para selectors), pero
// solo admin/ceo ven el detalle completo (email, leader_email,
// contract_type): esta tabla es un catálogo de TODA la empresa, sin scope
// por proyecto, y un leader solo necesita id+nombre para llenar sus
// selectores (ver costeo-equipo.js, costeo-comercial.js, costeo-centros.js —
// ninguno de los tres lee otro campo). Sin este recorte, cualquier leader
// autenticado podía enumerar email y líder de gente fuera de su proyecto.

function normalizeAliases(input) {
  if (input == null) return null;
  if (Array.isArray(input)) return JSON.stringify(input.filter(Boolean).map(String));
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Permitimos JSON array o coma-separado.
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return JSON.stringify(arr.map(String).filter(Boolean));
      } catch (e) { /* fall through */ }
    }
    const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? JSON.stringify(parts) : null;
  }
  return null;
}

function validate(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.canonical_name !== undefined) {
    if (!body.canonical_name || !String(body.canonical_name).trim()) errs.push('canonical_name es obligatorio');
  }
  if (!partial || body.email !== undefined) {
    const e = String(body.email || '').trim().toLowerCase();
    if (!e) errs.push('email es obligatorio');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errs.push('email con formato inválido');
  }
  return errs;
}

router.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.session.user.role === 'admin' || req.session.user.role === 'ceo';
    const rows = await query(
      isAdmin
        ? `SELECT employee_id, canonical_name, aliases, email, leader_name, leader_email,
                  project_folder, contract_type, is_active, receive_alerts, created_at
             FROM mp_employees
            ORDER BY is_active DESC, canonical_name`
        : `SELECT employee_id, canonical_name, is_active
             FROM mp_employees
            ORDER BY is_active DESC, canonical_name`
    );
    if (!isAdmin) return res.json({ rows });
    const list = rows.map((r) => {
      let aliasesArr = [];
      if (r.aliases) {
        try { const p = JSON.parse(r.aliases); if (Array.isArray(p)) aliasesArr = p; } catch (e) { /* ignore */ }
      }
      return { ...r, aliases: aliasesArr };
    });
    res.json({ rows: list });
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const errs = validate(req.body);
    if (errs.length) return res.status(400).json({ error: errs.join('. ') });

    const canonical_name = String(req.body.canonical_name).trim();
    const email = String(req.body.email).trim().toLowerCase();
    const leader_name = req.body.leader_name ? String(req.body.leader_name).trim() : null;
    const leader_email = req.body.leader_email ? String(req.body.leader_email).trim().toLowerCase() : null;
    const project_folder = req.body.project_folder ? String(req.body.project_folder).trim() : null;
    const aliases = normalizeAliases(req.body.aliases);
    const is_active = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;
    const receive_alerts = req.body.receive_alerts === false || req.body.receive_alerts === 0 ? 0 : 1;
    const contract_type = req.body.contract_type && VALID_CONTRACT_TYPES.includes(req.body.contract_type)
      ? req.body.contract_type : 'planta';

    // canonical_name es UNIQUE: respondemos 409 si ya existe.
    const dup = await query('SELECT employee_id FROM mp_employees WHERE canonical_name = ? LIMIT 1', [canonical_name]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un empleado con ese nombre canónico' });

    const result = await query(
      `INSERT INTO mp_employees (canonical_name, aliases, email, leader_name, leader_email, project_folder, contract_type, is_active, receive_alerts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [canonical_name, aliases, email, leader_name, leader_email, project_folder, contract_type, is_active, receive_alerts]
    );
    res.status(201).json({ employee_id: result.insertId });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const errs = validate(req.body, { partial: true });
    if (errs.length) return res.status(400).json({ error: errs.join('. ') });

    const existing = await query('SELECT employee_id FROM mp_employees WHERE employee_id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Empleado no encontrado' });

    const fields = [];
    const params = [];
    const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

    if (req.body.canonical_name !== undefined) {
      const name = String(req.body.canonical_name).trim();
      const dup = await query('SELECT employee_id FROM mp_employees WHERE canonical_name = ? AND employee_id <> ? LIMIT 1', [name, id]);
      if (dup.length) return res.status(409).json({ error: 'Ya existe otro empleado con ese nombre canónico' });
      set('canonical_name', name);
    }
    if (req.body.email !== undefined) set('email', String(req.body.email).trim().toLowerCase());
    if (req.body.leader_name !== undefined) set('leader_name', req.body.leader_name ? String(req.body.leader_name).trim() : null);
    if (req.body.leader_email !== undefined) set('leader_email', req.body.leader_email ? String(req.body.leader_email).trim().toLowerCase() : null);
    if (req.body.aliases !== undefined) set('aliases', normalizeAliases(req.body.aliases));
    if (req.body.project_folder !== undefined) set('project_folder', req.body.project_folder ? String(req.body.project_folder).trim() : null);
    if (req.body.contract_type !== undefined) {
      const ct = String(req.body.contract_type).trim();
      if (!VALID_CONTRACT_TYPES.includes(ct)) {
        return res.status(400).json({ error: `contract_type inválido. Valores: ${VALID_CONTRACT_TYPES.join(', ')}` });
      }
      set('contract_type', ct);
    }
    if (req.body.is_active !== undefined) set('is_active', req.body.is_active ? 1 : 0);
    if (req.body.receive_alerts !== undefined) set('receive_alerts', req.body.receive_alerts ? 1 : 0);

    if (!fields.length) return res.json({ updated: 0 });
    params.push(id);
    const result = await query(`UPDATE mp_employees SET ${fields.join(', ')} WHERE employee_id = ?`, params);
    res.json({ updated: result.affectedRows });
  } catch (err) { next(err); }
});

// Soft delete: marcamos is_active = 0 en lugar de eliminar la fila para preservar la historia
// en mp_task_facts (que referencia employee_id).
router.delete('/:id', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const result = await query('UPDATE mp_employees SET is_active = 0 WHERE employee_id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ deactivated: result.affectedRows });
  } catch (err) { next(err); }
});

// Crea (o asegura) la estructura SharePoint para un empleado: carpeta + copia del template.
// Idempotente: si la carpeta o el Excel ya existen, los reporta como alreadyExisted=true.
router.post('/:id/sharepoint', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    if (!sharepoint.isConfigured()) {
      // El mensaje al cliente NO nombra las variables de entorno que faltan
      // (14 sep 2026, corregido tras revisión de código) — aunque esta ruta
      // ya es admin/ceo y los nombres están en .env.example, un mensaje de
      // error no tiene por qué enumerar el esquema de configuración interna
      // del servidor. El detalle sigue disponible para quien tiene que
      // arreglarlo de verdad: queda en el log del servidor.
      console.error('[employees] POST /:id/sharepoint: falta GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET en .env');
      return res.status(503).json({
        error: 'La integración con Microsoft Graph no está configurada en el servidor.',
      });
    }

    const rows = await query(
      'SELECT employee_id, canonical_name, project_folder FROM mp_employees WHERE employee_id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    const emp = rows[0];

    const projectFolder = (req.body && req.body.project_folder) || emp.project_folder;
    if (!projectFolder) {
      return res.status(400).json({ error: 'El empleado no tiene project_folder. Edítalo primero o envíalo en el body.' });
    }
    if (!VALID_PROJECTS.includes(projectFolder)) {
      return res.status(400).json({ error: `Proyecto inválido. Debe ser uno de: ${VALID_PROJECTS.join(', ')}` });
    }

    const result = { employee: emp.canonical_name, projectFolder };

    const folder = await sharepoint.createEmployeeFolder({
      projectFolder,
      employeeName: emp.canonical_name,
    });
    result.folder = folder;

    try {
      const file = await sharepoint.copyTemplateForEmployee({
        projectFolder,
        employeeName: emp.canonical_name,
      });
      result.file = file;
    } catch (err) {
      // El folder ya quedó creado; reportamos el error del archivo pero no fallamos el endpoint entero.
      result.file = { error: err.message, status: err.status || 500 };
    }

    // Si el body trajo project_folder y el empleado no lo tenía guardado, persistimos.
    if (req.body && req.body.project_folder && !emp.project_folder) {
      await query('UPDATE mp_employees SET project_folder = ? WHERE employee_id = ?', [projectFolder, id]);
      result.persistedProjectFolder = true;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
