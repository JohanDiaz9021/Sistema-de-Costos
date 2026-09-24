'use strict';

/**
 * AISLAMIENTO ENTRE PROYECTOS — la propiedad de seguridad del sistema.
 *
 * Un PM (rol 'leader') solo puede ver y tocar los proyectos donde figura
 * como dueño activo en mp_project_owners. Si esto se rompe, un lider ve
 * el presupuesto, las tarifas por persona y la utilidad de proyectos de
 * otros equipos. No es un bug de UI: es una fuga de informacion
 * financiera y salarial.
 *
 * Escenario (test/helpers/fixtures.js):
 *   ALFA  -> Ana
 *   BETA  -> Bruno
 *   GAMMA -> nadie (solo ceo/admin)
 *
 * Regla de oro de este archivo: por cada endpoint que devuelve datos, se
 * comprueba ADEMAS que Ana SI ve lo suyo. Una prueba que solo verifica
 * "no ve lo ajeno" pasaria igual si el endpoint estuviera roto y no
 * devolviera nada.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');
const { assertTextoDePdf } = require('../helpers/pdf');

const ctx = prepararSuite();

// Recorre cualquier estructura y junta todo el texto, para poder buscar
// una fuga aunque venga anidada en un campo que la prueba no conoce.
function textoDe(valor) {
  return JSON.stringify(valor ?? '');
}

function assertSinRastroDe(payload, agujas, mensaje) {
  const texto = textoDe(payload);
  for (const aguja of agujas) {
    assert.ok(
      !texto.includes(aguja),
      `${mensaje}: se filtro "${aguja}" en la respuesta -> ${texto.slice(0, 400)}`
    );
  }
}

// Marcadores inequivocos del proyecto de Bruno.
const RASTROS_BETA = ['BETA', 'Proyecto Beta', 'CC-2026-002', 'Brenda Beta', 'Tercero de prueba BETA'];
const RASTROS_GAMMA = ['GAMMA', 'Proyecto Gamma', 'CC-2026-003'];

// ---------------------------------------------------------------
// Lectura: ningun endpoint puede devolver datos de otro proyecto
// ---------------------------------------------------------------

const ENDPOINTS_DE_LECTURA = [
  '/api/costeo/centros',
  '/api/costeo/equipo',
  '/api/costeo/gastos',
  '/api/costeo/overtime',
  '/api/costeo/indicadores',
  '/api/costeo/indicadores-17',
  '/api/costeo/alertas',
  '/api/costeo/historial',
  '/api/costeo/snapshots',
  '/api/costeo/comercial',
  '/api/costeo/tarifas-cargo',
];

for (const endpoint of ENDPOINTS_DE_LECTURA) {
  conBase(ctx, `GET ${endpoint}: Ana no ve nada de BETA ni de GAMMA`, async () => {
    const r = await ctx.clientes.ana.get(endpoint);
    assert.strictEqual(r.status, 200, `${endpoint} devolvio ${r.status}`);
    assertSinRastroDe(r.json, RASTROS_BETA, endpoint);
    assertSinRastroDe(r.json, RASTROS_GAMMA, endpoint);
  });

  conBase(ctx, `GET ${endpoint}: Bruno no ve nada de ALFA`, async () => {
    const r = await ctx.clientes.bruno.get(endpoint);
    assert.strictEqual(r.status, 200);
    assertSinRastroDe(r.json, ['ALFA', 'Proyecto Alfa', 'CC-2026-001', 'Alicia Alfa'], endpoint);
  });
}

conBase(ctx, 'control positivo: Ana SI ve lo suyo en cada endpoint', async () => {
  // Sin esto, todas las pruebas de arriba pasarian con endpoints rotos
  // que devuelven listas vacias.
  const esperado = {
    '/api/costeo/centros': (j) => j.centros.some((c) => c.project_folder === 'ALFA'),
    '/api/costeo/equipo': (j) => j.equipo.some((e) => e.canonical_name === 'Alicia Alfa'),
    '/api/costeo/gastos': (j) => j.gastos.some((g) => g.description.includes('ALFA')),
    '/api/costeo/overtime': (j) => j.overtime.length > 0,
    '/api/costeo/indicadores': (j) => j.centros.length === 1,
    '/api/costeo/indicadores-17': (j) => j.centros.length === 1,
    '/api/costeo/comercial': (j) => j.proyectos.length === 1,
  };
  for (const [endpoint, comprueba] of Object.entries(esperado)) {
    const r = await ctx.clientes.ana.get(endpoint);
    assert.strictEqual(r.status, 200, endpoint);
    assert.ok(comprueba(r.json), `${endpoint} no devolvio los datos propios de Ana: ${textoDe(r.json).slice(0, 300)}`);
  }
});

conBase(ctx, 'el CEO si ve los tres proyectos (el filtro solo aplica a leader)', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/centros');
  const folders = r.json.centros.map((c) => c.project_folder).sort();
  assert.deepStrictEqual(folders, ['ALFA', 'BETA', 'GAMMA']);
});

conBase(ctx, 'un leader SIN proyectos asignados no ve absolutamente nada', async () => {
  // Ejercita la rama 'AND 1=0' de projectScopeClause. Si esa rama
  // devolviera cadena vacia, este usuario veria TODA la empresa.
  const sonia = await ctx.como(ctx.fixtures.USUARIOS.liderSinProyecto);
  for (const endpoint of ENDPOINTS_DE_LECTURA) {
    const r = await sonia.get(endpoint);
    assert.strictEqual(r.status, 200, endpoint);
    assertSinRastroDe(r.json, ['ALFA', 'BETA', 'GAMMA'], `${endpoint} para un lider sin proyectos`);
  }
});

// ---------------------------------------------------------------
// Filtros: pedir explicitamente un id ajeno tampoco debe funcionar
// ---------------------------------------------------------------

conBase(ctx, 'filtrar por el cost_center_id de otro no devuelve sus datos', async () => {
  // El filtro ?cost_center_id= se aplica ADEMAS del scope, no en vez de.
  // Si el orden estuviera invertido, esto seria un IDOR de lectura.
  const idBeta = ctx.fixtures.CENTROS.beta.id;
  for (const endpoint of ['/api/costeo/equipo', '/api/costeo/gastos']) {
    const r = await ctx.clientes.ana.get(`${endpoint}?cost_center_id=${idBeta}`);
    assert.strictEqual(r.status, 200);
    const filas = r.json.equipo || r.json.gastos;
    assert.deepStrictEqual(filas, [], `${endpoint} filtrado al centro de Bruno deberia venir vacio`);
  }
});

conBase(ctx, 'el filtro ?leader= no permite espiar a otro lider', async () => {
  // resolveScope() intersecta con el scope actual. Si sustituyera en vez
  // de intersectar, Ana pasaria a ver los proyectos de Bruno.
  const emailBruno = ctx.fixtures.USUARIOS.liderBeta.email;
  const r = await ctx.clientes.ana.get(`/api/costeo/indicadores-17?leader=${encodeURIComponent(emailBruno)}`);
  assert.strictEqual(r.status, 200);
  assertSinRastroDe(r.json, RASTROS_BETA, 'filtro ?leader= ajeno');
});

// ---------------------------------------------------------------
// IDOR de escritura: PUT/DELETE sobre recursos de otro proyecto
// ---------------------------------------------------------------

conBase(ctx, 'IDOR: Ana no puede editar el centro de costos de Bruno', async () => {
  const r = await ctx.clientes.ana.put(`/api/costeo/centros/${ctx.fixtures.CENTROS.beta.id}`, {
    project_name: 'SECUESTRADO POR ANA',
    budget: 1,
  });
  assert.strictEqual(r.status, 403, `esperaba 403 y dio ${r.status}: ${textoDe(r.json)}`);

  // Y de verdad no cambio en la base.
  const [fila] = await ctx.db.query(
    'SELECT project_name, budget FROM mp_centro_costo WHERE cost_center_id = ?',
    [ctx.fixtures.CENTROS.beta.id]
  );
  assert.strictEqual(fila.project_name, ctx.fixtures.CENTROS.beta.nombre);
  assert.strictEqual(Number(fila.budget), ctx.fixtures.CENTROS.beta.presupuesto);
});

conBase(ctx, 'IDOR: Ana no puede editar ni borrar un gasto de Bruno', async () => {
  const idGastoBeta = ctx.fixtures.GASTOS.beta1.id;

  const put = await ctx.clientes.ana.put(`/api/costeo/gastos/${idGastoBeta}`, { amount: 1 });
  assert.strictEqual(put.status, 403, `PUT esperaba 403, dio ${put.status}`);

  const del = await ctx.clientes.ana.delete(`/api/costeo/gastos/${idGastoBeta}`);
  assert.strictEqual(del.status, 403, `DELETE esperaba 403, dio ${del.status}`);

  const filas = await ctx.db.query('SELECT amount FROM mp_costo_no_planeado WHERE expense_id = ?', [idGastoBeta]);
  assert.strictEqual(filas.length, 1, 'el gasto de Bruno sigue existiendo');
  assert.strictEqual(Number(filas[0].amount), ctx.fixtures.GASTOS.beta1.monto);
});

conBase(ctx, 'IDOR: Ana no puede crear un gasto en el centro de Bruno', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    description: 'Gasto colado por Ana',
    amount: 1000,
    expense_date: '2026-08-20',
    category: 'otro',
  });
  assert.strictEqual(r.status, 403, `esperaba 403, dio ${r.status}: ${textoDe(r.json)}`);

  const filas = await ctx.db.query(
    'SELECT 1 FROM mp_costo_no_planeado WHERE description = ?', ['Gasto colado por Ana']
  );
  assert.strictEqual(filas.length, 0);
});

conBase(ctx, 'IDOR: Ana no puede meter gente al equipo de Bruno', async () => {
  const r = await ctx.clientes.ana.post('/api/costeo/equipo', {
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    role_catalog: 'desarrollador',
    hourly_cost: 99999,
  });
  assert.strictEqual(r.status, 403, `esperaba 403, dio ${r.status}`);
});

conBase(ctx, 'IDOR: Ana no puede MOVER a alguien de su equipo al centro de Bruno', async () => {
  // Caso sutil: el recurso (team_member_id) SI es suyo, pero el destino
  // no. Hay que validar los dos extremos, no solo el de origen.
  const r = await ctx.clientes.ana.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.aliceEnAlfa.id}`, {
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
  });
  assert.strictEqual(r.status, 403, `esperaba 403, dio ${r.status}: ${textoDe(r.json)}`);

  const [fila] = await ctx.db.query(
    'SELECT cost_center_id FROM mp_equipo_proyecto WHERE team_member_id = ?',
    [ctx.fixtures.EQUIPO.aliceEnAlfa.id]
  );
  assert.strictEqual(fila.cost_center_id, ctx.fixtures.CENTROS.alfa.id, 'Alicia no se movio');
});

conBase(ctx, 'IDOR: Ana no puede decidir una hora extra de Bruno', async () => {
  const r = await ctx.clientes.ana.post(
    `/api/costeo/overtime/${ctx.fixtures.OVERTIME.betaAprobada.id}/decision`,
    { decision: 'no', note: 'intento de Ana' }
  );
  assert.strictEqual(r.status, 403, `esperaba 403, dio ${r.status}: ${textoDe(r.json)}`);
});

conBase(ctx, 'IDOR: Ana no puede leer un snapshot de un centro ajeno', async () => {
  // Se crea el snapshot como CEO y se intenta leer como Ana.
  const creado = await ctx.clientes.ceo.post('/api/costeo/snapshot', { centro: ctx.fixtures.CENTROS.beta.id });
  assert.strictEqual(creado.status, 201, textoDe(creado.json));
  const id = creado.json.snapshot_id;

  const r = await ctx.clientes.ana.get(`/api/costeo/snapshots/${id}`);
  assert.strictEqual(r.status, 404, `esperaba 404 y dio ${r.status}`);

  const borrar = await ctx.clientes.ana.delete(`/api/costeo/snapshots/${id}`);
  assert.ok([403, 404].includes(borrar.status), `esperaba 403/404 y dio ${borrar.status}`);

  const filas = await ctx.db.query('SELECT 1 FROM mp_costeo_snapshot WHERE snapshot_id = ?', [id]);
  assert.strictEqual(filas.length, 1, 'el snapshot ajeno sigue existiendo');
});

// ---------------------------------------------------------------
// Exports: el PDF y el Excel tampoco pueden llevar datos ajenos
// ---------------------------------------------------------------

conBase(ctx, 'export PDF de Ana no contiene datos de BETA', async () => {
  const r = await ctx.clientes.ana.get('/api/costeo/indicadores-17/export/pdf');
  assert.strictEqual(r.status, 200);

  // PDFKit COMPRIME los content streams: buscar en el binario crudo no
  // encuentra nada nunca y la prueba pasaria vacia. Hay que inflarlos.
  // `debeContener` es el control que evita ese falso verde.
  //
  // El control positivo es el PRESUPUESTO de Alfa (10.000.000), no el texto
  // "Alfa": este export es el del portafolio (sin ?centro=), y su encabezado
  // dice "Todos los proyectos (portafolio)" sin nombrar ningun proyecto. El
  // nombre solo aparecia de rebote, dentro del indicador "Dependencia de una
  // Sola Persona", que imprimia al talento con mas costo ("Alicia Alfa") —
  // al retirarse ese indicador (4 sep 2026) la prueba se quedo sin control y
  // fallo, que es exactamente lo que tenia que hacer.
  //
  // El presupuesto es mejor control que el nombre: ademas de probar que el
  // extractor lee, prueba el scope. El portafolio de Ana vale 10.000.000
  // (solo Alfa); si se colara Beta o Gamma la suma seria 35.000.000 y este
  // numero NO apareceria.
  assertTextoDePdf(r.buffer, {
    debeContener: ['10.000.000'],
    noDebeContener: ['Proyecto Beta', 'BETA', 'Gamma', 'Brenda'],
  }, assert);
});

conBase(ctx, 'el PDF del CEO si trae los tres proyectos (control del extractor)', async () => {
  // Confirma que el extractor SI ve los nombres cuando estan: es lo que
  // le da valor a la prueba de arriba.
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17/export/pdf');
  assert.strictEqual(r.status, 200);
  const texto = assertTextoDePdf(r.buffer, { debeContener: ['portafolio'] }, assert);
  assert.ok(texto.length > 200, `el texto extraido es sospechosamente corto: ${texto}`);
});

conBase(ctx, 'export XLSX de Ana no contiene datos de BETA', async () => {
  const r = await ctx.clientes.ana.get('/api/costeo/indicadores-17/export/xlsx');
  assert.strictEqual(r.status, 200);
  assert.ok(r.buffer && r.buffer.length > 500, 'el Excel vino vacio');
  // Firma ZIP: un .xlsx es un zip.
  assert.strictEqual(r.buffer.subarray(0, 2).toString(), 'PK', 'no es un xlsx');

  // El contenido va comprimido; se descomprime para poder inspeccionarlo
  // de verdad en vez de dar por bueno el binario.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  let texto = '';
  wb.eachSheet((hoja) => {
    hoja.eachRow((fila) => { texto += fila.values.map((v) => String(v ?? '')).join(' '); });
  });
  for (const aguja of ['Proyecto Beta', 'BETA']) {
    assert.ok(!texto.includes(aguja), `el Excel de Ana menciona "${aguja}"`);
  }
});

conBase(ctx, 'export con ?centro= de un centro ajeno da 404, no el archivo', async () => {
  for (const formato of ['pdf', 'xlsx']) {
    const r = await ctx.clientes.ana.get(
      `/api/costeo/indicadores-17/export/${formato}?centro=${ctx.fixtures.CENTROS.beta.id}`
    );
    assert.strictEqual(r.status, 404, `export ${formato} de un centro ajeno dio ${r.status}`);
  }
});

// ---------------------------------------------------------------
// El scope se recalcula por peticion, no se congela en la sesion
// ---------------------------------------------------------------

conBase(ctx, 'quitarle el proyecto a un PM le corta el acceso sin reiniciar sesion', async () => {
  const ana = await ctx.como(ctx.fixtures.USUARIOS.liderAlfa);
  assert.strictEqual((await ana.get('/api/costeo/centros')).json.centros.length, 1);

  await ctx.db.query(
    'UPDATE mp_project_owners SET is_active = 0 WHERE pmo_email = ?',
    [ctx.fixtures.USUARIOS.liderAlfa.email]
  );
  try {
    // attachScope corre en cada peticion: la MISMA cookie ya no ve nada.
    const r = await ana.get('/api/costeo/centros');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.centros, [], 'el scope quedo cacheado en la sesion');
  } finally {
    await ctx.resembrar();
  }
});
