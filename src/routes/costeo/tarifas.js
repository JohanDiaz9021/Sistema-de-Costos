'use strict';

/**
 * Tarifas por Cargo — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { projectScopeClause } = require('../../middleware/scope');
const { query, withTransaction } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit, formatMoneda } = require('../../queries/costo-audit');
const { rolesValidos, slugRole, nombreVisibleDeRoles } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------
// Tarifas por Cargo — la tarifa estándar de cada cargo, para no
// diligenciar el costo/hora persona por persona.
//
// La tarifa individual (mp_equipo_proyecto.hourly_cost) sigue siendo
// la que el motor usa; esta es el punto de partida.
//
// QUIÉN PUEDE QUÉ (corregido 15 sep 2026 tras auditoría: este encabezado
// decía que definir el catálogo era de admin/ceo "porque si un líder
// pudiera cambiarlo, repreciaría en silencio los proyectos de los demás".
// Eso dejó de ser cierto y describía una protección que el código NO tiene
// — un comentario que miente sobre la seguridad es peor que no tenerlo,
// porque el próximo que lo lea va a confiar en una garantía inexistente):
//
//   crear y definir tarifa (POST, PUT) -> cualquier rol, A PROPÓSITO: el PM
//     debe poder fijar "QA = $X" sin depender de admin/ceo (ver el detalle
//     en cada ruta). El catálogo es único para toda la empresa, así que si
//     dos PMs discrepan gana el último que guarde; el arreglo previsto para
//     eso es la tarifa por (cargo, centro), NO volver a cerrar la ruta.
//   aplicar en bloque (POST /aplicar) -> cualquier rol, acotado por scope:
//     un líder solo alcanza a su propia gente.
//   borrar del catálogo (DELETE) -> SOLO admin/ceo. Es la única operación
//     irreversible y sin alcance natural: borrar deja huérfana a gente de
//     proyectos que quien borra ni siquiera puede ver, y la pantalla le
//     muestra solo los suyos, así que tampoco puede medir el daño antes.
// ---------------------------------------------------------------

// Cuánta gente hay por cargo y en qué estado está su tarifa. Es lo que
// permite que la pantalla diga "aplicar a 6 personas" antes de aplicar,
// en vez de que el usuario descubra el alcance después de haberlo hecho.
async function getTarifasCargoConUso(scope) {
  const scopeF = projectScopeClause(scope, 'cc.project_folder');
  const uso = await query(
    `SELECT ep.role_catalog,
            COUNT(*) AS total,
            SUM(ep.hourly_cost IS NULL OR ep.hourly_cost = 0) AS sin_tarifa
       FROM mp_equipo_proyecto ep
       JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
      WHERE ep.is_active = 1 ${scopeF.clause}
      GROUP BY ep.role_catalog`,
    scopeF.params
  );
  const porRol = new Map(uso.map((u) => [u.role_catalog, u]));

  const cargos = await query(
    `SELECT tc.role_catalog, tc.nombre_visible, tc.hourly_cost, tc.nota, tc.updated_at,
            u.full_name AS updated_by_name
       FROM mp_tarifa_cargo tc
       LEFT JOIN mp_dashboard_users u ON u.user_id = tc.updated_by
      ORDER BY tc.nombre_visible`
  );

  return cargos.map((c) => {
    const u = porRol.get(c.role_catalog);
    const total = u ? Number(u.total) : 0;
    const sinTarifa = u ? Number(u.sin_tarifa) : 0;
    return {
      role_catalog: c.role_catalog,
      nombre_visible: c.nombre_visible,
      hourly_cost: c.hourly_cost !== null ? Number(c.hourly_cost) : null,
      nota: c.nota,
      updated_at: c.updated_at,
      updated_by_name: c.updated_by_name,
      personas: total,
      personas_sin_tarifa: sinTarifa,
      personas_con_tarifa: total - sinTarifa,
    };
  });
}

router.get('/tarifas-cargo', async (req, res, next) => {
  try {
    res.json({ cargos: await getTarifasCargoConUso(req.scope) });
  } catch (err) {
    next(err);
  }
});

// Crea un cargo nuevo en el catálogo (a pedido explícito: cualquier PM debe
// poder dar de alta un cargo sin depender de un despliegue — antes
// mp_tarifa_cargo.role_catalog era un ENUM fijo en el esquema, ver sql/23).
// Solo pide el nombre visible; la tarifa se define después con
// PUT /tarifas-cargo/:rol, igual que para los cargos que ya existían.
//
// Abierto a cualquier usuario autenticado, mismo criterio que ya aplica
// PUT /tarifas-cargo/:rol (ver el comentario ahí abajo): el catálogo es de
// toda la empresa, no de un proyecto.
router.post('/tarifas-cargo', async (req, res, next) => {
  try {
    const nombreVisible = String(req.body.nombre_visible || '').trim();
    if (!nombreVisible) return res.status(400).json({ error: 'nombre_visible es obligatorio' });
    if (nombreVisible.length > 60) return res.status(400).json({ error: 'nombre_visible no puede pasar de 60 caracteres' });

    let rol = slugRole(nombreVisible);
    // Colisión de slug (dos nombres distintos que normalizan igual, o el
    // mismo cargo creado dos veces): se distingue con un sufijo numérico en
    // vez de rechazar de plano, para no obligar al PM a inventar un nombre
    // distinto solo por una coincidencia de mayúsculas/acentos.
    const existentes = await rolesValidos();
    if (existentes.has(rol)) {
      let sufijo = 2;
      while (existentes.has(`${rol}_${sufijo}`)) sufijo++;
      rol = `${rol}_${sufijo}`;
    }

    // updated_at explícito (no solo el DEFAULT de la columna, que es NULL):
    // desde que la pantalla ya no ofrece "Definir tarifa" (28 ago 2026, a
    // pedido explícito — cada persona ya cobra distinto, un valor
    // "estándar" por cargo no aportaba), crear el cargo es la ÚNICA
    // escritura que le queda a una fila de mp_tarifa_cargo. Sin esto,
    // "Última edición" se quedaría vacía para siempre en todo cargo nuevo.
    await query(
      'INSERT INTO mp_tarifa_cargo (role_catalog, nombre_visible, updated_by, updated_at) VALUES (?, ?, ?, NOW())',
      [rol, nombreVisible, req.session.user.user_id || null]
    );

    await logAudit({
      costCenterId: null, entityType: 'tarifa_cargo', entityId: null, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Creó el cargo "${nombreVisible}" (${rol})`,
    });

    res.status(201).json({ role_catalog: rol, nombre_visible: nombreVisible });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ya existe un cargo con esa llave. Intenta con un nombre ligeramente distinto.' });
    }
    next(err);
  }
});

// Define la tarifa estándar de un cargo Y la aplica de una vez a todas las
// personas activas que lo tienen (a pedido explícito: antes "Definir
// tarifa" y "Aplicar a todos" eran dos pasos separados con un botón de
// confirmación aparte, y resultaba confuso — ahora guardar la tarifa YA es
// aplicarla, sin paso intermedio). Sobrescribe cualquier tarifa individual
// que alguien tuviera ajustada a mano para ese cargo.
//
// Abierto a cualquier usuario autenticado (incluye PM), a pedido explícito:
// el PM debe poder fijar "QA = $X" sin depender de admin/ceo. OJO: el
// catálogo es único para TODA la empresa, no por proyecto — si dos PMs
// definen distinto valor para el mismo cargo, gana el último que guarde. Si
// eso resulta problemático en la práctica, la solución es hacer la tarifa
// por (cargo, centro) en vez de solo por cargo, no volver a restringir esto
// a admin/ceo.
router.put('/tarifas-cargo/:rol', async (req, res, next) => {
  try {
    const rol = String(req.params.rol);
    if (!(await rolesValidos()).has(rol)) return res.status(400).json({ error: 'Cargo inválido' });

    const bruto = req.body.hourly_cost;
    // null/'' vacía la tarifa estándar (vuelve a "sin definir"), que es
    // distinto de ponerla en 0. En ese caso no hay nada que aplicar: a nadie
    // se le puede "asignar" una tarifa sin definir.
    let hourlyCost = null;
    if (bruto !== null && bruto !== undefined && String(bruto).trim() !== '') {
      hourlyCost = Number(bruto);
      if (!Number.isFinite(hourlyCost) || hourlyCost <= 0) {
        return res.status(400).json({ error: 'El costo/hora debe ser un número mayor que 0.' });
      }
    }

    const nota = req.body.nota !== undefined ? String(req.body.nota).slice(0, 255) : null;

    // El scope decide a quién le llega la aplicación en bloque: admin/ceo
    // llega a toda la empresa, un líder solo dentro de sus propios centros
    // (igual que ya hacía POST /tarifas-cargo/:rol/aplicar).
    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');

    const antes = await query('SELECT hourly_cost FROM mp_tarifa_cargo WHERE role_catalog = ?', [rol]);
    const resultado = await withTransaction(async (exec) => {
      const upd = await exec(
        'UPDATE mp_tarifa_cargo SET hourly_cost = ?, nota = ?, updated_by = ? WHERE role_catalog = ?',
        [hourlyCost, nota, req.session.user.user_id || null, rol]
      );
      let aplicados = 0;
      if (hourlyCost !== null) {
        const equipoUpd = await exec(
          `UPDATE mp_equipo_proyecto ep
             JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
              SET ep.hourly_cost = ?
            WHERE ep.role_catalog = ?
              AND ep.is_active = 1
              ${scopeF.clause}`,
          [hourlyCost, rol, ...scopeF.params]
        );
        aplicados = equipoUpd.affectedRows;
      }
      return { updated: upd.affectedRows, aplicados };
    });

    // La tarifa de un cargo es el numero con mas impacto financiero del
    // modulo (repreciar un cargo mueve el costo de todos los proyectos donde
    // ese cargo aparece) y era la unica escritura sin rastro en el historial.
    // Sin cost_center_id: el catalogo es de empresa, no de un centro.
    if (resultado.updated) {
      const valorAntes = antes[0]?.hourly_cost;
      const descAplicado = resultado.aplicados > 0 ? ` — aplicada a ${resultado.aplicados} persona(s)` : '';
      const nombreRol = await nombreVisibleDeRoles();
      await logAudit({
        costCenterId: null, entityType: 'tarifa_cargo', entityId: null, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Tarifa estándar de "${nombreRol(rol)}": ${valorAntes === null || valorAntes === undefined ? '—' : '$' + valorAntes} → ${hourlyCost === null ? '—' : '$' + hourlyCost}${descAplicado}`,
      });
    }
    res.json({ ok: true, role_catalog: rol, hourly_cost: hourlyCost, aplicados: resultado.aplicados });
  } catch (err) {
    next(err);
  }
});

// Aplica la tarifa estándar del cargo a las personas que lo tienen.
//
// modo 'solo_sin_tarifa' (por defecto) toca únicamente a quien está en 0:
// es el modo seguro, no pisa ninguna tarifa que alguien haya ajustado a
// mano. modo 'todos' sí sobrescribe, y por eso el frontend lo pide
// confirmado — un senior con tarifa propia perdería su valor.
router.post('/tarifas-cargo/:rol/aplicar', async (req, res, next) => {
  try {
    const rol = String(req.params.rol);
    if (!(await rolesValidos()).has(rol)) return res.status(400).json({ error: 'Cargo inválido' });

    const modo = req.body.modo === 'todos' ? 'todos' : 'solo_sin_tarifa';

    const filas = await query('SELECT hourly_cost FROM mp_tarifa_cargo WHERE role_catalog = ?', [rol]);
    const tarifa = filas.length && filas[0].hourly_cost !== null ? Number(filas[0].hourly_cost) : null;
    if (!(tarifa > 0)) {
      return res.status(400).json({ error: 'Ese cargo todavía no tiene una tarifa estándar definida.' });
    }

    // El scope decide el alcance: admin/ceo aplica a toda la empresa, un
    // líder solo dentro de los centros que le pertenecen.
    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');
    const condicionModo = modo === 'todos' ? '' : ' AND (ep.hourly_cost IS NULL OR ep.hourly_cost = 0)';

    const result = await query(
      `UPDATE mp_equipo_proyecto ep
         JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
          SET ep.hourly_cost = ?
        WHERE ep.role_catalog = ?
          AND ep.is_active = 1
          ${condicionModo}
          ${scopeF.clause}`,
      [tarifa, rol, ...scopeF.params]
    );

    // Un UPDATE masivo sobre las tarifas de decenas de personas no puede
    // quedar sin rastro, y menos el modo 'todos', que PISA tarifas que
    // alguien habia ajustado a mano y no hay forma de recuperar.
    if (result.affectedRows) {
      const nombreRol = await nombreVisibleDeRoles();
      await logAudit({
        costCenterId: null, entityType: 'tarifa_cargo', entityId: null, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Aplicó la tarifa estándar de "${nombreRol(rol)}" (${formatMoneda(tarifa)}/h) a ${result.affectedRows} persona(s), modo "${modo === 'todos' ? 'sobrescribir todas' : 'solo sin tarifa'}"`,
      });
    }

    res.json({ ok: true, role_catalog: rol, hourly_cost: tarifa, modo, actualizados: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

// Elimina un cargo del catálogo, tenga o no gente asignada — a pedido
// explícito: si la empresa decide sacar un cargo, debe poder borrarse
// igual. mp_equipo_proyecto.role_catalog no tiene FK hacia esta tabla (es
// un VARCHAR libre desde sql/23), así que no hay nada que lo bloquee a
// nivel de base de datos: a quien ya tenía este cargo asignado simplemente
// le queda ese valor "huérfano" (ya no aparece en el catálogo ni se puede
// volver a elegir para alguien nuevo, pero no se borra ni se reasigna solo
// — eso lo hace un humano desde Equipo del Proyecto si hace falta).
//
// SOLO admin/ceo (15 sep 2026, a pedido explícito tras la auditoría), a
// diferencia de crear y definir la tarifa, que siguen abiertos a cualquier
// rol. La diferencia no es arbitraria: crear y repreciar son reversibles y
// acotados, borrar no. El catálogo es de TODA la empresa, así que quitar un
// cargo deja huérfana a gente de proyectos que quien borra puede ni
// siquiera ver — y la pantalla le muestra solo los suyos, así que ni
// siquiera puede medir el daño antes de hacerlo.
//
// El frontend además deja la columna "Acciones" vacía para quien no es
// admin/ceo (ver tarifaCargoFilaHTML en public/js/costeo-equipo.js): un
// botón que siempre va a fallar es peor que no tenerlo. Esto de aquí es la
// garantía de verdad — el frontend solo evita el intento inútil.
router.delete('/tarifas-cargo/:rol', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const rol = String(req.params.rol);
    const filas = await query('SELECT nombre_visible FROM mp_tarifa_cargo WHERE role_catalog = ?', [rol]);
    if (!filas.length) return res.status(404).json({ error: 'Cargo no encontrado' });

    const [{ n: afectados }] = await query('SELECT COUNT(*) AS n FROM mp_equipo_proyecto WHERE role_catalog = ?', [rol]);

    const result = await query('DELETE FROM mp_tarifa_cargo WHERE role_catalog = ?', [rol]);
    if (result.affectedRows) {
      await logAudit({
        costCenterId: null, entityType: 'tarifa_cargo', entityId: null, action: 'eliminar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Eliminó el cargo "${filas[0].nombre_visible}" (${rol})`
          + (afectados > 0 ? ` — ${afectados} persona(s) quedaron con ese cargo fuera del catálogo` : ''),
      });
    }
    res.json({ deleted: !!result.affectedRows, afectados });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
