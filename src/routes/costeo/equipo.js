'use strict';

/**
 * Equipo del Proyecto (3.4) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { projectScopeClause } = require('../../middleware/scope');
const { query, withTransaction } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit, describirCambios, formatMoneda } = require('../../queries/costo-audit');
const { rolesValidos, canWriteCenter, nombreVisibleDeRoles } = require('./_shared');
const { getParametrosNomina, valorHoraDesdeSalario } = require('../../queries/costo-recargos');

const router = express.Router();

// Cuántas personas activas tiene HOY el equipo de un centro — se llama antes
// Y después de agregar/quitar a alguien, para poder dejar en el historial
// "Equipo: 3 → 4 personas" (7 sep 2026, a pedido explícito del dueño de la
// empresa: quiere ver el antes/después de cada cambio, no solo "se agregó a
// Fulano").
async function contarEquipoActivo(costCenterId) {
  const [{ n }] = await query(
    'SELECT COUNT(*) AS n FROM mp_equipo_proyecto WHERE cost_center_id = ? AND is_active = 1',
    [costCenterId]
  );
  return n;
}

// ---------------------------------------------------------------
// Equipo del Proyecto (3.4) — leader agrega a sus propios centros,
// admin/ceo edita o retira a cualquiera.
// ---------------------------------------------------------------

// Fórmula de GTC (sql/33): si el alta trae SALARIO MENSUAL, el valor hora
// deja de teclearse y sale de la división (salario / 210) — así el número
// que mueve el costo de todos los proyectos tiene un origen verificable en
// vez de ser una cifra suelta. Si no trae salario se conserva el modo de
// siempre (tarifa a mano, monthly_salary NULL): hay gente contratada por
// hora o por prestación, sin salario mensual del cual dividir.
async function resolverTarifa(body) {
  const monthlySalary = Number(body.monthly_salary);
  if (monthlySalary > 0) {
    const { horasMes } = await getParametrosNomina();
    return { monthly_salary: monthlySalary, hourly_cost: valorHoraDesdeSalario(monthlySalary, horasMes) };
  }
  return { monthly_salary: null, hourly_cost: Number(body.hourly_cost) };
}

// Horas planeadas (sql/35, a pedido explícito): opcional — no todas las
// personas tienen su carga definida todavía. undefined/null/'' se guardan
// como NULL ("sin definir", distinto de 0 horas); solo un número > 0 se
// acepta, para no guardar basura como negativos o texto.
function resolverHorasPlaneadas(body) {
  if (body.planned_hours === undefined || body.planned_hours === null || body.planned_hours === '') return null;
  const horas = Number(body.planned_hours);
  return horas > 0 ? horas : null;
}

// Salario ya conocido de un talento, si lo tiene de OTRA asignación (sql/33
// solo guarda monthly_salary por fila de mp_equipo_proyecto — cada proyecto
// es una fila propia). Es a pedido explícito: "si ya tengo su sueldo real,
// no me lo vuelvas a preguntar" — al agregar a alguien a un centro nuevo, el
// front usa esto para autocompletar el salario en vez de dejarlo en blanco.
//
// Abierto a los 3 roles (14 sep 2026, a pedido explícito del dueño de la
// empresa, tras revisión de seguridad): PM, admin y CEO tienen derecho a
// ver el sueldo de cualquier persona de la empresa — no es un dato que se
// les oculte entre sí. Hubo una versión intermedia restringida a admin/ceo
// por el riesgo de que un PM enumerara employeeId 1, 2, 3... a mano y
// armara la planilla completa de sueldos sin pasar por ningún formulario;
// se revirtió porque, una vez que la política es "todos pueden ver el
// sueldo de cualquiera", ese acceso deja de ser no autorizado — es
// exactamente lo que la empresa decidió permitir. El resguardo que sí queda
// vive en el front (ver initEquipoGastoForms en costeo-equipo.js): cuando
// el sueldo YA está asignado, el campo se muestra bloqueado en vez de
// editable, para que nadie lo pise por accidente — solo se puede escribir
// la primera vez, cuando todavía no existe.
router.get('/equipo/salario-conocido/:employeeId', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId inválido' });
    const rows = await query(
      `SELECT monthly_salary FROM mp_equipo_proyecto
        WHERE employee_id = ? AND monthly_salary IS NOT NULL
        ORDER BY added_at DESC LIMIT 1`,
      [employeeId]
    );
    if (!rows.length) return res.json({ monthly_salary: null, costo_hora: null });
    const { horasMes } = await getParametrosNomina();
    const monthlySalary = Number(rows[0].monthly_salary);
    // costo_hora ya calculado (además del salario crudo): el Simulador y el
    // Plan de Recursos lo necesitan listo para usar, sin tener que pedir
    // /parametros-nomina aparte solo para dividir.
    res.json({ monthly_salary: monthlySalary, costo_hora: valorHoraDesdeSalario(monthlySalary, horasMes) });
  } catch (err) {
    next(err);
  }
});

router.get('/equipo', async (req, res, next) => {
  try {
    const costCenterId = req.query.cost_center_id ? Number(req.query.cost_center_id) : null;
    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');
    const rows = await query(
      `SELECT ep.team_member_id, ep.cost_center_id, ep.employee_id, e.canonical_name,
              ep.role_catalog, ep.hourly_cost, ep.monthly_salary, ep.planned_hours, ep.is_active, cc.project_name, cc.project_folder
         FROM mp_equipo_proyecto ep
         JOIN mp_employees e ON e.employee_id = ep.employee_id
         JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
        WHERE 1=1 ${scopeF.clause}
          ${costCenterId ? 'AND ep.cost_center_id = ?' : ''}
        ORDER BY ep.is_active DESC, e.canonical_name`,
      costCenterId ? [...scopeF.params, costCenterId] : scopeF.params
    );
    res.json({ equipo: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/equipo', async (req, res, next) => {
  try {
    const cost_center_id = Number(req.body.cost_center_id);
    const employee_id = Number(req.body.employee_id);
    const role_catalog = String(req.body.role_catalog || '');
    const { hourly_cost, monthly_salary } = await resolverTarifa(req.body);
    const planned_hours = resolverHorasPlaneadas(req.body);

    // El catalogo de cargos ya no es una lista fija en el codigo: se valida
    // contra mp_tarifa_cargo, que es donde vive de verdad (ver sql/23 y
    // POST /tarifas-cargo, que es como un PM da de alta un cargo nuevo).
    if (!cost_center_id || !employee_id || !(hourly_cost > 0) || !(await rolesValidos()).has(role_catalog)) {
      return res.status(400).json({ error: 'Datos inválidos. role_catalog debe ser un cargo existente (ver GET /tarifas-cargo). Indica el salario mensual (se divide entre las horas/mes configuradas) o un costo/hora > 0.' });
    }
    if (!(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para asignar equipo a ese centro de costos' });
    }

    const antesCount = await contarEquipoActivo(cost_center_id);
    const result = await query(
      `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, req.session.user.user_id || null]
    );
    const empRows = await query('SELECT canonical_name FROM mp_employees WHERE employee_id = ?', [employee_id]);
    const nombreRol = await nombreVisibleDeRoles();
    await logAudit({
      costCenterId: cost_center_id, entityType: 'equipo', entityId: result.insertId, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Agregó a ${empRows[0]?.canonical_name || 'talento #' + employee_id} como ${nombreRol(role_catalog)}, ${formatMoneda(hourly_cost)}/h · Equipo: ${antesCount} → ${antesCount + 1} personas`,
    });
    res.status(201).json({ team_member_id: result.insertId });
  } catch (err) {
    // uk_equipo_centro_talento (sql/17): ya existe una fila de ese talento en
    // ese centro. Se responde con el motivo real en vez de un 500 genérico —
    // si estaba inactiva, lo correcto es reactivarla desde Editar, no crear
    // otra (dos filas activas duplicarían sus horas en el cálculo de costo).
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Ese talento ya está en el equipo de este centro de costos. Si aparece inactivo, edítalo para reactivarlo.',
      });
    }
    next(err);
  }
});

// Crea un talento nuevo Y lo agrega al equipo del centro en un solo paso —
// a pedido explícito: antes había que darlo de alta desde "Gestionar
// empleados" (admin/ceo, con nombre/correo/líder/tipo de contrato) y solo
// después un PM podía asignarlo. Aquí un PM cubre el caso común (persona
// nueva que entra directo a un proyecto) sin depender de admin/ceo.
//
// Se piden menos campos que el alta completa (nombre, cargo, centro,
// costo/hora, activo) — sin correo/líder/tipo de contrato/alias, que quedan
// vacíos o con su valor por defecto y se pueden completar después desde
// "Gestionar empleados" si hace falta (p.ej. para SharePoint o alertas).
// mp_employees.email es NULL-able desde sql/24 justo para esto. Mismo
// criterio de apertura que crear cargos: no se restringe a admin/ceo.
router.post('/equipo/nueva-persona', async (req, res, next) => {
  try {
    const canonical_name = String(req.body.canonical_name || '').trim();
    // El correo es opcional aquí (a diferencia del alta completa de admin/
    // ceo en POST /api/employees): si viene, se valida el formato; si no
    // viene, se guarda NULL y se puede completar después.
    const emailBruto = req.body.email !== undefined && req.body.email !== null ? String(req.body.email).trim().toLowerCase() : '';
    if (emailBruto && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailBruto)) {
      return res.status(400).json({ error: 'El correo, si se indica, debe tener un formato válido' });
    }
    const email = emailBruto || null;
    const cost_center_id = Number(req.body.cost_center_id);
    const role_catalog = String(req.body.role_catalog || '');
    const { hourly_cost, monthly_salary } = await resolverTarifa(req.body);
    const planned_hours = resolverHorasPlaneadas(req.body);
    const is_active = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;

    if (!canonical_name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!cost_center_id || !(hourly_cost > 0) || !(await rolesValidos()).has(role_catalog)) {
      return res.status(400).json({ error: 'Datos inválidos. role_catalog debe ser un cargo existente. Indica el salario mensual (se divide entre las horas/mes configuradas) o un costo/hora > 0.' });
    }
    if (!(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para asignar equipo a ese centro de costos' });
    }

    const centroRows = await query('SELECT project_folder, project_name FROM mp_centro_costo WHERE cost_center_id = ?', [cost_center_id]);
    if (!centroRows.length) return res.status(400).json({ error: 'Centro de costos inválido' });
    const centro = centroRows[0];

    // canonical_name es UNIQUE en mp_employees (igual que en POST /api/employees):
    // una persona puede estar en varios proyectos a la vez (una fila por
    // team_member_id en mp_equipo_proyecto), así que si el nombre ya existe
    // NO es un error — es la misma persona entrando a un proyecto más. Se
    // reusa su employee_id en vez de bloquear con 409 (antes obligaba a ir a
    // buscarla al selector de Talento, un paso extra innecesario).
    const existente = await query('SELECT employee_id FROM mp_employees WHERE canonical_name = ? LIMIT 1', [canonical_name]);
    const antesCount = await contarEquipoActivo(cost_center_id);

    const resultado = await withTransaction(async (exec) => {
      let employee_id;
      let yaExistia = false;
      if (existente.length) {
        employee_id = existente[0].employee_id;
        yaExistia = true;
      } else {
        const empResult = await exec(
          `INSERT INTO mp_employees (canonical_name, email, project_folder, is_active)
           VALUES (?, ?, ?, ?)`,
          [canonical_name, email, centro.project_folder, is_active]
        );
        employee_id = empResult.insertId;
      }
      const equipoResult = await exec(
        `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, is_active, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, is_active, req.session.user.user_id || null]
      );
      return { employee_id, team_member_id: equipoResult.insertId, yaExistia };
    });

    const nombreRol = await nombreVisibleDeRoles();
    // Solo cuenta como "+1" si entra activo: si is_active viene en false,
    // el equipo activo del centro no cambió todavía.
    const equipoTexto = is_active ? ` · Equipo: ${antesCount} → ${antesCount + 1} personas` : '';
    await logAudit({
      costCenterId: cost_center_id, entityType: 'equipo', entityId: resultado.team_member_id, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: (resultado.yaExistia
        ? `Agregó a ${canonical_name} (talento existente) como ${nombreRol(role_catalog)} en "${centro.project_name}", ${formatMoneda(hourly_cost)}/h`
        : `Creó a ${canonical_name} (talento nuevo) y lo agregó como ${nombreRol(role_catalog)} en "${centro.project_name}", ${formatMoneda(hourly_cost)}/h`) + equipoTexto,
    });

    res.status(201).json(resultado);
  } catch (err) {
    // uk_equipo_centro_talento (sql/17): esa persona ya tiene una fila en ESE
    // centro puntual (activa o inactiva) — ahí sí hay que editar en vez de
    // crear otra, para no duplicar sus horas en el cálculo de costo.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Ese talento ya está en el equipo de este centro de costos. Si aparece inactivo, edítalo para reactivarlo.',
      });
    }
    next(err);
  }
});

// El PM también puede editar el equipo de su(s) proyecto(s).
router.put('/equipo/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const actual = await query(
      `SELECT ep.*, e.canonical_name FROM mp_equipo_proyecto ep
        JOIN mp_employees e ON e.employee_id = ep.employee_id
       WHERE ep.team_member_id = ?`,
      [id]
    );
    if (!actual.length) return res.status(404).json({ error: 'Integrante no encontrado' });
    if (!(await canWriteCenter(req.scope, actual[0].cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const fields = [];
    const params = [];
    // El salario manda sobre el costo/hora tecleado: si la edición trae
    // monthly_salary > 0, el valor hora se RECALCULA con la fórmula y se
    // ignora lo que venga en hourly_cost. Mandar los dos y que ganara el
    // tecleado dejaría en pantalla un salario que no corresponde a la
    // tarifa con la que se está costeando. monthly_salary = 0 o null es la
    // forma de volver al modo manual.
    if (req.body.monthly_salary !== undefined && Number(req.body.monthly_salary) > 0) {
      const salario = Number(req.body.monthly_salary);
      const { horasMes } = await getParametrosNomina();
      fields.push('monthly_salary = ?'); params.push(salario);
      fields.push('hourly_cost = ?'); params.push(valorHoraDesdeSalario(salario, horasMes));
    } else {
      if (req.body.monthly_salary !== undefined) { fields.push('monthly_salary = ?'); params.push(null); }
      if (req.body.hourly_cost !== undefined) { fields.push('hourly_cost = ?'); params.push(Number(req.body.hourly_cost) || 0); }
    }
    if (req.body.role_catalog !== undefined) {
      if (!(await rolesValidos()).has(req.body.role_catalog)) return res.status(400).json({ error: 'role_catalog inválido' });
      fields.push('role_catalog = ?'); params.push(req.body.role_catalog);
    }
    if (req.body.planned_hours !== undefined) {
      fields.push('planned_hours = ?'); params.push(resolverHorasPlaneadas(req.body));
    }
    // Mover a un integrante de proyecto: hay que poder escribir en el centro
    // destino, igual que al darlo de alta (POST /equipo).
    if (req.body.cost_center_id !== undefined) {
      const destino = Number(req.body.cost_center_id);
      if (!destino) return res.status(400).json({ error: 'cost_center_id inválido' });
      if (!(await canWriteCenter(req.scope, destino))) {
        return res.status(403).json({ error: 'No tienes permiso para mover equipo a ese centro de costos' });
      }
      fields.push('cost_center_id = ?'); params.push(destino);
    }
    if (req.body.is_active !== undefined) {
      const active = req.body.is_active ? 1 : 0;
      fields.push('is_active = ?'); params.push(active);
      fields.push('removed_at = ?'); params.push(active ? null : new Date());
    }
    if (!fields.length) return res.json({ updated: 0 });

    // Cuenta ANTES del UPDATE, solo cuando is_active de verdad va a cambiar
    // (eliminar/reactivar) — es lo único que mueve el tamaño del equipo.
    const antesToggle = actual[0];
    const vaAEliminar = req.body.is_active === false && antesToggle.is_active;
    const vaAReactivar = req.body.is_active === true && !antesToggle.is_active;
    const antesCount = (vaAEliminar || vaAReactivar) ? await contarEquipoActivo(antesToggle.cost_center_id) : null;

    params.push(id);
    const result = await query(`UPDATE mp_equipo_proyecto SET ${fields.join(', ')} WHERE team_member_id = ?`, params);

    if (result.affectedRows) {
      const antes = actual[0];
      let action = 'editar';
      if (vaAEliminar) action = 'eliminar';
      else if (vaAReactivar) action = 'reactivar';
      const nombreRol = await nombreVisibleDeRoles();
      const desc = describirCambios(antes, req.body, {
        hourly_cost: 'Costo/hora', monthly_salary: 'Salario mensual', role_catalog: 'Cargo',
        cost_center_id: 'Centro de costos', is_active: 'Activo', planned_hours: 'Horas planeadas',
      }, {
        is_active: (v) => (v ? 'Sí' : 'No'), role_catalog: nombreRol,
        // Con puntos de miles: "8338 → 10000" es ilegible al lado de
        // "$ 8.338 → $ 10.000" (7 sep 2026, a pedido explícito).
        hourly_cost: formatMoneda, monthly_salary: formatMoneda,
      });
      // Equipo: N → M personas, solo cuando is_active de verdad cambió.
      const equipoTexto = vaAEliminar ? ` · Equipo: ${antesCount} → ${antesCount - 1} personas`
        : vaAReactivar ? ` · Equipo: ${antesCount} → ${antesCount + 1} personas` : '';
      await logAudit({
        costCenterId: req.body.cost_center_id !== undefined ? Number(req.body.cost_center_id) : antes.cost_center_id,
        entityType: 'equipo', entityId: id, action,
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `${antes.canonical_name}: ${desc}${equipoTexto}`,
      });
    }
    res.json({ updated: result.affectedRows });
  } catch (err) {
    // Mismo caso que en POST /equipo, pero al mover de centro: el talento ya
    // tiene una fila en el centro destino (uk_equipo_centro_talento, sql/17).
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Ese talento ya está en el equipo del centro de costos destino.',
      });
    }
    next(err);
  }
});

// Borrado DE VERDAD, distinto de inactivar (16 sep 2026, a pedido explícito).
//
// Hasta ahora el botón "Eliminar" de la pantalla mandaba is_active:false, o
// sea que decía "eliminar" y solo desactivaba. Son dos cosas distintas y
// ahora existen las dos:
//
//   Inactivar (PUT is_active:false) -> la persona sigue ahí, deja de contar
//     para alertas y costos (el motor filtra por is_active) y se puede
//     reactivar el día que vuelva.
//   Eliminar (esto)                 -> desaparece. Solo se permite si NO
//     dejó rastro en ningún sitio.
//
// La condición no es un capricho: mp_costeo_task_facts NO tiene clave
// foránea contra mp_employees, así que la base dejaría borrar a alguien con
// 749 filas de horas colgando y NADIE se enteraría — las horas quedarían sin
// dueño y el costo ejecutado de los meses ya cerrados cambiaría solo. Y el
// catálogo mp_employees lo comparte Planeación, que tiene 93.205 filas de 27
// personas: un borrado aquí puede romper un módulo que ni siquiera es este.
// Por eso, si hay historia, se rechaza y se explica en vez de borrar.
async function historiaDe(employeeId, teamMemberId) {
  const [costeo, planeacion, extras, plan, otrosEquipos] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM mp_costeo_task_facts WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_task_facts WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_overtime_decisions WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_plan_recursos WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_equipo_proyecto WHERE employee_id = ? AND team_member_id <> ?', [employeeId, teamMemberId]),
  ]);
  return {
    horasCosteo: Number(costeo[0].n),
    horasPlaneacion: Number(planeacion[0].n),
    horasExtra: Number(extras[0].n),
    planRecursos: Number(plan[0].n),
    otrosEquipos: Number(otrosEquipos[0].n),
  };
}

router.delete('/equipo/:id', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });

    const filas = await query(
      `SELECT ep.team_member_id, ep.employee_id, ep.cost_center_id, e.canonical_name
         FROM mp_equipo_proyecto ep
         JOIN mp_employees e ON e.employee_id = ep.employee_id
        WHERE ep.team_member_id = ?`,
      [id]
    );
    if (!filas.length) return res.status(404).json({ error: 'Integrante no encontrado' });
    const integrante = filas[0];

    if (!(await canWriteCenter(req.scope, integrante.cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const h = await historiaDe(integrante.employee_id, id);
    // Se enumera lo que SÍ tiene, no un "no se puede" a secas: quien lo lee
    // necesita saber por qué y qué hacer en su lugar.
    const motivos = [];
    if (h.horasCosteo) motivos.push(`${h.horasCosteo} registro(s) de horas en Costeo`);
    if (h.horasPlaneacion) motivos.push(`${h.horasPlaneacion} registro(s) de horas en Planeación`);
    if (h.horasExtra) motivos.push(`${h.horasExtra} hora(s) extra`);
    if (h.planRecursos) motivos.push(`${h.planRecursos} línea(s) de plan de recursos`);
    if (h.otrosEquipos) motivos.push(`${h.otrosEquipos} asignación(es) en otros proyectos`);

    if (motivos.length) {
      return res.status(409).json({
        error: `No se puede eliminar a ${integrante.canonical_name}: ya tiene ${motivos.join(', ')}. `
          + 'Borrarla dejaría esos datos sin dueño y cambiaría el costo ya calculado de meses cerrados. '
          + 'Usa "Inactivar": deja de contar para alertas y costos, y se puede reactivar si vuelve.',
        historia: h,
      });
    }

    // Sin rastro en ningún lado: se va del todo, también del catálogo de
    // personas. Es el caso del alta por error o de quien nunca llegó a
    // reportar nada.
    await withTransaction(async (exec) => {
      await exec('DELETE FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
      await exec('DELETE FROM mp_employees WHERE employee_id = ?', [integrante.employee_id]);
    });

    await logAudit({
      costCenterId: integrante.cost_center_id, entityType: 'equipo', entityId: id, action: 'eliminar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Eliminó del sistema a ${integrante.canonical_name} (no tenía ningún movimiento registrado)`,
    });

    res.json({ deleted: true, canonical_name: integrante.canonical_name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
