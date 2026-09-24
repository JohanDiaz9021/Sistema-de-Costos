'use strict';

/**
 * POST /centros/:id/cargar-excel-horas — carga manual del Excel semanal de
 * horas, la ÚNICA fuente de datos de Sistema de Costos (31 ago 2026, a
 * pedido explícito: Planeación y Costeo son totalmente independientes,
 * Costeo no tiene ningún RPA propio). Escribe en mp_costeo_task_facts, una
 * tabla propia — no en mp_task_facts, que es de Planeación.
 *
 * Reglas:
 *  1. Cada carga usa la fecha de HOY como snapshot_date (ya no hace falta
 *     "usar la fecha ya vigente en vez de hoy" — esa regla protegía la
 *     cadencia de un RPA compartido, que aquí no existe).
 *  2. Reemplaza (no acumula) las filas de esa persona en esa fecha.
 *  3. El "estado vigente" de una persona es SU PROPIO snapshot_date más
 *     reciente (ver baseWhere en costo-common.js), no un corte global — así
 *     que la carga de una persona un día no "envejece" a las demás.
 *
 * `crearCliente`/`clienteComo` (test/helpers/servidor.js) solo saben hablar
 * JSON — este endpoint necesita multipart/form-data, así que aquí se arma
 * el request a mano con fetch + FormData, reusando la cookie de sesión ya
 * autenticada.
 */

const assert = require('node:assert');
const { Blob } = require('node:buffer');
const ExcelJS = require('exceljs');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

const hoy = () => new Date().toISOString().slice(0, 10);

function hojaDePrueba(filasDeDatos) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Semanal');
  ws.addRow(['IDENTIFICACION', '', '', '', '', '', 'TIEMPOS Y EJECUCION', '', '', '', '', '', '', '', '', 'RESULTADO', '', '', '']);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'A Cargo De', 'Observaciones']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', '% cumplimiento', 'Elige responsable', 'Motivo']);
  for (const f of filasDeDatos) ws.addRow(f);
  return wb;
}

async function subirExcel(cliente, costCenterId, employeeId, wb) {
  const buffer = await wb.xlsx.writeBuffer();
  const form = new FormData();
  form.append('employee_id', String(employeeId));
  form.append('excel', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'prueba.xlsx');

  const res = await fetch(`${ctx.url}/api/costeo/centros/${costCenterId}/cargar-excel-horas`, {
    method: 'POST',
    headers: cliente.cookie ? { Cookie: cliente.cookie } : {},
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

conBase(ctx, 'POST /cargar-excel-horas: guarda las filas con la fecha de HOY como snapshot_date', async () => {
  const wb = hojaDePrueba([
    [1, 9, 'ALFA', 'Tarea de prueba', 'P', 5, new Date('2026-01-01'), new Date('2026-01-01'), 5, 0, 0, 0, 0, 0, 5, 'Terminado', '100%', 'Alicia', ''],
  ]);
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, wb);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas_insertadas, 1);
  assert.deepStrictEqual(r.json.proyectos, ['ALFA']);
  assert.strictEqual(String(r.json.snapshot_date).slice(0, 10), hoy(), 'sin RPA que proteger, cada carga usa la fecha de HOY');

  const filas = await ctx.db.query(
    'SELECT project_name, hours_monday, snapshot_date FROM mp_costeo_task_facts WHERE employee_id = ? AND snapshot_date = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, hoy()]
  );
  assert.ok(filas.some((f) => f.project_name === 'ALFA' && Number(f.hours_monday) === 5));

  await ctx.resembrar();
});

conBase(ctx, 'POST /cargar-excel-horas: subir de nuevo REEMPLAZA las filas de esa persona en esa fecha, no las acumula', async () => {
  await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, hojaDePrueba([
    [1, 9, 'ALFA', 'Primera version', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '', 'Alicia', ''],
  ]));
  const r2 = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, hojaDePrueba([
    [1, 9, 'ALFA', 'Version corregida', 'P', 8, null, null, 8, 0, 0, 0, 0, 0, 8, 'Terminado', '', 'Alicia', ''],
  ]));
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));

  const filas = await ctx.db.query(
    'SELECT activity, hours_monday FROM mp_costeo_task_facts WHERE employee_id = ? AND snapshot_date = ? AND project_name = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, hoy(), 'ALFA']
  );
  assert.strictEqual(filas.length, 1, 'la segunda carga debio reemplazar la primera, no acumularla');
  assert.strictEqual(filas[0].activity, 'Version corregida');
  assert.strictEqual(Number(filas[0].hours_monday), 8);

  await ctx.resembrar();
});

conBase(ctx, 'POST /cargar-excel-horas: no borra las filas de OTRA persona', async () => {
  const antesArturo = await ctx.db.query(
    'SELECT COUNT(*) n FROM mp_costeo_task_facts WHERE employee_id = ?',
    [ctx.fixtures.EMPLEADOS.arturoAlfa.id]
  );

  await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, hojaDePrueba([
    [1, 9, 'ALFA', 'Tarea de Alicia', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '', 'Alicia', ''],
  ]));

  const despuesArturo = await ctx.db.query(
    'SELECT COUNT(*) n FROM mp_costeo_task_facts WHERE employee_id = ?',
    [ctx.fixtures.EMPLEADOS.arturoAlfa.id]
  );
  assert.strictEqual(Number(despuesArturo[0].n), Number(antesArturo[0].n), 'las filas de Arturo no debieron tocarse');

  await ctx.resembrar();
});

conBase(ctx, 'POST /cargar-excel-horas: solo guarda las filas del proyecto del centro donde se abrio; las de otros proyectos se ignoran y se avisan', async () => {
  const wb = hojaDePrueba([
    [1, 9, 'ALFA', 'Tarea en Alfa', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '100%', 'Alicia', ''],
    [2, 9, 'BETA', 'Apoyo puntual a Beta', 'P', 3, null, null, 0, 3, 0, 0, 0, 0, 3, 'Terminado', '100%', 'Alicia', ''],
  ]);
  // Se abre desde la edicion de ALFA, pero el Excel de Alicia tambien trae
  // BETA. Regla vigente (10 sep 2026): la carga es DE UN CENTRO, asi que
  // solo entran las filas de ALFA y las de BETA se ignoran CON aviso.
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, wb);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas_insertadas, 1, 'solo la fila de ALFA');
  assert.deepStrictEqual(r.json.proyectos, ['ALFA']);
  assert.strictEqual(r.json.filas_ignoradas, 1, 'la de BETA no se guarda');
  assert.deepStrictEqual(r.json.proyectos_ignorados, ['BETA']);

  // Y en la base no quedo nada de BETA para esta persona en esta fecha.
  const filas = await ctx.db.query(
    'SELECT project_name FROM mp_costeo_task_facts WHERE employee_id = ? AND snapshot_date = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, hoy()]
  );
  assert.deepStrictEqual(filas.map((f) => f.project_name), ['ALFA']);

  await ctx.resembrar();
});

conBase(ctx, 'POST /cargar-excel-horas: Bruno (lider de BETA) no puede cargar horas en ALFA', async () => {
  const r = await subirExcel(ctx.clientes.bruno, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, hojaDePrueba([
    [1, 9, 'ALFA', 'Intento ajeno', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '', 'Alicia', ''],
  ]));
  assert.strictEqual(r.status, 403);
});

conBase(ctx, 'POST /cargar-excel-horas: un archivo sin la columna "Proyecto" da 400, no 500', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Vacia');
  ws.addRow(['A', 'B', 'C']);
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, wb);
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
});

conBase(ctx, 'POST /cargar-excel-horas: sin employee_id da 400', async () => {
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, '', hojaDePrueba([
    [1, 9, 'ALFA', 'A', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '', 'Alicia', ''],
  ]));
  assert.strictEqual(r.status, 400);
});

// La plantilla real de "Planeación Semanal" (31 ago 2026) trae columnas
// extra entre TT y "A Cargo De" (Desfase, Esfuerzo %) y varias filas de
// ACTIVIDAD por proyecto (no una sola fila por proyecto). Esta prueba sube
// ese layout exacto por HTTP, con dos proyectos reales de las fixtures
// (ALFA y BETA) para confirmar que las horas de varias actividades del
// mismo proyecto se suman, y que las de un proyecto NO se mezclan con las
// del otro — el caso concreto que motivó la pregunta del usuario.
function hojaPlantillaReal(filasDeDatos) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Planeación Semanal');
  ws.addRow(['IDENTIFICACION', '', '', '', '', 'TIEMPOS Y EJECUCION', '', '', '', '', '', '', '', '', 'RESULTADO', '', '', '', '', '']);
  ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P / NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Cumplimiento', 'Desfase', 'Esfuerzo %', 'A Cargo De']);
  ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada NP=No planeada', 'Horas planificadas', 'Fecha limite', 'fecha en que realmente se cerró la actividad.', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total ejecutado (auto)', 'Pendiente/En Proceso/Terminado/Bloqueado', 'Porcentaje de cumplimiento', 'Presup - TT (auto)', 'TT + Presup (auto)', 'Elige responsable']);
  for (const f of filasDeDatos) ws.addRow(f);
  return wb;
}

conBase(ctx, 'POST /cargar-excel-horas: la plantilla real (varias actividades por proyecto) suma las del proyecto del centro, y las ajenas no se guardan', async () => {
  const wb = hojaPlantillaReal([
    [1, 1, 'ALFA', 'Planeación semanal', 'P', 0.5, new Date('2026-08-31'), new Date('2026-08-31'), 0.5, 0, 0, 0, 0, 0, 0.5, 'Terminado', '100%', 0, '100%', 'Ana'],
    [2, 1, 'ALFA', 'Llenado de Redmine', 'P', 2.5, new Date('2026-09-04'), null, 1, 0, 0, 0, 0, 0, 1, 'Pendiente', '0%', 1.5, '40%', 'Ana'],
    [3, 1, 'BETA', 'Reunion con lider', 'P', 1.0, new Date('2026-09-04'), null, 0.75, 0, 0, 0, 0, 0, 0.75, 'Pendiente', '0%', 0.25, '75%', 'Bruno'],
  ]);
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, wb);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas_insertadas, 2, 'solo las 2 actividades de ALFA (el proyecto del centro)');
  assert.deepStrictEqual(r.json.proyectos, ['ALFA']);
  assert.strictEqual(r.json.filas_ignoradas, 1, 'la actividad de BETA se ignora y se avisa');
  assert.deepStrictEqual(r.json.proyectos_ignorados, ['BETA']);

  const porProyecto = await ctx.db.query(
    `SELECT project_name, SUM(hours_monday) AS total_lunes, COUNT(*) AS n
       FROM mp_costeo_task_facts WHERE employee_id = ? AND snapshot_date = ? GROUP BY project_name`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, hoy()]
  );
  const alfa = porProyecto.find((p) => p.project_name === 'ALFA');
  assert.strictEqual(alfa.n, 2, 'ALFA tenia 2 filas de actividad');
  assert.strictEqual(Number(alfa.total_lunes), 1.5, 'ALFA: 0.5 + 1 = 1.5 horas el lunes, sumando sus 2 actividades');
  assert.ok(!porProyecto.some((p) => p.project_name === 'BETA'), 'BETA no debio guardarse: el filtro por centro la descarto');

  await ctx.resembrar();
});

// Daño real causado en producción (31 ago 2026): el archivo trae una hoja
// por mes (Agosto, Septiembre...) más pestañas auxiliares (Datos, Control
// de Cambios). Cuando el cargador leía UNA sola hoja, como el guardado
// reemplaza todas las filas de esa persona en la fecha de corte, subir el
// Excel le borró a alguien sus 143.5h de agosto y lo dejó solo con las
// 4.7h de "Septiembre". Ahora se leen TODAS las hojas con datos.
conBase(ctx, 'POST /cargar-excel-horas: lee TODAS las hojas de meses — subir el Excel no borra un mes anterior', async () => {
  const wb = new ExcelJS.Workbook();
  const cabecera = (ws) => {
    ws.addRow(['# Consec.', 'Semana', 'Proyecto', 'Actividad', 'P/NP', 'Horas Presupuestadas', 'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', 'Estado', 'Observaciones']);
    ws.addRow(['Consecutivo', 'N° semana', 'Elige proyecto', 'Describe la tarea', 'P=Planeada', 'Horas planificadas', 'Fecha limite', 'Fecha real', 'Lunes', 'Martes', 'Miérc.', 'Jueves', 'Viernes', 'Sábado', 'Total (auto)', 'Estado', 'Motivo']);
  };
  const wsAgosto = wb.addWorksheet('Agosto');
  cabecera(wsAgosto);
  wsAgosto.addRow([1, 2, 'ALFA', 'Tarea de agosto', 'P', 4, new Date('2026-08-12'), null, 4, 0, 0, 0, 0, 0, 4, 'Terminado', '']);

  const wsSeptiembre = wb.addWorksheet('Septiembre');
  cabecera(wsSeptiembre);
  wsSeptiembre.addRow([1, 1, 'ALFA', 'Tarea de septiembre', 'P', 1, new Date('2026-09-04'), null, 1, 0, 0, 0, 0, 0, 1, 'Terminado', '']);
  wb.addWorksheet('Datos');
  wb.addWorksheet('Control de Cambios');

  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, wb);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.filas_insertadas, 2, 'las dos hojas de mes, no una sola');
  assert.deepStrictEqual(r.json.proyectos, ['ALFA']);

  const meses = await ctx.db.query(
    `SELECT month_number, COUNT(*) AS filas FROM mp_costeo_task_facts
      WHERE employee_id = ? AND snapshot_date = ? GROUP BY month_number ORDER BY month_number`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, hoy()]
  );
  assert.deepStrictEqual(
    meses.map((m) => Number(m.month_number)), [8, 9],
    'agosto NO puede haber desaparecido al subir un archivo que tambien trae septiembre'
  );

  await ctx.resembrar();
});

// Regresión del modelo viejo (compartido con Planeación, 31 ago 2026): dos
// personas subiendo su Excel en fechas DISTINTAS no debían "envejecerse"
// entre sí. Alicia sube hoy; Arturo ya tenía datos de un snapshot anterior
// (los que dejó sembrar() en 2026-08-21) — como nadie subió nada por él
// HOY, su snapshot de siempre sigue siendo "su vigente", no debe
// desaparecer solo porque OTRA persona subió un Excel más reciente.
conBase(ctx, 'POST /cargar-excel-horas: la carga de una persona no "envejece" el snapshot vigente de otra', async () => {
  const r = await subirExcel(ctx.clientes.ceo, ctx.fixtures.CENTROS.alfa.id, ctx.fixtures.EMPLEADOS.aliceAlfa.id, hojaDePrueba([
    [1, 9, 'ALFA', 'Tarea de Alicia de hoy', 'P', 5, null, null, 5, 0, 0, 0, 0, 0, 5, 'Terminado', '', 'Alicia', ''],
  ]));
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  // Mismo patrón correlacionado que el baseWhere real de costo-common.js:
  // el snapshot vigente de CADA fila es el más reciente DE ESE EMPLEADO,
  // no un corte global. Se prueba tal cual en vez de vía el motor de
  // dinero (costoLaboralEjecutado) para no depender de tarifas, festivos
  // ni otros centros — esto prueba directamente la propiedad que importa:
  // ninguno de los dos snapshots "apaga" al otro.
  const vigentes = await ctx.db.query(
    `SELECT employee_id, snapshot_date FROM mp_costeo_task_facts t
      WHERE employee_id IN (?, ?)
        AND snapshot_date = (
          SELECT MAX(t2.snapshot_date) FROM mp_costeo_task_facts t2
           WHERE t2.employee_id = t.employee_id
        )`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, ctx.fixtures.EMPLEADOS.arturoAlfa.id]
  );

  const deAlicia = vigentes.find((v) => v.employee_id === ctx.fixtures.EMPLEADOS.aliceAlfa.id);
  const deArturo = vigentes.find((v) => v.employee_id === ctx.fixtures.EMPLEADOS.arturoAlfa.id);
  assert.ok(deAlicia, 'Alicia debe tener un snapshot vigente (el que acaba de subir, hoy)');
  assert.strictEqual(String(deAlicia.snapshot_date).slice(0, 10), hoy());
  assert.ok(deArturo, 'Arturo debe seguir teniendo SU vigente, aunque Alicia haya subido algo mas reciente que el');
  assert.strictEqual(
    String(deArturo.snapshot_date).slice(0, 10), ctx.fixtures.SNAPSHOT_NUEVO,
    'el vigente de Arturo sigue siendo el suyo propio, no se vacio ni se le pego el de Alicia'
  );

  await ctx.resembrar();
});
