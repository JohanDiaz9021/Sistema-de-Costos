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
async function crearEquipoDesdeFilasPlanTx(exec, costCenterId, filas, userId) {
  const agregados = [];
  for (const f of filas) {
    if (!f.employee_id || !f.salarioNuevo) continue;
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
    // monthly_salary queda NULL a propósito: esta persona ya tenía salario
    // conocido en otra asignación, y el costo/hora del plan salió de ahí
    // (obtenerCostoHoraPersonas). Copiarlo aquí duplicaría el dato en dos
    // filas que después pueden divergir.
    await exec(
      `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, planned_hours, added_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [costCenterId, f.employee_id, f.role_catalog, f.costo_hora, f.horas_totales || null, userId]
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
async function guardarPlanRecursos(costCenterId, filas, gastos, userId, actualizarPresupuesto = true) {
  let presupuesto;
  let equipoCreado;
  await withTransaction(async (exec) => {
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
// mp_plan_recursos_gasto -> mp_centro_costo, este último al final): esta
// función no toca mp_equipo_proyecto, así que ya queda consistente con el
// orden canónico del módulo (ver el comentario de guardarPlanRecursos, más
// arriba) sin necesitar cambios.
async function eliminarPlanRecursos(costCenterId) {
  await withTransaction(async (exec) => {
    await exec('DELETE FROM mp_plan_recursos WHERE cost_center_id = ?', [costCenterId]);
    await exec('DELETE FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [costCenterId]);
    await exec('UPDATE mp_centro_costo SET budget_from_plan = 0 WHERE cost_center_id = ?', [costCenterId]);
  });
}

module.exports = {
  calcularPresupuestoPlan,
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
