'use strict';

/**
 * Plan de Recursos (sql/27) — presupuesto calculado por rol, no escrito a
 * mano: Presupuesto = Σ (personas × horas_totales × costo_hora).
 *
 * Ana lidera ALFA (ctx.fixtures.CENTROS.alfa) — se usa como el centro de
 * prueba en todo este archivo, con roles ya sembrados en mp_tarifa_cargo
 * (sql/20): 'analista', 'desarrollador', 'qa', etc.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

conBase(ctx, 'GET /centros/:id/plan-recursos: sin plan guardado, filas vacio', async () => {
  const r = await ctx.clientes.ana.get(`/api/costeo/centros/${ctx.fixtures.CENTROS.alfa.id}/plan-recursos`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.filas, []);
});

conBase(ctx, 'PUT /plan-recursos: guarda el plan, calcula el presupuesto y lo fija en el centro', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [
      { role_catalog: 'analista', personas: 1, horas_totales: 9, costo_hora: 5000 },
      { role_catalog: 'desarrollador', personas: 1, horas_totales: 5, costo_hora: 6000 },
      { role_catalog: 'qa', personas: 1, horas_totales: 12, costo_hora: 7000 },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.presupuesto), 159000);

  const [centro] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(centro.budget), 159000);
  assert.strictEqual(Number(centro.budget_from_plan), 1);

  const filas = await ctx.db.query('SELECT role_catalog, personas, horas_totales, costo_hora FROM mp_plan_recursos WHERE cost_center_id = ? ORDER BY role_catalog', [id]);
  assert.strictEqual(filas.length, 3);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: guardar de nuevo REEMPLAZA el plan anterior, no lo acumula', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'analista', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 2, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number(r.json.presupuesto), 20000, '2 personas x 10h x 1000 = 20.000');

  const filas = await ctx.db.query('SELECT role_catalog FROM mp_plan_recursos WHERE cost_center_id = ?', [id]);
  assert.strictEqual(filas.length, 1, 'el analista de la primera version no deberia seguir ahi');
  assert.strictEqual(filas[0].role_catalog, 'qa');

  await ctx.resembrar();
});

// Regresion (3 sep 2026, a pedido explícito): antes guardar el plan SIEMPRE
// pisaba el presupuesto del centro, así que un PM no podía llevar "cuántas
// horas va a trabajar cada quien" (para el indicador Costo Planeado) en un
// proyecto que ya tenía presupuesto fijado a mano sin que se lo cambiara
// solo. actualizar_presupuesto:false guarda las filas igual, pero deja el
// presupuesto y budget_from_plan intactos.
conBase(ctx, 'PUT /plan-recursos con actualizar_presupuesto:false NO toca el presupuesto del centro', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const [antes] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(antes.budget_from_plan), 0, 'premisa: ALFA empieza con presupuesto a mano');

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 12, costo_hora: 7000 }],
    actualizar_presupuesto: false,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.presupuesto), 84000, 'el total calculado sigue viniendo en la respuesta');

  const [despues] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(despues.budget), Number(antes.budget), 'el presupuesto del centro NO debe cambiar');
  assert.strictEqual(Number(despues.budget_from_plan), 0, 'el centro sigue en modo presupuesto a mano');

  const filas = await ctx.db.query('SELECT role_catalog, horas_totales FROM mp_plan_recursos WHERE cost_center_id = ?', [id]);
  assert.strictEqual(filas.length, 1, 'la fila SI debe quedar guardada, aunque no se haya usado para el presupuesto');
  assert.strictEqual(Number(filas[0].horas_totales), 12);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos con actualizar_presupuesto:false en un centro que SI calculaba su presupuesto del plan lo libera (budget_from_plan vuelve a 0, budget queda como estaba)', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  // Primero lo deja en modo "presupuesto = plan" (comportamiento de siempre).
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  const [conPlan] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(conPlan.budget_from_plan), 1);
  assert.strictEqual(Number(conPlan.budget), 10000);

  // Ahora se guarda de nuevo, sin marcar la casilla: las horas planeadas se
  // conservan (para Indicadores) pero el presupuesto deja de depender del plan.
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 2, horas_totales: 10, costo_hora: 1000 }],
    actualizar_presupuesto: false,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [despues] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(despues.budget_from_plan), 0, 'budget_from_plan debe soltarse');
  assert.strictEqual(Number(despues.budget), Number(conPlan.budget), 'el presupuesto se queda en el ultimo valor fijado por el plan, no se recalcula ni se resetea');

  await ctx.resembrar();
});

// El indicador "Costo Planeado (Mano de Obra)" (costo_planeado_mano_obra)
// pasó a salir de Equipo del Proyecto (sql/35, planned_hours), NO de este
// Plan de Recursos — ver el comentario junto a getCostoPlaneado en
// costo-indicadores-17.js y las pruebas en motor-costeo.test.js. Este test
// fija lo contrario: guardar un plan aquí NO debe mover ese indicador, para
// no contar las mismas horas dos veces si algún día persona+rol coinciden
// en las dos tablas.
conBase(ctx, 'GET /indicadores-17: costo_planeado_mano_obra NO sale de Plan de Recursos', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const { json: antes } = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const valorAntes = antes.centros.find((c) => c.cost_center_id === id).costo_planeado_mano_obra;

  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'analista', personas: 1, horas_totales: 20, costo_hora: 5000 }],
    actualizar_presupuesto: false,
  });

  const { json: despues } = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const valorDespues = despues.centros.find((c) => c.cost_center_id === id).costo_planeado_mano_obra;
  assert.strictEqual(Number(valorDespues), Number(valorAntes), 'guardar el Plan de Recursos no debe mover este indicador');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: rechaza un rol que no existe en el catalogo', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'inventado_no_existe', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 400);
});

conBase(ctx, 'PUT /plan-recursos: rechaza personas/horas/costo en 0 o negativos', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 0, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 400);
});

conBase(ctx, 'PUT /plan-recursos: rechaza el mismo rol repetido dos veces', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [
      { role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 },
      { role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 },
    ],
  });
  assert.strictEqual(r.status, 400);
});

// sql/29 — gastos iniciales del Plan de Recursos ("+ Añadir gasto" del
// Simulador y de "Editar centro"): partidas sueltas con nombre y valor que
// se suman al presupuesto junto con la mano de obra.
conBase(ctx, 'PUT /plan-recursos: con gastos, el presupuesto es mano de obra + gastos', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }], // 10.000
    gastos: [{ description: 'Licencia Azure', amount: 2000000 }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.presupuesto), 2010000);

  const [centro] = await ctx.db.query('SELECT budget FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(centro.budget), 2010000);

  const gastos = await ctx.db.query('SELECT description, amount FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [id]);
  assert.strictEqual(gastos.length, 1);
  assert.strictEqual(gastos[0].description, 'Licencia Azure');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: guardar sin mandar gastos borra los que ya habia (reemplaza todo el plan)', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
    gastos: [{ description: 'Licencia Azure', amount: 2000000 }],
  });

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number(r.json.presupuesto), 10000, 'sin gastos en este PUT, el presupuesto vuelve a ser solo mano de obra');

  const gastos = await ctx.db.query('SELECT 1 FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [id]);
  assert.strictEqual(gastos.length, 0);

  await ctx.resembrar();
});

conBase(ctx, 'GET /plan-recursos: devuelve filas y gastos por separado', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
    gastos: [{ description: 'Licencia Azure', amount: 2000000 }],
  });

  const r = await ctx.clientes.ana.get(`/api/costeo/centros/${id}/plan-recursos`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.filas.length, 1);
  assert.strictEqual(r.json.gastos.length, 1);
  assert.strictEqual(r.json.gastos[0].description, 'Licencia Azure');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: rechaza un gasto sin descripcion o con monto en 0', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
    gastos: [{ description: '', amount: 2000000 }],
  });
  assert.strictEqual(r.status, 400);
});

conBase(ctx, 'DELETE /plan-recursos: tambien borra los gastos', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
    gastos: [{ description: 'Licencia Azure', amount: 2000000 }],
  });

  const del = await ctx.clientes.ana.delete(`/api/costeo/centros/${id}/plan-recursos`);
  assert.strictEqual(del.status, 200);

  const gastos = await ctx.db.query('SELECT 1 FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [id]);
  assert.strictEqual(gastos.length, 0);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: Bruno (lider de BETA) no puede tocar el plan de ALFA', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.bruno.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 403);
});

conBase(ctx, 'una vez que el centro tiene plan, PUT /centros/:id no deja pisar el presupuesto a mano', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}`, { budget: 999999999 });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));

  const [centro] = await ctx.db.query('SELECT budget FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(centro.budget), 10000, 'el presupuesto no debio cambiar');

  await ctx.resembrar();
});

conBase(ctx, 'DELETE /plan-recursos: libera el centro, y despues SI se puede editar el presupuesto a mano', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });

  const del = await ctx.clientes.ana.delete(`/api/costeo/centros/${id}/plan-recursos`);
  assert.strictEqual(del.status, 200);

  const [centro] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(centro.budget_from_plan), 0);
  assert.strictEqual(Number(centro.budget), 10000, 'el ultimo presupuesto calculado se conserva como punto de partida');

  const editar = await ctx.clientes.ana.put(`/api/costeo/centros/${id}`, { budget: 5000000 });
  assert.strictEqual(editar.status, 200, JSON.stringify(editar.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_plan_recursos WHERE cost_center_id = ?', [id]);
  assert.strictEqual(filas.length, 0, 'el plan debio borrarse por completo');

  await ctx.resembrar();
});

conBase(ctx, 'GET /centros trae budget_from_plan para que el frontend sepa si bloquear el campo', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });

  const r = await ctx.clientes.ana.get('/api/costeo/centros');
  const alfa = r.json.centros.find((c) => c.cost_center_id === id);
  assert.strictEqual(Number(alfa.budget_from_plan), 1);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Filas "por Persona" (sql/34) — el costo/hora sale del salario real de
// alguien ya conocido, no se escribe a mano ni se estima por cargo.
// ---------------------------------------------------------------

conBase(ctx, 'PUT /plan-recursos: una fila "por Persona" calcula el costo/hora desde el salario real, ignorando lo que mande el body', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const alta = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Del Plan',
    cost_center_id: id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950, // 1.750.950 / 210 = 8.338
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));
  const employeeId = alta.json.employee_id;

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'desarrollador', employee_id: employeeId, personas: 99, horas_totales: 10, costo_hora: 1 }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.presupuesto), 83380, '1 persona (no 99) x 10h x 8.338 = 83.380, ignorando lo que mando el body');
  assert.strictEqual(r.json.filas[0].personas, 1, 'personas se fuerza a 1 en modo Persona, sin importar lo que se mandara');
  assert.strictEqual(r.json.filas[0].costo_hora, 8338);

  const [fila] = await ctx.db.query('SELECT employee_id, personas, costo_hora FROM mp_plan_recursos WHERE cost_center_id = ?', [id]);
  assert.strictEqual(fila.employee_id, employeeId);
  assert.strictEqual(fila.personas, 1);
  assert.strictEqual(Number(fila.costo_hora), 8338);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: rechaza una fila "por Persona" si esa persona no tiene salario conocido', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    // Alicia (fixtures.EMPLEADOS.aliceAlfa) tiene tarifa por hora, pero
    // nunca un salario mensual cargado (mp_equipo_proyecto.monthly_salary NULL).
    filas: [{ role_catalog: 'desarrollador', employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id, horas_totales: 10 }],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /no tiene un salario cargado/);
});

conBase(ctx, 'PUT /plan-recursos: dos personas reales pueden compartir el mismo rol (no dispara "rol repetido")', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const p1 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Uno Del Plan', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  const p2 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Dos Del Plan', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 1050000,
  });
  assert.strictEqual(p1.status, 201, JSON.stringify(p1.json));
  assert.strictEqual(p2.status, 201, JSON.stringify(p2.json));

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [
      { role_catalog: 'desarrollador', employee_id: p1.json.employee_id, horas_totales: 10 },
      { role_catalog: 'desarrollador', employee_id: p2.json.employee_id, horas_totales: 10 },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas.length, 2);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: rechaza a la misma persona dos veces en el plan', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const p1 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Repetida Del Plan', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(p1.status, 201, JSON.stringify(p1.json));

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [
      { role_catalog: 'desarrollador', employee_id: p1.json.employee_id, horas_totales: 10 },
      { role_catalog: 'qa', employee_id: p1.json.employee_id, horas_totales: 5 },
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /una sola vez en el plan/);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: se puede mezclar una fila "por Cargo" con una "por Persona" en el mismo plan', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const p1 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Mixta Del Plan', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(p1.status, 201, JSON.stringify(p1.json));

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [
      { role_catalog: 'desarrollador', employee_id: p1.json.employee_id, horas_totales: 10 }, // persona: 1x10x10000=100.000
      { role_catalog: 'qa', personas: 2, horas_totales: 10, costo_hora: 1000 }, // cargo: 2x10x1000=20.000
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.presupuesto), 120000);

  await ctx.resembrar();
});

conBase(ctx, 'GET /plan-recursos: trae el nombre de la persona en las filas "por Persona"', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const p1 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Visible Del Plan', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(p1.status, 201, JSON.stringify(p1.json));

  await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'desarrollador', employee_id: p1.json.employee_id, horas_totales: 10 }],
  });

  const r = await ctx.clientes.ana.get(`/api/costeo/centros/${id}/plan-recursos`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.filas[0].employee_name, 'Persona Visible Del Plan');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Salario NUEVO escrito desde el Plan de Recursos (2 sep 2026, hallazgo
// reportado por un PM real): antes, si una "Persona real" nunca había
// tenido salario en NINGÚN proyecto, la única forma de ponérselo era ir a
// Equipo del Proyecto — que exige un cost_center_id ya existente. Para
// plantear un proyecto NUEVO con esa persona había que meterla primero a
// un proyecto ajeno solo para poder escribirle el sueldo, crear el
// proyecto real, y después moverla — un ciclo de 4 pasos. Ahora la fila
// del plan puede traer `monthly_salary` cuando no hay uno conocido, y el
// servidor la da de alta en Equipo del Proyecto en el mismo paso.
// ---------------------------------------------------------------

conBase(ctx, 'PUT /plan-recursos: una fila "por Persona" con salario NUEVO (nunca visto en ningún lado) se acepta y da de alta a esa persona en Equipo del Proyecto', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const nuevo = await ctx.clientes.admin.post('/api/employees', {
    canonical_name: 'Persona Salario Nuevo', email: 'salario.nuevo@ejemplo.test',
  });
  assert.strictEqual(nuevo.status, 201, JSON.stringify(nuevo.json));
  const employeeId = nuevo.json.employee_id;

  // Antes de este arreglo esto se rechazaba con "no tiene un salario cargado".
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'desarrollador', employee_id: employeeId, horas_totales: 10, monthly_salary: 2100000 }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas[0].costo_hora, 10000, '2.100.000 / 210 = 10.000');
  assert.strictEqual(r.json.equipo_creado, 1);

  const [fila] = await ctx.db.query(
    'SELECT cost_center_id, employee_id, hourly_cost, monthly_salary, is_active FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [id, employeeId]
  );
  assert.ok(fila, 'deberia haber quedado dado de alta en Equipo del Proyecto, sin pasar por otro centro primero');
  assert.strictEqual(Number(fila.hourly_cost), 10000);
  assert.strictEqual(Number(fila.monthly_salary), 2100000);
  assert.strictEqual(fila.is_active, 1);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /plan-recursos: un monthly_salary en 0 o negativo se rechaza igual que no mandar ninguno', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const nuevo = await ctx.clientes.admin.post('/api/employees', {
    canonical_name: 'Persona Salario Invalido', email: 'salario.invalido@ejemplo.test',
  });
  assert.strictEqual(nuevo.status, 201, JSON.stringify(nuevo.json));

  for (const monthly_salary of [0, -100]) {
    const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
      filas: [{ role_catalog: 'desarrollador', employee_id: nuevo.json.employee_id, horas_totales: 10, monthly_salary }],
    });
    assert.strictEqual(r.status, 400, `monthly_salary=${monthly_salary} deberia rechazarse`);
    assert.match(r.json.error, /no tiene un salario cargado/);
  }
});

conBase(ctx, 'PUT /plan-recursos: si la persona YA tiene salario conocido, un monthly_salary distinto en el body se ignora', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const alta = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Con Salario Previo', cost_center_id: id, role_catalog: 'desarrollador', monthly_salary: 1750950,
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));
  const employeeId = alta.json.employee_id;

  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    // Manda un salario distinto al real a propósito: como ya hay uno
    // conocido, este debe ignorarse — el mismo principio que ya tenía la
    // regla original ("costo_hora NUNCA sale del body").
    filas: [{ role_catalog: 'desarrollador', employee_id: employeeId, horas_totales: 10, monthly_salary: 999999999 }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas[0].costo_hora, 8338, 'debe seguir usando el salario YA conocido (1.750.950/210), no el inventado');
  assert.strictEqual(r.json.equipo_creado, 0, 'no hay nada nuevo que dar de alta: esta persona ya estaba');

  await ctx.resembrar();
});

conBase(ctx, 'POST /centros: un proyecto NUEVO con una "Persona real" sin salario conocido se crea escribiendo su sueldo ahí mismo, sin pasar por otro proyecto primero', async () => {
  const nuevo = await ctx.clientes.admin.post('/api/employees', {
    canonical_name: 'Persona Del Proyecto Nuevo', email: 'proyecto.nuevo@ejemplo.test',
  });
  assert.strictEqual(nuevo.status, 201, JSON.stringify(nuevo.json));
  const employeeId = nuevo.json.employee_id;

  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Proyecto Nuevo Con Persona Real', start_date: '2026-03-01', planned_end_date: '2026-09-30',
    plan_recursos: [
      { role_catalog: 'desarrollador', employee_id: employeeId, horas_totales: 20, monthly_salary: 1750950 },
    ],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.equipo_creado, 1);
  assert.strictEqual(Number(r.json.budget), 166760, '20h x 8.338 = 166.760');

  const [fila] = await ctx.db.query(
    'SELECT hourly_cost, monthly_salary, is_active FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [r.json.cost_center_id, employeeId]
  );
  assert.ok(fila, 'deberia haber quedado en Equipo del Proyecto del centro RECIEN creado, en el mismo paso');
  assert.strictEqual(Number(fila.hourly_cost), 8338);
  assert.strictEqual(Number(fila.monthly_salary), 1750950);
  assert.strictEqual(fila.is_active, 1);

  await ctx.resembrar();
});
