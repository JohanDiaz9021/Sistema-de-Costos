'use strict';

/**
 * Centro de Costos (3.3) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const multer = require('multer');
const { projectScopeClause } = require('../../middleware/scope');
const { query, withTransaction } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit, describirCambios, formatMoneda } = require('../../queries/costo-audit');
// Mismo formato de dinero que la pantalla y los exports ("$ 1.750.950"): los
// textos del historial guardaban el número crudo (1750950) y con cifras de
// millones eso es ilegible — 7 sep 2026, a pedido explícito.
const { formatCOP } = require('../../queries/costo-export-format');
const { cargarExcelHoras } = require('../../queries/costo-task-facts-upload');
const {
  CENTRO_TIPOS, CENTRO_ESTADOS, CENTRO_TIPO_LABEL, CENTRO_ESTADO_LABEL, CARPETAS_NO_SON_PROYECTOS,
  generarCodigoCentro, generarProjectFolderUnico, canWriteCenter, rolesValidos, nombreVisibleDeRoles,
} = require('./_shared');
const {
  calcularPresupuestoPlan, validarFilasPlan, validarFilasGastos,
  getPlanRecursos, getPlanRecursosGastos, guardarPlanRecursos, guardarPlanRecursosTx,
  crearEquipoDesdeFilasPlanTx, sincronizarEquipoDesdePlanTx, eliminarPlanRecursos,
} = require('../../queries/costo-plan-recursos');

const router = express.Router();
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Texto para el historial de auditoría: una fila "por Persona" (sql/34) se
// describe con el nombre real, no solo el cargo — si no, "Desarrollador
// (1×100h×$8.338)" no dice a quién le corresponde ese costo real.
async function resumenFilasPlan(filas, nombreRol) {
  const idsPersona = filas.filter((f) => f.employee_id).map((f) => f.employee_id);
  const nombresPorId = new Map();
  if (idsPersona.length) {
    const rows = await query(
      `SELECT employee_id, canonical_name FROM mp_employees WHERE employee_id IN (${idsPersona.map(() => '?').join(',')})`,
      idsPersona
    );
    for (const r of rows) nombresPorId.set(r.employee_id, r.canonical_name);
  }
  return filas
    .map((f) => {
      const etiqueta = f.employee_id
        ? `${nombresPorId.get(f.employee_id) || 'talento #' + f.employee_id} (${nombreRol(f.role_catalog)})`
        : `${f.personas}× ${nombreRol(f.role_catalog)}`;
      return `${etiqueta} (${f.horas_totales}h × ${formatCOP(f.costo_hora)})`;
    })
    .join(', ');
}

// Texto para el historial cuando crearEquipoDesdeFilasPlanTx (costo-plan-
// recursos.js) dio de alta gente en Equipo del Proyecto al guardar el
// plan — para que quede tan trazable como cualquier alta manual desde esa
// pantalla (POST /equipo ya deja su propio log; esto es el equivalente
// para las altas que salen del Plan de Recursos).
async function resumenEquipoCreado(agregados, nombreRol) {
  if (!agregados.length) return '';
  const ids = agregados.map((a) => a.employee_id);
  const rows = await query(
    `SELECT employee_id, canonical_name FROM mp_employees WHERE employee_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const nombresPorId = new Map(rows.map((r) => [r.employee_id, r.canonical_name]));
  return agregados
    .map((a) => {
      const nombre = nombresPorId.get(a.employee_id) || 'talento #' + a.employee_id;
      // "desde salario X/mes" solo para quien entró con un salario NUEVO
      // (crearEquipoDesdeFilasPlanTx). A quien ya tenía tarifa conocida lo
      // da de alta sincronizarEquipoDesdePlanTx, sin monthly_salary — sin
      // este guard el historial le inventaba un "desde salario $ 0/mes".
      const origen = a.monthly_salary
        ? ` desde salario ${formatCOP(a.monthly_salary)}/mes`
        : '';
      const horas = a.horas_totales ? `, ${a.horas_totales}h planeadas` : '';
      return `${nombre} (${nombreRol(a.role_catalog)}, ${formatCOP(a.costo_hora)}/h${origen}${horas})`;
    })
    .join(', ');
}

// ---------------------------------------------------------------
// Centro de Costos (3.3) — solo admin/ceo crean; admin/ceo/leader editan
// (leader limitado a su(s) propio(s) centro(s) via canWriteCenter).
// ---------------------------------------------------------------

router.get('/centros', async (req, res, next) => {
  try {
    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');
    const rows = await query(
      `SELECT cc.cost_center_id, cc.codigo, cc.project_folder, cc.project_name, cc.tipo, cc.client_name,
              cc.origin, cc.budget, cc.budget_from_plan, cc.status, cc.contract_value,
              cc.start_date, cc.planned_end_date, cc.actual_end_date,
              (SELECT GROUP_CONCAT(po.pmo_canonical_name ORDER BY po.pmo_canonical_name SEPARATOR ', ')
                 FROM mp_project_owners po
                WHERE po.project_folder = cc.project_folder AND po.is_active = 1) AS pm_name,
              -- Cuántos cambios lleva registrados este centro (7 sep 2026, a
              -- pedido explícito del dueño de la empresa): alimenta el botón
              -- "Ver cambios (N)" de cada tarjeta de Costo Planeado, que abre
              -- el rastro completo con el antes/después de cada valor. Solo
              -- el conteo va aquí; el detalle lo pide esa ventana aparte
              -- (GET /historial?cost_center_id=N), para no traer el texto de
              -- cientos de cambios en la carga de la pantalla.
              (SELECT COUNT(*) FROM mp_costeo_audit_log a
                WHERE a.cost_center_id = cc.cost_center_id) AS cambios_total
         FROM mp_centro_costo cc
        WHERE 1=1 ${scopeF.clause}
        ORDER BY cc.project_name`,
      scopeF.params
    );
    res.json({ centros: rows });
  } catch (err) {
    next(err);
  }
});

// El PM (leader) también puede crear un proyecto, pero solo desde el
// Simulador (con Plan de Recursos incluido) — el botón "+ Nuevo centro" del
// encabezado sigue oculto para leader (ver isAdmin en costeo-indicadores.js).
router.post('/centros', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const project_name = String(req.body.project_name || '').trim();
    // El Simulador puede crear un proyecto que no viene de Planeación (no
    // tiene una carpeta real de SharePoint que cruzar) — si no mandan
    // project_folder, se autogenera del nombre comercial. El formulario
    // "+ Nuevo centro" de toda la vida sigue mandándolo siempre, así que no
    // cambia su comportamiento.
    let project_folder = String(req.body.project_folder || '').trim();
    if (!project_folder && project_name) project_folder = await generarProjectFolderUnico(project_name);

    const tipo = CENTRO_TIPOS.includes(req.body.tipo) ? req.body.tipo : 'Desarrollo';
    const status = CENTRO_ESTADOS.includes(req.body.status) ? req.body.status : null;
    const client_name = req.body.client_name ? String(req.body.client_name).trim() : null;
    const contract_value = req.body.contract_value !== undefined && req.body.contract_value !== ''
      ? Number(req.body.contract_value) : null;
    const start_date = req.body.start_date ? String(req.body.start_date) : null;
    const planned_end_date = req.body.planned_end_date ? String(req.body.planned_end_date) : null;
    const actual_end_date = req.body.actual_end_date ? String(req.body.actual_end_date) : null;
    if (!project_folder || !project_name || !start_date || !planned_end_date) {
      return res.status(400).json({ error: 'project_folder, project_name, start_date y planned_end_date son obligatorios' });
    }
    // 'QA'/'UX' son carpetas de SharePoint de gente que trabaja transversal
    // en varios proyectos, no proyectos reales — no pueden volver a
    // convertirse en un Centro de Costos (ver el comentario junto a
    // CARPETAS_NO_SON_PROYECTOS en _shared.js).
    if (CARPETAS_NO_SON_PROYECTOS.includes(project_folder.toUpperCase())) {
      return res.status(400).json({
        error: `"${project_folder}" es una carpeta de rol (QA/UX), no un proyecto — no se puede crear un centro de costos para ella.`,
      });
    }

    // Un leader puede crear un proyecto NUEVO desde el Simulador (ver el
    // comentario junto a este router.post), pero no puede reclamar uno que
    // YA tiene responsable — mp_project_owners se puede poblar desde Accesos
    // sin que exista todavía un Centro de Costos (ver /proyectos-disponibles:
    // "no depende de que exista el Centro de Costos financiero"), así que un
    // project_folder sin centro puede perfectamente ya tener un PM real
    // asignado. Sin este chequeo, cualquier leader que adivinara o
    // escribiera esa carpeta se colaba como copropietario silencioso más
    // abajo (INSERT ... ON DUPLICATE KEY UPDATE is_active=1) — sin pasar por
    // Accesos (exclusivo admin/ceo) ni que nadie lo aprobara. admin/ceo no
    // necesitan este chequeo: su scope ya es global, y son quienes gestionan
    // Accesos de todas formas (14 sep 2026, corregido tras revisión de
    // seguridad).
    if (req.session.user.role === 'leader') {
      // Se excluye al propio leader del chequeo: admin puede haberlo
      // asignado a este project_folder desde Accesos ANTES de que existiera
      // el centro (es justo el caso que /proyectos-disponibles contempla) —
      // ese leader sí tiene que poder crear su propio centro, no solo un
      // tercero ajeno.
      const dueñoExistente = await query(
        'SELECT 1 FROM mp_project_owners WHERE project_folder = ? AND is_active = 1 AND pmo_email <> ? LIMIT 1',
        [project_folder, req.session.user.email]
      );
      if (dueñoExistente.length) {
        return res.status(409).json({
          error: `"${project_folder}" ya tiene un responsable asignado — pídele a un administrador que te agregue desde Accesos.`,
        });
      }
    }

    const dup = await query('SELECT cost_center_id FROM mp_centro_costo WHERE project_folder = ? LIMIT 1', [project_folder]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un centro de costos para ese proyecto' });

    // El motor atribuye horas cruzando el "Proyecto" del Excel contra
    // project_name O project_folder de cada centro (costo-motor.js,
    // costo-weekly-hours.js) — si el nombre de este centro coincide con la
    // CARPETA de otro, o su carpeta con el NOMBRE de otro, las horas de
    // cualquiera de los dos se cobrarían a ambos a la vez. Pasó de verdad:
    // un centro manual "Costos" con carpeta "Sistema de costos" chocó con un
    // proyecto nuevo, real, llamado justo "Sistema de costos".
    const choque = await query(
      `SELECT cost_center_id, project_name, project_folder FROM mp_centro_costo
        WHERE project_name = ? OR project_folder = ? LIMIT 1`,
      [project_folder, project_name]
    );
    if (choque.length) {
      return res.status(409).json({
        error: `"${project_name}" choca con el centro "${choque[0].project_name}" (su nombre o carpeta interna coincide) — las horas del Excel se atribuirían a los dos. Cambia el nombre.`,
      });
    }

    // TOCTOU CONOCIDO, NO CONTENIDO AÚN (17 sep 2026, auditoría): los dos
    // SELECT de arriba (dup y choque) corren ANTES de la transacción, y
    // project_name / project_folder NO llevan UNIQUE en la tabla. Dos
    // admins creando el MISMO proyecto casi simultáneamente pasan ambos
    // los SELECT (todavía no existe nada) y los dos INSERT del bloque
    // withTransaction de abajo llegan a commit — la duplicación que estos
    // checks quieren evitar. Probabilidad baja; si se contiene algún día,
    // la opción es una migración con UNIQUE KEY sobre project_folder (con
    // limpieza previa de duplicados ya existentes) y un 409 "Ya existe un
    // centro..." sobre el error ER_DUP_ENTRY en el catch, o SELECT ... FOR
    // UPDATE dentro de la misma transacción para serializar los altas.

    // Plan de Recursos opcional desde el Simulador: si viene, el presupuesto
    // se calcula desde ahí (igual que PUT /plan-recursos) y el centro nace
    // ya con budget_from_plan=1 — el "budget" suelto que venga en el body
    // se ignora para no dejar dos verdades sobre cuánto vale el proyecto.
    // gastosPlan (sql/29, "+ Añadir gasto" del Simulador) solo se procesa
    // si además viene mano de obra: sin un plan activo no hay dónde colgar
    // un gasto suelto — esa combinación ya la bloquea el frontend, pero se
    // ignora en silencio aquí también en vez de crear un plan "solo gastos".
    let filasPlan = null;
    let gastosPlan = [];
    if (Array.isArray(req.body.plan_recursos) && req.body.plan_recursos.length) {
      const roles = await rolesValidos();
      const validacion = await validarFilasPlan(req.body.plan_recursos, roles);
      if (validacion.error) return res.status(400).json({ error: validacion.error });
      filasPlan = validacion.filas;

      if (Array.isArray(req.body.plan_recursos_gastos) && req.body.plan_recursos_gastos.length) {
        const validacionGastos = validarFilasGastos(req.body.plan_recursos_gastos);
        if (validacionGastos.error) return res.status(400).json({ error: validacionGastos.error });
        gastosPlan = validacionGastos.gastos;
      }
    }
    const budget = filasPlan ? calcularPresupuestoPlan(filasPlan, gastosPlan) : (Number(req.body.budget) || 0);

    // origin distingue proyectos con datos reales del RPA ('planeacion') de
    // los que el admin crea a mano sin que el RPA los reporte ('manual').
    const enRpa = await query('SELECT 1 FROM mp_task_facts WHERE project_folder = ? LIMIT 1', [project_folder]);
    const origin = enRpa.length ? 'planeacion' : 'manual';

    const codigo = await generarCodigoCentro();
    const columnas = ['codigo', 'project_folder', 'project_name', 'tipo', 'client_name', 'origin', 'budget', 'contract_value', 'start_date', 'planned_end_date', 'created_by'];
    const valores = [codigo, project_folder, project_name, tipo, client_name, origin, budget, contract_value, start_date, planned_end_date, req.session.user.user_id || null];
    if (actual_end_date) { columnas.push('actual_end_date'); valores.push(actual_end_date); }
    if (status) { columnas.push('status'); valores.push(status); }

    let insertId;
    let equipoCreado = [];
    await withTransaction(async (exec) => {
      const result = await exec(
        `INSERT INTO mp_centro_costo (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
        valores
      );
      insertId = result.insertId;
      if (filasPlan) {
        // Da de alta en Equipo del Proyecto a toda "Persona real" del plan —
        // tanto a quien acaba de escribir aquí su salario por primera vez
        // (crearEquipoDesdeFilasPlanTx, ver validarFilasPlan) como a quien ya
        // tenía tarifa conocida (sincronizarEquipoDesdePlanTx). El proyecto
        // ya tiene cost_center_id ahora que insertId existe, así que ya no
        // hace falta meter a nadie antes a un proyecto ajeno.
        //
        // ANTES que guardarPlanRecursosTx (14 sep 2026, corregido tras
        // revisión de código): mismo orden canónico que guardarPlanRecursos
        // en costo-plan-recursos.js — mp_equipo_proyecto antes que
        // mp_plan_recursos/mp_plan_recursos_gasto/mp_centro_costo. Aquí
        // insertId es una fila recién creada en esta misma transacción, así
        // que el orden no puede chocar con nada externo; se mantiene igual
        // por consistencia, para que ambos caminos hagan siempre lo mismo.
        const conSalarioNuevo = await crearEquipoDesdeFilasPlanTx(exec, insertId, filasPlan, req.session.user.user_id || null);
        const asignadosPorElPlan = await sincronizarEquipoDesdePlanTx(exec, insertId, filasPlan, req.session.user.user_id || null);
        equipoCreado = conSalarioNuevo.concat(asignadosPorElPlan);
        await guardarPlanRecursosTx(exec, insertId, filasPlan, gastosPlan, req.session.user.user_id || null);
      }

      // Un PM (leader) solo ve los proyectos donde es dueño activo en
      // mp_project_owners (ver attachScope) — sin esta fila, el proyecto que
      // acaba de crear le quedaría INVISIBLE en todas las pestañas y en los
      // filtros, y ni siquiera podría editarlo (canWriteCenter daría 403).
      // admin/ceo no la necesitan: su scope es global (allowedProjects=null).
      if (req.session.user.role === 'leader') {
        await exec(
          `INSERT INTO mp_project_owners (project_folder, pmo_canonical_name, pmo_email, is_active)
           VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE is_active = 1`,
          [project_folder, req.session.user.full_name, req.session.user.email]
        );
      }
    });

    await logAudit({
      costCenterId: insertId,
      entityType: 'centro_costo',
      entityId: insertId,
      action: 'crear',
      userId: req.session.user.user_id,
      userName: req.session.user.full_name,
      description: `Creó el centro "${project_name}" (${codigo}), presupuesto ${formatCOP(budget)}${filasPlan ? ' (calculado desde Plan de Recursos)' : ''}`,
    });
    if (filasPlan) {
      const nombreRol = await nombreVisibleDeRoles();
      const resumen = await resumenFilasPlan(filasPlan, nombreRol);
      const resumenGastos = gastosPlan.length
        ? ` + gastos: ${gastosPlan.map((g) => `${g.description} (${formatCOP(g.amount)})`).join(', ')}`
        : '';
      await logAudit({
        costCenterId: insertId, entityType: 'plan_recursos', entityId: insertId, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Guardó el Plan de Recursos al crear el proyecto: ${resumen}${resumenGastos} — presupuesto calculado: ${formatCOP(budget)}`,
      });
      if (equipoCreado.length) {
        const resumenEquipo = await resumenEquipoCreado(equipoCreado, nombreRol);
        await logAudit({
          costCenterId: insertId, entityType: 'equipo', entityId: insertId, action: 'crear',
          userId: req.session.user.user_id, userName: req.session.user.full_name,
          description: `Agregó a Equipo del Proyecto, con el salario escrito en el Plan de Recursos: ${resumenEquipo}`,
        });
      }
    }
    res.status(201).json({ cost_center_id: insertId, codigo, budget, equipo_creado: equipoCreado.length });
  } catch (err) {
    next(err);
  }
});

// El PM también puede editar (Costo Planeado / Comercial): es su proyecto,
// solo que canWriteCenter() lo limita al/los centro(s) donde es PMO activo
// en mp_project_owners. Crear/eliminar un centro sigue siendo admin/ceo.
router.put('/centros/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const fields = [];
    const params = [];
    if (req.body.project_name !== undefined) { fields.push('project_name = ?'); params.push(String(req.body.project_name).trim()); }
    if (req.body.tipo !== undefined) {
      if (!CENTRO_TIPOS.includes(req.body.tipo)) return res.status(400).json({ error: 'tipo inválido' });
      fields.push('tipo = ?'); params.push(req.body.tipo);
    }
    if (req.body.client_name !== undefined) { fields.push('client_name = ?'); params.push(req.body.client_name ? String(req.body.client_name).trim() : null); }
    if (req.body.budget !== undefined) {
      // Si el presupuesto ya sale de un Plan de Recursos (sql/27), no se
      // puede pisar a mano — para cambiarlo hay que editar el plan, así el
      // número siempre cuadra con la suma de sus filas. Se valida contra la
      // base (no contra lo que mande el body) para que nadie se salte esto
      // mandando budget_from_plan=0 en el mismo request.
      const [centroActual] = await query('SELECT budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
      if (centroActual?.budget_from_plan) {
        return res.status(409).json({ error: 'El presupuesto de este centro se calcula desde su Plan de Recursos — edita el plan, no este campo directo.' });
      }
      fields.push('budget = ?'); params.push(Number(req.body.budget) || 0);
    }
    if (req.body.status !== undefined) { fields.push('status = ?'); params.push(String(req.body.status)); }
    if (req.body.contract_value !== undefined) {
      fields.push('contract_value = ?');
      params.push(req.body.contract_value === '' || req.body.contract_value === null ? null : Number(req.body.contract_value));
    }
    if (req.body.start_date !== undefined) { fields.push('start_date = ?'); params.push(req.body.start_date || null); }
    if (req.body.planned_end_date !== undefined) { fields.push('planned_end_date = ?'); params.push(req.body.planned_end_date || null); }
    if (req.body.actual_end_date !== undefined) { fields.push('actual_end_date = ?'); params.push(req.body.actual_end_date || null); }
    if (!fields.length) return res.json({ updated: 0 });

    const antesRows = await query('SELECT * FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
    params.push(id);
    const result = await query(`UPDATE mp_centro_costo SET ${fields.join(', ')} WHERE cost_center_id = ?`, params);

    if (result.affectedRows && antesRows.length) {
      const desc = describirCambios(antesRows[0], req.body, {
        project_name: 'Nombre', tipo: 'Tipo', client_name: 'Cliente', budget: 'Presupuesto',
        status: 'Estado', contract_value: 'Valor de contrato',
        start_date: 'Fecha inicio', planned_end_date: 'Fecha fin planeada', actual_end_date: 'Fecha fin real',
      }, {
        tipo: (v) => (v ? CENTRO_TIPO_LABEL[v] || v : '—'),
        status: (v) => (v ? CENTRO_ESTADO_LABEL[v] || v : '—'),
        // Sin esto el historial decía "Presupuesto: 10000000 → 100000000",
        // que es justo lo que no se puede leer de un vistazo.
        budget: formatMoneda,
        contract_value: formatMoneda,
      });
      await logAudit({
        costCenterId: id, entityType: 'centro_costo', entityId: id, action: 'editar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: desc,
      });
    }
    res.json({ updated: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

// Borrado REAL y PERMANENTE (31 ago 2026, a pedido explícito: "cuando
// elimine un proyecto tiene que eliminarse, no quedarse inactivo"). Antes
// esto se desactivaba (status='inactivo') en vez de borrarse en cuanto el
// centro tenía equipo, gastos u horas extra — ahora siempre borra de
// verdad, sin importar cuántos datos tenga asociados.
//
// El equipo, los gastos y las horas extra de ese centro se pierden para
// siempre (es lo que se pidió). El HISTORIAL es la única excepción
// deliberada: se conserva desenganchado (cost_center_id = NULL, el nombre
// del proyecto queda como texto en cada descripción) en vez de borrarse,
// para no perder el rastro de quién hizo qué en un proyecto que ya no
// existe — mismo criterio que ya usan los Snapshots (sql/13, ON DELETE SET
// NULL) y que ya usaba este mismo endpoint antes de este cambio.
//
// mp_costeo_task_facts (las horas cargadas por Excel) NO se toca: sus filas
// quedan sin ningún centro que las reclame hasta que el project_name/folder
// se vuelva a usar en un centro nuevo — mismo criterio que ya se aplicaba a
// mp_task_facts (la tabla de Planeación) cuando Costeo todavía la compartía.
//
// Todo dentro de una sola transacción: si algo falla a la mitad, no debe
// quedar el centro borrado con su equipo o sus gastos todavía en pie (o
// viceversa).
//
// El PM (leader) también puede eliminar — igual que ya puede crear desde
// el Simulador — pero solo sus propios centros (canWriteCenter), no
// cualquiera. admin/ceo siguen sin restricción.
router.delete('/centros/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const centroRows = await query('SELECT project_name FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
    if (!centroRows.length) return res.status(404).json({ error: 'Centro de costos no encontrado' });
    const nombreCentro = centroRows[0].project_name;

    const eliminado = await withTransaction(async (exec) => {
      await exec('DELETE FROM mp_equipo_proyecto WHERE cost_center_id = ?', [id]);
      await exec('DELETE FROM mp_costo_no_planeado WHERE cost_center_id = ?', [id]);
      await exec('DELETE FROM mp_overtime_decisions WHERE cost_center_id = ?', [id]);
      // Desenganchar el historial ANTES del DELETE de mp_centro_costo: su FK
      // no tiene ON DELETE CASCADE/SET NULL (a propósito, ver sql/18), así
      // que sin este UPDATE el DELETE de abajo revienta con
      // ER_ROW_IS_REFERENCED en cualquier centro que alguna vez tuvo una
      // acción registrada — que es prácticamente todos.
      await exec('UPDATE mp_costeo_audit_log SET cost_center_id = NULL WHERE cost_center_id = ?', [id]);
      // mp_plan_recursos, mp_plan_recursos_gasto y mp_alerta_evento (+
      // mp_alerta_envio en cadena) tienen ON DELETE CASCADE — se limpian
      // solos aquí. mp_costeo_snapshot tiene ON DELETE SET NULL.
      const result = await exec('DELETE FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
      return !!result.affectedRows;
    });

    if (eliminado) {
      await logAudit({
        costCenterId: null, entityType: 'centro_costo', entityId: id, action: 'eliminar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Eliminó permanentemente el centro "${nombreCentro}" (junto con su equipo, gastos y horas extra)`,
      });
    }
    res.json({ deleted: eliminado });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Plan de Recursos (sql/27) — presupuesto calculado por rol, no escrito a
// mano. Mismo permiso que editar el centro (canWriteCenter): admin/ceo sin
// restricción, leader limitado a su(s) propio(s) centro(s).
// ---------------------------------------------------------------

router.get('/centros/:id/plan-recursos', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }
    const [filas, gastos] = await Promise.all([getPlanRecursos(id), getPlanRecursosGastos(id)]);
    res.json({ filas, gastos });
  } catch (err) {
    next(err);
  }
});

router.put('/centros/:id/plan-recursos', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const filasCrudas = Array.isArray(req.body.filas) ? req.body.filas : null;
    if (!filasCrudas || !filasCrudas.length) {
      return res.status(400).json({ error: 'filas es obligatorio y debe traer al menos un rol' });
    }
    // gastos (sql/29) es opcional: se puede seguir editando un plan que solo
    // tiene mano de obra, sin verse obligado a mandar partidas sueltas.
    const gastosCrudas = Array.isArray(req.body.gastos) ? req.body.gastos : [];

    const roles = await rolesValidos();
    const validacion = await validarFilasPlan(filasCrudas, roles);
    if (validacion.error) return res.status(400).json({ error: validacion.error });
    const filas = validacion.filas;

    const validacionGastos = validarFilasGastos(gastosCrudas);
    if (validacionGastos.error) return res.status(400).json({ error: validacionGastos.error });
    const gastos = validacionGastos.gastos;

    // actualizar_presupuesto (3 sep 2026, a pedido explícito): por defecto
    // true, mismo comportamiento de siempre — pero el front ahora puede
    // mandar false para guardar solo las horas planeadas por persona (para
    // Indicadores) sin pisar el presupuesto oficial del centro, en
    // proyectos donde ese presupuesto se sigue escribiendo a mano.
    const actualizarPresupuesto = req.body.actualizar_presupuesto !== false;
    const { presupuesto, equipoCreado } = await guardarPlanRecursos(id, filas, gastos, req.session.user.user_id || null, actualizarPresupuesto);

    const nombreRol = await nombreVisibleDeRoles();
    const resumen = await resumenFilasPlan(filas, nombreRol);
    const resumenGastos = gastos.length ? ` + gastos: ${gastos.map((g) => `${g.description} (${formatCOP(g.amount)})`).join(', ')}` : '';
    const notaPresupuesto = actualizarPresupuesto
      ? `presupuesto calculado: ${formatCOP(presupuesto)}`
      : `costo planeado: ${formatCOP(presupuesto)} (no se tocó el presupuesto del centro)`;
    await logAudit({
      costCenterId: id, entityType: 'plan_recursos', entityId: id, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Guardó el Plan de Recursos: ${resumen}${resumenGastos} — ${notaPresupuesto}`,
    });
    if (equipoCreado.length) {
      const resumenEquipo = await resumenEquipoCreado(equipoCreado, nombreRol);
      await logAudit({
        costCenterId: id, entityType: 'equipo', entityId: id, action: 'crear',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Agregó a Equipo del Proyecto, con el salario escrito en el Plan de Recursos: ${resumenEquipo}`,
      });
    }

    res.json({ presupuesto, filas, gastos, equipo_creado: equipoCreado.length });
  } catch (err) {
    next(err);
  }
});

router.delete('/centros/:id/plan-recursos', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }
    await eliminarPlanRecursos(id);
    await logAudit({
      costCenterId: id, entityType: 'plan_recursos', entityId: id, action: 'eliminar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: 'Eliminó el Plan de Recursos — el presupuesto vuelve a editarse a mano',
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Carga manual del Excel semanal de horas (costo-task-facts-upload.js) —
// mismo permiso que editar el centro: admin/ceo sin restricción, leader
// limitado a su(s) propio(s) centro(s).
//
// El Excel es de UNA PERSONA y trae todos sus proyectos de la semana, pero
// la carga se queda SOLO con las filas de ESTE centro (filtrarPorCentro):
// el botón vive dentro de un centro, así que eso es lo que la pantalla
// promete. Para cargar los demás proyectos se sube el mismo archivo dentro
// de cada uno.
// ---------------------------------------------------------------

router.post('/centros/:id/cargar-excel-horas', uploadExcel.single('excel'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    if (!(await canWriteCenter(req.scope, id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const employeeId = Number(req.body.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'Elige a quién pertenece el Excel' });
    }
    if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo' });

    const empleadoRows = await query('SELECT employee_id, canonical_name, project_folder FROM mp_employees WHERE employee_id = ?', [employeeId]);
    if (!empleadoRows.length) return res.status(404).json({ error: 'Esa persona no existe' });
    const empleado = empleadoRows[0];

    let resultado;
    try {
      resultado = await cargarExcelHoras(employeeId, empleado.project_folder, id, req.file.buffer);
    } catch (errParseo) {
      // Solo los errores marcados `esUsuario` (mensajes propios de
      // costo-task-facts-upload.js, ya pensados para mostrarse) se envían
      // tal cual. Cualquier otro — ExcelJS con un archivo corrupto, un
      // fallo de MySQL — se registra en el log del servidor y al cliente le
      // llega un mensaje genérico, para no filtrar detalles internos.
      if (errParseo.esUsuario) {
        return res.status(400).json({ error: errParseo.message });
      }
      console.error('[cargar-excel-horas] error inesperado:', errParseo);
      return res.status(400).json({ error: 'No se pudo procesar el archivo. Verifica que sea el Excel de la plantilla correcta.' });
    }

    await logAudit({
      costCenterId: id, entityType: 'centro_costo', entityId: id, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Cargó el Excel de horas de ${empleado.canonical_name} a mano (${resultado.filasInsertadas} fila(s), ${resultado.totalHoras}h, snapshot ${resultado.snapshotDate}) — proyectos: ${resultado.proyectos.join(', ')}`
        + (resultado.filas_ignoradas
          ? ` · ${resultado.filas_ignoradas} fila(s) de otros proyectos ignoradas (${resultado.proyectos_ignorados.join(', ')})`
          : ''),
    });

    res.json({
      empleado: empleado.canonical_name,
      snapshot_date: resultado.snapshotDate,
      filas_insertadas: resultado.filasInsertadas,
      total_horas: resultado.totalHoras,
      proyectos: resultado.proyectos,
      // Avisos de revisión: la carga SÍ se hizo, pero hay algo que mirar
      // (filas de otros proyectos que se dejaron fuera, o un TT que no
      // cuadra con la suma de los días).
      filas_ignoradas: resultado.filas_ignoradas,
      proyectos_ignorados: resultado.proyectos_ignorados,
      filas_total_descuadrado: resultado.filas_total_descuadrado,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
