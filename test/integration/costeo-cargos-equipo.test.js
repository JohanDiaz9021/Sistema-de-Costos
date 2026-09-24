'use strict';

/**
 * Cubre lo agregado en la sesion de "cargos dinamicos" (ago 2026):
 *   - Catalogo de cargos abierto a cualquier PM (crear / definir tarifa
 *     con auto-aplicacion / eliminar), en vez de la lista fija ENUM.
 *   - QA y UX dejan de poder ser Centro de Costos (son cargos, no
 *     proyectos).
 *   - Alta rapida de talento desde Equipo del Proyecto
 *     (POST /equipo/nueva-persona), incluida la reutilizacion cuando el
 *     nombre ya existe (una persona puede tener 1 o mas proyectos).
 *
 * Nada de esto estaba cubierto todavia: costeo-crud.test.js prueba
 * Centro de Costos/Equipo/Gastos/Overtime pero no toco tarifas-cargo ni
 * el flujo de alta combinada.
 */

const assert = require('node:assert');
const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// ---------------------------------------------------------------
// Tarifas por Cargo — catalogo dinamico
// ---------------------------------------------------------------

conBase(ctx, 'POST /tarifas-cargo: un PM (leader) crea un cargo nuevo con solo el nombre', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'Tester QA' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.role_catalog, 'tester_qa');
  assert.strictEqual(r.json.nombre_visible, 'Tester QA');

  const [fila] = await ctx.db.query('SELECT * FROM mp_tarifa_cargo WHERE role_catalog = ?', ['tester_qa']);
  assert.ok(fila, 'el cargo deberia quedar en mp_tarifa_cargo');
  assert.strictEqual(fila.hourly_cost, null, 'un cargo nuevo no trae tarifa todavia');
  // Ya no existe "Definir tarifa" (28 ago 2026): crear el cargo es la unica
  // escritura que le queda a la fila, asi que "Ultima edicion" tiene que
  // quedar poblada desde el alta, o se veria vacia para siempre.
  assert.ok(fila.updated_at, '"Ultima edicion" deberia quedar poblada desde que se crea el cargo');

  await ctx.resembrar();
});

conBase(ctx, 'POST /tarifas-cargo: nombre_visible vacio o demasiado largo se rechaza con 400', async () => {
  const vacio = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: '   ' });
  assert.strictEqual(vacio.status, 400);

  const largo = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'x'.repeat(61) });
  assert.strictEqual(largo.status, 400);
});

conBase(ctx, 'POST /tarifas-cargo: dos nombres que normalizan al mismo slug no chocan, se distinguen con sufijo', async () => {
  const r1 = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'Líder Técnico' });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r1.json.role_catalog, 'lider_tecnico');

  const r2 = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'Lider tecnico!!' });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.json.role_catalog, 'lider_tecnico_2', 'debe sufijarse en vez de chocar con el primero');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /tarifas-cargo/:rol: guardar la tarifa la aplica de inmediato a todo el equipo con ese cargo (dentro del scope)', async () => {
  // fixtures: EQUIPO.aliceEnAlfa = centro 1 (ALFA), rol 'desarrollador', tarifa 20000.
  //           OJO: EQUIPO.brendaEnBeta YA es 'desarrollador' en las fixtures
  //           base (tarifa 30000) -- no se reusa como "control" aqui porque
  //           su tarifa de fixture coincidiria por casualidad con la que
  //           esta prueba aplica, dando un falso verde. Se crea a alguien
  //           nuevo en BETA para el control.
  const nuevo = await ctx.clientes.bruno.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Control Beta',
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    role_catalog: 'desarrollador',
    hourly_cost: 1, // arranca con una tarifa individual "erronea" a proposito
  });
  assert.strictEqual(nuevo.status, 201, JSON.stringify(nuevo.json));

  // Ana (lider de ALFA) define la tarifa estandar de 'desarrollador'.
  const r = await ctx.clientes.ana.put('/api/costeo/tarifas-cargo/desarrollador', { hourly_cost: 40000 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.hourly_cost), 40000);

  // Su scope es solo ALFA: a Alicia (ALFA) SI le llega la tarifa nueva...
  const [alicia] = await ctx.db.query(
    'SELECT hourly_cost FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );
  assert.strictEqual(Number(alicia.hourly_cost), 40000, 'Alicia (ALFA, dentro del scope de Ana) deberia recibir la tarifa nueva');

  // ...pero a "Control Beta" (BETA, fuera del scope de Ana) NO la debe tocar.
  const [control] = await ctx.db.query(
    'SELECT hourly_cost FROM mp_equipo_proyecto WHERE team_member_id = ?', [nuevo.json.team_member_id]
  );
  assert.strictEqual(Number(control.hourly_cost), 1, 'Control Beta (fuera del scope de Ana) NO deberia tocarse');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /tarifas-cargo/:rol: dejar el campo vacio quita la tarifa estandar SIN tocar a nadie', async () => {
  await ctx.clientes.ceo.put('/api/costeo/tarifas-cargo/desarrollador', { hourly_cost: 99999 });
  const antes = await ctx.db.query(
    'SELECT hourly_cost FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );

  const r = await ctx.clientes.ceo.put('/api/costeo/tarifas-cargo/desarrollador', { hourly_cost: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.hourly_cost, null);
  assert.strictEqual(r.json.aplicados, 0, 'sin tarifa no hay nada que aplicar');

  const despues = await ctx.db.query(
    'SELECT hourly_cost FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );
  assert.strictEqual(Number(despues[0].hourly_cost), Number(antes[0].hourly_cost), 'la tarifa individual de Alicia no debio cambiar');

  await ctx.resembrar();
});

conBase(ctx, 'PUT /tarifas-cargo/:rol: cargo inexistente da 400, costo <= 0 tambien', async () => {
  const inexistente = await ctx.clientes.ceo.put('/api/costeo/tarifas-cargo/no_existe', { hourly_cost: 1000 });
  assert.strictEqual(inexistente.status, 400);

  const negativo = await ctx.clientes.ceo.put('/api/costeo/tarifas-cargo/desarrollador', { hourly_cost: -5 });
  assert.strictEqual(negativo.status, 400);
});

// El alta la puede hacer un PM (sigue abierta a proposito); el borrado ya no
// — desde el 15 sep 2026 es solo de admin/ceo, ver el encabezado de
// src/routes/costeo/tarifas.js.
conBase(ctx, 'DELETE /tarifas-cargo/:rol: sin nadie asignado, borra directo', async () => {
  await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'Sobrante' });
  const r = await ctx.clientes.ceo.delete('/api/costeo/tarifas-cargo/sobrante');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);
  assert.strictEqual(r.json.afectados, 0);

  const filas = await ctx.db.query('SELECT 1 FROM mp_tarifa_cargo WHERE role_catalog = ?', ['sobrante']);
  assert.strictEqual(filas.length, 0);
});

conBase(ctx, 'DELETE /tarifas-cargo/:rol: con gente asignada TAMBIEN borra (no bloquea), y avisa cuantos quedaron huerfanos', async () => {
  // 'desarrollador' tiene a Alicia asignada en las fixtures.
  const r = await ctx.clientes.ceo.delete('/api/costeo/tarifas-cargo/desarrollador');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);
  assert.ok(r.json.afectados >= 1, 'deberia contar a Alicia como afectada');

  const cargo = await ctx.db.query('SELECT 1 FROM mp_tarifa_cargo WHERE role_catalog = ?', ['desarrollador']);
  assert.strictEqual(cargo.length, 0, 'el cargo debe desaparecer del catalogo');

  // A Alicia NO se le toca su fila de equipo -- solo el cargo deja de
  // existir en el catalogo.
  const alicia = await ctx.db.query(
    'SELECT role_catalog FROM mp_equipo_proyecto WHERE cost_center_id = ? AND employee_id = ?',
    [ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );
  assert.strictEqual(alicia[0].role_catalog, 'desarrollador', 'la fila de equipo conserva el valor, aunque ya no este en el catalogo');

  await ctx.resembrar();
});

conBase(ctx, 'DELETE /tarifas-cargo/:rol: cargo inexistente da 404', async () => {
  const r = await ctx.clientes.ceo.delete('/api/costeo/tarifas-cargo/no_existe_este_rol');
  assert.strictEqual(r.status, 404);
});

// Borrar del catalogo es la unica operacion sin alcance natural: el catalogo
// es de TODA la empresa, asi que quitar un cargo deja huerfana a gente de
// proyectos que un PM ni siquiera ve. Crear (POST) y definir la tarifa (PUT)
// siguen abiertos a cualquier rol a proposito — ver el encabezado de
// src/routes/costeo/tarifas.js.
conBase(ctx, 'DELETE /tarifas-cargo/:rol: un lider NO puede borrar, aunque el cargo lo use solo su propia gente', async () => {
  // 'qa' solo lo tiene Arturo, en ALFA, que es de Ana: ni asi se le permite.
  // La regla es por ROL, no por alcance — mas simple de explicar y de
  // sostener, y coincide con lo que la pantalla le muestra (sin boton).
  const r = await ctx.clientes.ana.delete('/api/costeo/tarifas-cargo/qa');
  assert.strictEqual(r.status, 403, JSON.stringify(r.json));

  const sigue = await ctx.db.query("SELECT COUNT(*) n FROM mp_tarifa_cargo WHERE role_catalog = 'qa'");
  assert.strictEqual(Number(sigue[0].n), 1, 'el cargo tiene que seguir en el catalogo');

  await ctx.resembrar();
});

// El admin tiene el mismo permiso que el ceo, y hasta ahora ninguna prueba
// del catalogo lo ejercitaba: todas usaban al ceo. Si alguien escribiera
// requireRole('ceo') por descuido, nada lo habria detectado.
conBase(ctx, 'DELETE /tarifas-cargo/:rol: el admin tambien puede borrar, igual que el ceo', async () => {
  await ctx.clientes.ana.post('/api/costeo/tarifas-cargo', { nombre_visible: 'Para Admin' });
  const r = await ctx.clientes.admin.delete('/api/costeo/tarifas-cargo/para_admin');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);

  await ctx.resembrar();
});

conBase(ctx, 'DELETE /tarifas-cargo/:rol: el CEO si puede, aunque haya gente de varios proyectos con ese cargo', async () => {
  // 'desarrollador' lo tienen Alicia (ALFA) y Brenda (BETA): el CEO ve el
  // impacto completo, asi que se le deja y se le informa a cuantos afecta.
  const r = await ctx.clientes.ceo.delete('/api/costeo/tarifas-cargo/desarrollador');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);
  assert.ok(r.json.afectados >= 2, 'informa cuantas personas quedaron con el cargo huerfano');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// QA/UX ya no son proyectos, solo cargos
// ---------------------------------------------------------------

conBase(ctx, 'POST /centros: rechaza crear un Centro de Costos para QA o UX', async () => {
  for (const folder of ['QA', 'UX', 'qa', 'ux']) {
    const r = await ctx.clientes.ceo.post('/api/costeo/centros', {
      project_folder: folder, project_name: `Intento ${folder}`,
      budget: 1, start_date: '2026-01-01', planned_end_date: '2026-12-31',
    });
    assert.strictEqual(r.status, 400, `${folder} deberia rechazarse: ${JSON.stringify(r.json)}`);
  }

  const dup = await ctx.db.query("SELECT 1 FROM mp_centro_costo WHERE project_folder IN ('QA','UX')");
  assert.strictEqual(dup.length, 0, 'no debio quedar ningun centro QA/UX en la base');
});

conBase(ctx, 'GET /proyectos-disponibles: nunca lista QA ni UX aunque tengan tareas reportadas', async () => {
  // Simula que el RPA reporto tareas para la carpeta "QA" (caso real que
  // origino este cambio: QA/UX son carpetas de SharePoint de gente
  // transversal, no proyectos).
  await ctx.db.query(
    `INSERT INTO mp_task_facts
       (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
        week_number, project_name, activity, planned_type, total_executed_hours,
        hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
        budgeted_hours, task_status)
     VALUES ('2026-08-21', ?, 'QA', 'Agosto', 8, 2026, 2, 'QA', 'Prueba', 'P', 8, 8,0,0,0,0,0, 8, 'Terminado')`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );

  const r = await ctx.clientes.ceo.get('/api/costeo/proyectos-disponibles');
  assert.strictEqual(r.status, 200);
  const folders = r.json.proyectos.map((p) => p.project_folder);
  assert.ok(!folders.includes('QA'), `QA no deberia aparecer como proyecto disponible: ${folders.join(',')}`);
  assert.ok(!folders.includes('UX'), `UX no deberia aparecer como proyecto disponible: ${folders.join(',')}`);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// POST /equipo/nueva-persona — alta rapida + multi-proyecto
// ---------------------------------------------------------------

conBase(ctx, 'POST /equipo/nueva-persona: crea el talento y lo agrega al equipo en un solo paso, sin correo', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Diana Prueba',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    hourly_cost: 21000,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.yaExistia, false);

  const [emp] = await ctx.db.query('SELECT * FROM mp_employees WHERE employee_id = ?', [r.json.employee_id]);
  assert.strictEqual(emp.canonical_name, 'Diana Prueba');
  assert.strictEqual(emp.email, null, 'el correo debe quedar NULL, no exigirse');
  assert.strictEqual(emp.project_folder, ctx.fixtures.CENTROS.alfa.folder);

  const [eq] = await ctx.db.query('SELECT * FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(eq.role_catalog, 'desarrollador');
  assert.strictEqual(Number(eq.hourly_cost), 21000);
  assert.strictEqual(eq.is_active, 1);

  const historial = await ctx.db.query(
    "SELECT * FROM mp_costeo_audit_log WHERE entity_type='equipo' AND entity_id=?",
    [r.json.team_member_id]
  );
  assert.strictEqual(historial.length, 1);

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo/nueva-persona: is_active:false crea la fila directamente inactiva', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Eva Inactiva',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    hourly_cost: 21000,
    is_active: false,
  });
  assert.strictEqual(r.status, 201);
  const [eq] = await ctx.db.query('SELECT is_active FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(eq.is_active, 0);

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo/nueva-persona: nombre ya existente en OTRO centro reusa el employee_id (multi-proyecto), no bloquea', async () => {
  // "Alicia Alfa" ya existe (fixtures) y ya esta en ALFA. La agregamos
  // tambien a BETA usando el mismo flujo de alta rapida.
  const r = await ctx.clientes.ceo.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: ctx.fixtures.EMPLEADOS.aliceAlfa.nombre,
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    role_catalog: 'analista',
    hourly_cost: 22000,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.yaExistia, true);
  assert.strictEqual(r.json.employee_id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, 'debe reusar el employee_id existente, no crear uno nuevo');

  const filas = await ctx.db.query(
    'SELECT cost_center_id, is_active FROM mp_equipo_proyecto WHERE employee_id = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );
  assert.strictEqual(filas.length, 2, 'Alicia deberia terminar con 2 filas: ALFA (fixture) + BETA (nueva)');
  assert.ok(filas.every((f) => f.is_active === 1), 'ambas asignaciones deben quedar activas');

  const totalEmpleados = await ctx.db.query(
    'SELECT COUNT(*) AS n FROM mp_employees WHERE canonical_name = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.nombre]
  );
  assert.strictEqual(Number(totalEmpleados[0].n), 1, 'no debio duplicarse el registro de mp_employees');

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo/nueva-persona: mismo nombre + mismo centro donde YA esta -> 409 (editar, no duplicar)', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: ctx.fixtures.EMPLEADOS.aliceAlfa.nombre,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, // mismo centro donde ya esta en fixtures
    role_catalog: 'analista',
    hourly_cost: 22000,
  });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
});

conBase(ctx, 'POST /equipo/nueva-persona: un leader no puede asignar a un centro fuera de su scope (403)', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', { // Ana lidera ALFA, no BETA
    canonical_name: 'Intruso De Ana',
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    role_catalog: 'desarrollador',
    hourly_cost: 15000,
  });
  assert.strictEqual(r.status, 403);

  const existe = await ctx.db.query('SELECT 1 FROM mp_employees WHERE canonical_name = ?', ['Intruso De Ana']);
  assert.strictEqual(existe.length, 0, 'no debio crearse el empleado si la asignacion se rechaza');
});

conBase(ctx, 'POST /equipo/nueva-persona: validaciones basicas (nombre, cargo, costo/hora)', async () => {
  const sinNombre = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id, role_catalog: 'desarrollador', hourly_cost: 1000,
  });
  assert.strictEqual(sinNombre.status, 400);

  const cargoInvalido = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Sin Cargo Valido', cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'no_existe_este_cargo', hourly_cost: 1000,
  });
  assert.strictEqual(cargoInvalido.status, 400);

  const costoInvalido = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Sin Costo Valido', cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador', hourly_cost: 0,
  });
  assert.strictEqual(costoInvalido.status, 400);

  const correoMalo = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Correo Malo', cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador', hourly_cost: 1000, email: 'esto-no-es-un-correo',
  });
  assert.strictEqual(correoMalo.status, 400);
});

// ---------------------------------------------------------------
// El historial tiene que mostrar el NOMBRE del cargo ("Líder de proyecto"),
// no la llave interna cruda ("lider_proyecto") que solo tiene sentido para
// la base de datos. Cubre las 5 rutas que arman descripciones con un cargo.
//
// El nombre visible exacto de 'lider_proyecto' se lee de la base en vez de
// asumirlo a mano: mp_tarifa_cargo se siembra dos veces en las pruebas (el
// esquema inicial via sql/20, y de nuevo en cada resetearDatos() via un
// INSERT propio de test/helpers/db.js) y las dos copias no coinciden letra
// por letra ("Líder de proyecto" vs "Líder de Proyecto") — lo único que
// importa aquí es que el historial muestre ESE nombre, no el slug crudo.
// ---------------------------------------------------------------

async function nombreVisibleReal(ctx, rol) {
  const [fila] = await ctx.db.query('SELECT nombre_visible FROM mp_tarifa_cargo WHERE role_catalog = ?', [rol]);
  return fila.nombre_visible;
}

// ---------------------------------------------------------------
// Horas planeadas por persona (sql/35, 3 sep 2026, a pedido explícito):
// cada persona puede tener una carga distinta (50h, 35h, 10h...) y por lo
// tanto un costo planeado distinto — se define al agregarla al equipo
// (talento existente o persona nueva) o después, editándola.
// ---------------------------------------------------------------

conBase(ctx, 'POST /equipo: guarda planned_hours si viene, y queda NULL si no', async () => {
  const conHoras = await ctx.clientes.ana.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    employee_id: ctx.fixtures.EMPLEADOS.brendaBeta.id,
    role_catalog: 'lider_proyecto', hourly_cost: 30000, planned_hours: 50,
  });
  assert.strictEqual(conHoras.status, 201, JSON.stringify(conHoras.json));
  const [filaConHoras] = await ctx.db.query('SELECT planned_hours FROM mp_equipo_proyecto WHERE team_member_id = ?', [conHoras.json.team_member_id]);
  assert.strictEqual(Number(filaConHoras.planned_hours), 50);

  const sinHoras = await ctx.clientes.ceo.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    employee_id: ctx.fixtures.EMPLEADOS.arturoAlfa.id,
    role_catalog: 'qa', hourly_cost: 15000,
  });
  assert.strictEqual(sinHoras.status, 201, JSON.stringify(sinHoras.json));
  const [filaSinHoras] = await ctx.db.query('SELECT planned_hours FROM mp_equipo_proyecto WHERE team_member_id = ?', [sinHoras.json.team_member_id]);
  assert.strictEqual(filaSinHoras.planned_hours, null, 'sin planned_hours en el body debe quedar NULL, no 0');

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo/nueva-persona: tambien acepta planned_hours', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Nueva Con Horas', cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'qa', hourly_cost: 12000, planned_hours: 35,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [fila] = await ctx.db.query('SELECT planned_hours FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(Number(fila.planned_hours), 35);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /equipo/:id: edita planned_hours, y mandar vacio lo vuelve a dejar sin definir', async () => {
  const id = ctx.fixtures.EQUIPO.arturoEnAlfa.id;
  const puesto = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { planned_hours: 10 });
  assert.strictEqual(puesto.status, 200, JSON.stringify(puesto.json));
  const [conHoras] = await ctx.db.query('SELECT planned_hours FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(Number(conHoras.planned_hours), 10);

  const quitado = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { planned_hours: '' });
  assert.strictEqual(quitado.status, 200, JSON.stringify(quitado.json));
  const [sinHoras] = await ctx.db.query('SELECT planned_hours FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(sinHoras.planned_hours, null);

  await ctx.resembrar();
});

conBase(ctx, 'GET /equipo: trae planned_hours de cada fila', async () => {
  await ctx.clientes.ana.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.arturoEnAlfa.id}`, { planned_hours: 22 });
  const r = await ctx.clientes.ana.get('/api/costeo/equipo');
  const fila = r.json.equipo.find((e) => e.team_member_id === ctx.fixtures.EQUIPO.arturoEnAlfa.id);
  assert.strictEqual(Number(fila.planned_hours), 22);

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo: el historial muestra el nombre del cargo, no el slug', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  // brendaBeta ya esta en el equipo de BETA (fixtures), pero no en ALFA
  // todavia -- uk_equipo_centro_talento es por (centro, empleado), asi que
  // esta asignacion no choca.
  const r = await ctx.clientes.ana.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    employee_id: ctx.fixtures.EMPLEADOS.brendaBeta.id,
    role_catalog: 'lider_proyecto', hourly_cost: 30000,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='equipo' AND entity_id=?", [r.json.team_member_id]
  );
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/, `no deberia mostrar el slug crudo: ${log.description}`);

  await ctx.resembrar();
});

conBase(ctx, 'POST /equipo/nueva-persona: el historial muestra el nombre del cargo, no el slug', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Nueva Con Cargo', cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'lider_proyecto', hourly_cost: 30000,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='equipo' AND entity_id=?", [r.json.team_member_id]
  );
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /equipo/:id: cambiar de cargo muestra "de -> a" con nombres, no slugs', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  // arturoEnAlfa (fixtures): rol 'qa'.
  const id = ctx.fixtures.EQUIPO.arturoEnAlfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { role_catalog: 'lider_proyecto' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='equipo' AND entity_id=? ORDER BY log_id DESC LIMIT 1", [id]
  );
  assert.match(log.description, /QA/, `deberia mostrar el cargo anterior: ${log.description}`);
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/, `no deberia mostrar el slug crudo: ${log.description}`);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /tarifas-cargo/:rol: el historial muestra el nombre del cargo, no el slug', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  const r = await ctx.clientes.ana.put('/api/costeo/tarifas-cargo/lider_proyecto', { hourly_cost: 45000 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='tarifa_cargo' ORDER BY log_id DESC LIMIT 1"
  );
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/);

  await ctx.resembrar();
});

conBase(ctx, 'POST /tarifas-cargo/:rol/aplicar: el historial muestra el nombre del cargo, no el slug', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  await ctx.clientes.ana.put('/api/costeo/tarifas-cargo/lider_proyecto', { hourly_cost: 45000 });
  const r = await ctx.clientes.ana.post('/api/costeo/tarifas-cargo/lider_proyecto/aplicar', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='tarifa_cargo' ORDER BY log_id DESC LIMIT 1"
  );
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /centros/:id/plan-recursos: el historial muestra el nombre del cargo, no el slug', async () => {
  const nombreRol = await nombreVisibleReal(ctx, 'lider_proyecto');
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}/plan-recursos`, {
    filas: [{ role_catalog: 'lider_proyecto', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='plan_recursos' AND entity_id=? ORDER BY log_id DESC LIMIT 1", [id]
  );
  assert.ok(log.description.includes(nombreRol), `deberia mostrar "${nombreRol}": ${log.description}`);
  assert.doesNotMatch(log.description, /lider_proyecto/);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /centros/:id: cambiar tipo o estado muestra el texto legible, no el slug', async () => {
  const id = ctx.fixtures.CENTROS.alfa.id;
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${id}`, { tipo: 'Consultoria', status: 'por_vencer' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const [log] = await ctx.db.query(
    "SELECT description FROM mp_costeo_audit_log WHERE entity_type='centro_costo' AND entity_id=? ORDER BY log_id DESC LIMIT 1", [id]
  );
  assert.match(log.description, /Consultoría/, `deberia llevar tilde: ${log.description}`);
  assert.match(log.description, /Por vencer/, `deberia leerse "Por vencer", no el slug: ${log.description}`);
  assert.doesNotMatch(log.description, /por_vencer/);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Valor hora desde el salario (sql/33) — la formula de GTC
// ---------------------------------------------------------------
//
// Se dan de alta personas nuevas en vez de reusar las de fixtures: los 4
// empleados sembrados ya tienen fila en su centro (uk_equipo_centro_talento,
// sql/17), asi que un POST /equipo sobre ellos daria 409 y estariamos
// probando el indice unico, no la formula.

conBase(ctx, 'alta con salario mensual: el valor hora sale de la formula (1.750.950 / 210 = 8.338)', async () => {
  // El caso real que entrego GTC. Si este numero cambia, la app dejo de
  // coincidir con la hoja de nomina de la empresa.
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Con Salario',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [eq] = await ctx.db.query('SELECT * FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(Number(eq.monthly_salary), 1750950, 'el salario queda guardado, no solo el resultado');
  assert.strictEqual(Number(eq.hourly_cost), 8338);

  await ctx.resembrar();
});

conBase(ctx, 'alta con salario: el salario MANDA sobre el costo/hora tecleado', async () => {
  // Guardar los dos y que ganara el tecleado dejaria en pantalla un salario
  // que no corresponde a la tarifa con la que se esta costeando.
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Con Dos Cifras',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950,
    hourly_cost: 99999,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [eq] = await ctx.db.query('SELECT hourly_cost FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(Number(eq.hourly_cost), 8338, 'gana la formula, no lo tecleado');

  await ctx.resembrar();
});

conBase(ctx, 'alta sin salario: se conserva el modo manual (costo/hora tecleado, salario NULL)', async () => {
  // Hay gente por horas o por prestacion de servicios, sin salario mensual
  // del cual dividir: ese camino no puede quedar roto.
  const r = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Por Horas',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    hourly_cost: 21000,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  const [eq] = await ctx.db.query('SELECT * FROM mp_equipo_proyecto WHERE team_member_id = ?', [r.json.team_member_id]);
  assert.strictEqual(Number(eq.hourly_cost), 21000);
  assert.strictEqual(eq.monthly_salary, null);

  await ctx.resembrar();
});

conBase(ctx, 'PUT /equipo/:id: cambiar el salario RECALCULA el valor hora; vaciarlo devuelve al modo manual', async () => {
  const alta = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Que Cambia',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950,
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));
  const id = alta.json.team_member_id;

  const subida = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { monthly_salary: 2100000 });
  assert.strictEqual(subida.status, 200);
  const [tras] = await ctx.db.query('SELECT * FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(Number(tras.hourly_cost), 10000, '2.100.000 / 210 = 10.000');

  // Vaciar el salario es la forma explicita de volver a escribir la tarifa
  // a mano: si el salario quedara pegado, el valor hora se recalcularia solo
  // la proxima vez y pisaria lo que el PM acaba de teclear.
  const manual = await ctx.clientes.ana.put(`/api/costeo/equipo/${id}`, { monthly_salary: null, hourly_cost: 15000 });
  assert.strictEqual(manual.status, 200);
  const [final] = await ctx.db.query('SELECT * FROM mp_equipo_proyecto WHERE team_member_id = ?', [id]);
  assert.strictEqual(final.monthly_salary, null);
  assert.strictEqual(Number(final.hourly_cost), 15000);

  await ctx.resembrar();
});

conBase(ctx, 'GET /equipo devuelve el salario, para poder mostrar de donde sale la tarifa', async () => {
  const alta = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Visible',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950,
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));

  const r = await ctx.clientes.ana.get('/api/costeo/equipo');
  const fila = r.json.equipo.find((m) => m.team_member_id === alta.json.team_member_id);
  assert.ok(fila, 'la persona recien dada de alta deberia aparecer');
  assert.strictEqual(Number(fila.monthly_salary), 1750950);
  assert.strictEqual(Number(fila.hourly_cost), 8338);

  await ctx.resembrar();
});

conBase(ctx, 'GET /config: la tabla de recargos son los 8 casos de GTC, calculados con los valores vigentes', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/config');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.horas_mes, 210);

  const porFactor = r.json.tabla_recargos.map((f) => f.factor).sort((a, b) => a - b);
  assert.deepStrictEqual(porFactor, [1, 1.25, 1.35, 1.75, 1.9, 2.15, 2.25, 2.65],
    'los 8 renglones de la tabla de GTC');
});

conBase(ctx, 'GET /config: editar un porcentaje mueve la tabla mostrada (no es HTML escrito a mano)', async () => {
  await ctx.clientes.ceo.put('/api/costeo/config/recargo_dominical_festivo_pct', { config_value: 100 });

  const r = await ctx.clientes.ceo.get('/api/costeo/config');
  const porFactor = r.json.tabla_recargos.map((f) => f.factor).sort((a, b) => a - b);
  // Con el dominical al 100%: 1,90->2,00 ; 2,15->2,25 ; 2,25->2,35 ; 2,65->2,75
  assert.deepStrictEqual(porFactor, [1, 1.25, 1.35, 1.75, 2, 2.25, 2.35, 2.75]);

  await ctx.db.query("UPDATE mp_costeo_config SET config_value = '90' WHERE config_key = 'recargo_dominical_festivo_pct'");
});

// ---------------------------------------------------------------
// GET /equipo/salario-conocido/:employeeId — autocompletar salario (sql/33)
// ---------------------------------------------------------------

conBase(ctx, 'GET /equipo/salario-conocido: trae el ultimo salario conocido de esa persona en OTRO proyecto', async () => {
  const alta1 = await ctx.clientes.ana.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Persona Con Historial',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    monthly_salary: 1750950,
  });
  assert.strictEqual(alta1.status, 201, JSON.stringify(alta1.json));

  const r = await ctx.clientes.ana.get(`/api/costeo/equipo/salario-conocido/${alta1.json.employee_id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.monthly_salary, 1750950);

  await ctx.resembrar();
});

conBase(ctx, 'GET /equipo/salario-conocido: null si la persona nunca ha tenido salario cargado', async () => {
  const r = await ctx.clientes.ana.get(`/api/costeo/equipo/salario-conocido/${ctx.fixtures.EMPLEADOS.aliceAlfa.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.monthly_salary, null);
});

// Abierto a los 3 roles (14 sep 2026, a pedido explicito): PM, admin y CEO
// tienen derecho a ver el sueldo de cualquier persona de la empresa. El
// resguardo contra pisar un sueldo ya asignado vive en el front, que
// bloquea el campo cuando ya hay un valor conocido (ver initEquipoGastoForms
// en costeo-equipo.js) — no en quien puede leerlo.
conBase(ctx, 'GET /equipo/salario-conocido: un leader tambien puede leerlo (lo necesita para dar de alta)', async () => {
  const r = await ctx.clientes.ana.get('/api/costeo/equipo/salario-conocido/1');
  assert.notStrictEqual(r.status, 403);
});

// ---------------------------------------------------------------
// DELETE /equipo/:id — borrar de verdad, distinto de inactivar (16 sep 2026)
// ---------------------------------------------------------------

// Hasta hoy el boton "Eliminar" de la pantalla mandaba is_active:false: decia
// eliminar y solo desactivaba. Ahora son dos acciones distintas, y esta
// tiene una condicion que protege el dinero ya calculado.
conBase(ctx, 'DELETE /equipo/:id: borra de verdad a quien NO dejo ningun rastro', async () => {
  const alta = await ctx.clientes.ceo.post('/api/costeo/equipo/nueva-persona', {
    canonical_name: 'Alta Por Error',
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    role_catalog: 'desarrollador',
    hourly_cost: 15000,
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));

  const r = await ctx.clientes.ceo.delete(`/api/costeo/equipo/${alta.json.team_member_id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);

  // Se va del todo: ni del equipo ni del catalogo de personas queda nada.
  const enEquipo = await ctx.db.query('SELECT 1 FROM mp_equipo_proyecto WHERE team_member_id = ?', [alta.json.team_member_id]);
  assert.strictEqual(enEquipo.length, 0, 'no puede quedar en el equipo');
  const enCatalogo = await ctx.db.query('SELECT 1 FROM mp_employees WHERE canonical_name = ?', ['Alta Por Error']);
  assert.strictEqual(enCatalogo.length, 0, 'tampoco en el catalogo de personas');

  await ctx.resembrar();
});

// La regla que de verdad importa: mp_costeo_task_facts NO tiene clave foranea
// contra mp_employees, asi que la base dejaria borrar a alguien con horas
// colgando y nadie se enteraria — las horas quedarian sin dueno y el costo
// ejecutado de meses YA CERRADOS cambiaria solo.
conBase(ctx, 'DELETE /equipo/:id: se niega a borrar a quien ya tiene horas, y dice que usar en su lugar', async () => {
  // Alicia (aliceEnAlfa) ya trae horas sembradas en las fixtures.
  const r = await ctx.clientes.ceo.delete(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.aliceEnAlfa.id}`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /Inactivar/, 'tiene que ofrecer la alternativa, no solo negarse');
  assert.match(r.json.error, /horas/i, 'y decir que historia lo impide');

  // Y sobre todo: NO se toco nada.
  const sigue = await ctx.db.query('SELECT 1 FROM mp_equipo_proyecto WHERE team_member_id = ?', [ctx.fixtures.EQUIPO.aliceEnAlfa.id]);
  assert.strictEqual(sigue.length, 1, 'la persona tiene que seguir en el equipo');
  const horas = await ctx.db.query('SELECT COUNT(*) n FROM mp_costeo_task_facts WHERE employee_id = ?', [ctx.fixtures.EMPLEADOS.aliceAlfa.id]);
  assert.ok(Number(horas[0].n) > 0, 'y sus horas intactas');

  await ctx.resembrar();
});

conBase(ctx, 'DELETE /equipo/:id: un leader no puede borrar de un centro fuera de su scope', async () => {
  const r = await ctx.clientes.ana.delete(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.brendaEnBeta.id}`);
  assert.strictEqual(r.status, 403, JSON.stringify(r.json));
});
