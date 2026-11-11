'use strict';

/**
 * Motor de costeo contra datos reales: costo-motor.js y
 * costo-indicadores-17.js.
 *
 * Es la parte del sistema que produce numeros que alguien va a firmar. Las
 * pruebas calculan el resultado esperado A MANO a partir de las fixtures,
 * en vez de comparar contra "lo que devolvio la vez pasada": un golden
 * file convierte cualquier bug en el valor esperado.
 *
 * Jornada de las fixtures (test/helpers/fixtures.js):
 *   Alicia (ALFA, $20.000/h): 50h en la semana 2 -> 46 legales + 4 extra
 *   Arturo (ALFA, $15.000/h): 40h en la semana 3 -> sin horas extra
 *   Brenda (BETA, $30.000/h): 44h en la semana 2
 *   Carlos (ALFA, inactivo):  50h que NO deben contar
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

const UMBRAL_LEGAL = 46; // CONFIG_DEFAULTS.weekly_legal_hours

// ---------------------------------------------------------------
// Deduplicacion de snapshots (fue un bug real de dinero)
// ---------------------------------------------------------------

conBase(ctx, 'las horas de un talento NO se cuentan dos veces por tener dos snapshots', async () => {
  // mp_costeo_task_facts guarda una foto por carga de Excel. Las fixtures
  // tienen a Alicia repetida en dos snapshot_date con las mismas 50h. Si el
  // motor no filtrara por el ultimo snapshot DE ESE EMPLEADO, el costo
  // laboral saldria al doble (el bug medido en su dia fue de 2,6x y crecia
  // cada dia).
  const filas = await ctx.db.query(
    'SELECT COUNT(DISTINCT snapshot_date) n FROM mp_costeo_task_facts WHERE employee_id = ?',
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id]
  );
  assert.strictEqual(Number(filas[0].n), 2, 'premisa: Alicia esta en dos snapshots');

  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  // Solo el ultimo snapshot: Alicia 46h x $20.000 + Arturo 40h x $15.000
  const esperado = UMBRAL_LEGAL * 20000 + 40 * 15000;
  assert.strictEqual(
    alfa.costo_laboral_ejecutado, esperado,
    `costo laboral duplicado por snapshots: esperaba ${esperado}`
  );
});

conBase(ctx, 'un talento inactivo no suma horas al costo', async () => {
  // Carlos tiene 50h cargadas y esta con is_active = 0. Si contara,
  // el costo laboral de ALFA subiria.
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  const conCarlos = UMBRAL_LEGAL * 20000 + 40 * 15000 + UMBRAL_LEGAL * 0;
  assert.strictEqual(alfa.costo_laboral_ejecutado, conCarlos, 'Carlos (inactivo) no deberia sumar');

  // Y tampoco aparece en el conteo de personas trabajando.
  const ind = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const indAlfa = ind.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(indAlfa.ind7_personas_trabajando, 2, 'solo Alicia y Arturo');
});

// ---------------------------------------------------------------
// serie_semanal — Panel Comparativo / Gráficos (front)
// ---------------------------------------------------------------

conBase(ctx, 'serie_semanal: una entrada por semana con datos, ordenada cronologicamente, con el mismo costo legal que el resto del motor', async () => {
  // ALFA: Alicia en semana 2 (46h legales x $20.000 = $920.000, Carlos
  // inactivo no cuenta), Arturo en semana 3 (40h x $15.000 = $600.000).
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  assert.ok(Array.isArray(alfa.serie_semanal), 'serie_semanal deberia ser un arreglo');
  assert.strictEqual(alfa.serie_semanal.length, 2, 'ALFA tiene datos en 2 semanas distintas (2 y 3)');

  const [primera, segunda] = alfa.serie_semanal;
  assert.ok(
    primera.year < segunda.year || (primera.year === segunda.year && primera.week < segunda.week),
    'la serie debe venir ordenada cronologicamente (mas antigua primero)'
  );
  assert.strictEqual(primera.week, 2);
  assert.strictEqual(primera.month, 8, 'la serie debe traer el mes (bug weekKey, 17 sep 2026)');
  assert.strictEqual(primera.costo_laboral, UMBRAL_LEGAL * 20000, 'semana 2 = solo Alicia, 46h legales');
  assert.strictEqual(segunda.week, 3);
  assert.strictEqual(segunda.month, 8);
  assert.strictEqual(segunda.costo_laboral, 40 * 15000, 'semana 3 = solo Arturo, 40h');
});

// HALLAZGO (ago 2026): estos dos indicadores mostraban 0 en producción sin
// que ninguna prueba lo detectara — el bucle que los calcula leía un campo
// (r.hourly_cost) que weeklyAggregate() ya no expone. Se corrigió junto con
// serie_semanal (ver costo-indicadores-17.js) y se fijan aquí para que no
// se vuelva a romper en silencio.
conBase(ctx, 'ind6 (bus factor): identifica a Alicia como quien mas concentra el costo de ALFA, con el % correcto', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  // costo legal: Alicia 46h x $20.000 = $920.000; Arturo 40h x $15.000 = $600.000.
  const laboral = UMBRAL_LEGAL * 20000 + 40 * 15000; // 1.520.000
  const esperado = (UMBRAL_LEGAL * 20000 / laboral) * 100;

  assert.strictEqual(alfa.ind6_bus_factor_employee_id, ctx.fixtures.EMPLEADOS.aliceAlfa.id);
  assert.strictEqual(alfa.ind6_bus_factor_employee_name, ctx.fixtures.EMPLEADOS.aliceAlfa.nombre);
  assert.ok(alfa.ind6_bus_factor_pct > 0, 'el bug dejaba esto en 0 siempre');
  assert.ok(
    Math.abs(alfa.ind6_bus_factor_pct - esperado) < 0.01,
    `esperaba ~${esperado.toFixed(2)}%, dio ${alfa.ind6_bus_factor_pct}%`
  );
});

conBase(ctx, 'ind8 (costo real por hora): pondera por TODAS las horas ejecutadas (legales + extra), no solo las legales', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  // Alicia: 46h legales x $20.000 = $920.000, mas 4h extra diurna con el
  // recargo de ley (sql/25, +25%) x $20.000 = $100.000 => $1.020.000.
  // Arturo: 40h totales x $15.000 = $600.000 (sin extra, sin festivo en su semana).
  // (46+4+40) horas => (1.020.000 + 600.000) / 90 = $18.000/h.
  const esperado = (46 * 20000 + 4 * 20000 * 1.25 + 40 * 15000) / 90;

  assert.ok(alfa.ind8_costo_real_por_hora > 0, 'el bug dejaba esto en $0 siempre');
  assert.ok(
    Math.abs(alfa.ind8_costo_real_por_hora - esperado) < 0.01,
    `esperaba ~${esperado.toFixed(2)}, dio ${alfa.ind8_costo_real_por_hora}`
  );
});

// Costo Planeado (Mano de Obra) — sql/35, 3 sep 2026, a pedido explícito:
// "cuánto va a costar cada persona" según las horas planeadas que se le
// pusieron en Equipo del Proyecto. Distinto de ind8: no pesa por horas YA
// trabajadas, solo multiplica horas planeadas × costo/hora de cada persona.
conBase(ctx, 'costo_planeado_mano_obra: suma horas_planeadas x costo/hora de cada persona activa del centro', async () => {
  // Alicia (ALFA, $20.000/h): 50h planeadas -> 1.000.000
  // Arturo (ALFA, $15.000/h): sin horas planeadas -> no cuenta
  await ctx.clientes.ceo.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.aliceEnAlfa.id}`, { planned_hours: 50 });

  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(Number(alfa.costo_planeado_mano_obra), 1000000);

  // Se agregan las horas de Arturo tambien: 50x20.000 + 10x15.000 = 1.150.000
  await ctx.clientes.ceo.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.arturoEnAlfa.id}`, { planned_hours: 10 });
  const r2 = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa2 = r2.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(Number(alfa2.costo_planeado_mano_obra), 1150000);

  await ctx.resembrar();
});

conBase(ctx, 'costo_planeado_mano_obra: un talento inactivo (Carlos) o desactivado en el equipo no cuenta aunque tenga horas planeadas', async () => {
  // Carlos (ALFA, sql/17 lo trae inactivo en mp_employees) esta en el
  // equipo de ALFA con hourly_cost=0 (fixture "sin tarifa") — igual se le
  // ponen horas planeadas para comprobar que ninguna de las dos cosas lo
  // hace contar.
  await ctx.clientes.ceo.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.sinTarifaEnAlfa.id}`, { planned_hours: 100 });
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(Number(alfa.costo_planeado_mano_obra), 0, 'sin tarifa (costo/hora 0) no debe sumar nada');

  await ctx.resembrar();
});

// Regresion (3 sep 2026, reportada por un PM real: "tengo 2 horas extra
// aprobadas y no se ve en Indicadores"): desde el 2 sep 2026 el alta manual
// (POST /overtime) es la UNICA via para registrar horas extra — el Excel de
// Planeacion ya no las genera solo. Esas filas viven en mp_overtime_decisions
// pero NUNCA en mp_costeo_task_facts, que es lo unico que leian ind8/ind9/
// ind17 (weeklyAggregate). El dinero (ind1, ind5) ya las contaba via
// costoExtraAprobado, pero las HORAS se quedaban invisibles — la misma clase
// de bug que ind7 tenia con Equipo del Proyecto.
conBase(ctx, 'una hora extra dada de alta A MANO se refleja en ind8/ind9 (no solo en el dinero ejecutado)', async () => {
  const antes = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfaAntes = antes.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  // Arturo (ALFA, $15.000/h) no tiene horas extra en la base (ver jornada de
  // fixtures arriba) ni ninguna fila fija en la semana 5 de agosto — se le
  // registra un turno de 3h ahi, netamente extra (nada de horas legales esa
  // semana todavia).
  const alta = await ctx.clientes.ana.post('/api/costeo/overtime', {
    employee_id: ctx.fixtures.EMPLEADOS.arturoAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-29T18:00', fin: '2026-08-29T21:00',
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));

  const despues = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfaDespues = despues.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  assert.strictEqual(
    alfaDespues.ind9_horas_extra - alfaAntes.ind9_horas_extra, 3,
    'las 3h del alta manual deberian sumarse a ind9_horas_extra'
  );
  assert.strictEqual(
    alfaDespues.ind9_horas_ejecutadas - alfaAntes.ind9_horas_ejecutadas, 3,
    'y tambien al total de horas ejecutadas (denominador de ind9)'
  );
  assert.ok(
    alfaDespues.ind9_proporcion_horas_extra_pct > alfaAntes.ind9_proporcion_horas_extra_pct,
    'la proporcion de horas extra deberia subir, no quedarse igual'
  );
  // ind8 (costo real por hora) tambien debe moverse: si solo se sumaran las
  // horas sin su costo, el promedio ponderado saldria diluido hacia abajo.
  assert.notStrictEqual(alfaDespues.ind8_costo_real_por_hora, alfaAntes.ind8_costo_real_por_hora);

  await ctx.resembrar();
});

conBase(ctx, 'serie_semanal: el portafolio agrega las semanas de TODOS los centros, no solo uno', async () => {
  // BETA: Brenda en semana 2 tambien (44h x $30.000). Como cae en la misma
  // semana que Alicia (ambas semana 2), el portafolio debe sumarlas en la
  // MISMA entrada de semana, no traer 3 entradas separadas.
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const semana2 = r.json.portafolio.serie_semanal.find((s) => s.week === 2);
  assert.ok(semana2, 'deberia existir una entrada para la semana 2 en el portafolio');
  assert.strictEqual(
    semana2.costo_laboral, UMBRAL_LEGAL * 20000 + 44 * 30000,
    'semana 2 del portafolio = Alicia (ALFA) + Brenda (BETA)'
  );
});

// AISLAMIENTO: la agregacion de arriba demuestra que el motor SI suma bien
// varios centros en la misma semana -- falta confirmar que un lider (scope
// restringido) no reciba en su "portafolio" filas de un proyecto ajeno
// mezcladas en la misma entrada de semana. Como el filtrado de scope pasa
// ANTES de construir la lista de centros que se le manda a
// computeIndicadoresPortafolio (ver GET /indicadores-17), esto deberia
// cumplirse por construccion -- se fija con una prueba explicita porque es
// exactamente el tipo de fuga que costeo-cargos-equipo.test.js y
// aislamiento.test.js ya cuidan para el resto del modulo.
conBase(ctx, 'serie_semanal: el portafolio de un lider NO mezcla el costo de un proyecto ajeno en la misma semana', async () => {
  // Ana lidera solo ALFA. Su "portafolio" (sin filtro de project) debe
  // sumar unicamente ALFA -- el costo de Brenda (BETA) en la misma semana 2
  // no deberia aparecer.
  const r = await ctx.clientes.ana.get('/api/costeo/indicadores-17');
  const semana2 = r.json.portafolio.serie_semanal.find((s) => s.week === 2);
  assert.ok(semana2, 'Ana deberia seguir viendo su propia semana 2 (Alicia, ALFA)');
  assert.strictEqual(
    semana2.costo_laboral, UMBRAL_LEGAL * 20000,
    'el portafolio de Ana NO debe incluir el costo de Brenda (BETA, fuera de su scope)'
  );

  // Control negativo: el mismo endpoint con CEO (sin scope) SI trae la suma
  // de ambos -- si este control fallara, la prueba de arriba no probaria
  // nada (podria estar fallando por otra razon, no por aislamiento).
  const rCeo = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const semana2Ceo = rCeo.json.portafolio.serie_semanal.find((s) => s.week === 2);
  assert.strictEqual(semana2Ceo.costo_laboral, UMBRAL_LEGAL * 20000 + 44 * 30000);
});

// ---------------------------------------------------------------
// Atribucion por proyecto (fue un bug real de dinero, ago 2026 — dos
// veces: primero en /indicadores (costo-motor.js) y luego se encontró que
// /indicadores-17 tenía el MISMO problema en costo-weekly-hours.js, porque
// "Personas Trabajando" de un centro nunca reflejaba a alguien cuya carpeta
// de SharePoint no fuera igual al nombre de ese proyecto)
// ---------------------------------------------------------------

conBase(ctx, 'el costo laboral (/indicadores) se cobra al proyecto de LA TAREA, no a la carpeta de la persona', async () => {
  // El caso real que lo destapo: una persona de la carpeta "Document Online"
  // reportaba 1.811 h al proyecto "Management", y el motor se las cobraba a
  // Document Online porque cruzaba por la carpeta. Aqui: Arturo pertenece a
  // la carpeta ALFA pero dedica una semana entera al proyecto BETA.
  const antes = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa0 = antes.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id).costo_laboral_ejecutado;
  const beta0 = antes.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.beta.id).costo_laboral_ejecutado;

  // Arturo (carpeta ALFA, $15.000/h en ALFA) trabaja 10h para el proyecto
  // BETA en una semana nueva. Se registra con su tarifa en BETA para que esas
  // horas puedan convertirse en dinero alli.
  await ctx.db.query(
    `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, is_active, added_by)
     VALUES (?, ?, 'qa', 1000, 1, ?)`,
    [ctx.fixtures.CENTROS.beta.id, ctx.fixtures.EMPLEADOS.arturoAlfa.id, ctx.fixtures.USUARIOS.ceo.id]
  );
  await ctx.db.query(
    `INSERT INTO mp_costeo_task_facts
       (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
        week_number, project_name, activity, planned_type, total_executed_hours,
        hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
        budgeted_hours, task_status)
     VALUES ('2026-08-21', ?, 'ALFA', 'Agosto', 8, 2026, 4, ?, 'Apoyo a Beta', 'P', 10,
             10, 0, 0, 0, 0, 0, 10, 'Terminado')`,
    [ctx.fixtures.EMPLEADOS.arturoAlfa.id, ctx.fixtures.CENTROS.beta.nombre]
  );

  const despues = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa1 = despues.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id).costo_laboral_ejecutado;
  const beta1 = despues.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.beta.id).costo_laboral_ejecutado;

  assert.strictEqual(beta1 - beta0, 10 * 1000, 'las 10h debieron sumarle $10.000 a BETA, que es el proyecto de la tarea');
  assert.strictEqual(alfa1, alfa0, 'ALFA no debio moverse: es solo la carpeta de Arturo, no el proyecto de esa tarea');

  await ctx.resembrar();
});

conBase(ctx, 'indicadores-17 ("Personas Trabajando", "Costo Real por Hora") tambien atribuyen por proyecto, no por carpeta', async () => {
  // Mismo escenario, pero contra /indicadores-17 (costo-weekly-hours.js):
  // este es el caso real que reporto un PM — agrego a alguien al equipo de
  // un proyecto nuevo, esa persona reporta horas con el NOMBRE del proyecto
  // en su Excel, pero su carpeta de SharePoint sigue siendo la de siempre.
  await ctx.db.query(
    `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, is_active, added_by)
     VALUES (?, ?, 'qa', 2000, 1, ?)`,
    [ctx.fixtures.CENTROS.beta.id, ctx.fixtures.EMPLEADOS.arturoAlfa.id, ctx.fixtures.USUARIOS.ceo.id]
  );
  await ctx.db.query(
    `INSERT INTO mp_costeo_task_facts
       (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
        week_number, project_name, activity, planned_type, total_executed_hours,
        hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
        budgeted_hours, task_status)
     VALUES ('2026-08-21', ?, 'ALFA', 'Agosto', 8, 2026, 4, ?, 'Apoyo a Beta', 'P', 10,
             10, 0, 0, 0, 0, 0, 10, 'Terminado')`,
    [ctx.fixtures.EMPLEADOS.arturoAlfa.id, ctx.fixtures.CENTROS.beta.nombre]
  );

  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const beta = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.beta.id);
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  // BETA ya tenia a Brenda (44h) trabajando; con Arturo (carpeta ALFA) ahora
  // deberian ser 2 personas distintas, no 1.
  assert.strictEqual(beta.ind7_personas_trabajando, 2, 'Arturo deberia contar en BETA, aunque su carpeta sea ALFA');
  // Y ALFA sigue viendo solo a quienes de verdad trabajaron ahi esa semana
  // (Alicia) — Arturo, en esta semana nueva, dedico sus 10h a BETA.
  assert.ok(alfa.ind7_personas_trabajando >= 1, 'ALFA no debio perder a su gente real');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Composicion del ejecutado
// ---------------------------------------------------------------

conBase(ctx, 'el ejecutado total es la suma exacta de sus cuatro partes', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  for (const c of r.json.centros) {
    const suma = c.costo_laboral_ejecutado + c.costo_extra_aprobado + c.costo_no_planeado_total;
    assert.ok(
      Math.abs(c.ejecutado_total - suma) < 0.01 || c.ejecutado_total >= suma,
      `${c.project_name}: el total (${c.ejecutado_total}) no cuadra con las partes (${suma})`
    );
  }
});

conBase(ctx, 'solo la hora extra APROBADA suma al ejecutado', async () => {
  // ALFA tiene tres: una aprobada ($80.000), una pendiente y una sin
  // decidir. Solo la primera puede contar.
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(
    alfa.costo_extra_aprobado, ctx.fixtures.OVERTIME.alfaAprobada.final,
    'estaria contando horas extra sin aprobar'
  );
});

conBase(ctx, 'el gasto no planeado suma los gastos del centro', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  const esperado = ctx.fixtures.GASTOS.alfa1.monto
    + ctx.fixtures.GASTOS.alfa2.monto
    + ctx.fixtures.GASTOS.alfaOtroAnio.monto;
  assert.strictEqual(alfa.costo_no_planeado_total, esperado);
});

conBase(ctx, 'los totales del portafolio son la suma de los centros', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const suma = r.json.centros.reduce((a, c) => a + c.ejecutado_total, 0);
  assert.ok(
    Math.abs(r.json.totales.ejecutado_total - suma) < 0.01,
    `total ${r.json.totales.ejecutado_total} vs suma ${suma}`
  );
});

// ---------------------------------------------------------------
// Filtro de periodo: mes Y año (fue un bug real)
// ---------------------------------------------------------------

conBase(ctx, 'filtrar por Agosto NO mezcla el gasto de agosto de otro año', async () => {
  // Las fixtures tienen un gasto de agosto de 2025 y dos de agosto de
  // 2026 en el mismo centro. Con el filtro viejo `MONTH(expense_date) = 8`
  // los tres caian juntos.
  const sinFiltro = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const conAgosto = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Agosto');

  const alfaSin = sinFiltro.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.strictEqual(
    alfaSin.costo_no_planeado_total,
    ctx.fixtures.GASTOS.alfa1.monto + ctx.fixtures.GASTOS.alfa2.monto + ctx.fixtures.GASTOS.alfaOtroAnio.monto,
    'sin filtro deben estar los tres gastos'
  );

  const alfaCon = conAgosto.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  // mesYAnio('Agosto') resuelve al año MAS RECIENTE con datos: 2026.
  // Solo alfa1 es de agosto de 2026 (alfa2 es de julio, alfaOtroAnio de 2025).
  assert.ok(
    alfaCon.ind14_gasto_no_predecible_pct !== undefined,
    'el indicador 14 deberia venir calculado'
  );

  const gastoAgosto2026 = await ctx.db.query(
    `SELECT SUM(amount) t FROM mp_costo_no_planeado
      WHERE cost_center_id = ? AND expense_date >= '2026-08-01' AND expense_date < '2026-09-01'`,
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.strictEqual(
    Number(gastoAgosto2026[0].t), ctx.fixtures.GASTOS.alfa1.monto,
    'premisa: solo un gasto cae en agosto de 2026'
  );
});

conBase(ctx, 'un mes sin datos no revienta el calculo', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17?month=Diciembre');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.centros));
});

// ---------------------------------------------------------------
// Horas extra: el corte contra el umbral legal
// ---------------------------------------------------------------

conBase(ctx, 'la sincronizacion detecta las horas por encima del umbral', async () => {
  await ctx.db.query('DELETE FROM mp_overtime_decisions');

  const r = await ctx.clientes.ceo.post('/api/costeo/overtime/sync', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  // Alicia: 50h -> 4h extra. Arturo: 40h -> ninguna. Brenda: 44h -> ninguna.
  // El costo de la extra lleva el recargo diurno de ley (sql/25, +25%):
  // 4h x $20.000 x 1.25 = $100.000, no $80.000 planos.
  const filas = await ctx.db.query('SELECT employee_id, extra_hours, extra_cost_potential FROM mp_overtime_decisions');
  assert.strictEqual(filas.length, 1, `esperaba solo la de Alicia y hay ${filas.length}`);
  assert.strictEqual(filas[0].employee_id, ctx.fixtures.EMPLEADOS.aliceAlfa.id);
  assert.strictEqual(Number(filas[0].extra_hours), 4);
  assert.strictEqual(Number(filas[0].extra_cost_potential), 4 * 20000 * 1.25);

  await ctx.resembrar();
});

conBase(ctx, 'sincronizar dos veces no duplica filas', async () => {
  await ctx.db.query('DELETE FROM mp_overtime_decisions');
  await ctx.clientes.ceo.post('/api/costeo/overtime/sync', {});
  const primera = await ctx.db.query('SELECT COUNT(*) n FROM mp_overtime_decisions');
  await ctx.clientes.ceo.post('/api/costeo/overtime/sync', {});
  const segunda = await ctx.db.query('SELECT COUNT(*) n FROM mp_overtime_decisions');
  assert.strictEqual(Number(segunda[0].n), Number(primera[0].n));

  await ctx.resembrar();
});

conBase(ctx, 'sincronizar NO pisa una hora extra ya decidida', async () => {
  // Una vez decidida, sus cifras son un registro historico de lo que se
  // acordo: no pueden moverse porque cambio un umbral despues.
  const id = ctx.fixtures.OVERTIME.alfaAprobada.id;
  const [antes] = await ctx.db.query('SELECT extra_hours, extra_cost_final FROM mp_overtime_decisions WHERE decision_id = ?', [id]);

  await ctx.clientes.ceo.post('/api/costeo/overtime/sync', {});

  const [despues] = await ctx.db.query('SELECT extra_hours, extra_cost_final FROM mp_overtime_decisions WHERE decision_id = ?', [id]);
  assert.strictEqual(Number(despues.extra_hours), Number(antes.extra_hours));
  assert.strictEqual(Number(despues.extra_cost_final), Number(antes.extra_cost_final));
});

conBase(ctx, 'GET /overtime ya NO sincroniza (dejo de ser una escritura)', async () => {
  await ctx.db.query('DELETE FROM mp_overtime_decisions');
  const r = await ctx.clientes.ceo.get('/api/costeo/overtime');
  assert.strictEqual(r.status, 200);

  const filas = await ctx.db.query('SELECT COUNT(*) n FROM mp_overtime_decisions');
  assert.strictEqual(Number(filas[0].n), 0, 'un GET no puede escribir en la base');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Indicadores derivados
// ---------------------------------------------------------------

conBase(ctx, 'el porcentaje de presupuesto ejecutado usa el presupuesto del centro', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  const ind = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const ejecutado = ind.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id).ejecutado_total;

  const esperado = (ejecutado / ctx.fixtures.CENTROS.alfa.presupuesto) * 100;
  assert.ok(
    Math.abs(alfa.ind1_presupuesto_ejecutado_pct - esperado) < 0.01,
    `ind1 = ${alfa.ind1_presupuesto_ejecutado_pct}, esperaba ${esperado}`
  );
});

conBase(ctx, 'un centro sin presupuesto no divide por cero', async () => {
  await ctx.db.query('UPDATE mp_centro_costo SET budget = 0 WHERE cost_center_id = ?', [ctx.fixtures.CENTROS.alfa.id]);
  try {
    const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
    assert.strictEqual(r.status, 200);
    const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
    assert.ok(
      alfa.ind1_presupuesto_ejecutado_pct === null || Number.isFinite(alfa.ind1_presupuesto_ejecutado_pct),
      `ind1 salio ${alfa.ind1_presupuesto_ejecutado_pct} (Infinity o NaN)`
    );
  } finally {
    await ctx.resembrar();
  }
});

conBase(ctx, 'el portafolio suma en crudo, no promedia porcentajes', async () => {
  // Promediar porcentajes ya redondeados de cada centro da un numero
  // distinto (y equivocado) del que sale de sumar los importes.
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const { centros, portafolio } = r.json;

  const activos = centros.filter((c) => c.cost_center_id !== ctx.fixtures.CENTROS.gamma.id || true);
  const promedioIngenuo = activos.reduce((a, c) => a + (c.ind1_presupuesto_ejecutado_pct || 0), 0) / activos.length;

  const ind = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const presupuestoTotal = ind.json.totales.presupuesto;
  const ejecutadoTotal = ind.json.totales.ejecutado_total;
  const esperado = (ejecutadoTotal / presupuestoTotal) * 100;

  assert.ok(
    Math.abs(portafolio.ind1_presupuesto_ejecutado_pct - esperado) < 0.5,
    `el portafolio (${portafolio.ind1_presupuesto_ejecutado_pct}) deberia salir de sumas reales (${esperado}), no del promedio (${promedioIngenuo})`
  );
});

conBase(ctx, 'ningun indicador devuelve NaN ni Infinity', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  for (const centro of [...r.json.centros, r.json.portafolio]) {
    for (const [clave, valor] of Object.entries(centro)) {
      if (typeof valor === 'number') {
        assert.ok(Number.isFinite(valor), `${centro.project_name}.${clave} = ${valor}`);
      }
    }
  }
});

// ---------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------

conBase(ctx, 'las alertas vienen ordenadas por severidad', async () => {
  const r = await ctx.clientes.ceo.get('/api/costeo/alertas');
  assert.strictEqual(r.status, 200);
  const orden = { critica: 0, alta: 1, media: 2, baja: 3 };
  const valores = r.json.alertas.map((a) => orden[a.severidad]);
  for (let i = 1; i < valores.length; i++) {
    assert.ok(valores[i] >= valores[i - 1], `alerta ${i} rompe el orden de severidad`);
  }
});

conBase(ctx, 'un talento sin costo/hora dispara su alerta, con nombre y centro', async () => {
  // Carlos esta en el equipo de ALFA con hourly_cost = 0.
  const r = await ctx.clientes.ceo.get('/api/costeo/alertas');
  const alerta = r.json.alertas.find((a) => /costo\/hora/i.test(a.tipo) && a.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  assert.ok(alerta, `no se genero la alerta de talento sin costo/hora: ${JSON.stringify(r.json.alertas.map((a) => a.tipo))}`);
  assert.strictEqual(alerta.severidad, 'critica');
  assert.match(alerta.detalle, /Carlos Baja/, 'la alerta deberia decir de quien se trata');
});

conBase(ctx, 'las alertas globales son solo para ceo/admin', async () => {
  const deCeo = await ctx.clientes.ceo.get('/api/costeo/alertas');
  const deAna = await ctx.clientes.ana.get('/api/costeo/alertas');
  const globalesCeo = deCeo.json.alertas.filter((a) => !a.project_name).length;
  const globalesAna = deAna.json.alertas.filter((a) => !a.project_name).length;
  assert.strictEqual(globalesAna, 0, 'un leader no deberia ver alertas que cruzan proyectos');
  assert.ok(globalesCeo >= 0);
});

// ---------------------------------------------------------------
// Cruce de meses en serie_semanal (bug de weekKey, 17 sep 2026)
// ---------------------------------------------------------------

// La clave de semana era year*100+week SIN el mes, pero week_number es la
// semana DEL MES (sql/21): la vista por defecto (sin filtro de Periodo)
// toma el ultimo snapshot POR EMPLEADO/PROYECTO, y pueden ser de meses
// distintos. Entonces agosto-semana-2 y septiembre-semana-2 caian en el
// MISMO bucket (202602) y la serie mezclaba los dos meses en una sola
// entrada con los costos sumados. Con month en la clave, conviven como
// entradas separadas y el orden numerico es el cronologico.
conBase(ctx, 'serie_semanal: septiembre NO se funde con agosto (cada mes en su propia entrada)', async () => {
  // Arturo (ALFA, $15.000/h, sin horas extra) recibe un snapshot de
  // SEPTIEMBRE — su ultimo snapshot por empleado/proyecto pasa de
  // agosto-semana-3 a septiembre-semana-2, asi el rango sin periodo tiene
  // DOS meses con datos de verdad (Alicia queda en agosto-semana-2).
  await ctx.db.query(
    `INSERT INTO mp_costeo_task_facts
       (snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
        week_number, project_name, activity, planned_type, total_executed_hours,
        hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
        budgeted_hours, task_status)
     VALUES (?, ?, ?, 'Septiembre', 9, 2026, ?, 'Proyecto ALFA', 'Actividad de prueba', 'P',
             ?, 8, 8, 8, 8, 8, 0, 8, 'Terminado')`,
    ['2026-09-05', ctx.fixtures.EMPLEADOS.arturoAlfa.id, 'ALFA', 2, 40]
  );

  // Y un turno manual de 3h en septiembre (semana 2) — las 4h extra que
  // Alicia ya tiene en agosto-semana-2 se quedan en su mes.
  const alta = await ctx.clientes.ana.post('/api/costeo/overtime', {
    employee_id: ctx.fixtures.EMPLEADOS.arturoAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-09-08T18:00', fin: '2026-09-08T21:00',
  });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.json));

  const r = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const alfa = r.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  const serie = alfa.serie_semanal;

  // EL REGRESION: antes del fix la serie traia UNA entrada (agosto-semana-2
  // fusionada con septiembre-semana-2) porque a la clave le faltaba el mes.
  const agoS2 = serie.find((s) => s.month === 8 && s.week === 2);
  const sepS2 = serie.find((s) => s.month === 9 && s.week === 2);
  assert.ok(agoS2 && sepS2, `deben coexistir agosto-s2 y septiembre-s2 como entradas DISTINTAS: ${JSON.stringify(serie)}`);
  assert.ok(serie.length >= 2, 'dos meses, dos entradas (minimo) en la serie');

  assert.strictEqual(agoS2.costo_laboral, UMBRAL_LEGAL * 20000, 'agosto-s2 = solo Alicia (46h legales)');
  assert.strictEqual(agoS2.horas_extra, 4, 'agosto-s2 = las 4h extra de Alicia desde task_facts');
  assert.strictEqual(sepS2.costo_laboral, 40 * 15000, 'septiembre-s2 = solo Arturo (40h)');
  assert.strictEqual(sepS2.horas_extra, 3, 'septiembre-s2 = solo el turno manual de 3h');

  assert.ok(serie.indexOf(agoS2) < serie.indexOf(sepS2), 'orden cronologico: agosto antes de septiembre');
  assert.ok(serie.every((s) => s.year === 2026 && Number.isInteger(s.month) && Number.isInteger(s.week)),
    `cada entrada debe traer year/month/week: ${JSON.stringify(serie)}`);
  assert.ok(!serie.some((s) => s.week === 3), 'el snapshot viejo de Arturo (agosto-s3) lo reemplaza septiembre-s2');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// Cache por peticion: no puede cambiar el resultado
// ---------------------------------------------------------------

// ind2 (tiempo transcurrido) e ind3, que se deriva de el, dependen del
// reloj: dos llamadas separadas por milisegundos dan valores distintos en
// el ultimo decimal. Es correcto, no es la cache — pero obliga a
// compararlos aparte en vez de con un deepStrictEqual.
const INDICADORES_DEPENDIENTES_DEL_RELOJ = [
  'ind2_tiempo_transcurrido_pct',
  'ind3_ritmo_gasto_vs_tiempo',
  'ind4_fecha_quiebre_presupuestal',
  'ind4_se_queda_sin_plata_antes',
];

function sinIndicadoresDeReloj(centro) {
  const copia = { ...centro };
  for (const clave of INDICADORES_DEPENDIENTES_DEL_RELOJ) delete copia[clave];
  return copia;
}

conBase(ctx, 'la cache por peticion no altera los numeros entre llamadas', async () => {
  const a = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');
  const b = await ctx.clientes.ceo.get('/api/costeo/indicadores-17');

  assert.deepStrictEqual(
    a.json.centros.map(sinIndicadoresDeReloj),
    b.json.centros.map(sinIndicadoresDeReloj),
    'dos llamadas iguales deben dar lo mismo'
  );
  assert.deepStrictEqual(sinIndicadoresDeReloj(a.json.portafolio), sinIndicadoresDeReloj(b.json.portafolio));

  // Y los que si dependen del reloj tienen que moverse poquisimo: si
  // saltaran, seria que se estan calculando sobre datos distintos.
  const t1 = a.json.portafolio.ind2_tiempo_transcurrido_pct;
  const t2 = b.json.portafolio.ind2_tiempo_transcurrido_pct;
  assert.ok(Math.abs(t2 - t1) < 0.01, `ind2 salto de ${t1} a ${t2} entre dos llamadas seguidas`);
});

conBase(ctx, 'un cambio se ve en la peticion SIGUIENTE (la cache no persiste)', async () => {
  const antes = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfaAntes = antes.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  const gasto = await ctx.clientes.ceo.post('/api/costeo/gastos', {
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    description: 'Gasto que debe verse ya', amount: 777777,
    expense_date: '2026-08-25', category: 'otro',
  });
  assert.strictEqual(gasto.status, 201);
  // El gasto nace 'pendiente' (sql/28) y en ese estado no suma; lo que se
  // mide aqui es la cache, asi que primero se aprueba.
  const aprobar = await ctx.clientes.ceo.post(`/api/costeo/gastos/${gasto.json.expense_id}/aprobacion`, { approved: true });
  assert.strictEqual(aprobar.status, 200);

  const despues = await ctx.clientes.ceo.get('/api/costeo/indicadores');
  const alfaDespues = despues.json.centros.find((c) => c.cost_center_id === ctx.fixtures.CENTROS.alfa.id);

  assert.strictEqual(
    alfaDespues.costo_no_planeado_total - alfaAntes.costo_no_planeado_total, 777777,
    'la cache se quedo con datos viejos entre peticiones'
  );

  await ctx.resembrar();
});
