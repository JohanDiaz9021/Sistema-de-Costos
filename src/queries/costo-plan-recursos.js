'use strict';

/**
 * Plan de Recursos (sql/27) — el presupuesto de un centro de costos
 * calculado, no escrito a mano: por cada rol, cuántas personas, cuántas
 * horas totales del proyecto necesita, y a qué costo/hora. sql/29 le suma
 * gastos iniciales sueltos (licencias, viáticos de arranque...): partidas
 * con nombre y valor que no son mano de obra, pero sí presupuesto conocido
 * de antemano.
 *
 *   Presupuesto = Σ (personas × horas_totales × costo_hora) + Σ (gastos)
 *
 * Un centro sin plan guardado sigue con presupuesto editable a mano (ver
 * PUT /centros/:id en centros.js) — esto es estrictamente opcional. Los
 * gastos son opcionales incluso con el plan activo (basta con la mano de
 * obra) — el array puede llegar vacío.
 */

const { query, withTransaction } = require('../db');
const { getParametrosNomina, valorHoraDesdeSalario } = require('./costo-recargos');

// Suma pura, separada de la escritura para poder probarla sin base de
// datos. "horas_totales" es el total del proyecto para ese rol (no
// semanal) — a diferencia de "Horas/sem c/u" del Simulador de Comercial.
function calcularPresupuestoPlan(filas, gastos = []) {
  const totalFilas = filas.reduce(
    (s, f) => s + (Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0),
    0
  );
  const totalGastos = gastos.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  return Number((totalFilas + totalGastos).toFixed(2));
}

// Salario conocido de cada talento (ya calculado a costo/hora), buscando su
// asignación más reciente CON salario en cualquier proyecto — igual que
// GET /equipo/salario-conocido, pero para uso interno del servidor (aquí no
// se puede confiar en lo que mande el cliente: sql/34 dice que en una fila
// "por Persona" el costo/hora SIEMPRE sale de esta consulta, nunca del
// body). Un employee_id ausente del Map devuelto significa que esa persona
// no tiene salario cargado en ningún lado.
//
// UNA sola consulta para todos los employee_id de la fila plan, no una por
// fila (14 sep 2026, corregido tras revisión de código: validarFilasPlan la
// llamaba dentro del loop, un N+1 real en un plan con muchas filas "por
// Persona"). ORDER BY employee_id, added_at DESC agrupa las filas de cada
// persona juntas con la más reciente primero, así que basta con quedarse
// con la PRIMERA fila que se vea de cada employee_id.
async function obtenerCostoHoraPersonas(employeeIds) {
  const mapa = new Map();
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return mapa;

  const placeholders = ids.map(() => '?').join(',');
  const rows = await query(
    `SELECT employee_id, monthly_salary FROM mp_equipo_proyecto
      WHERE employee_id IN (${placeholders}) AND monthly_salary IS NOT NULL
      ORDER BY employee_id, added_at DESC`,
    ids
  );
  const { horasMes } = await getParametrosNomina();
  for (const r of rows) {
    if (mapa.has(r.employee_id)) continue;
    mapa.set(r.employee_id, valorHoraDesdeSalario(Number(r.monthly_salary), horasMes));
  }
  return mapa;
}

// Valida y normaliza las filas crudas que llegan del cliente (PUT
// /plan-recursos y POST /centros con plan_recursos incluido comparten esta
// misma regla: no tiene sentido que un centro nuevo pueda entrar con un
// plan que uno ya existente rechazaría). `roles` es el Set que devuelve
// rolesValidos() — se recibe ya resuelto para no golpear la base dos veces
// cuando el caller también lo necesita para otra cosa.
//
// Dos modos por fila (sql/34), según traiga employee_id o no:
//   "por Cargo"    (employee_id ausente): igual que siempre — personas,
//                  horas_totales y costo_hora se escriben a mano, y cada
//                  cargo puede aparecer una sola vez en el plan.
//   "por Persona"  (employee_id presente): personas queda fijo en 1 (es
//                  ESA persona), y costo_hora NUNCA se toma del body — se
//                  recalcula aquí desde su salario conocido, para que no
//                  pueda quedar una cifra inventada a nombre de alguien
//                  real.
//
//                  Si esa persona NO tiene salario conocido en ningún
//                  proyecto (2 sep 2026, a pedido explícito — antes esto
//                  rechazaba la fila sin más salida): se acepta un
//                  `monthly_salary` en la fila, igual de confiable que el
//                  que ya se le pide a POST /equipo cuando alguien se da de
//                  alta ahí — es la MISMA acción (registrar el sueldo real
//                  de alguien), solo que ahora se puede hacer sin que el
//                  proyecto donde va a trabajar exista todavía. Antes el
//                  único lugar para escribir un salario era "Equipo del
//                  Proyecto", que exige un cost_center_id ya creado — un PM
//                  armando un proyecto NUEVO con una persona real que nunca
//                  ha estado en ningún otro no tenía cómo hacerlo sin
//                  meterla primero a un proyecto ajeno solo para poder
//                  ponerle el sueldo. La fila queda marcada con
//                  `salarioNuevo`: quien la reciba (crearEquipoDesdeFilasPlanTx,
//                  más abajo) sabe que tiene que darla de alta también en
//                  Equipo del Proyecto, no solo en el plan.
async function validarFilasPlan(filasCrudas, roles) {
  const filas = [];
  const empleadosVistos = new Set();
  const rolesCargoVistos = new Set();

  const idsConEmployee = filasCrudas
    .map((f) => (f.employee_id ? Number(f.employee_id) : null))
    .filter(Boolean);
  const costoHoraConocido = await obtenerCostoHoraPersonas(idsConEmployee);

  for (const f of filasCrudas) {
    const role_catalog = String(f.role_catalog || '');
    const horas_totales = Number(f.horas_totales);
    if (!roles.has(role_catalog)) {
      return { error: `"${role_catalog}" no es un cargo del catálogo (ver GET /tarifas-cargo)` };
    }
    if (!(horas_totales > 0)) {
      return { error: `El rol "${role_catalog}" necesita horas_totales mayor a 0` };
    }

    const employeeId = f.employee_id ? Number(f.employee_id) : null;
    if (employeeId) {
      if (empleadosVistos.has(employeeId)) {
        return { error: 'Cada persona debe aparecer una sola vez en el plan — si trabaja en más de un rol, súbele las horas totales en esa misma fila.' };
      }
      let costo_hora = costoHoraConocido.get(employeeId) || null;
      let salarioNuevo = null;
      if (!costo_hora) {
        const monthlySalary = Number(f.monthly_salary);
        if (!(monthlySalary > 0)) {
          return { error: `"${role_catalog}": esa persona todavía no tiene un salario cargado en ningún proyecto — escribe su salario mensual en esta misma fila, o usa "Por Cargo".` };
        }
        const { horasMes } = await getParametrosNomina();
        costo_hora = valorHoraDesdeSalario(monthlySalary, horasMes);
        salarioNuevo = monthlySalary;
      }
      empleadosVistos.add(employeeId);
      filas.push({ role_catalog, employee_id: employeeId, personas: 1, horas_totales, costo_hora, salarioNuevo });
    } else {
      const personas = Number(f.personas);
      const costo_hora = Number(f.costo_hora);
      if (!(personas > 0) || !(costo_hora > 0)) {
        return { error: `El rol "${role_catalog}" necesita personas y costo_hora, ambos mayores a 0` };
      }
      if (rolesCargoVistos.has(role_catalog)) {
        return { error: 'Cada rol debe aparecer una sola vez — si necesitas más de una persona, sube el número de Personas en esa misma fila.' };
      }
      rolesCargoVistos.add(role_catalog);
      filas.push({ role_catalog, employee_id: null, personas, horas_totales, costo_hora, salarioNuevo: null });
    }
  }
  return { filas };
}

// Igual que validarFilasPlan pero para los gastos sueltos (sql/29): sin
// catálogo que validar (la descripción es texto libre), solo que traigan
// nombre y un valor positivo. Un array vacío es válido — los gastos son
// opcionales incluso con el plan activo.
function validarFilasGastos(gastosCrudos) {
  const gastos = [];
  for (const g of gastosCrudos) {
    const description = String(g.description || '').trim();
    const amount = Number(g.amount);
    if (!description) {
      return { error: 'Cada gasto del plan necesita una descripción' };
    }
    if (!(amount > 0)) {
      return { error: `El gasto "${description}" necesita un valor mayor a 0` };
    }
    gastos.push({ description, amount });
  }
  return { gastos };
}

async function getPlanRecursos(costCenterId) {
  return query(
    `SELECT pr.role_catalog, pr.personas, pr.horas_totales, pr.costo_hora,
            pr.employee_id, e.canonical_name AS employee_name
       FROM mp_plan_recursos pr
       LEFT JOIN mp_employees e ON e.employee_id = pr.employee_id
      WHERE pr.cost_center_id = ?
      ORDER BY pr.employee_id IS NULL DESC, e.canonical_name, pr.role_catalog`,
    [costCenterId]
  );
}

async function getPlanRecursosGastos(costCenterId) {
  return query(
    `SELECT plan_gasto_id, description, amount
       FROM mp_plan_recursos_gasto
      WHERE cost_center_id = ?
      ORDER BY plan_gasto_id`,
    [costCenterId]
  );
}

// Da de alta en Equipo del Proyecto (mp_equipo_proyecto) a cada "Persona
// real" del plan cuyo salario se acaba de escribir por primera vez
// (validarFilasPlan la marcó con `salarioNuevo`) — cierra el ciclo que
// antes obligaba a meter a esa persona a un proyecto ajeno solo para
// poder registrarle el sueldo (ver el comentario de validarFilasPlan).
//
// Corre en LA MISMA transacción que guarda el plan (guardarPlanRecursosTx
// más abajo la llama con el mismo `exec`): si algo falla después, no queda
// un plan con una "persona real" que en Equipo del Proyecto nunca aparece.
//
// ON DUPLICATE KEY UPDATE en vez de un INSERT liso: es un caso borde, pero
// esa persona podría YA tener una fila en mp_equipo_proyecto para este
// mismo centro con una tarifa puesta a mano (hourly_cost sin
// monthly_salary) — si eso pasa, se actualiza con el salario real en vez
// de chocar contra uk_equipo_centro_talento (sql/17).
// Si la persona estaba "Sin proyecto" en Equipo del Proyecto (sql/45), su
// PRIMER proyecto convierte esa fila en vez de crear otra al lado (16 oct
// 2026, reportado por el usuario: Johan salía "Sin proyecto" y "Leads" a la
// vez). El salario de esa fila se conserva salvo que el plan traiga uno.
// Devuelve true si convirtió.
async function convertirSinProyectoTx(exec, costCenterId, f, monthlySalary = null) {
  const filas = await exec(
    'SELECT team_member_id FROM mp_equipo_proyecto WHERE employee_id = ? AND cost_center_id IS NULL LIMIT 1',
    [f.employee_id]
  );
  if (!filas || !filas.length) return false;
  await exec(
    `UPDATE mp_equipo_proyecto
        SET cost_center_id = ?, role_catalog = ?, hourly_cost = ?, monthly_salary = COALESCE(?, monthly_salary),
            planned_hours = ?, is_active = 1, removed_at = NULL
      WHERE team_member_id = ?`,
    [costCenterId, f.role_catalog, f.costo_hora, monthlySalary, f.horas_totales || null, filas[0].team_member_id]
  );
  return true;
}

// El salario mensual más reciente que tenga la persona en cualquier fila
// (incluida una "Sin proyecto"), o null.
async function salarioConocidoTx(exec, employeeId) {
  const rows = await exec(
    `SELECT monthly_salary FROM mp_equipo_proyecto
      WHERE employee_id = ? AND monthly_salary IS NOT NULL
      ORDER BY added_at DESC LIMIT 1`,
    [employeeId]
  );
  return rows && rows.length ? Number(rows[0].monthly_salary) : null;
}

async function crearEquipoDesdeFilasPlanTx(exec, costCenterId, filas, userId) {
  const agregados = [];
  for (const f of filas) {
    if (!f.employee_id || !f.salarioNuevo) continue;
    const yaEnEsteCentro = await exec(
      'SELECT 1 FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ? LIMIT 1',
      [costCenterId, f.employee_id]
    );
    if (!(yaEnEsteCentro && yaEnEsteCentro.length) && await convertirSinProyectoTx(exec, costCenterId, f, f.salarioNuevo)) {
      agregados.push({
        employee_id: f.employee_id, role_catalog: f.role_catalog,
        costo_hora: f.costo_hora, monthly_salary: f.salarioNuevo,
      });
      continue;
    }
    await exec(
      `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         hourly_cost = VALUES(hourly_cost), monthly_salary = VALUES(monthly_salary),
         planned_hours = VALUES(planned_hours), is_active = 1, removed_at = NULL`,
      [costCenterId, f.employee_id, f.role_catalog, f.costo_hora, f.salarioNuevo, f.horas_totales || null, userId]
    );
    agregados.push({
      employee_id: f.employee_id, role_catalog: f.role_catalog,
      costo_hora: f.costo_hora, monthly_salary: f.salarioNuevo,
    });
  }
  return agregados;
}

// Baja el Plan de Recursos a Equipo del Proyecto: toda "Persona real" del
// plan tiene que existir ahí, con sus horas planeadas. Dos casos:
//
//   - Ya está en el equipo  -> se le actualizan las planned_hours.
//   - No está              -> se da de alta (INSERT) con su cargo, su
//                             costo/hora y sus horas del plan.
//
// Por qué hace falta: crearEquipoDesdeFilasPlanTx solo da de alta a quien
// trae salario NUEVO (el que se escribe ahí mismo por primera vez). Para
// alguien con salario YA conocido — el caso más común — no hacía nada, así
// que asignarlo en Costo Planeado no lo mostraba por ningún lado en Equipo
// del Proyecto. Reportado por el usuario dos veces con casos reales: el 8
// sep 2026 con Alexander Alberto Muñoz Coneo (50h en "MIA", estaba en el
// equipo pero sin horas) y con Emily Tench (20h en "Talento Humano", que ni
// siquiera aparecía en el equipo).
//
// A alguien que fue RETIRADO del equipo (is_active = 0) no se le reactiva
// sola la fila: el UPDATE lleva `is_active = 1`, y el INSERT no corre
// porque la fila sí existe. Sacar a alguien del equipo es una decisión
// explícita, y un plan guardado después no debería deshacerla en silencio.
//
// Devuelve los que dio de alta, para que el caller los deje en el historial.
async function sincronizarEquipoDesdePlanTx(exec, costCenterId, filas, userId) {
  const conPersona = filas.filter((f) => f.employee_id);
  if (!conPersona.length) return [];

  // Una sola lectura para saber quién ya está (incluye a los que
  // crearEquipoDesdeFilasPlanTx acaba de insertar: corre en la MISMA
  // transacción, así que sus filas ya son visibles aquí).
  const existentes = await exec(
    'SELECT employee_id FROM mp_equipo_proyecto WHERE cost_center_id = ?',
    [costCenterId]
  );
  const yaEnElEquipo = new Set((existentes || []).map((r) => Number(r.employee_id)));

  const creados = [];
  for (const f of conPersona) {
    if (yaEnElEquipo.has(Number(f.employee_id))) {
      await exec(
        `UPDATE mp_equipo_proyecto SET planned_hours = ?
          WHERE cost_center_id = ? AND employee_id = ? AND is_active = 1`,
        [f.horas_totales || null, costCenterId, f.employee_id]
      );
      continue;
    }
    // Si estaba "Sin proyecto", esa fila pasa a ser este proyecto.
    if (await convertirSinProyectoTx(exec, costCenterId, f)) {
      creados.push({
        employee_id: f.employee_id, role_catalog: f.role_catalog,
        costo_hora: f.costo_hora, horas_totales: f.horas_totales,
      });
      continue;
    }
    // El salario conocido SÍ se copia (16 oct 2026). Antes quedaba NULL "para
    // no duplicar el dato", pero entonces el salario vivía en una sola fila:
    // si esa fila se borraba, la persona se quedaba sin salario en todos lados
    // y el Plan de Recursos la rechazaba ("todavía no tiene un salario
    // cargado"). Desde que cambiar el salario lo reemplaza en todas sus filas
    // (actualizarSalarioEnSusProyectos, routes/costeo/equipo.js), copiarlo ya
    // no puede hacer que diverjan.
    const salario = await salarioConocidoTx(exec, f.employee_id);
    await exec(
      `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary, planned_hours, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [costCenterId, f.employee_id, f.role_catalog, f.costo_hora, salario, f.horas_totales || null, userId]
    );
    creados.push({
      employee_id: f.employee_id, role_catalog: f.role_catalog,
      costo_hora: f.costo_hora, horas_totales: f.horas_totales,
    });
  }
  return creados;
}

// Núcleo de guardarPlanRecursos() que recibe un `exec` ya abierto — para
// poder guardar el plan en LA MISMA transacción que crea el centro (ver
// POST /centros con plan_recursos incluido), en vez de dos transacciones
// separadas donde un fallo en la segunda dejaría un centro huérfano sin
// plan o sin sus gastos.
// actualizarPresupuesto (3 sep 2026, a pedido explícito): antes guardar el
// plan SIEMPRE pisaba el presupuesto del centro con la suma calculada,
// aunque solo se quisiera anotar cuántas horas va a trabajar cada quien en
// un proyecto que YA tiene presupuesto fijado a mano — un PM no podía usar
// el Plan de Recursos para llevar las horas planeadas de su equipo sin que
// eso le cambiara el presupuesto oficial por sorpresa. Con el flag en false
// (el caso nuevo: cualquier proyecto, no solo los creados desde un plan) se
// guardan las filas igual, pero el presupuesto y budget_from_plan quedan
// intactos — la casilla "Calcular el presupuesto desde este plan" en el
// front es la que decide cuál de los dos casos aplica.
async function guardarPlanRecursosTx(exec, costCenterId, filas, gastos, userId, actualizarPresupuesto = true) {
  const presupuesto = calcularPresupuestoPlan(filas, gastos);
  await exec('DELETE FROM mp_plan_recursos WHERE cost_center_id = ?', [costCenterId]);
  for (const f of filas) {
    await exec(
      `INSERT INTO mp_plan_recursos (cost_center_id, role_catalog, employee_id, personas, horas_totales, costo_hora, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [costCenterId, f.role_catalog, f.employee_id || null, f.personas, f.horas_totales, f.costo_hora, userId]
    );
  }
  await exec('DELETE FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [costCenterId]);
  for (const g of gastos) {
    await exec(
      `INSERT INTO mp_plan_recursos_gasto (cost_center_id, description, amount, created_by)
       VALUES (?, ?, ?, ?)`,
      [costCenterId, g.description, g.amount, userId]
    );
  }
  if (actualizarPresupuesto) {
    await exec(
      'UPDATE mp_centro_costo SET budget = ?, budget_from_plan = 1 WHERE cost_center_id = ?',
      [presupuesto, costCenterId]
    );
  } else {
    // budget_from_plan siempre se deja en el estado que corresponde (nunca
    // "como estaba"): si no, un centro que SÍ tenía el presupuesto atado al
    // plan y ahora se guarda solo para llevar horas planeadas se quedaría
    // con budget_from_plan=1 viejo — el PUT /centros/:id normal seguiría
    // rechazando el presupuesto a mano (ver el guard ahí) aunque el usuario
    // ya haya desmarcado la casilla.
    await exec('UPDATE mp_centro_costo SET budget_from_plan = 0 WHERE cost_center_id = ?', [costCenterId]);
  }
  return presupuesto;
}

// Reemplaza el plan completo de un centro (borra todo lo que había y
// vuelve a insertar, filas Y gastos) y actualiza el presupuesto del centro
// con la suma — todo en una sola transacción: si algo falla, no queda ni
// el plan a medias ni un presupuesto que no cuadre con ninguna fila.
// De paso, dentro de la MISMA transacción, deja Equipo del Proyecto al día
// con el plan: da de alta a toda "Persona real" que no estuviera ya (con su
// salario si se acaba de escribir — ver crearEquipoDesdeFilasPlanTx — o solo
// con su costo/hora si ya era conocido, ver sincronizarEquipoDesdePlanTx) y
// actualiza las horas planeadas de las que sí estaban. Todas las altas van
// juntas en `equipoCreado`, para que el caller las deje en el historial.
// Orden de tablas DENTRO de la transacción (14 sep 2026, corregido tras
// revisión de código): mp_equipo_proyecto ANTES que mp_plan_recursos /
// mp_plan_recursos_gasto / mp_centro_costo — no es un orden arbitrario.
// DELETE /centros/:id (centros.js) borra mp_equipo_proyecto antes que
// mp_centro_costo porque el FK de mp_equipo_proyecto no tiene ON DELETE
// CASCADE (sql/07): la base OBLIGA ese orden ahí, no se puede cambiar sin
// tocar el schema. Si esta función tocara mp_centro_costo antes que
// mp_equipo_proyecto (como hacía antes), un PUT /plan-recursos y un DELETE
// /centros/:id corriendo a la vez sobre el mismo centro tomarían los locks
// en orden opuesto — receta de deadlock. Mismo motivo por el que
// eliminarPlanRecursos, más abajo, deja mp_centro_costo al final.
async function guardarPlanRecursos(costCenterId, filas, gastos, userId, actualizarPresupuesto = true, quitados = []) {
  let presupuesto;
  let equipoCreado;
  await withTransaction(async (exec) => {
    // Quienes se quitaron del plan (ya revisados: sin horas, ver
    // revisarQuitadosDelPlan) salen también del Equipo de este proyecto.
    for (const q of quitados) await sacarDelEquipoTx(exec, costCenterId, q.employee_id, userId);
    const conSalarioNuevo = await crearEquipoDesdeFilasPlanTx(exec, costCenterId, filas, userId);
    const asignadosPorElPlan = await sincronizarEquipoDesdePlanTx(exec, costCenterId, filas, userId);
    equipoCreado = conSalarioNuevo.concat(asignadosPorElPlan);
    presupuesto = await guardarPlanRecursosTx(exec, costCenterId, filas, gastos, userId, actualizarPresupuesto);
  });
  return { presupuesto, equipoCreado };
}

// Borra el plan (filas y gastos) y devuelve el centro a modo manual. El
// presupuesto ya calculado se queda tal cual (como punto de partida
// editable a mano), no se resetea a 0 — perder el número de un plumazo
// sería peor que dejarlo desactualizado hasta que alguien lo ajuste.
// Las 3 sentencias van en UNA transacción (14 sep 2026, corregido tras
// revisión de código): sueltas, si la segunda o la tercera fallaba a mitad
// (conexión caída, reinicio de la base), el centro quedaba con el plan ya
// borrado pero budget_from_plan todavía en 1 — el campo Presupuesto se ve
// bloqueado en el formulario de edición (ver budget_from_plan en
// costeo-centros.js) sin ningún plan que lo justifique, y sin ningún error
// visible que lo explique. Mismo orden de tablas que ya usa
// guardarPlanRecursosTx en este archivo (mp_plan_recursos ->
// mp_plan_recursos_gasto -> mp_centro_costo, este último al final). Desde el
// 10 nov 2026 saca primero del Equipo a las personas del plan que no tenían
// horas (`quitados`, ver revisarQuitadosDelPlan): mp_equipo_proyecto va
// antes que todo, el mismo orden canónico de guardarPlanRecursos.
async function eliminarPlanRecursos(costCenterId, quitados = [], userId = null) {
  await withTransaction(async (exec) => {
    for (const q of quitados) await sacarDelEquipoTx(exec, costCenterId, q.employee_id, userId);
    await exec('DELETE FROM mp_plan_recursos WHERE cost_center_id = ?', [costCenterId]);
    await exec('DELETE FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [costCenterId]);
    await exec('UPDATE mp_centro_costo SET budget_from_plan = 0 WHERE cost_center_id = ?', [costCenterId]);
  });
}

// Equipo del Proyecto -> Plan de Recursos (16 oct 2026, reportado por el
// usuario: "le asigné el proyecto en Equipo del Proyecto, pero en Costo
// Planeado no aparece el trabajador"). Hasta aquí la sincronización solo iba
// del Plan al Equipo (sincronizarEquipoDesdePlanTx); ahora también al revés.
//
// Deja las filas "Persona real" del plan de ESE centro iguales a su equipo
// activo: cargo, costo/hora (que sale del salario) y horas planeadas. Quien
// ya no está activo en el equipo sale del plan. Las filas "Por cargo"
// (employee_id NULL) no se tocan: no son de una persona del equipo.
//
// Si el presupuesto del centro sale del plan (budget_from_plan), se
// recalcula para que siga cuadrando con lo que muestra.
async function sincronizarPlanDesdeEquipo(costCenterId) {
  if (!costCenterId) return;
  await query(
    `INSERT INTO mp_plan_recursos (cost_center_id, role_catalog, employee_id, personas, horas_totales, costo_hora, created_by)
     SELECT ep.cost_center_id, ep.role_catalog, ep.employee_id, 1, COALESCE(ep.planned_hours, 0), ep.hourly_cost, ep.added_by
       FROM mp_equipo_proyecto ep
      WHERE ep.cost_center_id = ? AND ep.is_active = 1
     ON DUPLICATE KEY UPDATE
       role_catalog = VALUES(role_catalog),
       costo_hora = VALUES(costo_hora),
       horas_totales = IF(VALUES(horas_totales) > 0, VALUES(horas_totales), horas_totales)`,
    [costCenterId]
  );
  await query(
    `DELETE FROM mp_plan_recursos
      WHERE cost_center_id = ? AND employee_id IS NOT NULL
        AND employee_id NOT IN (
          SELECT employee_id FROM mp_equipo_proyecto WHERE cost_center_id = ? AND is_active = 1
        )`,
    [costCenterId, costCenterId]
  );
  const [centro] = await query('SELECT budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [costCenterId]);
  if (centro && Number(centro.budget_from_plan) === 1) {
    const [filas, gastos] = await Promise.all([getPlanRecursos(costCenterId), getPlanRecursosGastos(costCenterId)]);
    await query('UPDATE mp_centro_costo SET budget = ? WHERE cost_center_id = ?', [calcularPresupuestoPlan(filas, gastos), costCenterId]);
  }
}

// ---------------------------------------------------------------
// Quitar a una persona del Plan de Recursos (10 nov 2026, a pedido
// explícito). El plan es el reflejo del Equipo activo del proyecto
// (sincronizarPlanDesdeEquipo), así que quitarla solo del plan no dura: el
// siguiente cambio en el Equipo la volvía a poner. Por eso:
//
//   - Con horas ejecutadas en ese proyecto: NO se puede. Esas horas se
//     trabajaron y se pagaron, son costo del proyecto; sacarla de su Equipo
//     las dejaría sin tarifa. Lo que corresponde es Inactivarla en Equipo del
//     Proyecto (sale del plan y sus horas siguen contando).
//   - Sin horas: sale del plan Y del Equipo de ese proyecto, igual que
//     "Ninguno" en Editar de Equipo: si sigue en otros proyectos solo pierde
//     este; si era el único, queda "Sin proyecto".
// ---------------------------------------------------------------

// Personas ("Persona real") que estaban en el plan guardado y ya no vienen
// en las filas nuevas. Pura, para probarla sin base.
function personasQuitadasDelPlan(filasAntes, filasNuevas) {
  const siguen = new Set((filasNuevas || []).filter((f) => f.employee_id).map((f) => Number(f.employee_id)));
  return [...new Set((filasAntes || [])
    .filter((f) => f.employee_id && !siguen.has(Number(f.employee_id)))
    .map((f) => Number(f.employee_id)))];
}

// Horas ejecutadas de cada persona en un centro, con el corte vigente de
// cada (persona, proyecto) — el mismo que usa el motor. Map employee_id ->
// horas; quien no aparece no tiene horas.
async function horasEjecutadasEnCentro(costCenterId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const filas = await query(
    `SELECT t.employee_id,
            SUM(COALESCE(t.hours_monday,0) + COALESCE(t.hours_tuesday,0) + COALESCE(t.hours_wednesday,0) +
                COALESCE(t.hours_thursday,0) + COALESCE(t.hours_friday,0) + COALESCE(t.hours_saturday,0)) AS horas
       FROM mp_costeo_task_facts t
       JOIN mp_centro_costo cc ON cc.cost_center_id = ?
      WHERE t.employee_id IN (${employeeIds.map(() => '?').join(',')})
        AND (t.project_name = cc.project_name OR t.project_name = cc.project_folder)
        AND t.snapshot_date = (
          SELECT MAX(t2.snapshot_date) FROM mp_costeo_task_facts t2
           WHERE t2.employee_id = t.employee_id AND t2.project_name = t.project_name
        )
      GROUP BY t.employee_id
     HAVING horas > 0`,
    [costCenterId, ...employeeIds]
  );
  return new Map(filas.map((f) => [Number(f.employee_id), Number(f.horas)]));
}

// Revisa a quienes se quitan del plan. Devuelve { error } si alguno tiene
// horas ejecutadas en el proyecto, o { quitados: [{employee_id, nombre}] }.
async function revisarQuitadosDelPlan(costCenterId, filasNuevas) {
  const antes = await getPlanRecursos(costCenterId);
  const ids = personasQuitadasDelPlan(antes, filasNuevas);
  if (!ids.length) return { quitados: [] };
  const nombres = new Map((await query(
    `SELECT employee_id, canonical_name FROM mp_employees WHERE employee_id IN (${ids.map(() => '?').join(',')})`,
    ids
  )).map((r) => [Number(r.employee_id), r.canonical_name]));
  const horas = await horasEjecutadasEnCentro(costCenterId, ids);
  const conHoras = ids.filter((id) => horas.has(id));
  if (conHoras.length) {
    const detalle = conHoras
      .map((id) => `${nombres.get(id) || `talento #${id}`} (${Number(horas.get(id).toFixed(2))} h)`)
      .join(', ');
    return {
      error: `No se puede quitar del plan a ${detalle}: ya tiene horas ejecutadas en este proyecto, y son costo pagado. `
        + 'Si ya no va a trabajar aquí, inactívala en Equipo del Proyecto: sale del plan y sus horas siguen contando.',
    };
  }
  return { quitados: ids.map((id) => ({ employee_id: id, nombre: nombres.get(id) || `talento #${id}` })) };
}

// Saca a la persona del Equipo de este proyecto (ver arriba). Va dentro de la
// transacción del plan y antes que mp_plan_recursos (orden canónico del
// módulo, ver guardarPlanRecursos).
async function sacarDelEquipoTx(exec, costCenterId, employeeId, userId) {
  const [fila] = await exec(
    'SELECT team_member_id FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [costCenterId, employeeId]
  ) || [];
  if (!fila) return;
  const [{ n }] = await exec(
    `SELECT COUNT(*) AS n FROM mp_equipo_proyecto
      WHERE employee_id = ? AND team_member_id <> ? AND (is_active = 1 OR cost_center_id IS NULL)`,
    [employeeId, fila.team_member_id]
  );
  if (Number(n) > 0) {
    await exec('DELETE FROM mp_equipo_proyecto WHERE team_member_id = ?', [fila.team_member_id]);
  } else {
    await exec(
      `UPDATE mp_equipo_proyecto SET cost_center_id = NULL, planned_hours = NULL, is_active = 1,
              removed_at = NULL, added_at = NOW(), added_by = ?
        WHERE team_member_id = ?`,
      [userId, fila.team_member_id]
    );
  }
}

module.exports = {
  calcularPresupuestoPlan,
  personasQuitadasDelPlan,
  revisarQuitadosDelPlan,
  horasEjecutadasEnCentro,
  sincronizarPlanDesdeEquipo,
  validarFilasPlan,
  validarFilasGastos,
  getPlanRecursos,
  getPlanRecursosGastos,
  guardarPlanRecursos,
  guardarPlanRecursosTx,
  crearEquipoDesdeFilasPlanTx,
  sincronizarEquipoDesdePlanTx,
  eliminarPlanRecursos,
};
