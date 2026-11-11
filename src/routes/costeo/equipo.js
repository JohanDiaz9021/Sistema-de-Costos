'use strict';

/**
 * Equipo del Proyecto (3.4) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { query, withTransaction } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit, describirCambios, formatMoneda } = require('../../queries/costo-audit');
const { rolesValidos, canWriteCenter, nombreVisibleDeRoles } = require('./_shared');
const { getParametrosNomina, valorHoraDesdeSalario } = require('../../queries/costo-recargos');
const { sincronizarPlanDesdeEquipo } = require('../../queries/costo-plan-recursos');

// Después de tocar el equipo de uno o varios centros, deja su Plan de
// Recursos al día (ver sincronizarPlanDesdeEquipo). Si falla, el cambio en
// Equipo del Proyecto ya quedó guardado: se anota y no se tumba la respuesta.
async function alDiaElPlan(...centros) {
  for (const c of new Set(centros.filter(Boolean).map(Number))) {
    try {
      await sincronizarPlanDesdeEquipo(c);
    } catch (err) {
      console.error(`[equipo] no se pudo sincronizar el plan del centro ${c}:`, err.message);
    }
  }
}

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

// Personas SIN proyecto todavía (sql/45, 16 oct 2026): un PM puede dar de
// alta a alguien con su cargo y salario antes de que exista el proyecto al
// que va, y asignárselo después desde Editar.
//
// Desde el 21 oct 2026 (a pedido explícito) "Sin proyecto" es la BOLSA
// común de la empresa: todos los trabajadores entran ahí y cada PM toma a
// los que necesita para sus proyectos. Por eso cualquier PM ve y puede
// editar (asignar) una fila sin proyecto — el centro destino sigue pasando
// por canWriteCenter. Borrarla sigue siendo de quien la agregó, el admin y
// el CEO (puedeTocarFila): borrar saca a la persona del sistema para todos.
function centroOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

async function puedeEditarFila(req, fila) {
  if (fila.cost_center_id === null || fila.cost_center_id === undefined) return true;
  return canWriteCenter(req.scope, fila.cost_center_id);
}

async function puedeTocarFila(req, fila) {
  if (fila.cost_center_id === null || fila.cost_center_id === undefined) {
    return req.scope.allowedProjects === null
      || Number(fila.added_by) === Number(req.session.user.user_id);
  }
  return canWriteCenter(req.scope, fila.cost_center_id);
}

// Una sola fila sin proyecto por persona: la llave única de sql/17 no lo
// impide porque MySQL no compara NULLs entre sí.
async function yaEstaSinProyecto(employeeId) {
  const rows = await query(
    'SELECT team_member_id FROM mp_equipo_proyecto WHERE employee_id = ? AND cost_center_id IS NULL LIMIT 1',
    [employeeId]
  );
  return rows.length > 0;
}

const MENSAJE_YA_SIN_PROYECTO = 'Esa persona ya está registrada sin proyecto. Edítala para asignarle uno.';

// Sin proyecto se puede registrar a alguien sin salario ni costo/hora
// todavía; para asignarle un proyecto hace falta, porque de ahí sale lo que
// cuesta (16 oct 2026, a pedido explícito).
const MENSAJE_FALTA_SALARIO = 'Para asignarle un proyecto, primero escribe su salario mensual: el costo/hora se calcula solo.';

// El salario más reciente que tenga la persona en cualquier fila, o null.
async function salarioConocido(employeeId) {
  const rows = await query(
    `SELECT monthly_salary FROM mp_equipo_proyecto
      WHERE employee_id = ? AND monthly_salary IS NOT NULL
      ORDER BY added_at DESC LIMIT 1`,
    [employeeId]
  );
  return rows.length ? Number(rows[0].monthly_salary) : null;
}

// Al darle su PRIMER proyecto a alguien que estaba "Sin proyecto", esa fila
// se convierte en el proyecto en vez de quedar al lado (16 oct 2026,
// reportado por el usuario: Johan salía "Sin proyecto" y "Leads" a la vez).
// Si después lo agregan a otro proyecto, ya no hay fila sin proyecto y se
// crea una nueva, como siempre. Se puede pasar `exec` de una transacción.
// Devuelve el team_member_id reutilizado, o null si no había ninguna.
async function convertirFilaSinProyecto(exec, { employeeId, costCenterId, roleCatalog, hourlyCost, monthlySalary, plannedHours, isActive = 1 }) {
  const filas = await exec(
    'SELECT team_member_id FROM mp_equipo_proyecto WHERE employee_id = ? AND cost_center_id IS NULL LIMIT 1',
    [employeeId]
  );
  if (!filas.length) return null;
  const id = filas[0].team_member_id;
  await exec(
    `UPDATE mp_equipo_proyecto
        SET cost_center_id = ?, role_catalog = ?, hourly_cost = ?, monthly_salary = COALESCE(?, monthly_salary),
            planned_hours = ?, is_active = ?, removed_at = NULL
      WHERE team_member_id = ?`,
    [costCenterId, roleCatalog, hourlyCost, monthlySalary, plannedHours, isActive, id]
  );
  return id;
}

// Un solo salario por persona (16 oct 2026, a pedido explícito): cuando se
// guarda un salario mensual para alguien, reemplaza al anterior en TODAS sus
// otras asignaciones que se costean por salario. Antes el formulario lo
// bloqueaba para que nadie lo cambiara sin querer; ahora se puede cambiar, y
// esto mantiene la misma cifra en todos los proyectos de la misma persona.
// Las filas con costo/hora escrito a mano (monthly_salary NULL) no se tocan:
// esa gente no se costea por salario.
async function actualizarSalarioEnSusProyectos(req, { employeeId, teamMemberId, monthlySalary, hourlyCost, nombre }) {
  if (!(monthlySalary > 0)) return 0;
  const r = await query(
    `UPDATE mp_equipo_proyecto SET monthly_salary = ?, hourly_cost = ?
      WHERE employee_id = ? AND team_member_id <> ?
        AND monthly_salary IS NOT NULL AND monthly_salary <> ?`,
    [monthlySalary, hourlyCost, employeeId, teamMemberId, monthlySalary]
  );
  const n = r && typeof r.affectedRows === 'number' ? r.affectedRows : 0;
  if (n) {
    await logAudit({
      costCenterId: null, entityType: 'equipo', entityId: teamMemberId, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Actualizó el salario de ${nombre || 'talento #' + employeeId} a ${formatMoneda(monthlySalary)} (${formatMoneda(hourlyCost)}/h) en ${n} proyecto(s) más`,
    });
  }
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
    // LEFT JOIN: las personas sin proyecto (sql/45) no tienen centro.
    //
    // Un PM ve a TODOS los trabajadores con el nombre de su(s) proyecto(s)
    // (21 oct 2026, a pedido explícito), para poder sumarlos también a uno
    // suyo — una persona puede estar en varios proyectos. De las filas de
    // proyectos ajenos solo ve quién, qué cargo y en qué proyecto
    // (ajeno = 1): el costo/hora, el salario y las horas planeadas de un
    // proyecto que no es suyo se le mandan vacíos, y no las puede editar
    // (puedeEditarFila). Su bolsa "Sin proyecto" y sus proyectos, completos.
    const rows = await query(
      `SELECT ep.team_member_id, ep.cost_center_id, ep.employee_id, e.canonical_name,
              ep.role_catalog, ep.hourly_cost, ep.monthly_salary, ep.planned_hours, ep.is_active, ep.added_by,
              cc.project_name, cc.project_folder
         FROM mp_equipo_proyecto ep
         JOIN mp_employees e ON e.employee_id = ep.employee_id
         LEFT JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
        WHERE 1=1
          ${costCenterId ? 'AND ep.cost_center_id = ?' : ''}
        ORDER BY ep.is_active DESC, e.canonical_name`,
      costCenterId ? [costCenterId] : []
    );
    if (req.scope.allowedProjects === null) return res.json({ equipo: rows });
    const propios = new Set(req.scope.allowedProjects);
    res.json({
      equipo: rows.map((m) => (m.cost_center_id === null || propios.has(m.project_folder)
        ? { ...m, ajeno: 0 }
        : { ...m, hourly_cost: null, monthly_salary: null, planned_hours: null, added_by: null, ajeno: 1 })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/equipo', async (req, res, next) => {
  try {
    // Sin centro = la persona queda registrada SIN proyecto (sql/45).
    const cost_center_id = centroOpcional(req.body.cost_center_id);
    const employee_id = Number(req.body.employee_id);
    const role_catalog = String(req.body.role_catalog || '');
    // Con proyecto y sin salario en el alta, se usa el que ya tenga la persona.
    const salarioDelAlta = Number(req.body.monthly_salary) > 0 ? Number(req.body.monthly_salary)
      : (cost_center_id && employee_id ? await salarioConocido(employee_id) : null);
    const { hourly_cost: hourlyCrudo, monthly_salary } = await resolverTarifa({ ...req.body, monthly_salary: salarioDelAlta });
    const hourly_cost = Number.isFinite(hourlyCrudo) && hourlyCrudo > 0 ? hourlyCrudo : 0;
    const planned_hours = resolverHorasPlaneadas(req.body);

    // El catalogo de cargos ya no es una lista fija en el codigo: se valida
    // contra mp_tarifa_cargo, que es donde vive de verdad (ver sql/23 y
    // POST /tarifas-cargo, que es como un PM da de alta un cargo nuevo).
    if (Number.isNaN(cost_center_id) || !employee_id || !(await rolesValidos()).has(role_catalog)) {
      return res.status(400).json({ error: 'Datos inválidos. Elige un talento y un cargo existente.' });
    }
    if (cost_center_id && !(hourly_cost > 0)) {
      return res.status(400).json({ error: MENSAJE_FALTA_SALARIO });
    }
    if (cost_center_id && !(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para asignar equipo a ese centro de costos' });
    }
    if (!cost_center_id && await yaEstaSinProyecto(employee_id)) {
      return res.status(409).json({ error: MENSAJE_YA_SIN_PROYECTO });
    }

    const antesCount = cost_center_id ? await contarEquipoActivo(cost_center_id) : null;
    const reutilizada = cost_center_id
      ? await convertirFilaSinProyecto(query, {
        employeeId: employee_id, costCenterId: cost_center_id, roleCatalog: role_catalog,
        hourlyCost: hourly_cost, monthlySalary: monthly_salary, plannedHours: planned_hours,
      })
      : null;
    const result = reutilizada
      ? { insertId: reutilizada }
      : await query(
        `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, req.session.user.user_id || null]
      );
    const empRows = await query('SELECT canonical_name FROM mp_employees WHERE employee_id = ?', [employee_id]);
    const nombreRol = await nombreVisibleDeRoles();
    await logAudit({
      costCenterId: cost_center_id, entityType: 'equipo', entityId: result.insertId, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: cost_center_id
        ? `Agregó a ${empRows[0]?.canonical_name || 'talento #' + employee_id} como ${nombreRol(role_catalog)}, ${formatMoneda(hourly_cost)}/h · Equipo: ${antesCount} → ${antesCount + 1} personas`
        : `Registró a ${empRows[0]?.canonical_name || 'talento #' + employee_id} SIN proyecto todavía, como ${nombreRol(role_catalog)}, ${formatMoneda(hourly_cost)}/h`,
    });
    await actualizarSalarioEnSusProyectos(req, {
      employeeId: employee_id, teamMemberId: result.insertId, monthlySalary: monthly_salary, hourlyCost: hourly_cost,
      nombre: empRows[0]?.canonical_name,
    });
    await alDiaElPlan(cost_center_id);
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
    // Sin centro = la persona queda registrada SIN proyecto (sql/45).
    const cost_center_id = centroOpcional(req.body.cost_center_id);
    const role_catalog = String(req.body.role_catalog || '');
    const { hourly_cost: hourlyCrudo, monthly_salary } = await resolverTarifa(req.body);
    const hourly_cost = Number.isFinite(hourlyCrudo) && hourlyCrudo > 0 ? hourlyCrudo : 0;
    const planned_hours = resolverHorasPlaneadas(req.body);
    const is_active = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;

    if (!canonical_name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (Number.isNaN(cost_center_id) || !(await rolesValidos()).has(role_catalog)) {
      return res.status(400).json({ error: 'Datos inválidos. Elige un cargo existente.' });
    }
    if (cost_center_id && !(hourly_cost > 0)) {
      return res.status(400).json({ error: MENSAJE_FALTA_SALARIO });
    }
    if (cost_center_id && !(await canWriteCenter(req.scope, cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso para asignar equipo a ese centro de costos' });
    }

    let centro = null;
    if (cost_center_id) {
      const centroRows = await query('SELECT project_folder, project_name FROM mp_centro_costo WHERE cost_center_id = ?', [cost_center_id]);
      if (!centroRows.length) return res.status(400).json({ error: 'Centro de costos inválido' });
      centro = centroRows[0];
    }

    // canonical_name es UNIQUE en mp_employees (igual que en POST /api/employees):
    // una persona puede estar en varios proyectos a la vez (una fila por
    // team_member_id en mp_equipo_proyecto), así que si el nombre ya existe
    // NO es un error — es la misma persona entrando a un proyecto más. Se
    // reusa su employee_id en vez de bloquear con 409 (antes obligaba a ir a
    // buscarla al selector de Talento, un paso extra innecesario).
    const existente = await query('SELECT employee_id FROM mp_employees WHERE canonical_name = ? LIMIT 1', [canonical_name]);
    if (!cost_center_id && existente.length && await yaEstaSinProyecto(existente[0].employee_id)) {
      return res.status(409).json({ error: MENSAJE_YA_SIN_PROYECTO });
    }
    const antesCount = cost_center_id ? await contarEquipoActivo(cost_center_id) : null;

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
          [canonical_name, email, centro ? centro.project_folder : null, is_active]
        );
        employee_id = empResult.insertId;
      }
      const reutilizada = yaExistia && cost_center_id
        ? await convertirFilaSinProyecto(exec, {
          employeeId: employee_id, costCenterId: cost_center_id, roleCatalog: role_catalog,
          hourlyCost: hourly_cost, monthlySalary: monthly_salary, plannedHours: planned_hours, isActive: is_active,
        })
        : null;
      if (reutilizada) return { employee_id, team_member_id: reutilizada, yaExistia };
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
    const equipoTexto = is_active && centro ? ` · Equipo: ${antesCount} → ${antesCount + 1} personas` : '';
    const donde = centro ? `en "${centro.project_name}"` : 'SIN proyecto todavía';
    await logAudit({
      costCenterId: cost_center_id, entityType: 'equipo', entityId: resultado.team_member_id, action: 'crear',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: (resultado.yaExistia
        ? `Agregó a ${canonical_name} (talento existente) como ${nombreRol(role_catalog)} ${donde}, ${formatMoneda(hourly_cost)}/h`
        : `Creó a ${canonical_name} (talento nuevo) y lo agregó como ${nombreRol(role_catalog)} ${donde}, ${formatMoneda(hourly_cost)}/h`) + equipoTexto,
    });

    await alDiaElPlan(cost_center_id);
    if (resultado.yaExistia) {
      await actualizarSalarioEnSusProyectos(req, {
        employeeId: resultado.employee_id, teamMemberId: resultado.team_member_id,
        monthlySalary: monthly_salary, hourlyCost: hourly_cost, nombre: canonical_name,
      });
    }
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
    if (!(await puedeEditarFila(req, actual[0]))) {
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
      // Vaciar el salario: el costo/hora sale del salario (16 oct 2026), así
      // que sin salario no hay costo/hora — y quien está en un proyecto no
      // puede quedarse sin él.
      const quedaEnProyecto = req.body.cost_center_id !== undefined ? !!Number(req.body.cost_center_id) : actual[0].cost_center_id !== null;
      if (req.body.monthly_salary !== undefined) {
        if (quedaEnProyecto && req.body.hourly_cost === undefined) {
          return res.status(400).json({ error: MENSAJE_FALTA_SALARIO });
        }
        fields.push('monthly_salary = ?'); params.push(null);
        if (req.body.hourly_cost === undefined) { fields.push('hourly_cost = ?'); params.push(0); }
      }
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
    // Sacar del proyecto: "Ninguno" en el Centro de Costos (16 oct 2026, a
    // pedido explícito). Si la persona sigue en OTROS proyectos, solo sale
    // de este (se borra esta asignación); si este era el único, queda "Sin
    // proyecto" — con su alerta contando desde hoy, a nombre de quien la
    // sacó.
    //
    // No se permite si ya tiene horas cargadas en este proyecto: el costo de
    // esas horas sale de esta asignación (costo-motor.js) y sacarla las
    // dejaría en $0. Para eso está Inactivar, que conserva el registro.
    const sacarDelProyecto = (req.body.cost_center_id === null || req.body.cost_center_id === '')
      && actual[0].cost_center_id !== null;
    if (sacarDelProyecto) {
      const [{ n: horas }] = await query(
        `SELECT COUNT(*) AS n FROM mp_costeo_task_facts t
           JOIN mp_centro_costo cc ON cc.cost_center_id = ?
          WHERE t.employee_id = ? AND (t.project_name = cc.project_name OR t.project_name = cc.project_folder)`,
        [actual[0].cost_center_id, actual[0].employee_id]
      );
      if (Number(horas) > 0) {
        return res.status(409).json({
          error: `${actual[0].canonical_name} ya tiene ${horas} registro(s) de horas en este proyecto: sacarla las dejaría sin costo. Usa "Inactivar".`,
        });
      }
      const [{ n: otros }] = await query(
        `SELECT COUNT(*) AS n FROM mp_equipo_proyecto
          WHERE employee_id = ? AND team_member_id <> ? AND cost_center_id IS NOT NULL AND is_active = 1`,
        [actual[0].employee_id, id]
      );
      const antesCount = await contarEquipoActivo(actual[0].cost_center_id);
      if (Number(otros) > 0) {
        await query('DELETE FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
      } else {
        if (await yaEstaSinProyecto(actual[0].employee_id)) {
          return res.status(409).json({ error: MENSAJE_YA_SIN_PROYECTO });
        }
        // Con los demás cambios de esta misma edición (cargo, salario...).
        await query(
          `UPDATE mp_equipo_proyecto SET ${[...fields, 'cost_center_id = NULL', 'added_at = NOW()', 'added_by = ?'].join(', ')}
            WHERE team_member_id = ?`,
          [...params, req.session.user.user_id || null, id]
        );
      }
      await logAudit({
        costCenterId: actual[0].cost_center_id, entityType: 'equipo', entityId: id, action: 'eliminar',
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `Sacó a ${actual[0].canonical_name} del proyecto${Number(otros) > 0 ? '' : ' (queda "Sin proyecto")'} · Equipo: ${antesCount} → ${Math.max(0, antesCount - (actual[0].is_active ? 1 : 0))} personas`,
      });
      await alDiaElPlan(actual[0].cost_center_id);
      return res.json({ updated: 1, sin_proyecto: !(Number(otros) > 0) });
    }

    if (req.body.cost_center_id !== undefined && req.body.cost_center_id !== null && req.body.cost_center_id !== '') {
      const destino = Number(req.body.cost_center_id);
      if (!destino) return res.status(400).json({ error: 'cost_center_id inválido' });
      // Pasar de "Sin proyecto" a un proyecto exige tarifa: la que traiga
      // esta misma edición o la que ya tuviera la fila.
      const salarioEdicion = Number(req.body.monthly_salary) > 0;
      const tarifaEdicion = req.body.hourly_cost !== undefined && Number(req.body.hourly_cost) > 0;
      if (actual[0].cost_center_id === null && !salarioEdicion && !tarifaEdicion && !(Number(actual[0].hourly_cost) > 0)) {
        return res.status(400).json({ error: MENSAJE_FALTA_SALARIO });
      }
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
    const antesCount = (vaAEliminar || vaAReactivar) && antesToggle.cost_center_id
      ? await contarEquipoActivo(antesToggle.cost_center_id) : null;

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
      const equipoTexto = antesCount === null ? ''
        : vaAEliminar ? ` · Equipo: ${antesCount} → ${antesCount - 1} personas`
          : vaAReactivar ? ` · Equipo: ${antesCount} → ${antesCount + 1} personas` : '';
      await logAudit({
        costCenterId: req.body.cost_center_id !== undefined ? Number(req.body.cost_center_id) : antes.cost_center_id,
        entityType: 'equipo', entityId: id, action,
        userId: req.session.user.user_id, userName: req.session.user.full_name,
        description: `${antes.canonical_name}: ${desc}${equipoTexto}`,
      });
      if (req.body.monthly_salary !== undefined && Number(req.body.monthly_salary) > 0) {
        const salario = Number(req.body.monthly_salary);
        const { horasMes } = await getParametrosNomina();
        await actualizarSalarioEnSusProyectos(req, {
          employeeId: antes.employee_id, teamMemberId: id, monthlySalary: salario,
          hourlyCost: valorHoraDesdeSalario(salario, horasMes), nombre: antes.canonical_name,
        });
      }
    }
    await alDiaElPlan(actual[0].cost_center_id, req.body.cost_center_id);
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
//   Inactivar (PUT is_active:false) -> la persona sigue ahí, sale de las
//     alertas y del plan, y se puede reactivar el día que vuelva. Sus horas
//     ya trabajadas siguen siendo costo del proyecto (desde el 10 nov 2026
//     el motor ya no filtra por is_active).
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
async function historiaDe(employeeId, teamMemberId, costCenterId = null) {
  const [costeo, planeacion, extras, plan, otrosEquipos] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM mp_costeo_task_facts WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_task_facts WHERE employee_id = ?', [employeeId]),
    query('SELECT COUNT(*) AS n FROM mp_overtime_decisions WHERE employee_id = ?', [employeeId]),
    // Su línea en el plan de ESTE mismo proyecto no cuenta: es el reflejo de
    // esta asignación (sincronizarPlanDesdeEquipo) y se borra con ella.
    query('SELECT COUNT(*) AS n FROM mp_plan_recursos WHERE employee_id = ? AND NOT (cost_center_id <=> ?)', [employeeId, costCenterId]),
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
      `SELECT ep.team_member_id, ep.employee_id, ep.cost_center_id, ep.added_by, e.canonical_name
         FROM mp_equipo_proyecto ep
         JOIN mp_employees e ON e.employee_id = ep.employee_id
        WHERE ep.team_member_id = ?`,
      [id]
    );
    if (!filas.length) return res.status(404).json({ error: 'Integrante no encontrado' });
    const integrante = filas[0];

    if (!(await puedeTocarFila(req, integrante))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    const h = await historiaDe(integrante.employee_id, id, integrante.cost_center_id);
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
          + 'Usa "Inactivar": sale de las alertas y del plan, sus horas siguen contando como costo del proyecto, y se puede reactivar si vuelve.',
        historia: h,
      });
    }

    // Sin rastro en ningún lado: se va del todo, también del catálogo de
    // personas. Es el caso del alta por error o de quien nunca llegó a
    // reportar nada.
    await withTransaction(async (exec) => {
      await exec('DELETE FROM mp_plan_recursos WHERE employee_id = ?', [integrante.employee_id]);
      await exec('DELETE FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
      await exec('DELETE FROM mp_employees WHERE employee_id = ?', [integrante.employee_id]);
    });

    await logAudit({
      costCenterId: integrante.cost_center_id, entityType: 'equipo', entityId: id, action: 'eliminar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Eliminó del sistema a ${integrante.canonical_name} (no tenía ningún movimiento registrado)`,
    });

    await alDiaElPlan(integrante.cost_center_id);
    res.json({ deleted: true, canonical_name: integrante.canonical_name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
