'use strict';

/**
 * Matriz de autorizacion sobre los 56 endpoints de /api.
 *
 * Dos propiedades:
 *   1. Sin sesion, TODO /api/* responde 401 (salvo el propio login).
 *   2. Los endpoints administrativos rechazan al rol 'leader' con 403 y
 *      aceptan a admin/ceo.
 *
 * La lista de endpoints se compara ademas contra las rutas que la app
 * registra de verdad: si alguien agrega una ruta nueva y no la clasifica
 * aqui, la ultima prueba del archivo falla. Es lo que evita que la
 * cobertura se quede vieja en silencio.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// ---------------------------------------------------------------
// 1. Sin sesion: 401 en todo /api/*
// ---------------------------------------------------------------

// Un representante de cada router, con metodo y ruta reales.
const SIN_SESION = [
  ['GET', '/api/auth/me'],
  ['PUT', '/api/auth/me/sidebar'],
  ['GET', '/api/filters/'],
  ['GET', '/api/indicator/1'],
  ['GET', '/api/indicator/1/drilldown'],
  ['GET', '/api/indicator/export/pdf'],
  ['POST', '/api/indicator/export/pdf-graficos'],
  ['GET', '/api/resource/1'],
  ['GET', '/api/employees/'],
  ['POST', '/api/employees/'],
  ['PUT', '/api/employees/1'],
  ['DELETE', '/api/employees/1'],
  ['POST', '/api/employees/1/sharepoint'],
  ['GET', '/api/validation/errors'],
  ['GET', '/api/validation/errors/summary'],
  ['POST', '/api/validation/errors/1/ack'],
  ['POST', '/api/validation/errors/1/revert'],
  ['POST', '/api/validation/errors/1/unrevert'],
  ['GET', '/api/validation/runs'],
  ['GET', '/api/costeo/centros'],
  ['POST', '/api/costeo/centros'],
  ['PUT', '/api/costeo/centros/1'],
  ['DELETE', '/api/costeo/centros/1'],
  ['GET', '/api/costeo/centros/1/plan-recursos'],
  ['PUT', '/api/costeo/centros/1/plan-recursos'],
  ['DELETE', '/api/costeo/centros/1/plan-recursos'],
  ['POST', '/api/costeo/centros/1/cargar-excel-horas'],
  ['GET', '/api/costeo/tarifas-cargo'],
  ['POST', '/api/costeo/tarifas-cargo'],
  ['PUT', '/api/costeo/tarifas-cargo/qa'],
  ['POST', '/api/costeo/tarifas-cargo/qa/aplicar'],
  ['DELETE', '/api/costeo/tarifas-cargo/qa'],
  ['GET', '/api/costeo/equipo'],
  ['POST', '/api/costeo/equipo'],
  ['POST', '/api/costeo/equipo/nueva-persona'],
  ['PUT', '/api/costeo/equipo/1'],
  ['DELETE', '/api/costeo/equipo/1'],
  ['GET', '/api/costeo/gastos'],
  ['POST', '/api/costeo/gastos'],
  ['PUT', '/api/costeo/gastos/1'],
  ['POST', '/api/costeo/gastos/1/aprobacion'],
  ['DELETE', '/api/costeo/gastos/1'],
  ['POST', '/api/costeo/overtime/sync'],
  ['GET', '/api/costeo/overtime'],
  ['POST', '/api/costeo/overtime'],
  ['POST', '/api/costeo/overtime/1/decision'],
  ['POST', '/api/costeo/overtime/1/approve'],
  ['PUT', '/api/costeo/overtime/1'],
  ['DELETE', '/api/costeo/overtime/1'],
  ['GET', '/api/costeo/meses'],
  ['GET', '/api/costeo/indicadores'],
  ['GET', '/api/costeo/indicadores-17'],
  ['GET', '/api/costeo/alertas'],
  ['POST', '/api/costeo/alertas/corregida'],
  ['GET', '/api/costeo/alertas/email/estado'],
  ['POST', '/api/costeo/alertas/email'],
  ['GET', '/api/costeo/indicadores-17/export/pdf'],
  ['GET', '/api/costeo/indicadores-17/export/xlsx'],
  ['GET', '/api/costeo/comercial'],
  ['POST', '/api/costeo/snapshot'],
  ['GET', '/api/costeo/snapshots'],
  ['GET', '/api/costeo/snapshots/1'],
  ['DELETE', '/api/costeo/snapshots/1'],
  ['GET', '/api/costeo/proyectos-disponibles'],
  ['GET', '/api/costeo/accesos'],
  ['POST', '/api/costeo/accesos'],
  ['PUT', '/api/costeo/accesos/1'],
  ['GET', '/api/costeo/historial'],
  ['GET', '/api/costeo/config'],
  ['PUT', '/api/costeo/config/weekly_legal_hours'],
  ['GET', '/api/costeo/parametros-nomina'],
  ['GET', '/api/costeo/equipo/salario-conocido/1'],
];

conBase(ctx, `sin sesion, los ${SIN_SESION.length} endpoints de /api dan 401`, async () => {
  const anon = ctx.anonimo();
  const fallos = [];

  for (const [metodo, ruta] of SIN_SESION) {
    const r = metodo === 'GET' ? await anon.get(ruta)
      : metodo === 'POST' ? await anon.post(ruta, {})
        : metodo === 'PUT' ? await anon.put(ruta, {})
          : await anon.delete(ruta);
    if (r.status !== 401) fallos.push(`${metodo} ${ruta} -> ${r.status}`);
  }

  assert.deepStrictEqual(fallos, [], `endpoints accesibles sin sesion:\n  ${fallos.join('\n  ')}`);
});

conBase(ctx, 'sin sesion no se filtra NADA en el cuerpo del 401', async () => {
  const anon = ctx.anonimo();
  for (const ruta of ['/api/costeo/centros', '/api/costeo/accesos', '/api/employees/']) {
    const r = await anon.get(ruta);
    assert.strictEqual(r.status, 401);
    const texto = JSON.stringify(r.json);
    for (const aguja of ['ALFA', 'BETA', 'ejemplo.test', 'Alicia']) {
      assert.ok(!texto.includes(aguja), `${ruta} filtro "${aguja}" en el 401`);
    }
  }
});

conBase(ctx, 'el login SI es accesible sin sesion (control)', async () => {
  // Sin este control, la prueba de arriba pasaria con un servidor que
  // devuelve 401 a todo, login incluido.
  //
  // Se usan credenciales VALIDAS a proposito: con una clave mala el login
  // responde 401 igual que requireAuth, y el status no distinguiria
  // "credenciales invalidas" de "hace falta sesion".
  const r = await ctx.anonimo().post('/api/auth/login', {
    email: ctx.fixtures.USUARIOS.ceo.email,
    password: ctx.fixtures.CLAVE,
  });
  assert.strictEqual(r.status, 200, 'el login no puede exigir sesion previa');
});

conBase(ctx, 'logout es publico a proposito y es idempotente', async () => {
  // /api/auth se monta ANTES de requireAuth (server.js), asi que este
  // router hace sus propias comprobaciones. Para el logout es
  // deliberado: cerrar una sesion que ya no existe debe responder ok, no
  // un 401 que dejaria al usuario atrapado en una pantalla de error.
  const r = await ctx.anonimo().post('/api/auth/logout', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true });
});

// ---------------------------------------------------------------
// 2. Endpoints administrativos: leader 403, admin/ceo pasa
// ---------------------------------------------------------------

// `cuerpo` es un payload valido a proposito: si fuera invalido, un 400
// podria confundirse con un rechazo por permisos y la prueba pasaria
// por la razon equivocada.
// "crear centro de costos" (POST /centros) y "eliminar centro de costos"
// (DELETE /centros/:id) NO van aquí: desde ago 2026 un leader (PM) también
// puede crear (con Plan de Recursos, ver el Simulador -> "Agregar
// proyecto") y eliminar (borrado real, ver sql y comentario del endpoint),
// pero solo en SUS PROPIOS centros
// (canWriteCenter) — hay pruebas positivas dedicadas más abajo. El caso de
// "leader intenta tocar un centro AJENO" (GAMMA, sin PM) sigue dando 403 y
// queda cubierto por 'el DELETE de un centro por un leader no borra nada'.
const SOLO_ADMIN = [
  {
    nombre: 'aprobar hora extra',
    metodo: 'POST', ruta: (fx) => `/api/costeo/overtime/${fx.OVERTIME.alfaPendiente.id}/approve`,
    cuerpo: () => ({ approved: true }),
    limpiar: async (db, fx) => db.query(
      "UPDATE mp_overtime_decisions SET approval_status='pendiente', extra_cost_final=0, approved_by=NULL, approved_at=NULL WHERE decision_id=?",
      [fx.OVERTIME.alfaPendiente.id]
    ),
  },
  {
    // sql/28: el PM SOLICITA el gasto no planeado; aprobarlo o rechazarlo
    // es del CEO/admin. Si esta guarda se cae, el PM se aprueba su propio
    // gasto y la aprobacion no significa nada.
    nombre: 'aprobar un gasto no planeado',
    metodo: 'POST', ruta: (fx) => `/api/costeo/gastos/${fx.GASTOS.alfa1.id}/aprobacion`,
    cuerpo: () => ({ approved: true }),
    // alfa1 nace 'aprobado' en las fixtures; se deja pendiente para que el
    // caso positivo (admin y ceo SI pueden) tenga algo que aprobar.
    preparar: async (db, fx) => db.query(
      "UPDATE mp_costo_no_planeado SET approval_status='pendiente', approved_by=NULL, approved_at=NULL WHERE expense_id=?",
      [fx.GASTOS.alfa1.id]
    ),
    limpiar: async (db, fx) => db.query(
      "UPDATE mp_costo_no_planeado SET approval_status='aprobado', approved_by=NULL, approved_at=NULL, rejection_note=NULL WHERE expense_id=?",
      [fx.GASTOS.alfa1.id]
    ),
  },
  {
    nombre: 'listar accesos de PM',
    metodo: 'GET', ruta: '/api/costeo/accesos',
  },
  {
    nombre: 'crear acceso de PM',
    metodo: 'POST', ruta: '/api/costeo/accesos',
    cuerpo: () => ({
      full_name: 'PM de prueba', email: 'pm-nuevo@ejemplo.test',
      password: 'clave-larga-123', project_folders: [],
    }),
    limpiar: async (db) => db.query("DELETE FROM mp_dashboard_users WHERE email = 'pm-nuevo@ejemplo.test'"),
  },
  {
    nombre: 'editar acceso de PM',
    metodo: 'PUT', ruta: (fx) => `/api/costeo/accesos/${fx.USUARIOS.liderBeta.id}`,
    cuerpo: () => ({ full_name: 'Bruno Líder' }),
  },
  {
    nombre: 'proyectos disponibles',
    metodo: 'GET', ruta: '/api/costeo/proyectos-disponibles',
  },
  {
    nombre: 'leer configuracion de umbrales',
    metodo: 'GET', ruta: '/api/costeo/config',
  },
  {
    nombre: 'cambiar un umbral',
    metodo: 'PUT', ruta: '/api/costeo/config/umbral_presupuesto',
    cuerpo: () => ({ config_value: 85 }),
  },
  {
    nombre: 'crear snapshot',
    metodo: 'POST', ruta: '/api/costeo/snapshot',
    cuerpo: (fx) => ({ centro: fx.CENTROS.alfa.id }),
    limpiar: async (db) => db.query('DELETE FROM mp_costeo_snapshot'),
  },
  {
    nombre: 'crear empleado',
    metodo: 'POST', ruta: '/api/employees/',
    cuerpo: () => ({ canonical_name: 'Empleado De Prueba', email: 'nuevo-emp@ejemplo.test' }),
    limpiar: async (db) => db.query("DELETE FROM mp_employees WHERE email = 'nuevo-emp@ejemplo.test'"),
  },
  {
    nombre: 'ver el estado de alertas por correo',
    metodo: 'GET', ruta: '/api/costeo/alertas/email/estado',
  },
  {
    // ?previsualizar=1 devuelve el HTML del correo SIN enviarlo: el test
    // positivo verifica el permiso sin abrir una conexion SMTP real.
    nombre: 'previsualizar el correo de alertas',
    metodo: 'POST', ruta: '/api/costeo/alertas/email?previsualizar=1',
    cuerpo: () => ({}),
  },
  // GET /equipo/salario-conocido NO va aquí: los 3 roles pueden leerlo (a
  // pedido explícito, 14 sep 2026) — ver el permiso positivo del leader en
  // costeo-cargos-equipo.test.js.
];

function resolver(valor, fx) {
  return typeof valor === 'function' ? valor(fx) : valor;
}

async function ejecutar(cliente, caso, fx) {
  const ruta = resolver(caso.ruta, fx);
  const cuerpo = caso.cuerpo ? caso.cuerpo(fx) : {};
  switch (caso.metodo) {
    case 'GET': return cliente.get(ruta);
    case 'POST': return cliente.post(ruta, cuerpo);
    case 'PUT': return cliente.put(ruta, cuerpo);
    case 'DELETE': return cliente.delete(ruta);
    default: throw new Error(`metodo no soportado: ${caso.metodo}`);
  }
}

for (const caso of SOLO_ADMIN) {
  conBase(ctx, `un leader NO puede: ${caso.nombre}`, async () => {
    if (caso.preparar) await caso.preparar(ctx.db, ctx.fixtures);
    const r = await ejecutar(ctx.clientes.ana, caso, ctx.fixtures);
    // El 403 no deberia haber escrito nada, pero `preparar` si toco la
    // base: se deshace igual, para no dejarle estado a la prueba siguiente.
    if (caso.limpiar) await caso.limpiar(ctx.db, ctx.fixtures);
    assert.strictEqual(
      r.status, 403,
      `${caso.metodo} ${resolver(caso.ruta, ctx.fixtures)} deberia dar 403 para un leader y dio ${r.status}: ${JSON.stringify(r.json)}`
    );
  });
}

for (const caso of SOLO_ADMIN) {
  conBase(ctx, `admin y ceo SI pueden: ${caso.nombre}`, async () => {
    // El control positivo: sin el, un endpoint roto que devuelve 403 a
    // todo el mundo pasaria la prueba de arriba.
    for (const [rol, cliente] of [['admin', ctx.clientes.admin], ['ceo', ctx.clientes.ceo]]) {
      if (caso.preparar) await caso.preparar(ctx.db, ctx.fixtures);
      const r = await ejecutar(cliente, caso, ctx.fixtures);
      assert.ok(
        r.status < 400,
        `${rol} deberia poder ${caso.nombre} y recibio ${r.status}: ${JSON.stringify(r.json)}`
      );
      if (caso.limpiar) await caso.limpiar(ctx.db, ctx.fixtures);
    }
  });
}

conBase(ctx, 'un leader (PM) SI puede crear un proyecto desde el Simulador, con Plan de Recursos', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/centros', {
    project_name: 'Proyecto creado por PM', start_date: '2026-01-01', planned_end_date: '2026-12-31',
    plan_recursos: [{ role_catalog: 'qa', personas: 1, horas_totales: 10, costo_hora: 1000 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(Number(r.json.budget), 10000);

  // Sin la fila de dueño, el PM no vería en NINGUNA pestaña el proyecto que
  // acaba de crear (attachScope filtra por mp_project_owners) — este es el
  // punto de la prueba, no un detalle de limpieza.
  const duenos = await ctx.db.query(
    "SELECT pmo_email FROM mp_project_owners WHERE project_folder = 'proyecto-creado-por-pm' AND is_active = 1"
  );
  assert.deepStrictEqual(duenos.map((d) => d.pmo_email), [ctx.fixtures.USUARIOS.liderAlfa.email]);

  // Y en efecto lo ve: aparece en la lista que alimenta el filtro global.
  const lista = await ctx.clientes.ana.get('/api/costeo/centros');
  assert.ok(
    lista.json.centros.some((c) => c.cost_center_id === r.json.cost_center_id),
    'el PM deberia ver el proyecto que acaba de crear'
  );

  await ctx.resembrar();
});

// 14 sep 2026, corregido tras revisión de seguridad: mp_project_owners se
// puede poblar desde Accesos sin que exista todavía un Centro de Costos
// (ver /proyectos-disponibles) — así que un project_folder sin centro
// puede perfectamente ya tener un PM real asignado. Antes, cualquier
// leader que escribiera esa carpeta en "+ Nuevo centro" se colaba como
// copropietario silencioso (mp_project_owners permite varios dueños por
// carpeta), sin pasar por Accesos ni que nadie lo aprobara.
conBase(ctx, 'un leader NO puede crear un centro para un project_folder que ya tiene otro responsable', async () => {
  // Bruno queda asignado a un proyecto real que todavía no tiene Centro de
  // Costos — exactamente el hueco que existía.
  const acceso = await ctx.clientes.ceo.post('/api/costeo/accesos', {
    full_name: 'PM Con Proyecto Sin Centro', email: 'pm-huerfano@ejemplo.test',
    password: 'clave-larga-1234', project_folders: ['proyecto-de-bruno-sin-centro'],
  });
  assert.strictEqual(acceso.status, 201, JSON.stringify(acceso.json));

  // Ana (otra leader, sin ninguna relación con ese proyecto) intenta
  // "crearlo" ella misma, reclamando esa misma carpeta.
  const r = await ctx.clientes.ana.post('/api/costeo/centros', {
    project_folder: 'proyecto-de-bruno-sin-centro', project_name: 'Intento De Ana',
    start_date: '2026-01-01', planned_end_date: '2026-12-31',
  });
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /ya tiene un responsable asignado/);

  // No se creó ningún centro, y Ana no se coló como dueña de esa carpeta.
  const centro = await ctx.db.query(
    "SELECT 1 FROM mp_centro_costo WHERE project_folder = 'proyecto-de-bruno-sin-centro'"
  );
  assert.strictEqual(centro.length, 0);
  const duenos = await ctx.db.query(
    "SELECT pmo_email FROM mp_project_owners WHERE project_folder = 'proyecto-de-bruno-sin-centro' AND is_active = 1"
  );
  assert.deepStrictEqual(duenos.map((d) => d.pmo_email), ['pm-huerfano@ejemplo.test']);

  await ctx.resembrar();
});

// El chequeo no puede bloquear al PM correcto: es normal que admin lo haya
// asignado desde Accesos antes de que el centro exista todavía.
conBase(ctx, 'un leader SI puede crear el centro de SU PROPIO project_folder, ya asignado antes desde Accesos', async () => {
  const acceso = await ctx.clientes.ceo.post('/api/costeo/accesos', {
    full_name: 'PM Con Proyecto Propio Sin Centro', email: 'pm-propio@ejemplo.test',
    password: 'clave-larga-1234', project_folders: ['proyecto-propio-sin-centro'],
  });
  assert.strictEqual(acceso.status, 201, JSON.stringify(acceso.json));

  const sesion = ctx.anonimo();
  const login = await sesion.login('pm-propio@ejemplo.test', 'clave-larga-1234');
  assert.strictEqual(login.status, 200, JSON.stringify(login.json));

  const r = await sesion.post('/api/costeo/centros', {
    project_folder: 'proyecto-propio-sin-centro', project_name: 'Proyecto Propio',
    start_date: '2026-01-01', planned_end_date: '2026-12-31',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  await ctx.resembrar();
});

conBase(ctx, 'el DELETE de un centro AJENO por un leader no borra nada', async () => {
  // GAMMA no tiene PM asignado — Ana (liderAlfa) no lo puede tocar.
  // Comprobar el 403 no basta: hay que verificar el efecto en la base.
  const antes = await ctx.db.query('SELECT COUNT(*) n FROM mp_centro_costo');
  const r = await ctx.clientes.ana.delete(`/api/costeo/centros/${ctx.fixtures.CENTROS.gamma.id}`);
  assert.strictEqual(r.status, 403);
  const despues = await ctx.db.query('SELECT COUNT(*) n FROM mp_centro_costo');
  assert.strictEqual(Number(despues[0].n), Number(antes[0].n));
});

conBase(ctx, 'un leader (PM) SI puede eliminar de verdad SU PROPIO centro de costos, aunque tenga equipo/gastos/horas extra', async () => {
  // ALFA (de Ana) ya tiene equipo asociado en las fixtures — el borrado
  // real (31 ago 2026) no distingue si tiene datos o no, siempre borra.
  const r = await ctx.clientes.ana.delete(`/api/costeo/centros/${ctx.fixtures.CENTROS.alfa.id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.deleted, true);

  const centro = await ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE cost_center_id = ?', [ctx.fixtures.CENTROS.alfa.id]);
  assert.strictEqual(centro.length, 0);

  await ctx.resembrar();
});

conBase(ctx, 'un leader (PM) puede borrar de verdad un centro propio SIN equipo/gastos/horas extra', async () => {
  const creado = await ctx.clientes.ana.post('/api/costeo/centros', {
    project_name: 'Proyecto vacio de Ana', start_date: '2026-01-01', planned_end_date: '2026-12-31',
    plan_recursos: [{ role_catalog: 'qa', personas: 1, horas_totales: 5, costo_hora: 1000 }],
  });
  assert.strictEqual(creado.status, 201, JSON.stringify(creado.json));

  const r = await ctx.clientes.ana.delete(`/api/costeo/centros/${creado.json.cost_center_id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json, { deleted: true });

  const filas = await ctx.db.query('SELECT 1 FROM mp_centro_costo WHERE cost_center_id = ?', [creado.json.cost_center_id]);
  assert.strictEqual(filas.length, 0, 'el centro debio borrarse de verdad, no solo desactivarse');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// 3. Endpoints que un leader SI puede usar (en lo suyo)
// ---------------------------------------------------------------

conBase(ctx, 'un leader SI puede operar sobre su propio proyecto', async () => {
  // La otra cara de la matriz: si todo diera 403, el rol seria inutil.
  const gasto = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto propio de Ana',
    amount: 50000,
    expense_date: '2026-08-20',
    category: 'otro',
  });
  assert.strictEqual(gasto.status, 201, `crear gasto propio: ${JSON.stringify(gasto.json)}`);

  const editar = await ctx.clientes.ana.put(`/api/costeo/gastos/${gasto.json.expense_id}`, { amount: 60000 });
  assert.strictEqual(editar.status, 200);

  const borrar = await ctx.clientes.ana.delete(`/api/costeo/gastos/${gasto.json.expense_id}`);
  assert.strictEqual(borrar.status, 200);

  const editarCentro = await ctx.clientes.ana.put(`/api/costeo/centros/${ctx.fixtures.CENTROS.alfa.id}`, {
    client_name: 'Cliente puesto por Ana',
  });
  assert.strictEqual(editarCentro.status, 200, 'el PM puede editar su propio centro');
});

conBase(ctx, 'un leader SI puede leer el divisor de la formula (lo necesita para dar de alta a alguien)', async () => {
  // /config completo es de admin/ceo; este parametro suelto no, a proposito:
  // sin el, el formulario de Equipo del Proyecto no puede mostrarle al PM el
  // valor hora mientras escribe el salario, y tendria que adivinar 210.
  const r = await ctx.clientes.ana.get('/api/costeo/parametros-nomina');
  assert.strictEqual(r.status, 200, `un leader deberia poder leerlo, dio ${r.status}`);
  assert.strictEqual(r.json.horas_mes, 210);

  const config = await ctx.clientes.ana.get('/api/costeo/config');
  assert.strictEqual(config.status, 403, 'pero el resto de la configuracion sigue siendo de admin/ceo');
});

conBase(ctx, 'un leader puede decidir una hora extra suya (pero no aprobarla)', async () => {
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;

  const decision = await ctx.clientes.ana.post(`/api/costeo/overtime/${id}/decision`, {
    decision: 'si', motivo: 'interno', calidad: false,
  });
  assert.strictEqual(decision.status, 200, `decidir: ${JSON.stringify(decision.json)}`);

  const aprobar = await ctx.clientes.ana.post(`/api/costeo/overtime/${id}/approve`, { approved: true });
  assert.strictEqual(aprobar.status, 403, 'aprobar es exclusivo de admin/ceo');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// 4. La lista de arriba tiene que seguir cubriendo TODAS las rutas
// ---------------------------------------------------------------

conBase(ctx, 'no hay ningun endpoint de /api sin clasificar en esta matriz', async () => {
  // Se leen las rutas que la app registra de verdad y se comprueba que
  // cada una aparece en SIN_SESION. Si alguien agrega un endpoint nuevo,
  // esta prueba falla y obliga a decidir su politica de acceso.
  const routers = {
    auth: '../../src/routes/auth',
    filters: '../../src/routes/filters',
    indicator: '../../src/routes/indicators',
    resource: '../../src/routes/resource',
    employees: '../../src/routes/employees',
    validation: '../../src/routes/validation',
    costeo: '../../src/routes/costeo',
  };

  function listar(router) {
    const out = [];
    for (const capa of router.stack) {
      if (capa.route) {
        for (const metodo of Object.keys(capa.route.methods)) {
          out.push([metodo.toUpperCase(), capa.route.path]);
        }
      } else if (capa.handle && capa.handle.stack) {
        out.push(...listar(capa.handle));
      }
    }
    return out;
  }

  // Se normalizan los parametros (:id, :n(\d+), :rol...) para poder
  // comparar '/centros/:id' con lo que la matriz escribe como '/centros/1'.
  const normalizar = (ruta) => ruta
    .replace(/:[A-Za-z_]+\([^)]*\)/g, '*')
    .replace(/:[A-Za-z_]+/g, '*')
    .replace(/\/+$/, '');

  const cubiertos = new Set(SIN_SESION.map(([m, r]) => `${m} ${normalizar(r).replace(/\/(1|qa|weekly_legal_hours)(?=\/|$)/g, '/*')}`));

  const sinCubrir = [];
  for (const [base, mod] of Object.entries(routers)) {
    for (const [metodo, ruta] of listar(require(mod))) {
      const completa = `${metodo} ${normalizar(`/api/${base}${ruta}`)}`;
      // Dos excepciones legitimas, las dos en /api/auth (que se monta
      // antes de requireAuth): el login, y el logout, que es idempotente
      // a proposito. Cualquier otra ruta publica tiene que justificarse.
      if (completa === 'POST /api/auth/login') continue;
      if (completa === 'POST /api/auth/logout') continue;
      if (!cubiertos.has(completa)) sinCubrir.push(completa);
    }
  }

  assert.deepStrictEqual(
    sinCubrir, [],
    'endpoints sin clasificar en la matriz de autorizacion:\n  ' + sinCubrir.join('\n  ')
  );
});
