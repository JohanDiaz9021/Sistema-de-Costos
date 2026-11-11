'use strict';

/**
 * CRUD de Costeo contra la base real, incluyendo transacciones.
 *
 * Cada prueba comprueba el efecto EN LA BASE, no solo el codigo de estado.
 * Un 200 sobre un UPDATE que no escribio nada es peor que un 500: nadie se
 * entera.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// ---------------------------------------------------------------
// Centro de Costos
// ---------------------------------------------------------------

conBase(ctx, 'crear un centro genera codigo correlativo y deja rastro en el historial', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_folder: 'DELTA', project_name: 'Proyecto Delta',
    budget: 7000000, start_date: '2026-02-01', planned_end_date: '2026-10-31',
    tipo: 'Consultoria', client_name: 'Cliente Delta',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.codigo, /^CC-\d{4}-\d{3}$/, `codigo raro: ${r.json.codigo}`);

  const [fila] = await ctx.db.query(
    'SELECT * FROM mp_centro_costo WHERE cost_center_id = ?', [r.json.cost_center_id]
  );
  assert.strictEqual(fila.project_name, 'Proyecto Delta');
  assert.strictEqual(Number(fila.budget), 7000000);
  assert.strictEqual(fila.tipo, 'Consultoria');
  // DELTA no aparece en mp_task_facts, asi que el origen es 'manual'.
  assert.strictEqual(fila.origin, 'manual');

  const historial = await ctx.db.query(
    "SELECT * FROM mp_costeo_audit_log WHERE entity_type='centro_costo' AND entity_id=?",
    [r.json.cost_center_id]
  );
  assert.strictEqual(historial.length, 1, 'la creacion no quedo en el historial');
  assert.strictEqual(historial[0].action, 'crear');
  assert.strictEqual(historial[0].user_id, ctx.fixtures.USUARIOS.ceo.id);

  await ctx.resembrar();
});

conBase(ctx, 'no se pueden crear dos centros para el mismo proyecto', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_folder: ctx.fixtures.CENTROS.alfa.folder, project_name: 'Duplicado',
    budget: 1, start_date: '2026-01-01', planned_end_date: '2026-12-31',
  });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
});

conBase(ctx, 'crear un centro cuyo NOMBRE choca con la CARPETA de otro se rechaza (ambiguedad de atribucion)', async () => {
  // Caso real: un centro manual "Costos" con carpeta interna "Sistema de
  // costos" ya existia; crear un proyecto nuevo llamado justo "Sistema de
  // costos" haria que el motor le cobrara las mismas horas a los dos
  // (cc.project_name = t.project_name OR cc.project_folder = t.project_name).
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: ctx.fixtures.CENTROS.alfa.folder, // = carpeta interna de ALFA
    start_date: '2026-01-01', planned_end_date: '2026-12-31',
  });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE project_name = ?', [ctx.fixtures.CENTROS.alfa.folder]);
  assert.strictEqual(filas.length, 0, 'no debio crearse nada');
});

conBase(ctx, 'crear un centro exige los campos obligatorios', async () => {
  for (const cuerpo of [
    // project_folder SÍ es opcional (se autogenera del nombre, ver el test
    // de arriba) — pero project_name, start_date y planned_end_date no.
    { start_date: '2026-01-01', planned_end_date: '2026-12-31' },
    { project_folder: 'X', start_date: '2026-01-01', planned_end_date: '2026-12-31' },
    { project_folder: 'X', project_name: 'Sin fechas' },
  ]) {
    const r = await ctx.clientes.ceo.post('/api/costeo/centros', cuerpo);
    assert.strictEqual(r.status, 400, `deberia rechazar ${JSON.stringify(cuerpo)}`);
  }
});

conBase(ctx, 'crear un centro sin project_folder lo autogenera del nombre comercial', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Portal Cliente XYZ', start_date: '2026-01-01', planned_end_date: '2026-06-30',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [fila] = await ctx.db.query('SELECT project_folder FROM mp_centro_costo WHERE cost_center_id = ?', [r.json.cost_center_id]);
  assert.strictEqual(fila.project_folder, 'portal-cliente-xyz');

  await ctx.resembrar();
});

conBase(ctx, 'crear un centro con plan_recursos calcula el presupuesto y lo deja bloqueado (Simulador -> Agregar proyecto)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Proyecto desde Simulador', start_date: '2026-03-01', planned_end_date: '2026-09-30',
    client_name: 'Cliente Simulado', status: 'vigente', actual_end_date: '2026-09-15',
    plan_recursos: [
      { role_catalog: 'analista', personas: 1, horas_totales: 10, costo_hora: 5000 },
      { role_catalog: 'qa', personas: 2, horas_totales: 10, costo_hora: 1000 },
    ],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.budget), 70000, '1x10x5000 + 2x10x1000 = 70.000');

  const [centro] = await ctx.db.query(
    'SELECT budget, budget_from_plan, actual_end_date, status FROM mp_centro_costo WHERE cost_center_id = ?', [r.json.cost_center_id]
  );
  assert.strictEqual(Number(centro.budget), 70000);
  assert.strictEqual(Number(centro.budget_from_plan), 1);
  assert.strictEqual(centro.status, 'vigente');

  const filas = await ctx.db.query('SELECT role_catalog FROM mp_plan_recursos WHERE cost_center_id = ?', [r.json.cost_center_id]);
  assert.strictEqual(filas.length, 2);

  await ctx.resembrar();
});

// sql/29 — "+ Añadir gasto" del Simulador: partidas sueltas con nombre y
// valor que se suman al presupuesto junto con la mano de obra.
conBase(ctx, 'crear un centro con plan_recursos_gastos suma esos gastos al presupuesto (Simulador)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Proyecto con gastos iniciales', start_date: '2026-03-01', planned_end_date: '2026-09-30',
    plan_recursos: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }], // 10.000
    plan_recursos_gastos: [
      { description: 'Licencia Azure', amount: 2000000 },
      { description: 'Viáticos de arranque', amount: 500000 },
    ],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.budget), 2510000, '10.000 de mano de obra + 2.500.000 de gastos');

  const [centro] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [r.json.cost_center_id]);
  assert.strictEqual(Number(centro.budget), 2510000);
  assert.strictEqual(Number(centro.budget_from_plan), 1);

  const gastos = await ctx.db.query(
    'SELECT description, amount FROM mp_plan_recursos_gasto WHERE cost_center_id = ? ORDER BY plan_gasto_id', [r.json.cost_center_id]
  );
  assert.strictEqual(gastos.length, 2);
  assert.strictEqual(gastos[0].description, 'Licencia Azure');
  assert.strictEqual(Number(gastos[0].amount), 2000000);

  await ctx.resembrar();
});

conBase(ctx, 'crear un centro con plan_recursos_gastos pero sin plan_recursos ignora los gastos (no hay plan activo)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Proyecto sin plan pero con gastos', start_date: '2026-03-01', planned_end_date: '2026-09-30',
    budget: 5000000,
    plan_recursos_gastos: [{ description: 'Licencia Azure', amount: 2000000 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [centro] = await ctx.db.query('SELECT budget, budget_from_plan FROM mp_centro_costo WHERE cost_center_id = ?', [r.json.cost_center_id]);
  assert.strictEqual(Number(centro.budget), 5000000, 'el budget suelto se respeta, no hay plan que lo reemplace');
  assert.strictEqual(Number(centro.budget_from_plan), 0);

  const gastos = await ctx.db.query('SELECT 1 FROM mp_plan_recursos_gasto WHERE cost_center_id = ?', [r.json.cost_center_id]);
  assert.strictEqual(gastos.length, 0, 'sin plan_recursos activo, plan_recursos_gastos no debio insertarse');

  await ctx.resembrar();
});

conBase(ctx, 'crear un centro con un plan_recursos invalido no crea nada (ni el centro huerfano)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
    project_name: 'Proyecto que deberia fallar', start_date: '2026-01-01', planned_end_date: '2026-12-31',
    plan_recursos: [{ role_catalog: 'inventado_no_existe', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE project_name = ?', ['Proyecto que deberia fallar']);
  assert.strictEqual(filas.length, 0, 'no debio quedar un centro sin su plan');
});

conBase(ctx, 'editar un centro registra el ANTES y el DESPUES en el historial', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/centros/${id}`, { budget: 12345678 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.updated, 1);

  const [fila] = await ctx.db.query('SELECT budget FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(Number(fila.budget), 12345678);

  const historial = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='centro_costo' AND action='editar' AND entity_id=? ORDER BY log_id DESC LIMIT 1",
    [id]
  );
  assert.strictEqual(historial.length, 1);
  assert.match(historial[0].description, /Presupuesto/);
  // Con puntos de miles, no el numero crudo (7 sep 2026, a pedido explicito:
  // "12345678" al lado de "10000000" era ilegible en el historial). Lo pone
  // formatMoneda en describirCambios — ver src/queries/costo-audit.js.
  assert.match(historial[0].description, /\$ 12\.345\.678/);
  // El ANTES tambien va formateado: la gracia del historial es poder leer el
  // salto de un vistazo, y medio renglon en crudo lo rompe igual.
  assert.match(historial[0].description, /\$ 10\.000\.000 → \$ 12\.345\.678/);

  await ctx.resembrar();
});

conBase(ctx, 'un tipo de centro fuera del catalogo se rechaza con 400', async () => {
  const r = await ctx.clientes.ceo.put(`/api/costeo/centros/${ctx.fixtures.CENTROS.alfa.id}`, {
    tipo: 'TipoInventado',
  });
  assert.strictEqual(r.status, 400);
});

// Borrado real y permanente (31 ago 2026, a pedido explicito): ya no se
// desactiva "por las dudas" cuando el centro tiene equipo, gastos u horas
// extra -- se borra todo. El historial es la unica excepcion: sobrevive
// desenganchado (cost_center_id = NULL), no se pierde el rastro.
conBase(ctx, 'un centro CON equipo, gastos, horas extra e historial se borra TODO de verdad, salvo el historial', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;

  await ctx.db.query(
    `INSERT INTO mp_costeo_audit_log (cost_center_id, entity_type, entity_id, action, user_id, user_name, description)
     VALUES (?, 'centro_costo', ?, 'editar', ?, 'Prueba', 'Cambio de prueba antes de borrar ALFA')`,
    [id, id, ctx.fixtures.USUARIOS.ceo.id]
  );

  const r = await ctx.clientes.ceo.delete(`/api/costeo/centros/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);

  const [centro, equipo, gastos, overtime, historial] = await Promise.all([
    ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE cost_center_id = ?', [id]),
    ctx.db.query('SELECT 1 FROM mp_equipo_proyecto WHERE cost_center_id = ?', [id]),
    ctx.db.query('SELECT 1 FROM mp_costo_no_planeado WHERE cost_center_id = ?', [id]),
    ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE cost_center_id = ?', [id]),
    ctx.db.query('SELECT description, cost_center_id FROM mp_costeo_audit_log WHERE description = ?', ['Cambio de prueba antes de borrar ALFA']),
  ]);
  assert.strictEqual(centro.length, 0, 'el centro deberia haberse borrado');
  assert.strictEqual(equipo.length, 0, 'el equipo deberia haberse borrado');
  assert.strictEqual(gastos.length, 0, 'los gastos deberian haberse borrado');
  assert.strictEqual(overtime.length, 0, 'las horas extra deberian haberse borrado');
  assert.strictEqual(historial.length, 1, 'el historial NO deberia borrarse');
  assert.strictEqual(historial[0].cost_center_id, null, 'el historial queda desenganchado, no apuntando a un centro que ya no existe');

  await ctx.resembrar();
});

conBase(ctx, 'un centro SIN datos si se borra de verdad', async () => {
  const id = ctx.fixtures.CENTROS.gamma.id;
  const r = await ctx.clientes.ceo.delete(`/api/costeo/centros/${id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.deleted, true);

  const filas = await ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE cost_center_id = ?', [id]);
  assert.strictEqual(filas.length, 0);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Gastos no planeados
// ---------------------------------------------------------------

conBase(ctx, 'ciclo completo de un gasto: crear, editar, borrar', async () => {
  const crear = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto del ciclo', amount: 123456,
    expense_date: '2026-08-15', category: 'licencia',
  });
  assert.strictEqual(crear.status, 201);
  const id = crear.json.expense_id;

  let [fila] = await ctx.db.query('SELECT * FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(fila.amount), 123456);
  assert.strictEqual(fila.category, 'licencia');

  const editar = await ctx.clientes.ana.put(`/api/costeo/gastos/${id}`, {
    amount: 654321, category: 'viatico',
  });
  assert.strictEqual(editar.status, 200);
  [fila] = await ctx.db.query('SELECT * FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(fila.amount), 654321);
  assert.strictEqual(fila.category, 'viatico');

  const borrar = await ctx.clientes.ana.delete(`/api/costeo/gastos/${id}`);
  assert.strictEqual(borrar.status, 200);
  assert.strictEqual((await ctx.db.query('SELECT 1 FROM mp_costo_no_planeado WHERE expense_id = ?', [id])).length, 0);

  // Las tres acciones quedaron en el historial.
  const acciones = await ctx.db.query(
    "SELECT action FROM mp_costeo_audit_log WHERE entity_type='gasto' AND entity_id=? ORDER BY log_id", [id]
  );
  assert.deepStrictEqual(acciones.map((a) => a.action), ['crear', 'editar', 'eliminar']);
});

// ---------------------------------------------------------------
// Aprobacion del gasto no planeado (sql/28)
// ---------------------------------------------------------------

async function noPlaneadoDeAlfa(ctx) {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  return Number(alfa.costo_no_planeado_total);
}

conBase(ctx, 'el gasto que registra el PM nace pendiente y NO suma al ejecutado hasta que el CEO lo aprueba', async () => {
  const antes = await noPlaneadoDeAlfa(ctx);

  const crear = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Licencia por aprobar', amount: 400000,
    expense_date: '2026-08-18', category: 'licencia',
  });
  assert.strictEqual(crear.status, 201);
  const id = crear.json.expense_id;

  let [fila] = await ctx.db.query('SELECT approval_status FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(fila.approval_status, 'pendiente', 'el gasto del PM no deberia entrar ya aprobado');
  assert.strictEqual(await noPlaneadoDeAlfa(ctx), antes, 'un gasto pendiente no puede mover el ejecutado');

  // El GET lo devuelve con su estado, que es lo que el PM ve en pantalla.
  const listado = await ctx.clientes.ana.get('/api/costeo/gastos');
  const enLista = listado.json.gastos.find((g) => g.expense_id === id);
  assert.strictEqual(enLista.approval_status, 'pendiente');

  const aprobar = await ctx.clientes.ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: true });
  assert.strictEqual(aprobar.status, 200, JSON.stringify(aprobar.json));
  assert.strictEqual(aprobar.json.approval_status, 'aprobado');

  [fila] = await ctx.db.query('SELECT approval_status, approved_by, approved_at FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(fila.approval_status, 'aprobado');
  assert.strictEqual(fila.approved_by, ctx.fixtures.USUARIOS.ceo.id);
  assert.ok(fila.approved_at, 'deberia quedar la fecha de aprobacion');

  assert.strictEqual(await noPlaneadoDeAlfa(ctx), antes + 400000, 'aprobado, el gasto si suma al ejecutado');

  await ctx.resembrar();
});

conBase(ctx, 'un gasto rechazado guarda el motivo y no suma nunca al ejecutado', async () => {
  const antes = await noPlaneadoDeAlfa(ctx);

  const crear = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Viatico dudoso', amount: 300000,
    expense_date: '2026-08-19', category: 'viatico',
  });
  const id = crear.json.expense_id;

  // Rechazar SIN motivo no se puede: es lo unico que el PM va a leer para
  // saber que corregir.
  const sinMotivo = await ctx.clientes.ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: false });
  assert.strictEqual(sinMotivo.status, 400);

  const rechazar = await ctx.clientes.ceo.post(`/api/costeo/gastos/${id}/aprobacion`, {
    approved: false, note: 'No corresponde a este proyecto',
  });
  assert.strictEqual(rechazar.status, 200);

  const [fila] = await ctx.db.query(
    'SELECT approval_status, rejection_note FROM mp_costo_no_planeado WHERE expense_id = ?', [id]
  );
  assert.strictEqual(fila.approval_status, 'rechazado');
  assert.strictEqual(fila.rejection_note, 'No corresponde a este proyecto');
  assert.strictEqual(await noPlaneadoDeAlfa(ctx), antes, 'un gasto rechazado no puede sumar al ejecutado');

  await ctx.resembrar();
});

conBase(ctx, 'un gasto ya resuelto no se vuelve a resolver ni lo edita/borra el PM', async () => {
  const crear = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto resuelto', amount: 100000, expense_date: '2026-08-20',
  });
  const id = crear.json.expense_id;

  assert.strictEqual((await ctx.clientes.ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: true })).status, 200);

  // Segunda resolucion: 409, y el estado no cambia.
  const otraVez = await ctx.clientes.admin.post(`/api/costeo/gastos/${id}/aprobacion`, {
    approved: false, note: 'me arrepenti',
  });
  assert.strictEqual(otraVez.status, 409);
  const [fila] = await ctx.db.query('SELECT approval_status FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(fila.approval_status, 'aprobado', 'el rechazo tardio no puede pisar la aprobacion');

  // El PM ya no puede cambiarle el monto ni borrarlo: seria saltarse la
  // aprobacion despues de tenerla.
  const editar = await ctx.clientes.ana.put(`/api/costeo/gastos/${id}`, { amount: 9000000 });
  assert.strictEqual(editar.status, 409, JSON.stringify(editar.json));
  const borrar = await ctx.clientes.ana.delete(`/api/costeo/gastos/${id}`);
  assert.strictEqual(borrar.status, 409);

  const [intacta] = await ctx.db.query('SELECT amount FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(intacta.amount), 100000);

  // Quien aprueba si puede corregir.
  assert.strictEqual((await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { amount: 120000 })).status, 200);

  await ctx.resembrar();
});

conBase(ctx, 'aprobar y rechazar quedan en el historial de auditoria', async () => {
  const crear = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto auditado', amount: 50000, expense_date: '2026-08-21',
  });
  const id = crear.json.expense_id;
  await ctx.clientes.ceo.post(`/api/costeo/gastos/${id}/aprobacion`, { approved: true });

  const acciones = await ctx.db.query(
    "SELECT action, user_id FROM mp_costeo_audit_log WHERE entity_type='gasto' AND entity_id=? ORDER BY log_id", [id]
  );
  assert.deepStrictEqual(acciones.map((a) => a.action), ['crear', 'aprobar']);
  assert.strictEqual(acciones[1].user_id, ctx.fixtures.USUARIOS.ceo.id);

  await ctx.resembrar();
});

conBase(ctx, 'un gasto con monto 0 o negativo se rechaza', async () => {
  for (const amount of [0, -100]) {
    const r = await ctx.clientes.ana.post('/api/costeo/gastos', {
      cost_center_id: ctx.fixtures.CENTROS.alfa.id,
      description: 'Monto invalido', amount, expense_date: '2026-08-15',
    });
    assert.strictEqual(r.status, 400, `amount=${amount} deberia dar 400`);
  }
});

conBase(ctx, 'una categoria fuera del catalogo cae en "otro" al crear', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Categoria rara', amount: 1000,
    expense_date: '2026-08-15', category: 'inventada',
  });
  assert.strictEqual(r.status, 201);
  const [fila] = await ctx.db.query('SELECT category FROM mp_costo_no_planeado WHERE expense_id = ?', [r.json.expense_id]);
  assert.strictEqual(fila.category, 'otro');

  // Al EDITAR, en cambio, si se rechaza. La asimetria es intencionada
  // segun el codigo; queda documentada por si algun dia se unifica.
  const editar = await ctx.clientes.ana.put(`/api/costeo/gastos/${r.json.expense_id}`, { category: 'inventada' });
  assert.strictEqual(editar.status, 400);

  await ctx.clientes.ana.delete(`/api/costeo/gastos/${r.json.expense_id}`);
});

// ---------------------------------------------------------------
// Equipo del proyecto
// ---------------------------------------------------------------

conBase(ctx, 'no se puede meter dos veces al mismo talento en un centro', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    role_catalog: 'qa', hourly_cost: 1000,
  });
  assert.strictEqual(r.status, 409, `esperaba 409 por la unique key: ${JSON.stringify(r.json)}`);
  assert.match(r.json.error, /ya est[aá]/i, 'el mensaje deberia explicar el motivo real');
});

conBase(ctx, 'dar de baja a un integrante marca removed_at', async () => {
  const id = ctx.fixtures.EQUIPO.arturoEnAlfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { is_active: false });
  assert.strictEqual(r.status, 200);

  const [fila] = await ctx.db.query('SELECT is_active, removed_at FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(Number(fila.is_active), 0);
  assert.ok(fila.removed_at, 'removed_at deberia quedar con fecha');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Horas extra: el flujo de decision + aprobacion
// ---------------------------------------------------------------

conBase(ctx, 'no se puede aprobar una hora extra que el PM no decidio', async () => {
  // Regresion del bug de dinero: approval_status nace en 'pendiente' por
  // DEFAULT, asi que mirar solo esa columna dejaba aprobar horas extra
  // que nadie autorizo.
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const r = await ctx.clientes.ceo.post(`/api/costeo/overtime/${id}/approve`, { approved: true });
  assert.strictEqual(r.status, 409, `esperaba 409: ${JSON.stringify(r.json)}`);

  const [fila] = await ctx.db.query('SELECT extra_cost_final, approval_status FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(Number(fila.extra_cost_final), 0, 'no puede haberse escrito ningun costo');
  assert.strictEqual(fila.approval_status, 'pendiente');
});

conBase(ctx, 'flujo feliz: el PM decide "si" y queda aprobada de una vez, sin paso de admin (26 ago 2026)', async () => {
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const potencial = ctx.fixtures.OVERTIME.alfaSinDecidir.potencial;

  const decision = await ctx.clientes.ana.post(`/api/costeo/overtime/${id}/decision`, {
    decision: 'si', motivo: 'externo', calidad: false,
  });
  assert.strictEqual(decision.status, 200);
  assert.strictEqual(decision.json.approval_status, 'aprobado', 'decidir "si" ya deja la fila aprobada');

  const [fila] = await ctx.db.query(
    'SELECT extra_cost_final, approval_status, approved_by, approved_at FROM mp_overtime_decisions WHERE decision_id = ?', [id]
  );
  assert.strictEqual(Number(fila.extra_cost_final), potencial, 'decidir "si" ya fija el costo potencial (auto-aprobado)');
  assert.strictEqual(fila.approval_status, 'aprobado');
  assert.strictEqual(fila.approved_by, ctx.fixtures.USUARIOS.liderAlfa.id, 'quien decide queda registrado como quien aprobo');
  assert.ok(fila.approved_at);

  await ctx.resembrar();
});

conBase(ctx, 'decidir "no" exige una observacion', async () => {
  const r = await ctx.clientes.ana.post(
    `/api/costeo/overtime/${ctx.fixtures.OVERTIME.alfaSinDecidir.id}/decision`,
    { decision: 'no' }
  );
  assert.strictEqual(r.status, 400);
});

conBase(ctx, 'una hora extra ya resuelta no se puede volver a decidir', async () => {
  const r = await ctx.clientes.ana.post(
    `/api/costeo/overtime/${ctx.fixtures.OVERTIME.alfaAprobada.id}/decision`,
    { decision: 'no', note: 'me arrepenti' }
  );
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));

  const [fila] = await ctx.db.query(
    'SELECT extra_cost_final FROM mp_overtime_decisions WHERE decision_id = ?',
    [ctx.fixtures.OVERTIME.alfaAprobada.id]
  );
  assert.strictEqual(Number(fila.extra_cost_final), ctx.fixtures.OVERTIME.alfaAprobada.final);
});

conBase(ctx, 'alta manual de hora extra: rechaza a quien no tiene tarifa', async () => {
  // Sin tarifa la hora extra valdria $0 y nadie lo notaria hasta que
  // alguien la aprueba y el costo no se mueve.
  const r = await ctx.clientes.ana.post('/api/costeo/overtime', {
    employee_id: ctx.fixtures.EMPLEADOS.carlosBaja.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-01T18:00', fin: '2026-08-01T20:00',
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /tarifa|costo\/hora/i);
});

// El alta manual es la ÚNICA escritura que llena fecha/hora_inicio/hora_fin
// (sql/26): la sincronización automática las deja en NULL porque
// mp_costeo_task_facts trae un total por día, sin hora. Si esas 3 columnas no
// existen en la base, el INSERT entero revienta y no se puede registrar
// ninguna hora extra a mano — pasó en producción el 28 ago 2026 porque
// sql/26 nunca se había aplicado allá. Esta prueba fija el contrato.
conBase(ctx, 'alta manual de hora extra: guarda fecha, hora de inicio y hora de fin del turno', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/overtime', {
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-29T18:00', fin: '2026-08-29T21:30',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [fila] = await ctx.db.query(
    'SELECT fecha, hora_inicio, hora_fin, extra_hours, extra_cost_potential, pm_decision, approval_status FROM mp_overtime_decisions WHERE decision_id = ?',
    [r.json.decision_id]
  );
  assert.strictEqual(String(fila.fecha).slice(0, 10), '2026-08-29');
  assert.match(String(fila.hora_inicio), /^18:00/);
  assert.match(String(fila.hora_fin), /^21:30/);
  assert.strictEqual(Number(fila.extra_hours), 3.5, '18:00 a 21:30 son 3.5 horas');
  assert.ok(Number(fila.extra_cost_potential) > 0, 'deberia costearse con la tarifa del talento');
  // Alta manual = decidida y aprobada de una vez (26 ago 2026).
  assert.strictEqual(fila.pm_decision, 'si');
  assert.strictEqual(fila.approval_status, 'aprobado');

  await ctx.resembrar();
});

conBase(ctx, 'alta manual duplicada da 409, no crea una segunda fila', async () => {
  // 2026-08-29 (semana 5) -- Alicia/ALFA no tiene ninguna fila fija de
  // fixtures ahi (alfaAprobada usa semana 2, alfaSinDecidir semana 4).
  const base = {
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-29T18:00', fin: '2026-08-29T20:00',
  };
  const primera = await ctx.clientes.ana.post('/api/costeo/overtime', base);
  assert.strictEqual(primera.status, 201, JSON.stringify(primera.json));

  const segunda = await ctx.clientes.ana.post('/api/costeo/overtime', base);
  assert.strictEqual(segunda.status, 409);

  const filas = await ctx.db.query(
    'SELECT 1 FROM mp_overtime_decisions WHERE employee_id=? AND cost_center_id=? AND week_number=5 AND month_number=8 AND year_number=2026',
    [base.employee_id, base.cost_center_id]
  );
  assert.strictEqual(filas.length, 1);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Horas extra: editar/eliminar mientras está Pendiente (sql/31, 31 ago 2026)
// ---------------------------------------------------------------

conBase(ctx, 'editar una hora extra pendiente corrige las horas y recalcula el costo', async () => {
  // alfaSinDecidir: pm_decision='pendiente', extra=3h, potencial=60000
  // (20000/h). Corregir a 6h debe recalcular con la MISMA tarifa por hora.
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/overtime/${id}`, { extra_hours: 6 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.extra_hours), 6);
  assert.strictEqual(Number(r.json.extra_cost_potential), 120000, 'debe mantener la tarifa de 20000/h');

  const [fila] = await ctx.db.query(
    'SELECT extra_hours, extra_cost_potential, hours_overridden FROM mp_overtime_decisions WHERE decision_id = ?', [id]
  );
  assert.strictEqual(Number(fila.extra_hours), 6);
  assert.strictEqual(Number(fila.extra_cost_potential), 120000);
  assert.strictEqual(Number(fila.hours_overridden), 1, 'debe quedar marcada para que el sync no la sobreescriba');

  await ctx.resembrar();
});

conBase(ctx, 'una hora extra ya decidida no se puede editar', async () => {
  const id = ctx.fixtures.OVERTIME.alfaAprobada.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/overtime/${id}`, { extra_hours: 10 });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));

  const [fila] = await ctx.db.query('SELECT extra_hours FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(Number(fila.extra_hours), ctx.fixtures.OVERTIME.alfaAprobada.extra, 'no debe haberse tocado');
});

conBase(ctx, 'editar exige extra_hours mayor que 0', async () => {
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/overtime/${id}`, { extra_hours: 0 });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
});

conBase(ctx, 'un PM sin permiso sobre ese centro no puede editar la hora extra', async () => {
  // Bruno lidera BETA, no ALFA.
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const r = await ctx.clientes.bruno.put(`/api/costeo/overtime/${id}`, { extra_hours: 6 });
  assert.strictEqual(r.status, 403, JSON.stringify(r.json));
});

conBase(ctx, 'eliminar una hora extra pendiente la borra y queda en el historial', async () => {
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const r = await ctx.clientes.ana.delete(`/api/costeo/overtime/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(filas.length, 0);

  const [hist] = await ctx.db.query(
    `SELECT action FROM mp_costeo_audit_log WHERE entity_type='overtime' AND entity_id=? ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  assert.strictEqual(hist.action, 'eliminar');

  await ctx.resembrar();
});

conBase(ctx, 'una hora extra ya decidida no se puede eliminar', async () => {
  const id = ctx.fixtures.OVERTIME.alfaAprobada.id;
  const r = await ctx.clientes.ana.delete(`/api/costeo/overtime/${id}`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(filas.length, 1, 'no debe haberse borrado');
});

conBase(ctx, 'el admin si puede eliminar una hora extra ya decidida (registro por error)', async () => {
  // 17 sep 2026, a pedido explícito: "el CEO o admin pueden tener la opción
  // de eliminar en caso de que se haya registrado una por error". La
  // restricción de Pendiente de sql/31 aplica solo al líder/PM.
  const id = ctx.fixtures.OVERTIME.alfaAprobada.id;
  const r = await ctx.clientes.admin.delete(`/api/costeo/overtime/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(filas.length, 0, 'la fila ya decidida debió borrarse también');

  const [hist] = await ctx.db.query(
    `SELECT action FROM mp_costeo_audit_log WHERE entity_type='overtime' AND entity_id=? ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  assert.strictEqual(hist.action, 'eliminar', 'la eliminación de admin debe quedar en el historial');

  await ctx.resembrar();
});

conBase(ctx, 'el ceo también puede eliminar una hora extra ya decidida', async () => {
  const id = ctx.fixtures.OVERTIME.betaAprobada.id;
  const r = await ctx.clientes.ceo.delete(`/api/costeo/overtime/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true, JSON.stringify(r.json));

  const filas = await ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(filas.length, 0, 'la fila de BETA debió borrarse');

  await ctx.resembrar();
});

conBase(ctx, 'el PM que registró a mano una hora extra puede eliminarla de su sesión', async () => {
  // 17 sep 2026, a pedido explícito: al registrar varias horas extra
  // seguidas desde el modal, quien registró debe poder borrar su propio
  // error aunque el alta manual ya nazca aprobada (createManualOvertime
  // inserta pm_decision='si' y approval_status='aprobado'). La vía es
  // approved_by = el usuario que registró (la regla de "solo Pendiente"
  // de sql/31 aplica al líder que NO es el creador).
  const alta = await ctx.clientes.ana.post('/api/costeo/overtime', {
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-29T18:00', fin: '2026-08-29T21:00',
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));
  const id = alta.json.decision_id;

  const [fila] = await ctx.db.query(
    'SELECT pm_decision, approval_status, approved_by FROM mp_overtime_decisions WHERE decision_id = ?',
    [id]
  );
  assert.strictEqual(fila.pm_decision, 'si');
  assert.strictEqual(fila.approval_status, 'aprobado');
  assert.strictEqual(fila.approved_by, ctx.fixtures.USUARIOS.liderAlfa.id, 'quien registra queda como creador');

  const r = await ctx.clientes.ana.delete(`/api/costeo/overtime/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true, JSON.stringify(r.json));

  const restantes = await ctx.db.query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(restantes.length, 0, 'la hora extra recién registrada debe poder borrarla su creador');

  await ctx.resembrar();
});

conBase(ctx, 'editar una hora extra y luego sincronizar no revierte la correccion (hours_overridden)', async () => {
  // Esta es la prueba que confirma que sql/31 hace lo que promete: sin
  // hours_overridden, syncOvertimeDecisions() pisaria la correccion del PM
  // en el siguiente refresco del panel (POST /overtime/sync corre antes de
  // cada GET /overtime).
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  const edicion = await ctx.clientes.ana.put(`/api/costeo/overtime/${id}`, { extra_hours: 6 });
  assert.strictEqual(edicion.status, 200, JSON.stringify(edicion.json));

  const sync = await ctx.clientes.ana.post('/api/costeo/overtime/sync', {});
  assert.strictEqual(sync.status, 200, JSON.stringify(sync.json));

  const [fila] = await ctx.db.query(
    'SELECT extra_hours, extra_cost_potential FROM mp_overtime_decisions WHERE decision_id = ?', [id]
  );
  assert.strictEqual(Number(fila.extra_hours), 6, 'el sync no debio revertir la correccion del PM');
  assert.strictEqual(Number(fila.extra_cost_potential), 120000);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Transacciones: withTransaction()
// ---------------------------------------------------------------

conBase(ctx, 'crear un PM es atomico: usuario y proyectos, o nada', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/accesos', {
    full_name: 'PM Transaccional', email: 'pm-tx@ejemplo.test',
    password: 'clave-larga-1234', project_folders: ['ALFA', 'BETA'],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const usuarios = await ctx.db.query('SELECT user_id FROM mp_dashboard_users WHERE email = ?', ['pm-tx@ejemplo.test']);
  const owners = await ctx.db.query('SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active=1', ['pm-tx@ejemplo.test']);
  assert.strictEqual(usuarios.length, 1);
  assert.deepStrictEqual(owners.map((o) => o.project_folder).sort(), ['ALFA', 'BETA']);

  await ctx.resembrar();
});

conBase(ctx, 'si el INSERT de proyectos falla, NO queda el usuario a medias', async () => {
  // Se fuerza el fallo mandando un project_folder mas largo que la
  // columna (varchar(50)). El INSERT de mp_project_owners revienta
  // DESPUES de que el usuario ya se inserto: sin transaccion, quedaria un
  // PM que puede entrar al sistema y no ve ningun proyecto.
  const antes = await ctx.db.query('SELECT COUNT(*) n FROM mp_dashboard_users');

  const folderImposible = 'X'.repeat(80);
  const r = await ctx.clientes.ceo.post('/api/costeo/accesos', {
    full_name: 'PM Que No Debe Existir', email: 'pm-rollback@ejemplo.test',
    password: 'clave-larga-1234', project_folders: [folderImposible],
  });
  assert.ok(r.status >= 400, `deberia fallar y devolvio ${r.status}`);

  const usuarios = await ctx.db.query('SELECT 1 FROM mp_dashboard_users WHERE email = ?', ['pm-rollback@ejemplo.test']);
  assert.strictEqual(usuarios.length, 0, 'ROLLBACK no ocurrio: quedo un usuario huerfano');

  const despues = await ctx.db.query('SELECT COUNT(*) n FROM mp_dashboard_users');
  assert.strictEqual(Number(despues[0].n), Number(antes[0].n), 'cambio la cantidad de usuarios');
});

conBase(ctx, 'editar un PM es atomico: no se queda sin proyectos si falla', async () => {
  // PUT /accesos desactiva TODAS las asignaciones y despues reinserta.
  // Si el segundo paso falla sin transaccion, el PM pierde el acceso a
  // todo y nadie se entera.
  const id = ctx.fixtures.USUARIOS.liderAlfa.id;
  const email = ctx.fixtures.USUARIOS.liderAlfa.email;

  const antes = await ctx.db.query(
    'SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active = 1', [email]
  );
  assert.strictEqual(antes.length, 1, 'premisa: Ana tiene un proyecto');

  const r = await ctx.clientes.ceo.put(`/api/costeo/accesos/${id}`, {
    project_folders: ['Y'.repeat(80)],
  });
  assert.ok(r.status >= 400, `deberia fallar y devolvio ${r.status}`);

  const despues = await ctx.db.query(
    'SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active = 1', [email]
  );
  assert.deepStrictEqual(
    despues.map((o) => o.project_folder), antes.map((o) => o.project_folder),
    'ROLLBACK no ocurrio: Ana se quedo sin sus proyectos'
  );
});

conBase(ctx, 'cambiar el correo de un PM le conserva sus proyectos', async () => {
  const id = ctx.fixtures.USUARIOS.liderBeta.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/accesos/${id}`, { email: 'bruno-nuevo@ejemplo.test' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const owners = await ctx.db.query(
    'SELECT project_folder FROM mp_project_owners WHERE pmo_email = ? AND is_active = 1',
    ['bruno-nuevo@ejemplo.test']
  );
  assert.deepStrictEqual(owners.map((o) => o.project_folder), ['BETA'], 'perdio el vinculo con su proyecto');

  await ctx.resembrar();
});

conBase(ctx, 'no se puede poner a un PM el correo de otro', async () => {
  const r = await ctx.clientes.ceo.put(`/api/costeo/accesos/${ctx.fixtures.USUARIOS.liderBeta.id}`, {
    email: ctx.fixtures.USUARIOS.liderAlfa.email,
  });
  assert.strictEqual(r.status, 409, `esperaba 409 y no un 500 generico: ${r.status}`);
});

// ---------------------------------------------------------------
// Configuracion de umbrales
// ---------------------------------------------------------------

conBase(ctx, 'cambiar weekly_legal_hours afecta el calculo de horas extra', async () => {
  // El umbral no es decorativo: separa horas normales de horas extra.
  // Alicia tiene 50h ejecutadas en la semana 2.
  const antes = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');
  const extraAntes = antes.json.portafolio.ind9_proporcion_horas_extra_pct;

  const r = await ctx.clientes.ceo.put('/api/costeo/config/weekly_legal_hours', { config_value: 40 });
  assert.strictEqual(r.status, 200);

  const despues = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');
  const extraDespues = despues.json.portafolio.ind9_proporcion_horas_extra_pct;

  assert.ok(
    extraDespues > extraAntes,
    `bajar el umbral a 40h deberia aumentar la proporcion de horas extra (${extraAntes} -> ${extraDespues})`
  );

  await ctx.db.query("DELETE FROM mp_costeo_config WHERE config_key = 'weekly_legal_hours'");
});

// sql/30 — cambiar un umbral mueve dinero real en todos los proyectos
// (ej. cuándo dispara la alerta crítica, o cuánto vale una hora extra), y
// hasta ahora no quedaba ningún rastro de quién lo cambió.
conBase(ctx, 'cambiar un umbral queda en el historial con el valor anterior y el nuevo', async () => {
  const r1 = await ctx.clientes.ceo.put('/api/costeo/config/umbral_presupuesto', { config_value: 90 });
  assert.strictEqual(r1.status, 200);
  const r2 = await ctx.clientes.ceo.put('/api/costeo/config/umbral_presupuesto', { config_value: 75 });
  assert.strictEqual(r2.status, 200);

  // description LIKE, no solo entity_type='config': otra prueba de este
  // mismo archivo también cambia un umbral (weekly_legal_hours) y deja su
  // propio rastro en mp_costeo_audit_log sin limpiarlo — filtrar por el
  // label evita que ese log ajeno se cuele aquí según el orden en que
  // corran las pruebas.
  const logs = await ctx.db.query(
    "SELECT description, user_id FROM mp_costeo_audit_log WHERE entity_type='config' AND description LIKE 'Umbral de presupuesto%' ORDER BY log_id"
  );
  assert.strictEqual(logs.length, 2);
  assert.match(logs[0].description, /85%.*90%/, `deberia ir del default (85%) al nuevo valor: ${logs[0].description}`);
  assert.match(logs[1].description, /90%.*75%/, `deberia ir del valor anterior al nuevo: ${logs[1].description}`);
  assert.strictEqual(logs[0].user_id, ctx.fixtures.USUARIOS.ceo.id);

  await ctx.db.query("DELETE FROM mp_costeo_config WHERE config_key = 'umbral_presupuesto'");
  await ctx.db.query("DELETE FROM mp_costeo_audit_log WHERE entity_type = 'config'");
});

conBase(ctx, 'un umbral negativo o no numerico se rechaza', async () => {
  // null, '' , [] y false entran aqui desde la correccion de QA-04 (2 sep
  // 2026): Number() los convierte a 0 y antes los cuatro se guardaban como
  // un 0 que nadie escribio. Ahora se mira el TIPO antes de convertir.
  for (const valor of [-1, 'abc', undefined, {}, null, '', [], false, '   ']) {
    const r = await ctx.clientes.ceo.put('/api/costeo/config/umbral_presupuesto', { config_value: valor });
    assert.strictEqual(r.status, 400, `config_value=${JSON.stringify(valor)} deberia dar 400`);
  }
});

conBase(ctx, 'QA-04 corregido: null, "", [] y false NO se guardan como 0', async () => {
  // Era el bug de dinero mas barato de disparar de todo el modulo: un
  // formulario mal enviado (o un curl con un typo) dejaba weekly_legal_hours
  // en 0 y cada hora trabajada de la empresa pasaba a contar como extra.
  // Number(null) === Number('') === Number([]) === Number(false) === 0, y la
  // validacion vieja (isFinite && >= 0) los daba por buenos.
  for (const valor of [null, '', [], false]) {
    const r = await ctx.clientes.ceo.put('/api/costeo/config/weekly_legal_hours', { config_value: valor });
    assert.strictEqual(r.status, 400, `${JSON.stringify(valor)} deberia rechazarse`);

    const filas = await ctx.db.query(
      "SELECT config_value FROM mp_costeo_config WHERE config_key = 'weekly_legal_hours'"
    );
    assert.strictEqual(filas.length, 0, `${JSON.stringify(valor)} no debio escribir NADA en la tabla`);
  }
});

conBase(ctx, 'QA-04 corregido: un 0 explicito tampoco entra en los dos divisores del motor', async () => {
  // 0 es un valor legitimo en un recargo ("no aplicamos recargo nocturno"),
  // pero no en estos dos: sin jornada legal toda hora es extra, y sin
  // divisor la formula de nomina deja el costo de todo el mundo en $0.
  for (const key of ['weekly_legal_hours', 'horas_mes_liquidacion']) {
    const r = await ctx.clientes.ceo.put(`/api/costeo/config/${key}`, { config_value: 0 });
    assert.strictEqual(r.status, 400, `${key} = 0 deberia rechazarse`);
    assert.match(r.json.error, /mayor o igual a 1/, 'el mensaje debe decir cual es el piso');
  }
});

conBase(ctx, 'QA-04 corregido: un 0 SI se acepta donde es legitimo (recargos, dias de preaviso)', async () => {
  for (const key of ['recargo_extra_diurna_pct', 'dias_antes_preventiva']) {
    const r = await ctx.clientes.ceo.put(`/api/costeo/config/${key}`, { config_value: 0 });
    assert.strictEqual(r.status, 200, `${key} = 0 es un valor de negocio valido`);
    await ctx.db.query('DELETE FROM mp_costeo_config WHERE config_key = ?', [key]);
  }
  await ctx.db.query("DELETE FROM mp_costeo_audit_log WHERE entity_type = 'config'");
});

conBase(ctx, 'QA-04 corregido: el indicador 9 ya no se puede llevar al 100% con un envio vacio', async () => {
  // La consecuencia medible que documentaba el hallazgo, ahora al reves:
  // el intento se rechaza y el indicador queda intacto.
  const antes = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');
  const pctAntes = antes.json.portafolio.ind9_proporcion_horas_extra_pct;
  assert.ok(pctAntes < 10, `premisa: con el umbral normal hay pocas horas extra (${pctAntes}%)`);

  const r = await ctx.clientes.ceo.put('/api/costeo/config/weekly_legal_hours', { config_value: null });
  assert.strictEqual(r.status, 400);

  const despues = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');
  assert.strictEqual(
    despues.json.portafolio.ind9_proporcion_horas_extra_pct, pctAntes,
    'el indicador no debio moverse: el cambio fue rechazado'
  );
});

// ---------------------------------------------------------------
// Snapshots (sql/30) — crear y eliminar un snapshot tampoco quedaba en
// el historial hasta ahora.
// ---------------------------------------------------------------

conBase(ctx, 'crear un snapshot de un centro queda en el historial', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/snapshot', { centro: ctx.fixtures.CENTROS.alfa.id });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description, cost_center_id, user_id FROM mp_costeo_audit_log WHERE entity_type='snapshot' AND entity_id=?",
    [r.json.snapshot_id]
  );
  assert.match(log.description, /Proyecto Alfa/);
  assert.strictEqual(log.cost_center_id, ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(log.user_id, ctx.fixtures.USUARIOS.ceo.id);

  await ctx.resembrar();
});

conBase(ctx, 'crear un snapshot del portafolio (sin centro) tambien queda en el historial', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/snapshot', {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description, cost_center_id FROM mp_costeo_audit_log WHERE entity_type='snapshot' AND entity_id=?",
    [r.json.snapshot_id]
  );
  assert.match(log.description, /portafolio/i);
  assert.strictEqual(log.cost_center_id, null);

  await ctx.resembrar();
});

conBase(ctx, 'eliminar un snapshot queda en el historial con el nombre del proyecto y la fecha', async () => {
  const creado = await ctx.clientes.ceo.post('/api/costeo/snapshot', { centro: ctx.fixtures.CENTROS.alfa.id });
  const id = creado.json.snapshot_id;

  const r = await ctx.clientes.ceo.delete(`/api/costeo/snapshots/${id}`);
  assert.strictEqual(r.status, 200);

  const [log] = await ctx.db.query(
    "SELECT description, action FROM mp_costeo_audit_log WHERE entity_type='snapshot' AND entity_id=? AND action='eliminar'",
    [id]
  );
  assert.match(log.description, /Proyecto Alfa/);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Costo No Planeado — validacion de monto y descripcion (4 sep 2026)
// ---------------------------------------------------------------
//
// El POST siempre valido `amount > 0` y descripcion no vacia, pero el PUT
// no repetia ninguna de las dos: `Number(req.body.amount) || 0` dejaba
// pasar un negativo tal cual y `String(...).trim()` aceptaba "". Un gasto
// negativo RESTA del presupuesto ejecutado y ensucia el indicador #1, el
// ritmo de gasto (#5) y la alerta "Presupuesto casi agotado", sin dejar
// ninguna marca de que la fila es invalida.
//
// Se usa el cliente del CEO porque los gastos del fixture nacen
// 'aprobado' y un PM no puede editar una solicitud ya resuelta (esa
// guarda se prueba aparte); aqui lo que se ejercita es la validacion.

conBase(ctx, 'PUT de un gasto con monto negativo se rechaza y no toca la base', async () => {
  const id = ctx.fixtures.GASTOS.alfa1.id;
  const antes = ctx.fixtures.GASTOS.alfa1.monto;

  const r = await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { amount: -500000 });
  assert.strictEqual(r.status, 400, `esperaba 400 y dio ${r.status}: ${JSON.stringify(r.json)}`);

  const [fila] = await ctx.db.query('SELECT amount FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(fila.amount), antes, 'el monto no debio cambiar');
});

conBase(ctx, 'PUT de un gasto con monto 0 se rechaza', async () => {
  const id = ctx.fixtures.GASTOS.alfa1.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { amount: 0 });
  assert.strictEqual(r.status, 400, `esperaba 400 y dio ${r.status}`);

  const [fila] = await ctx.db.query('SELECT amount FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(fila.amount), ctx.fixtures.GASTOS.alfa1.monto, 'el monto no debio cambiar');
});

conBase(ctx, 'PUT de un gasto con monto no numerico se rechaza (no se guarda como 0)', async () => {
  const id = ctx.fixtures.GASTOS.alfa1.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { amount: 'mil pesos' });
  assert.strictEqual(r.status, 400, `esperaba 400 y dio ${r.status}`);

  const [fila] = await ctx.db.query('SELECT amount FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(Number(fila.amount), ctx.fixtures.GASTOS.alfa1.monto, 'un NaN no puede terminar en 0 en la base');
});

conBase(ctx, 'PUT de un gasto con descripcion vacia se rechaza', async () => {
  const id = ctx.fixtures.GASTOS.alfa1.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { description: '   ' });
  assert.strictEqual(r.status, 400, `esperaba 400 y dio ${r.status}`);

  const [fila] = await ctx.db.query('SELECT description FROM mp_costo_no_planeado WHERE expense_id = ?', [id]);
  assert.strictEqual(fila.description, ctx.fixtures.GASTOS.alfa1.desc, 'la descripcion no debio cambiar');
});

conBase(ctx, 'POST de un gasto con monto negativo se rechaza (la regla ya existia, queda fijada)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto con monto negativo',
    amount: -1,
    expense_date: '2026-08-20',
    category: 'otro',
  });
  assert.strictEqual(r.status, 400, `esperaba 400 y dio ${r.status}`);

  const filas = await ctx.db.query(
    'SELECT 1 FROM mp_costo_no_planeado WHERE description = ?', ['Gasto con monto negativo']
  );
  assert.strictEqual(filas.length, 0, 'no debio insertarse nada');
});

conBase(ctx, 'PUT de un gasto con monto valido SI actualiza (no se rompio el camino feliz)', async () => {
  const id = ctx.fixtures.GASTOS.alfa1.id;
  const r = await ctx.clientes.ceo.put(`/api/costeo/gastos/${id}`, { amount: 750000, description: 'Licencia corregida' });
  assert.strictEqual(r.status, 200, `esperaba 200 y dio ${r.status}: ${JSON.stringify(r.json)}`);

  const [fila] = await ctx.db.query(
    'SELECT amount, description FROM mp_costo_no_planeado WHERE expense_id = ?', [id]
  );
  assert.strictEqual(Number(fila.amount), 750000);
  assert.strictEqual(fila.description, 'Licencia corregida');
});
