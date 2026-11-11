'use strict';

/**
 * Personas en Equipo del Proyecto SIN proyecto todavía (sql/45, 16 oct 2026).
 *
 * Pedido del usuario: un PM registra a alguien cuyo proyecto llega en unos
 * días, y se lo asigna después desde Editar.
 *
 * 21 oct 2026: "Sin proyecto" es la bolsa común — todos los PMs la ven y
 * toman de ahí a la gente para sus proyectos. Tener gente en la bolsa es lo
 * normal, así que ya no genera la alerta "Persona sin proyecto".
 */

const assert = require('node:assert');
const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

async function registrarSinProyecto(cliente, empleado) {
  return cliente.post('/api/costeo/equipo', {
    employee_id: empleado.id, role_catalog: 'desarrollador', hourly_cost: 15000,
  });
}

const sinProyectoDe = (r) => r.json.equipo.filter((m) => m.cost_center_id === null);
const alertasSinProyecto = (r) => r.json.alertas.filter((a) => a.tipo === 'Persona sin proyecto');

conBase(ctx, 'un PM registra a alguien sin proyecto: queda en la tabla como "sin proyecto"', async () => {
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  const r = await registrarSinProyecto(ctx.clientes.ana, brenda);
  assert.strictEqual(r.status, 201, `${r.status} ${r.texto || JSON.stringify(r.json)}`);

  const filas = sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo'));
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].employee_id, brenda.id);

  // Dos veces sin proyecto la misma persona no: se edita la que ya existe.
  const otra = await registrarSinProyecto(ctx.clientes.ana, brenda);
  assert.strictEqual(otra.status, 409);

  await ctx.resembrar();
});

conBase(ctx, 'la bolsa "Sin proyecto" la ven todos los PMs, el admin y el CEO', async () => {
  await registrarSinProyecto(ctx.clientes.ana, ctx.fixtures.EMPLEADOS.brendaBeta);

  assert.strictEqual(sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo')).length, 1, 'Ana la registró');
  assert.strictEqual(sinProyectoDe(await ctx.clientes.bruno.get('/api/costeo/equipo')).length, 1, 'Bruno también la ve');
  assert.strictEqual(sinProyectoDe(await ctx.clientes.admin.get('/api/costeo/equipo')).length, 1, 'el admin la ve');
  assert.strictEqual(sinProyectoDe(await ctx.clientes.ceo.get('/api/costeo/equipo')).length, 1, 'el CEO la ve');

  // La gente de ALFA la ve con su proyecto, pero sin ninguna cifra.
  const deBruno = await ctx.clientes.bruno.get('/api/costeo/equipo');
  const deAlfa = deBruno.json.equipo.filter((m) => m.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.ok(deAlfa.length > 0);
  assert.ok(deAlfa.every((m) => m.ajeno === 1 && m.hourly_cost === null), 'ALFA le llega a Bruno sin costo/hora');

  await ctx.resembrar();
});

conBase(ctx, 'la bolsa que carga el admin: cualquier PM la asigna a SU proyecto, pero no la borra', async () => {
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  const alta = await ctx.clientes.admin.post('/api/costeo/equipo', { employee_id: brenda.id, role_catalog: 'otro' });
  assert.strictEqual(alta.status, 201, `${alta.status} ${alta.texto || JSON.stringify(alta.json)}`);
  const id = alta.json.team_member_id;

  assert.strictEqual((await ctx.clientes.bruno.delete(`/api/costeo/equipo/${id}`)).status, 403, 'un PM no borra de la bolsa');

  // A un proyecto ajeno no.
  const ajeno = await ctx.clientes.bruno.put(`/api/costeo/equipo/${id}`, { cost_center_id: ctx.fixtures.CENTROS.alfa.id, monthly_salary: 2100000 });
  assert.strictEqual(ajeno.status, 403);

  const r = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(r.status, 200, `${r.status} ${r.texto || JSON.stringify(r.json)}`);
  const [fila] = await ctx.db.query('SELECT cost_center_id, role_catalog FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(fila.cost_center_id, ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(fila.role_catalog, 'desarrollador');

  await ctx.resembrar();
});

conBase(ctx, 'un empleado nuevo de "Gestionar empleados" entra solo a la bolsa "Sin proyecto"', async () => {
  const r = await ctx.clientes.admin.post('/api/employees', {
    canonical_name: 'Trabajador Recién Contratado', email: 'recien@ejemplo.test',
  });
  assert.strictEqual(r.status, 201, `${r.status} ${r.texto || JSON.stringify(r.json)}`);
  const filas = await ctx.db.query('SELECT cost_center_id, role_catalog FROM mp_equipo_proyecto WHERE employee_id = ?', [r.json.employee_id]);
  assert.deepStrictEqual(filas.map((f) => [f.cost_center_id, f.role_catalog]), [[null, 'otro']]);
  assert.ok(
    sinProyectoDe(await ctx.clientes.bruno.get('/api/costeo/equipo')).some((m) => m.employee_id === r.json.employee_id),
    'cualquier PM lo ve en la bolsa'
  );

  await ctx.resembrar();
});

conBase(ctx, 'tener gente sin proyecto NO genera alertas, ni para el PM ni para el CEO, aunque lleve días', async () => {
  // Registrada por un PM y con 6 días: el caso que antes escalaba al CEO.
  await registrarSinProyecto(ctx.clientes.ana, ctx.fixtures.EMPLEADOS.brendaBeta);
  await ctx.db.query('UPDATE mp_equipo_proyecto SET added_at = NOW() - INTERVAL 6 DAY WHERE cost_center_id IS NULL');

  for (const cliente of [ctx.clientes.ana, ctx.clientes.bruno, ctx.clientes.ceo]) {
    const r = await cliente.get('/api/costeo/alertas');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(alertasSinProyecto(r).length, 0, 'no debe haber alerta "Persona sin proyecto"');
    assert.ok(!r.json.escalamientos.some((e) => e.tipo === 'Persona sin proyecto'), 'ni en "Sin corregir"');
  }

  await ctx.resembrar();
});

conBase(ctx, 'asignarle un proyecto con Editar lo saca de la bolsa', async () => {
  await registrarSinProyecto(ctx.clientes.ana, ctx.fixtures.EMPLEADOS.brendaBeta);
  const [fila] = sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo'));

  // Bruno puede tomarla de la bolsa, pero solo para SUS proyectos.
  const ajeno = await ctx.clientes.bruno.put(`/api/costeo/equipo/${fila.team_member_id}`, { cost_center_id: ctx.fixtures.CENTROS.alfa.id });
  assert.strictEqual(ajeno.status, 403);

  const r = await ctx.clientes.ana.put(`/api/costeo/equipo/${fila.team_member_id}`, { cost_center_id: ctx.fixtures.CENTROS.alfa.id });
  assert.strictEqual(r.status, 200, `${r.status} ${r.texto || JSON.stringify(r.json)}`);

  assert.strictEqual(sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo')).length, 0);

  await ctx.resembrar();
});

conBase(ctx, '"Agregar persona nueva" también acepta quedar sin proyecto', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Recién Llegada', role_catalog: 'analista', hourly_cost: 12000,
  });
  assert.strictEqual(r.status, 201, `${r.status} ${r.texto || JSON.stringify(r.json)}`);
  const filas = sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo'));
  assert.deepStrictEqual(filas.map((f) => f.canonical_name), ['Persona Recién Llegada']);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Un solo salario por persona (16 oct 2026): el salario ya no se bloquea al
// agregar a alguien a otro proyecto; si se cambia, el nuevo reemplaza al
// anterior en todas sus asignaciones por salario.
// ---------------------------------------------------------------

conBase(ctx, 'salario: al agregar a alguien con un salario nuevo, reemplaza al anterior en sus otros proyectos', async () => {
  const alicia = ctx.fixtures.EMPLEADOS.aliceAlfa;
  // Alicia ya está en ALFA; se le pone un salario ahí.
  const filaAlfa = ctx.fixtures.EQUIPO.aliceEnAlfa.id;
  const puesto = await ctx.clientes.ceo.put(`/api/costeo/equipo/${filaAlfa}`, { monthly_salary: 2100000 });
  assert.strictEqual(puesto.status, 200);

  // Se agrega a BETA con un salario distinto.
  const r = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.beta.id, employee_id: alicia.id,
    role_catalog: 'desarrollador', monthly_salary: 3150000,
  });
  assert.strictEqual(r.status, 201, `${r.status} ${r.texto || JSON.stringify(r.json)}`);

  const filas = await ctx.db.query(
    'SELECT cost_center_id, monthly_salary, hourly_cost FROM mp_equipo_proyecto WHERE employee_id = ? ORDER BY cost_center_id',
    [alicia.id]
  );
  assert.deepStrictEqual(filas.map((f) => Number(f.monthly_salary)), [3150000, 3150000], 'ALFA debió quedar con el salario nuevo');
  assert.strictEqual(Number(filas[0].hourly_cost), Number(filas[1].hourly_cost), 'mismo costo/hora en los dos proyectos');

  await ctx.resembrar();
});

conBase(ctx, 'salario: quien tiene costo/hora escrito a mano (sin salario) no se toca', async () => {
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  const r = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, employee_id: brenda.id,
    role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(r.status, 201);
  const [enBeta] = await ctx.db.query(
    'SELECT monthly_salary, hourly_cost FROM mp_equipo_proyecto WHERE employee_id = ? AND cost_center_id = ?',
    [brenda.id, ctx.fixtures.CENTROS.beta.id]
  );
  assert.strictEqual(enBeta.monthly_salary, null);
  assert.strictEqual(Number(enBeta.hourly_cost), ctx.fixtures.EQUIPO.brendaEnBeta.tarifa);

  await ctx.resembrar();
});

conBase(ctx, 'agregar a un proyecto a quien estaba "sin proyecto" convierte esa fila; un segundo proyecto suma otra', async () => {
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  await registrarSinProyecto(ctx.clientes.ceo, brenda);

  const primero = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.gamma.id, employee_id: brenda.id, role_catalog: 'desarrollador', hourly_cost: 15000,
  });
  assert.strictEqual(primero.status, 201, `${primero.status} ${primero.texto || JSON.stringify(primero.json)}`);

  const filas = await ctx.db.query('SELECT cost_center_id FROM mp_equipo_proyecto WHERE employee_id = ? ORDER BY cost_center_id', [brenda.id]);
  assert.deepStrictEqual(
    filas.map((f) => f.cost_center_id),
    [ctx.fixtures.CENTROS.beta.id, ctx.fixtures.CENTROS.gamma.id],
    'la fila sin proyecto debió convertirse en GAMMA, no quedar al lado'
  );

  await ctx.resembrar();
});

// 16 oct 2026: sin proyecto se puede registrar sin salario; para asignarle
// un proyecto hace falta, porque de ahí sale el costo/hora.
conBase(ctx, 'sin proyecto se registra sin salario; para asignarle proyecto exige el salario', async () => {
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  const alta = await ctx.clientes.ana.post('/api/costeo/equipo', { employee_id: brenda.id, role_catalog: 'desarrollador' });
  assert.strictEqual(alta.status, 201, `${alta.status} ${alta.texto || JSON.stringify(alta.json)}`);
  const [fila] = sinProyectoDe(await ctx.clientes.ana.get('/api/costeo/equipo'));
  assert.strictEqual(Number(fila.hourly_cost), 0);

  const sinSalario = await ctx.clientes.ana.put(`/api/costeo/equipo/${fila.team_member_id}`, { cost_center_id: ctx.fixtures.CENTROS.alfa.id });
  assert.strictEqual(sinSalario.status, 400);
  assert.match(sinSalario.json.error, /salario mensual/);

  const conSalario = await ctx.clientes.ana.put(`/api/costeo/equipo/${fila.team_member_id}`, {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, monthly_salary: 2100000,
  });
  assert.strictEqual(conSalario.status, 200, `${conSalario.status} ${conSalario.texto || JSON.stringify(conSalario.json)}`);
  const [asignada] = await ctx.db.query('SELECT cost_center_id, hourly_cost FROM mp_equipo_proyecto WHERE team_member_id = ?', [fila.team_member_id]);
  assert.strictEqual(asignada.cost_center_id, ctx.fixtures.CENTROS.alfa.id);
  assert.ok(Number(asignada.hourly_cost) > 0, 'el costo/hora debe salir del salario');

  await ctx.resembrar();
});

conBase(ctx, 'agregar directo a un proyecto sin salario se rechaza con el motivo', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, employee_id: ctx.fixtures.EMPLEADOS.brendaBeta.id, role_catalog: 'desarrollador',
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /salario mensual/);
});

// 16 oct 2026: "Ninguno" en el Centro de Costos saca a la persona del proyecto.
conBase(ctx, 'sacar del proyecto: si era el único queda "Sin proyecto" (en la bolsa); si tiene otro, solo deja este', async () => {
  const nueva = await ctx.clientes.ceo.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Para Sacar', role_catalog: 'analista', monthly_salary: 2100000,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
  });
  assert.strictEqual(nueva.status, 201, `${nueva.status} ${nueva.texto || JSON.stringify(nueva.json)}`);
  const { employee_id, team_member_id } = nueva.json;

  // Con otro proyecto (GAMMA): sacarla de ALFA solo borra esa asignación.
  const enGamma = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.gamma.id, employee_id, role_catalog: 'analista', monthly_salary: 2100000,
  });
  assert.strictEqual(enGamma.status, 201);
  const fuera = await ctx.clientes.ceo.put(`/api/costeo/equipo/${team_member_id}`, { cost_center_id: null });
  assert.strictEqual(fuera.status, 200, `${fuera.status} ${fuera.texto || JSON.stringify(fuera.json)}`);
  let filas = await ctx.db.query('SELECT team_member_id, cost_center_id FROM mp_equipo_proyecto WHERE employee_id = ?', [employee_id]);
  assert.deepStrictEqual(filas.map((f) => f.cost_center_id), [ctx.fixtures.CENTROS.gamma.id]);

  // Era su único proyecto: vuelve a la bolsa "Sin proyecto".
  const sinProyecto = await ctx.clientes.ceo.put(`/api/costeo/equipo/${filas[0].team_member_id}`, { cost_center_id: null });
  assert.strictEqual(sinProyecto.status, 200);
  filas = await ctx.db.query('SELECT cost_center_id FROM mp_equipo_proyecto WHERE employee_id = ?', [employee_id]);
  assert.deepStrictEqual(filas.map((f) => f.cost_center_id), [null]);

  await ctx.resembrar();
});

conBase(ctx, 'sacar del proyecto a quien ya tiene horas ahí se rechaza (usar Inactivar)', async () => {
  const [conHoras] = await ctx.db.query(
    `SELECT ep.team_member_id FROM mp_equipo_proyecto ep
       JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
       JOIN mp_costeo_task_facts t ON t.employee_id = ep.employee_id
        AND (t.project_name = cc.project_name OR t.project_name = cc.project_folder)
      LIMIT 1`
  );
  assert.ok(conHoras, 'los fixtures deberían tener a alguien con horas en su proyecto');
  const r = await ctx.clientes.ceo.put(`/api/costeo/equipo/${conHoras.team_member_id}`, { cost_center_id: null });
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /Inactivar/);
});

// 16 oct 2026: eliminar un proyecto no borra a su gente de Equipo del
// Proyecto. Quien se queda sin ningún proyecto pasa a "Sin proyecto".
conBase(ctx, 'eliminar el proyecto deja "Sin proyecto" a quien no tenía otro, y a los demás solo les quita esa asignación', async () => {
  const alfa = ctx.fixtures.CENTROS.alfa.id;
  const { aliceAlfa, brendaBeta } = ctx.fixtures.EMPLEADOS;
  // Brenda también entra a ALFA (sigue en BETA).
  const enAlfa = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: alfa, employee_id: brendaBeta.id, role_catalog: 'desarrollador', monthly_salary: 2100000,
  });
  assert.strictEqual(enAlfa.status, 201);

  const r = await ctx.clientes.ceo.delete(`/api/costeo/centros/${alfa}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const alicia = await ctx.db.query('SELECT cost_center_id, role_catalog FROM mp_equipo_proyecto WHERE employee_id = ?', [aliceAlfa.id]);
  assert.deepStrictEqual(alicia.map((f) => f.cost_center_id), [null], 'Alicia solo estaba en ALFA: queda Sin proyecto');
  assert.strictEqual(alicia[0].role_catalog, 'desarrollador', 'conserva su cargo');

  const brenda = await ctx.db.query('SELECT cost_center_id FROM mp_equipo_proyecto WHERE employee_id = ?', [brendaBeta.id]);
  assert.deepStrictEqual(brenda.map((f) => f.cost_center_id), [ctx.fixtures.CENTROS.beta.id], 'Brenda sigue en BETA, sin fila suelta');

  await ctx.resembrar();
});

// 16 oct 2026: lo que se asigna en Equipo del Proyecto aparece en el Plan de
// Recursos de Costo Planeado (antes solo iba del Plan al Equipo).
conBase(ctx, 'asignar en Equipo del Proyecto agrega a la persona al Plan de Recursos; sacarla la quita', async () => {
  const gamma = ctx.fixtures.CENTROS.gamma.id;
  const brenda = ctx.fixtures.EMPLEADOS.brendaBeta;
  const r = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: gamma, employee_id: brenda.id, role_catalog: 'desarrollador', monthly_salary: 2100000, planned_hours: 40,
  });
  assert.strictEqual(r.status, 201);

  const plan = await ctx.clientes.ceo.get(`/api/costeo/centros/${gamma}/plan-recursos`);
  const fila = plan.json.filas.find((f) => f.employee_id === brenda.id);
  assert.ok(fila, 'Brenda debe aparecer en el Plan de Recursos de GAMMA');
  assert.strictEqual(fila.role_catalog, 'desarrollador');
  assert.strictEqual(Number(fila.horas_totales), 40);
  assert.ok(Number(fila.costo_hora) > 0, 'el costo/hora sale de su salario');

  const sacar = await ctx.clientes.ceo.put(`/api/costeo/equipo/${r.json.team_member_id}`, { cost_center_id: null });
  assert.strictEqual(sacar.status, 200);
  const despues = await ctx.clientes.ceo.get(`/api/costeo/centros/${gamma}/plan-recursos`);
  assert.ok(!despues.json.filas.some((f) => f.employee_id === brenda.id), 'al sacarla del proyecto sale del plan');

  await ctx.resembrar();
});
