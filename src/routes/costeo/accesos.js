'use strict';

/**
 * Accesos (Gestion de PMs) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { cerrarSesionesDe } = require('../../lib/sesiones');
const { query, withTransaction } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../queries/costo-audit');
const { CARPETAS_NO_SON_PROYECTOS } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------
// Accesos (Gestión de PMs) — exclusivo admin/ceo. Crea/edita cuentas
// reales en mp_dashboard_users (rol 'leader') y las asigna a un
// centro de costos vía mp_project_owners. La PK es (project_folder,
// pmo_email), así que 2+ PMs pueden compartir el mismo proyecto.
// La UI vive aquí, en Costeo, pero es el mismo login del resto del sistema.
// ---------------------------------------------------------------

// Todos los proyectos disponibles para asignar un PM: los que reporta el RPA
// (mp_task_facts) más los Centros de Costos creados a mano (origin='manual',
// ej. Management, Talento Humano — áreas sin seguimiento de tareas del RPA).
// mp_project_owners solo necesita el project_folder, no depende de que
// exista el Centro de Costos financiero.
router.get('/proyectos-disponibles', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    // CARPETAS_NO_SON_PROYECTOS ('QA', 'UX'): son la carpeta de SharePoint
    // de alguien que trabaja transversal en varios proyectos, no un
    // proyecto real — no se ofrecen para asignar un PM ni para crear un
    // Centro de Costos. Es lo mismo que ya se corrigió a mano en
    // CC-2026-010/011 (ver sql/23 y el hallazgo de negocio que lo motivó).
    const excluir = CARPETAS_NO_SON_PROYECTOS.map(() => '?').join(',');
    const rows = await query(
      `SELECT project_folder, project_name FROM (
         SELECT DISTINCT t.project_folder, cc.project_name
           FROM mp_task_facts t
           LEFT JOIN mp_centro_costo cc ON cc.project_folder = t.project_folder
          WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
            AND t.project_folder IS NOT NULL
         UNION
         SELECT project_folder, project_name FROM mp_centro_costo
       ) p
       WHERE p.project_folder NOT IN (${excluir})
       ORDER BY project_folder`,
      CARPETAS_NO_SON_PROYECTOS
    );
    res.json({ proyectos: rows });
  } catch (err) {
    next(err);
  }
});

// Un PM puede tener varios project_folder activos en mp_project_owners
// (asignaciones históricas). Para esta tabla solo mostramos el más
// reciente por usuario (1 fila por PM, no una por proyecto asignado).
router.get('/accesos', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    // Un PM puede tener 2+ proyectos activos a la vez (mp_project_owners ya
    // lo permite) — se traen todos concatenados y se arman en un solo array
    // por PM, para que la tabla muestre una fila con todas sus pastillas en
    // vez de una fila repetida por proyecto.
    const rows = await query(
      `SELECT u.user_id, u.full_name, u.email, u.username, u.is_active,
              GROUP_CONCAT(
                DISTINCT CONCAT(po.project_folder, '::', COALESCE(cc.project_name, po.project_folder))
                ORDER BY cc.project_name SEPARATOR '||'
              ) AS proyectos_raw
         FROM mp_dashboard_users u
         LEFT JOIN mp_project_owners po ON po.pmo_email = u.email AND po.is_active = 1
         LEFT JOIN mp_centro_costo cc ON cc.project_folder = po.project_folder
        WHERE u.role = 'leader'
        GROUP BY u.user_id
        ORDER BY u.full_name`
    );
    const accesos = rows.map((r) => {
      const proyectos = r.proyectos_raw
        ? r.proyectos_raw.split('||').map((p) => {
            const [project_folder, project_name] = p.split('::');
            return { project_folder, project_name };
          })
        : [];
      // Se desestructura solo para excluirlo del objeto que se devuelve.
      const { proyectos_raw: _omitido, ...resto } = r;
      return {
        ...resto,
        proyectos,
        // Compatibilidad: el formulario de edición solo asigna un proyecto
        // a la vez, así que precarga el primero.
        project_folder: proyectos[0]?.project_folder || null,
        project_name: proyectos[0]?.project_name || null,
      };
    });
    res.json({ accesos });
  } catch (err) {
    next(err);
  }
});

router.post('/accesos', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const full_name = String(req.body.full_name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = req.body.username ? String(req.body.username).trim().toLowerCase() : null;
    const password = String(req.body.password || '');
    // Vacío es válido: el PM queda creado sin proyecto asignado todavía.
    const project_folders = Array.isArray(req.body.project_folders)
      ? [...new Set(req.body.project_folders.map((p) => String(p).trim()).filter(Boolean))]
      : [];
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'full_name, email y password son obligatorios' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    if (username && !/^[a-z0-9._-]{3,50}$/.test(username)) {
      return res.status(400).json({ error: 'El usuario solo puede tener letras, números, puntos, guiones y guion bajo (mínimo 3 caracteres)' });
    }

    const dup = await query('SELECT user_id FROM mp_dashboard_users WHERE email = ? LIMIT 1', [email]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    if (username) {
      const dupUser = await query('SELECT user_id FROM mp_dashboard_users WHERE username = ? LIMIT 1', [username]);
      if (dupUser.length) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    // Todo dentro de una transacción: crear el usuario y asignarle sus
    // proyectos es UNA operación. Si fallaba a mitad quedaba un PM que puede
    // entrar al sistema pero no ve ningún proyecto, sin ningún aviso.
    const userId = await withTransaction(async (exec) => {
      const result = await exec(
        `INSERT INTO mp_dashboard_users (email, username, password_hash, full_name, role, is_active)
         VALUES (?, ?, ?, ?, 'leader', 1)`,
        [email, username, password_hash, full_name]
      );

      // mp_project_owners: PK (project_folder, pmo_email) — varios PMs pueden
      // compartir el mismo proyecto sin pisarse entre sí, y un mismo PM puede
      // tener varios proyectos (una fila por cada uno). Lista vacía = el PM
      // queda creado sin asignación todavía.
      //
      // Un solo INSERT multi-fila en vez de N idas y vueltas a la base.
      if (project_folders.length) {
        const placeholders = project_folders.map(() => '(?, ?, ?, 1)').join(', ');
        const params = project_folders.flatMap((pf) => [pf, full_name, email]);
        await exec(
          `INSERT INTO mp_project_owners (project_folder, pmo_canonical_name, pmo_email, is_active)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE pmo_canonical_name = VALUES(pmo_canonical_name), pmo_email = VALUES(pmo_email), is_active = 1`,
          params
        );
      }

      return result.insertId;
    });

    await logAudit({
      costCenterId: null, entityType: 'acceso', entityId: userId, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Creó el acceso de PM "${full_name}" (${email})${project_folders.length ? ` con ${project_folders.length} proyecto(s) asignado(s)` : ' sin proyectos asignados'}`,
    });

    res.status(201).json({ user_id: userId });
  } catch (err) {
    next(err);
  }
});

router.put('/accesos/:id', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const userRows = await query('SELECT email, full_name, is_active FROM mp_dashboard_users WHERE user_id = ? AND role = ?', [id, 'leader']);
    if (!userRows.length) return res.status(404).json({ error: 'Acceso no encontrado' });
    const usuarioAntes = userRows[0];
    const emailActual = usuarioAntes.email;

    const fields = [];
    const params = [];
    let nuevoEmail = emailActual;
    if (req.body.full_name !== undefined) { fields.push('full_name = ?'); params.push(String(req.body.full_name).trim()); }
    if (req.body.email !== undefined) {
      nuevoEmail = String(req.body.email).trim().toLowerCase();
      if (!nuevoEmail) return res.status(400).json({ error: 'El correo no puede quedar vacío' });
      // El POST sí validaba duplicados; el PUT no, y la columna es UNIQUE
      // (sql/01). Sin esto el usuario veía un "Error interno" genérico en vez
      // de saber que ese correo ya está tomado.
      if (nuevoEmail !== emailActual) {
        const dupEmail = await query('SELECT user_id FROM mp_dashboard_users WHERE email = ? AND user_id <> ? LIMIT 1', [nuevoEmail, id]);
        if (dupEmail.length) return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
      }
      fields.push('email = ?'); params.push(nuevoEmail);
    }
    if (req.body.username !== undefined) {
      const username = req.body.username ? String(req.body.username).trim().toLowerCase() : null;
      if (username && !/^[a-z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({ error: 'El usuario solo puede tener letras, números, puntos, guiones y guion bajo (mínimo 3 caracteres)' });
      }
      if (username) {
        const dupUser = await query('SELECT user_id FROM mp_dashboard_users WHERE username = ? AND user_id <> ? LIMIT 1', [username, id]);
        if (dupUser.length) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario' });
      }
      fields.push('username = ?'); params.push(username);
    }
    if (req.body.is_active !== undefined) { fields.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }
    if (req.body.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      fields.push('password_hash = ?'); params.push(await bcrypt.hash(String(req.body.password), 10));
    }

    const fullNameFinal = req.body.full_name !== undefined
      ? String(req.body.full_name).trim()
      : usuarioAntes.full_name;

    // Todo en una transacción. El paso peligroso es el de abajo: para
    // reasignar proyectos primero se DESACTIVAN todos los que el PM tenía y
    // después se reinsertan los nuevos. Si algo fallaba entre esos dos pasos
    // (y estaban sueltos), el PM quedaba sin acceso a ningún proyecto y no
    // había forma de saber que había pasado.
    await withTransaction(async (exec) => {
      if (fields.length) {
        await exec(`UPDATE mp_dashboard_users SET ${fields.join(', ')} WHERE user_id = ?`, [...params, id]);
      }

      // Un PM puede tener varios proyectos a la vez (PK compuesta de
      // mp_project_owners lo permite desde sql/16) — project_folders llega
      // como arreglo, vacío = sin asignar. Se libera todo lo anterior y se
      // vuelve a activar/crear solo lo que venga en la lista nueva.
      if (req.body.project_folders !== undefined) {
        const project_folders = Array.isArray(req.body.project_folders)
          ? [...new Set(req.body.project_folders.map((p) => String(p).trim()).filter(Boolean))]
          : [];

        await exec('UPDATE mp_project_owners SET is_active = 0 WHERE pmo_email = ? AND is_active = 1', [emailActual]);

        if (project_folders.length) {
          const placeholders = project_folders.map(() => '(?, ?, ?, 1)').join(', ');
          const valores = project_folders.flatMap((pf) => [pf, fullNameFinal, nuevoEmail]);
          await exec(
            `INSERT INTO mp_project_owners (project_folder, pmo_canonical_name, pmo_email, is_active)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE pmo_canonical_name = VALUES(pmo_canonical_name), pmo_email = VALUES(pmo_email), is_active = 1`,
            valores
          );
        }
      } else if (nuevoEmail !== emailActual) {
        // Cambió el correo pero no el proyecto: mantener el vínculo con el nuevo correo.
        await exec('UPDATE mp_project_owners SET pmo_email = ? WHERE pmo_email = ? AND is_active = 1', [nuevoEmail, emailActual]);
      }
    });

    // Cambiar una contraseña o desactivar una cuenta de PM tampoco dejaba
    // rastro. La contraseña nueva NUNCA se registra, solo el hecho de que
    // alguien la cambió y quién fue.
    const cambios = [];
    if (req.body.full_name !== undefined && fullNameFinal !== usuarioAntes.full_name) cambios.push(`Nombre: ${usuarioAntes.full_name} → ${fullNameFinal}`);
    if (nuevoEmail !== emailActual) cambios.push(`Correo: ${emailActual} → ${nuevoEmail}`);
    if (req.body.username !== undefined) cambios.push('Usuario actualizado');
    if (req.body.password) cambios.push('Contraseña restablecida');
    if (req.body.is_active !== undefined && Boolean(req.body.is_active) !== Boolean(usuarioAntes.is_active)) {
      cambios.push(req.body.is_active ? 'Cuenta activada' : 'Cuenta desactivada');
    }
    if (req.body.project_folders !== undefined) cambios.push('Proyectos asignados actualizados');

    // Desactivar una cuenta tiene que cortarle el acceso YA. requireAuth solo
    // mira si hay sesión, nunca revalida contra la base, así que sin esto la
    // persona seguía trabajando con sus permisos hasta que caducara su cookie
    // — 8 horas, aunque cerrara el navegador. En un sistema que muestra
    // sueldos, ese margen importa justo el día que alguien se va.
    //
    // También al cambiar la contraseña: restablecerla es lo que se hace
    // cuando se sospecha que alguien mas la tiene, y dejar viva la sesión
    // abierta con la contraseña vieja vaciaría el gesto.
    //
    // Va DESPUÉS del guardado y fuera de la transacción a propósito: es una
    // consecuencia del cambio, no parte de él. Si fallara, la cuenta queda
    // igualmente desactivada (que es lo que se pidió) y la sesión caduca sola
    // — nunca al revés.
    const desactivada = req.body.is_active !== undefined && !req.body.is_active
      && Boolean(usuarioAntes.is_active);
    if (desactivada || req.body.password) {
      const cerradas = await cerrarSesionesDe(id);
      if (cerradas) cambios.push(`${cerradas} sesión(es) abierta(s) cerrada(s)`);
    }

    if (cambios.length) {
      await logAudit({
        costCenterId: null, entityType: 'acceso', entityId: id, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Acceso de "${fullNameFinal}" — ${cambios.join(', ')}`,
      });
    }

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
