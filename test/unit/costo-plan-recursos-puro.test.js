'use strict';

/**
 * calcularPresupuestoPlan() de src/queries/costo-plan-recursos.js —
 * Presupuesto = Σ (personas × horas_totales × costo_hora) por rol.
 * "horas_totales" es el total del proyecto para ese rol, NO semanal.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  calcularPresupuestoPlan, validarFilasPlan, validarFilasGastos, crearEquipoDesdeFilasPlanTx,
  sincronizarEquipoDesdePlanTx,
} = require('../../src/queries/costo-plan-recursos');

test('calcularPresupuestoPlan: sin filas, presupuesto 0', () => {
  assert.strictEqual(calcularPresupuestoPlan([]), 0);
});

test('calcularPresupuestoPlan: una fila, personas=1 -> horas × costo_hora', () => {
  const total = calcularPresupuestoPlan([{ role_catalog: 'analista', personas: 1, horas_totales: 9, costo_hora: 5000 }]);
  assert.strictEqual(total, 45000);
});

test('calcularPresupuestoPlan: el ejemplo real (analista + desarrollo + qa)', () => {
  const total = calcularPresupuestoPlan([
    { role_catalog: 'analista_datos', personas: 1, horas_totales: 9, costo_hora: 5000 },
    { role_catalog: 'desarrollador', personas: 1, horas_totales: 5, costo_hora: 6000 },
    { role_catalog: 'qa', personas: 1, horas_totales: 12, costo_hora: 7000 },
  ]);
  // 45.000 + 30.000 + 84.000
  assert.strictEqual(total, 159000);
});

test('calcularPresupuestoPlan: personas > 1 multiplica el subtotal completo', () => {
  const total = calcularPresupuestoPlan([{ role_catalog: 'desarrollador', personas: 3, horas_totales: 10, costo_hora: 6000 }]);
  assert.strictEqual(total, 180000, '3 personas x 10h x 6000 = 180.000, no 60.000');
});

test('calcularPresupuestoPlan: valores faltantes o no numericos cuentan como 0, no NaN', () => {
  const total = calcularPresupuestoPlan([{ role_catalog: 'x', personas: undefined, horas_totales: null, costo_hora: 'abc' }]);
  assert.strictEqual(total, 0);
});

test('calcularPresupuestoPlan: redondea a 2 decimales', () => {
  const total = calcularPresupuestoPlan([{ role_catalog: 'x', personas: 1, horas_totales: 3, costo_hora: 3.333 }]);
  assert.strictEqual(total, 10);
});

// validarFilasPlan() — la comparten PUT /plan-recursos y POST /centros
// (crear con plan_recursos desde el Simulador): un centro nuevo no puede
// entrar con un plan que uno ya existente rechazaría.
const ROLES = new Set(['analista', 'qa', 'desarrollador']);

test('validarFilasPlan: filas validas pasan tal cual, normalizadas a numero', async () => {
  const r = await validarFilasPlan([{ role_catalog: 'qa', personas: '2', horas_totales: '10', costo_hora: '1000' }], ROLES);
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.filas, [{ role_catalog: 'qa', employee_id: null, personas: 2, horas_totales: 10, costo_hora: 1000, salarioNuevo: null }]);
});

test('validarFilasPlan: rechaza un rol fuera del catalogo', async () => {
  const r = await validarFilasPlan([{ role_catalog: 'inventado', personas: 1, horas_totales: 10, costo_hora: 1000 }], ROLES);
  assert.match(r.error, /no es un cargo del catálogo/);
});

test('validarFilasPlan: rechaza personas/horas/costo en 0 o negativos', async () => {
  for (const campo of ['personas', 'horas_totales', 'costo_hora']) {
    const fila = { role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000, [campo]: 0 };
    const r = await validarFilasPlan([fila], ROLES);
    assert.ok(r.error, `deberia rechazar ${campo}=0`);
  }
});

test('validarFilasPlan: rechaza el mismo rol repetido (dos filas por Cargo)', async () => {
  const r = await validarFilasPlan([
    { role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 },
    { role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 },
  ], ROLES);
  assert.match(r.error, /una sola vez/);
});

// sql/34 — filas "por Persona": el costo_hora NUNCA sale del body, siempre
// de obtenerCostoHoraPersona() (mp_equipo_proyecto.monthly_salary). Estas
// dos SÍ tocan la base (employee_id truthy dispara la consulta), así que se
// prueban en la suite de integracion (plan-recursos.test.js), no aqui.

test('validarFilasPlan: dos personas reales pueden compartir el mismo rol (no es "el mismo rol repetido")', async () => {
  // Sin employee_id no hay forma de probar esto sin tocar la base (ver
  // nota de arriba) — pero al menos se verifica que DOS FILAS DE CARGO
  // GENERICO con distinto rol conviven bien, como control.
  const r = await validarFilasPlan([
    { role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 },
    { role_catalog: 'desarrollador', personas: 1, horas_totales: 5, costo_hora: 1000 },
  ], ROLES);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.filas.length, 2);
});

// sql/29 — gastos iniciales del Plan de Recursos ("+ Añadir gasto" del
// Simulador): partidas sueltas con nombre y valor que se suman al
// presupuesto junto con la mano de obra.
test('calcularPresupuestoPlan: suma los gastos al presupuesto de mano de obra', () => {
  const filas = [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }]; // 10.000
  const gastos = [{ description: 'Licencia Azure', amount: 2000000 }, { description: 'Viáticos', amount: 500000 }];
  assert.strictEqual(calcularPresupuestoPlan(filas, gastos), 2510000);
});

test('calcularPresupuestoPlan: sin gastos (parametro omitido) se comporta igual que antes', () => {
  const filas = [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }];
  assert.strictEqual(calcularPresupuestoPlan(filas), 10000);
});

test('calcularPresupuestoPlan: gastos con monto faltante o no numerico cuentan como 0', () => {
  const total = calcularPresupuestoPlan([], [{ description: 'x', amount: undefined }, { description: 'y', amount: 'abc' }]);
  assert.strictEqual(total, 0);
});

test('validarFilasGastos: gastos validos pasan normalizados a numero', () => {
  const r = validarFilasGastos([{ description: '  Licencia  ', amount: '2000000' }]);
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.gastos, [{ description: 'Licencia', amount: 2000000 }]);
});

test('validarFilasGastos: array vacio es valido (los gastos son opcionales)', () => {
  const r = validarFilasGastos([]);
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.gastos, []);
});

test('validarFilasGastos: rechaza descripcion vacia', () => {
  const r = validarFilasGastos([{ description: '   ', amount: 1000 }]);
  assert.match(r.error, /descripción/);
});

test('validarFilasGastos: rechaza monto en 0 o negativo', () => {
  for (const amount of [0, -100]) {
    const r = validarFilasGastos([{ description: 'x', amount }]);
    assert.ok(r.error, `deberia rechazar amount=${amount}`);
  }
});

// ---------------------------------------------------------------
// crearEquipoDesdeFilasPlanTx() — hallazgo del 2 sep 2026: recibe un `exec`
// ya inyectado (no toca la base directamente), así que se puede probar con
// un doble simple en vez de mockear src/db.
// ---------------------------------------------------------------

function execEspia() {
  const llamadas = [];
  const exec = async (sql, params) => { llamadas.push({ sql, params }); return {}; };
  exec.llamadas = llamadas;
  return exec;
}

test('crearEquipoDesdeFilasPlanTx: solo inserta las filas con salarioNuevo (persona real Y salario recién escrito)', async () => {
  const exec = execEspia();
  const filas = [
    { role_catalog: 'desarrollador', employee_id: 7, personas: 1, horas_totales: 10, costo_hora: 10000, salarioNuevo: 2100000 },
    // Cargo genérico: no tiene employee_id, nunca debería intentar un INSERT.
    { role_catalog: 'qa', employee_id: null, personas: 2, horas_totales: 10, costo_hora: 1000, salarioNuevo: null },
    // Persona real, pero su salario YA era conocido (salarioNuevo null): no hay nada que dar de alta.
    { role_catalog: 'analista', employee_id: 8, personas: 1, horas_totales: 5, costo_hora: 8338, salarioNuevo: null },
  ];
  const agregados = await crearEquipoDesdeFilasPlanTx(exec, 42, filas, 1);

  assert.strictEqual(exec.llamadas.length, 1, 'solo la fila con salarioNuevo dispara un INSERT');
  assert.strictEqual(agregados.length, 1);
  assert.deepStrictEqual(agregados[0], { employee_id: 7, role_catalog: 'desarrollador', costo_hora: 10000, monthly_salary: 2100000 });
});

test('crearEquipoDesdeFilasPlanTx: el INSERT lleva cost_center_id, employee_id, role_catalog, hourly_cost, monthly_salary y planned_hours en ese orden', async () => {
  const exec = execEspia();
  await crearEquipoDesdeFilasPlanTx(exec, 42, [
    { role_catalog: 'desarrollador', employee_id: 7, personas: 1, horas_totales: 10, costo_hora: 10000, salarioNuevo: 2100000 },
  ], 5);

  assert.match(exec.llamadas[0].sql, /INSERT INTO mp_equipo_proyecto/);
  assert.match(exec.llamadas[0].sql, /ON DUPLICATE KEY UPDATE/, 'debe tolerar que la fila ya exista (tarifa manual previa en ese mismo centro)');
  assert.match(exec.llamadas[0].sql, /planned_hours/, 'las horas del plan deben llegar a Equipo del Proyecto (8 sep 2026, bug reportado: quedaban en null)');
  // horas_totales (10) va como planned_hours, ANTES de userId (5) — si no,
  // "Horas Planeadas" y "Costo Planeado" en Equipo del Proyecto se quedan
  // vacíos aunque el Plan de Recursos sí tenga las horas.
  assert.deepStrictEqual(exec.llamadas[0].params, [42, 7, 'desarrollador', 10000, 2100000, 10, 5]);
});

test('crearEquipoDesdeFilasPlanTx: sin ninguna fila con salarioNuevo, no llama a exec ni una vez', async () => {
  const exec = execEspia();
  const agregados = await crearEquipoDesdeFilasPlanTx(exec, 42, [
    { role_catalog: 'qa', employee_id: null, personas: 1, horas_totales: 10, costo_hora: 1000, salarioNuevo: null },
  ], 1);
  assert.strictEqual(exec.llamadas.length, 0);
  assert.deepStrictEqual(agregados, []);
});

// sincronizarEquipoDesdePlanTx (8 sep 2026, reportado por el usuario DOS
// veces con casos reales): una "Persona real" del Plan de Recursos con
// salario YA conocido — el caso más común — no llegaba a Equipo del
// Proyecto, porque crearEquipoDesdeFilasPlanTx solo da de alta a quien trae
// salario NUEVO. Primer reporte: Alexander Alberto Muñoz Coneo, que SÍ
// estaba en el equipo pero sin "Horas Planeadas". Segundo: Emily Tench
// (20h en "Talento Humano"), que ni siquiera aparecía en el equipo.
//
// espiaConExistentes(ids): el SELECT de "quién ya está" devuelve esos
// employee_id; el resto de sentencias devuelve {} como execEspia.
function espiaConExistentes(ids) {
  const llamadas = [];
  const exec = async (sql, params) => {
    llamadas.push({ sql, params });
    if (/^SELECT employee_id FROM mp_equipo_proyecto/.test(sql.trim())) {
      return ids.map((employee_id) => ({ employee_id }));
    }
    return {};
  };
  exec.llamadas = llamadas;
  return exec;
}

test('sincronizarEquipoDesdePlanTx: si la persona YA está en el equipo, actualiza sus planned_hours', async () => {
  const exec = espiaConExistentes([8]);
  const creados = await sincronizarEquipoDesdePlanTx(exec, 27, [
    { role_catalog: 'analista', employee_id: 8, personas: 1, horas_totales: 120, costo_hora: 8338, salarioNuevo: null },
  ], 5);

  const update = exec.llamadas.find((l) => /UPDATE mp_equipo_proyecto/.test(l.sql));
  assert.ok(update, 'deberia actualizar la fila existente');
  assert.match(update.sql, /SET planned_hours/);
  assert.match(update.sql, /is_active = 1/, 'no debe reactivar a alguien que se sacó del equipo');
  assert.deepStrictEqual(update.params, [120, 27, 8]);
  assert.deepStrictEqual(creados, [], 'no dio de alta a nadie: ya estaba');
});

// El caso de Emily Tench: en el plan, con tarifa conocida, pero SIN fila en
// mp_equipo_proyecto. Antes no pasaba nada y la pantalla salia vacia.
test('sincronizarEquipoDesdePlanTx: si la persona NO está en el equipo, la da de alta con cargo, costo/hora y horas', async () => {
  const exec = espiaConExistentes([]); // el centro no tiene a nadie todavia
  const creados = await sincronizarEquipoDesdePlanTx(exec, 5, [
    { role_catalog: 'innovacion_e_ia', employee_id: 4, personas: 1, horas_totales: 20, costo_hora: 19048, salarioNuevo: null },
  ], 5);

  const insert = exec.llamadas.find((l) => /INSERT INTO mp_equipo_proyecto/.test(l.sql));
  assert.ok(insert, 'deberia dar de alta a la persona que falta');
  assert.match(insert.sql, /planned_hours/, 'las horas del plan tienen que llegar con el alta');
  // cost_center_id, employee_id, role_catalog, hourly_cost, planned_hours, added_by
  assert.deepStrictEqual(insert.params, [5, 4, 'innovacion_e_ia', 19048, 20, 5]);
  assert.deepStrictEqual(creados, [
    { employee_id: 4, role_catalog: 'innovacion_e_ia', costo_hora: 19048, horas_totales: 20 },
  ], 'debe reportar el alta para que quede en el historial');
});

test('sincronizarEquipoDesdePlanTx: cargos genéricos (sin employee_id) no tocan Equipo del Proyecto', async () => {
  const exec = espiaConExistentes([]);
  const creados = await sincronizarEquipoDesdePlanTx(exec, 27, [
    { role_catalog: 'qa', employee_id: null, personas: 2, horas_totales: 10, costo_hora: 1000, salarioNuevo: null },
  ], 5);
  assert.strictEqual(exec.llamadas.length, 0, 'ni siquiera deberia leer quien esta en el equipo');
  assert.deepStrictEqual(creados, []);
});
