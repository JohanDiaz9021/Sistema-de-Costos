'use strict';

/**
 * Datos de prueba deterministas.
 *
 * Todo lo que se siembra aqui es inventado. Ni un nombre, correo o
 * proyecto real: los backups/ del repo tienen datos de personas de la
 * empresa y no se usan como fixture a proposito.
 *
 * El escenario esta armado para poder afirmar sobre AISLAMIENTO:
 *
 *   ALFA   -> lo lidera Ana (leader).           Tiene equipo, gastos y horas extra.
 *   BETA   -> lo lidera Bruno (leader).         Tiene equipo, gastos y horas extra.
 *   GAMMA  -> sin PM asignado.                  Solo lo ven ceo/admin.
 *
 * Cualquier prueba que vea datos de BETA con la sesion de Ana es una
 * fuga real de informacion entre proyectos.
 *
 * Ids fijos: resetearDatos() hace TRUNCATE, asi que los AUTO_INCREMENT
 * arrancan en 1 y estos numeros son estables entre corridas.
 */

const bcrypt = require('bcryptjs');
const { query } = require('./db');

// Un solo hash para todos, calculado una vez: bcrypt con coste 10 tarda
// ~80ms, y sembrar 5 usuarios en cada suite se notaria.
const CLAVE = 'clave-de-prueba-123';
let hashCache = null;
function hashClave() {
  if (!hashCache) hashCache = bcrypt.hashSync(CLAVE, 10);
  return hashCache;
}

const USUARIOS = {
  ceo:          { id: 1, email: 'ceo@ejemplo.test',      username: 'ceo',      nombre: 'Carmen CEO',       rol: 'ceo',    activo: 1 },
  admin:        { id: 2, email: 'admin@ejemplo.test',    username: 'admin',    nombre: 'Adolfo Admin',     rol: 'admin',  activo: 1 },
  liderAlfa:    { id: 3, email: 'ana@ejemplo.test',      username: 'ana',      nombre: 'Ana Líder',        rol: 'leader', activo: 1 },
  liderBeta:    { id: 4, email: 'bruno@ejemplo.test',    username: 'bruno',    nombre: 'Bruno Líder',      rol: 'leader', activo: 1 },
  liderInactivo:{ id: 5, email: 'inactiva@ejemplo.test', username: 'inactiva', nombre: 'Inés Inactiva',    rol: 'leader', activo: 0 },
  // Lider ACTIVO pero sin ninguna fila en mp_project_owners: es el caso
  // que ejercita la rama 'AND 1=0' de projectScopeClause.
  liderSinProyecto: { id: 6, email: 'sinproyecto@ejemplo.test', username: 'sinpro', nombre: 'Sonia SinProyecto', rol: 'leader', activo: 1 },
};

const PROYECTOS = { alfa: 'ALFA', beta: 'BETA', gamma: 'GAMMA' };

const CENTROS = {
  alfa:  { id: 1, codigo: 'CC-2026-001', folder: 'ALFA',  nombre: 'Proyecto Alfa',  presupuesto: 10000000, contrato: 15000000 },
  beta:  { id: 2, codigo: 'CC-2026-002', folder: 'BETA',  nombre: 'Proyecto Beta',  presupuesto: 20000000, contrato: 22000000 },
  gamma: { id: 3, codigo: 'CC-2026-003', folder: 'GAMMA', nombre: 'Proyecto Gamma', presupuesto: 5000000,  contrato: null },
};

const EMPLEADOS = {
  aliceAlfa:  { id: 1, nombre: 'Alicia Alfa',   email: 'alicia@ejemplo.test', folder: 'ALFA' },
  arturoAlfa: { id: 2, nombre: 'Arturo Alfa',   email: 'arturo@ejemplo.test', folder: 'ALFA' },
  brendaBeta: { id: 3, nombre: 'Brenda Beta',   email: 'brenda@ejemplo.test', folder: 'BETA' },
  // Inactivo: el motor lo excluye (e.is_active = 1 en los JOIN).
  carlosBaja: { id: 4, nombre: 'Carlos Baja',   email: 'carlos@ejemplo.test', folder: 'ALFA', activo: 0 },
};

const EQUIPO = {
  aliceEnAlfa:  { id: 1, centro: 1, empleado: 1, rol: 'desarrollador', tarifa: 20000 },
  arturoEnAlfa: { id: 2, centro: 1, empleado: 2, rol: 'qa',            tarifa: 15000 },
  brendaEnBeta: { id: 3, centro: 2, empleado: 3, rol: 'desarrollador', tarifa: 30000 },
  // Sin tarifa: ejercita la alerta de "talento sin tarifa" y el rechazo
  // de horas extra manuales.
  sinTarifaEnAlfa: { id: 4, centro: 1, empleado: 4, rol: 'analista',   tarifa: 0 },
};

// `estado` es el approval_status de sql/28: un gasto no planeado solo suma
// al ejecutado cuando admin/ceo lo aprobo. Los cuatro de aqui van
// 'aprobado' porque son los que alimentan las cuentas del motor; el
// pendiente y el rechazado se crean dentro de las pruebas que los
// necesitan, para no cambiar los totales de todas las demas.
const GASTOS = {
  alfa1: { id: 1, centro: 1, desc: 'Licencia de prueba ALFA', monto: 500000,  fecha: '2026-08-10', categoria: 'licencia', estado: 'aprobado' },
  alfa2: { id: 2, centro: 1, desc: 'Viático de prueba ALFA',  monto: 200000,  fecha: '2026-07-15', categoria: 'viatico', estado: 'aprobado' },
  beta1: { id: 3, centro: 2, desc: 'Tercero de prueba BETA',  monto: 1000000, fecha: '2026-08-12', categoria: 'tercero', estado: 'aprobado' },
  // Mismo mes que alfa1 pero de OTRO año: es la fixture que prueba la
  // correccion del filtro por mes que antes ignoraba el año.
  alfaOtroAnio: { id: 4, centro: 1, desc: 'Gasto de agosto de 2025', monto: 999999, fecha: '2025-08-10', categoria: 'otro', estado: 'aprobado' },
};

const OVERTIME = {
  // Aprobada: suma a costoExtraAprobado.
  alfaAprobada:  { id: 1, centro: 1, empleado: 1, semana: 2, mes: 8, anio: 2026, extra: 4,  potencial: 80000,  decision: 'si', aprobacion: 'aprobado',  final: 80000 },
  // Decidida por el PM pero sin aprobar: NO debe sumar.
  alfaPendiente: { id: 2, centro: 1, empleado: 2, semana: 3, mes: 8, anio: 2026, extra: 2,  potencial: 30000,  decision: 'si', aprobacion: 'pendiente', final: 0 },
  // Recien sincronizada, sin decision del PM: aprobarla debe dar 409
  // (es el bug de dinero que se corrigio; aqui queda como regresion).
  alfaSinDecidir:{ id: 3, centro: 1, empleado: 1, semana: 4, mes: 8, anio: 2026, extra: 3,  potencial: 60000,  decision: 'pendiente', aprobacion: 'pendiente', final: 0 },
  betaAprobada:  { id: 4, centro: 2, empleado: 3, semana: 2, mes: 8, anio: 2026, extra: 5,  potencial: 150000, decision: 'si', aprobacion: 'aprobado',  final: 150000 },
};

// Dos snapshot_date distintos para la MISMA persona/semana/proyecto.
// mp_costeo_task_facts guarda una foto por CARGA de Excel; si el motor no
// filtrara por el ultimo snapshot DE ESA PERSONA, sumaria las mismas horas
// dos veces (fue un bug real de costoLaboralEjecutado). Estas filas existen
// para detectar la regresion.
const SNAPSHOT_VIEJO = '2026-08-20';
const SNAPSHOT_NUEVO = '2026-08-21';

async function sembrar() {
  const hash = hashClave();

  for (const u of Object.values(USUARIOS)) {
    await query(
      `INSERT INTO mp_dashboard_users (user_id, email, username, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.email, u.username, hash, u.nombre, u.rol, u.activo]
    );
  }

  // Ana lidera ALFA, Bruno lidera BETA. GAMMA no tiene PM.
  await query(
    `INSERT INTO mp_project_owners (project_folder, pmo_canonical_name, pmo_email, is_active) VALUES
       (?, ?, ?, 1), (?, ?, ?, 1)`,
    [PROYECTOS.alfa, USUARIOS.liderAlfa.nombre, USUARIOS.liderAlfa.email,
     PROYECTOS.beta, USUARIOS.liderBeta.nombre, USUARIOS.liderBeta.email]
  );

  for (const e of Object.values(EMPLEADOS)) {
    await query(
      `INSERT INTO mp_employees (employee_id, canonical_name, email, project_folder, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [e.id, e.nombre, e.email, e.folder, e.activo ?? 1]
    );
  }

  for (const c of Object.values(CENTROS)) {
    await query(
      `INSERT INTO mp_centro_costo
         (cost_center_id, codigo, project_folder, project_name, tipo, origin, budget,
          contract_value, start_date, planned_end_date, status, created_by)
       VALUES (?, ?, ?, ?, 'Desarrollo', 'planeacion', ?, ?, '2026-01-01', '2026-12-31', 'vigente', ?)`,
      [c.id, c.codigo, c.folder, c.nombre, c.presupuesto, c.contrato, USUARIOS.ceo.id]
    );
  }

  for (const m of Object.values(EQUIPO)) {
    await query(
      `INSERT INTO mp_equipo_proyecto (team_member_id, cost_center_id, employee_id, role_catalog, hourly_cost, is_active, added_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [m.id, m.centro, m.empleado, m.rol, m.tarifa, USUARIOS.ceo.id]
    );
  }

  for (const g of Object.values(GASTOS)) {
    await query(
      `INSERT INTO mp_costo_no_planeado (expense_id, cost_center_id, description, amount, expense_date, category, created_by, approval_status, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [g.id, g.centro, g.desc, g.monto, g.fecha, g.categoria, USUARIOS.ceo.id,
        g.estado || 'aprobado',
        g.estado === 'pendiente' ? null : USUARIOS.ceo.id,
        g.estado === 'pendiente' ? null : new Date()]
    );
  }

  for (const o of Object.values(OVERTIME)) {
    await query(
      `INSERT INTO mp_overtime_decisions
         (decision_id, employee_id, cost_center_id, week_number, month_number, year_number,
          executed_hours, legal_hours, extra_hours, extra_cost_potential,
          pm_decision, approval_status, extra_cost_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, 46, ?, ?, ?, ?, ?)`,
      [o.id, o.empleado, o.centro, o.semana, o.mes, o.anio,
       46 + o.extra, o.extra, o.potencial, o.decision, o.aprobacion, o.final]
    );
  }

  await sembrarTaskFacts();

  // '2026-08-31' (semana 5 de agosto) a propósito: NINGÚN empleado de este
  // fixture tiene horas en esa semana (todos están en semana 2, 3 o 4), así
  // que el recargo de horas extra por festivo (sql/25) no le cambia ni un
  // peso a ningún assert existente sobre Alicia/Arturo/Brenda/Carlos. La
  // cobertura de esa regla vive en unit tests puros (sin tocar la base).
  await query(
    `INSERT INTO mp_holidays (holiday_date, holiday_name) VALUES
       ('2026-01-01', 'Año Nuevo de prueba'), ('2026-08-31', 'Festivo de prueba')`
  );
}

async function sembrarTaskFacts() {
  const filas = [];
  const agregar = (snapshot, empleadoId, folder, semana, horas) => {
    filas.push([
      snapshot, empleadoId, folder, 'Agosto', 8, 2026, semana,
      `Proyecto ${folder}`, 'Actividad de prueba', 'P', horas.reduce((a, b) => a + b, 0),
      ...horas,
    ]);
  };

  // [lun, mar, mie, jue, vie, sab]
  // Alicia en ALFA: 50h ejecutadas => 46 legales + 4 extra con el umbral
  // por defecto. Sirve para verificar el corte de horas extra.
  agregar(SNAPSHOT_VIEJO, EMPLEADOS.aliceAlfa.id, 'ALFA', 2, [8, 9, 9, 9, 9, 6]);
  agregar(SNAPSHOT_NUEVO, EMPLEADOS.aliceAlfa.id, 'ALFA', 2, [8, 9, 9, 9, 9, 6]);

  // Arturo en ALFA: 40h, por debajo del umbral, sin horas extra.
  agregar(SNAPSHOT_NUEVO, EMPLEADOS.arturoAlfa.id, 'ALFA', 3, [8, 8, 8, 8, 8, 0]);

  // Brenda en BETA: solo la ve Bruno (y ceo/admin).
  agregar(SNAPSHOT_NUEVO, EMPLEADOS.brendaBeta.id, 'BETA', 2, [8, 9, 9, 9, 9, 0]);

  // Carlos esta inactivo en mp_employees: el motor debe ignorar sus horas.
  agregar(SNAPSHOT_NUEVO, EMPLEADOS.carlosBaja.id, 'ALFA', 2, [8, 9, 9, 9, 9, 0]);

  // Se siembra en las DOS tablas con los mismos datos sintéticos: esta
  // función es la base compartida de fixtures.js, y algunas pruebas de
  // Planeación (ej. GET /resource/:id, validation-resource.test.js) también
  // dependen de encontrar horas de Alicia/Arturo/Brenda/Carlos — aunque
  // Planeación y Costeo ya no comparten la tabla real (31 ago 2026), no hay
  // razón para que las pruebas de ambos no puedan compartir los MISMOS
  // datos de prueba, cada una en su propia tabla.
  for (const f of filas) {
    await query(
      `INSERT INTO mp_task_facts
         (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
          week_number, project_name, activity, planned_type, total_executed_hours,
          hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
          budgeted_hours, task_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'Terminado')`,
      f
    );
    await query(
      `INSERT INTO mp_costeo_task_facts
         (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
          week_number, project_name, activity, planned_type, total_executed_hours,
          hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
          budgeted_hours, task_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'Terminado')`,
      f
    );
  }
}

module.exports = {
  CLAVE,
  USUARIOS,
  PROYECTOS,
  CENTROS,
  EMPLEADOS,
  EQUIPO,
  GASTOS,
  OVERTIME,
  SNAPSHOT_VIEJO,
  SNAPSHOT_NUEVO,
  sembrar,
};
