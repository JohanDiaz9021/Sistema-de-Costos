'use strict';

/**
 * Los 18 indicadores de Planeación — GET /api/indicator/:n.
 *
 * Solo estaba cubierto el 401/403 (autorización). Aquí se cubre la
 * LÓGICA: cada fórmula se verifica contra un resultado calculado A MANO
 * sobre las fixtures de test/helpers/fixtures-planeacion.js, casi siempre
 * acotado con `?employee_id=` para poder verificar el número sin tener que
 * sumar filas de todos los indicadores a la vez.
 *
 * Reglas que se repiten y vale la pena tener presentes al leer los
 * cálculos de cada bloque:
 *   - notCancelledClause: excluye status='Cancelado' — la usan los
 *     indicadores #1,#5,#6,#7,#8,#9,#10,#11,#14,#16,#18. NO la usan
 *     #2,#3,#4,#12,#13,#15,#17.
 *   - notPermisoClause: excluye FILAS cuya activity matchee una palabra
 *     de permiso/festivo — la usa #1 como WHERE (excluye la fila entera).
 *     #8,#16,#18 la usan como CASE (la fila cuenta para el conteo de
 *     tareas, pero sus horas budgeted/executed no suman).
 *   - e.is_active = 1 en todos: Carlos (inactivo) nunca debe aparecer.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');
const plan = require('../helpers/fixtures-planeacion');

const ctx = prepararSuite();

conBase(ctx, '(setup) siembra las fixtures de Planeación encima de las de Costeo', async () => {
  await plan.sembrarPlaneacion();
});

const EMP = () => ctx.fixtures.EMPLEADOS;

// ---------------------------------------------------------------
// #1 — % Cumplimiento semanal
// ---------------------------------------------------------------

conBase(ctx, '#1: cumplimiento semanal de Arturo en la semana 2', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/1?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.status, 200);
  const semana2 = r.json.data.series.find((s) => s.week === 2);
  // fact2(b8,x4) + fact5(b2,x2) + fact14(b2,x2) = b12,x8
  assert.strictEqual(semana2.budgeted, 12);
  assert.strictEqual(semana2.executed, 8);
  assert.strictEqual(semana2.compliance_pct, 66.7);
  assert.strictEqual(r.json.data.target_pct, 100);
});

conBase(ctx, '#1: una tarea de "Permiso" no cuenta ni en budgeted ni en executed', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/1?employee_id=${EMP().aliceAlfa.id}`);
  const semana3 = r.json.data.series.find((s) => s.week === 3);
  // Semana 3 de Alicia: fact7(b4,x0) + fact11(b8,x8). fact9 (Cancelado) y
  // fact13 ("Permiso médico", b8) quedan fuera de la suma.
  assert.strictEqual(semana3.budgeted, 12, `budgeted incluyo el permiso o el cancelado: ${JSON.stringify(semana3)}`);
  assert.strictEqual(semana3.executed, 8);
});

conBase(ctx, '#1: drilldown trae el detalle fila por fila con compliance_pct calculado', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/1/drilldown?employee_id=${EMP().aliceAlfa.id}&week=2`);
  assert.strictEqual(r.status, 200);
  const fila = r.json.data.rows.find((x) => x.activity === 'Desarrollo de endpoint');
  // ROUND() sobre una division en MariaDB devuelve DECIMAL, y mysql2 lo
  // entrega como cadena por defecto (no como number) -- asi llega tal cual
  // hasta el JSON de la respuesta. Se compara con Number() a proposito.
  assert.strictEqual(Number(fila.compliance_pct), 100, 'fact1: budgeted=10, executed=10 -> 100%');
});

// ---------------------------------------------------------------
// #2 — % Entrega a tiempo
// ---------------------------------------------------------------

conBase(ctx, '#2: a Alicia le cuentan 2 de 3 entregas a tiempo', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/2?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.status, 200);
  // fact1 (a tiempo, exacta), fact3 (3 dias tarde), fact4 (a tiempo).
  // fact11/fact13 no tienen actual_delivery_date, no cuentan como "finished".
  assert.strictEqual(r.json.data.finished, 3);
  assert.strictEqual(r.json.data.on_time, 2);
  assert.strictEqual(r.json.data.pct, 67);
});

conBase(ctx, '#2: entregar ANTES de lo estimado cuenta como "a tiempo"', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/2?employee_id=${EMP().arturoAlfa.id}`);
  // fact5 (2 dias antes), fact6 (5 dias tarde), fact14 (exacto). fact2/8/10/12 sin fechas.
  assert.strictEqual(r.json.data.finished, 3);
  assert.strictEqual(r.json.data.on_time, 2, 'la entrega anticipada deberia contar como a tiempo');
  assert.strictEqual(r.json.data.pct, 67);
});

conBase(ctx, '#2: sin ninguna entrega terminada, pct es null (no 0 ni NaN)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/2?employee_id=${EMP().brendaBeta.id}&week=99`);
  assert.strictEqual(r.json.data.finished, 0);
  assert.strictEqual(r.json.data.pct, null);
});

// ---------------------------------------------------------------
// #3 — Actividades vencidas sin cerrar
// ---------------------------------------------------------------

conBase(ctx, '#3: cuenta la tarea Pendiente vencida, pero NO la Cancelada vencida', async () => {
  const rArturo = await ctx.clientes.ceo.get(`/api/indicator/3?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(rArturo.json.data.total, 1, 'fact8 (Pendiente, vencida) deberia contar');

  const rAlicia = await ctx.clientes.ceo.get(`/api/indicator/3?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(rAlicia.json.data.total, 0, 'fact9 esta Cancelada: no deberia contar como vencida');
});

conBase(ctx, '#3: drilldown trae los dias de atraso', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/3/drilldown?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.json.data.rows.length, 1);
  assert.ok(r.json.data.rows[0].days_overdue >= 1);
});

// ---------------------------------------------------------------
// #4 — Días de desfase promedio
// ---------------------------------------------------------------

conBase(ctx, '#4: promedio de desfase de Alicia (dos a tiempo, una tarde)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/4?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.json.data.finished, 3);
  assert.strictEqual(r.json.data.avg_days, 1, '(0 + 3 + 0) / 3');
  assert.strictEqual(r.json.data.on_time, 2);
  assert.strictEqual(r.json.data.late, 1);
});

conBase(ctx, '#4: el promedio de Arturo puede ser positivo aunque tenga una entrega anticipada', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/4?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.json.data.finished, 3);
  assert.strictEqual(r.json.data.avg_days, 1, '(-2 + 5 + 0) / 3');
  assert.strictEqual(r.json.data.on_time, 2, 'diff <= 0 cuenta como a tiempo (incluye la anticipada)');
  assert.strictEqual(r.json.data.late, 1);
});

// ---------------------------------------------------------------
// #5 — % Actividades terminadas
// ---------------------------------------------------------------

conBase(ctx, '#5: buckets de Alicia, incluyendo la de permiso (SI cuenta aqui, a diferencia de #1)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/5?employee_id=${EMP().aliceAlfa.id}`);
  // Terminado: fact1,3,4,11,13 = 5. Bloqueado: fact7 = 1. "En Progreso": la
  // tarea de #17 (fact102, misma Alicia, semana 4) tambien cae en este
  // snapshot y si cuenta aqui (#5 no filtra por semana). fact9 (Cancelado) excluida.
  assert.strictEqual(r.json.data.buckets.Terminado, 5);
  assert.strictEqual(r.json.data.buckets.Bloqueado, 1);
  assert.strictEqual(r.json.data.buckets['En Progreso'], 1);
  assert.strictEqual(r.json.data.total, 7);
  assert.strictEqual(r.json.data.completed_pct, 71);
});

conBase(ctx, 'QA-07 corregido: #5 drilldown SI filtra por ?status=', async () => {
  // Antes esto devolvia las 8 filas del recurso sin filtrar: la ruta hacia
  // parseFilters({...req.query, status}) y parseFilters descartaba `status`
  // en silencio. El usuario hacia clic en "ver solo las bloqueadas" y
  // recibia la lista completa, sin ningun aviso de que el filtro no aplico.
  const r = await ctx.clientes.ceo.get(`/api/indicator/5/drilldown?employee_id=${EMP().aliceAlfa.id}&status=Bloqueado`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.data.rows.length > 0, 'deberia traer al menos la tarea bloqueada de Alicia');
  assert.ok(
    r.json.data.rows.every((x) => x.task_status === 'Bloqueado'),
    'ninguna fila deberia tener un status distinto al pedido'
  );
  assert.strictEqual(r.json.filters.status, 'Bloqueado', 'el filtro debe viajar en la respuesta');
});

conBase(ctx, 'QA-07 corregido: #5 drilldown sin ?status= sigue trayendo todo', async () => {
  // El drilldown de #5, a diferencia de su propio aggregate(), NO excluye
  // Cancelado: son 7 filas "vivas" + fact9 (Cancelada) = 8.
  const r = await ctx.clientes.ceo.get(`/api/indicator/5/drilldown?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.json.data.rows.length, 8);
  assert.strictEqual(r.json.filters.status, null);
});

// ---------------------------------------------------------------
// #6 — % Actividades bloqueadas
// ---------------------------------------------------------------

conBase(ctx, '#6: 1 de 7 tareas de Alicia esta bloqueada', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/6?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.json.data.blocked, 1);
  assert.strictEqual(r.json.data.total, 7);
  assert.match(String(r.json.data.pct), /^14\.[23]$/);
});

// ---------------------------------------------------------------
// #7 — Horas ejecutadas vs presupuestadas
// ---------------------------------------------------------------

conBase(ctx, '#7: sin semana especifica, agrupa por semana', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/7?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.json.data.groupBy, 'week');
  const s2 = r.json.data.series.find((s) => s.label === 'Semana 2');
  const s3 = r.json.data.series.find((s) => s.label === 'Semana 3');
  assert.strictEqual(s2.budgeted, 12);
  assert.strictEqual(s2.executed, 8);
  assert.strictEqual(s3.budgeted, 15, 'fact6(6)+fact8(3)+fact10(2)+fact12(4)');
  assert.strictEqual(s3.executed, 17, 'fact6(8)+fact8(1)+fact10(3)+fact12(5)');
  assert.strictEqual(r.json.data.totals.budgeted, 27);
  assert.strictEqual(r.json.data.totals.executed, 25);
});

conBase(ctx, '#7: CON una semana especifica, agrupa por proyecto (project_folder, no project_name)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/7?employee_id=${EMP().arturoAlfa.id}&week=2`);
  assert.strictEqual(r.json.data.groupBy, 'project');
  // fact14 tiene project_name 'SUECO CRM' pero project_folder sigue siendo
  // 'ALFA' — #7 agrupa por folder, asi que debe quedar UNA sola serie.
  assert.strictEqual(r.json.data.series.length, 1);
  assert.strictEqual(r.json.data.series[0].label, 'ALFA');
  assert.strictEqual(r.json.data.series[0].budgeted, 12);
});

// ---------------------------------------------------------------
// #8 — Indicador general por recurso
// ---------------------------------------------------------------

conBase(ctx, '#8: fila de Alicia — el permiso no suma horas, el bloqueo la pone en rojo', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/8?employee_id=${EMP().aliceAlfa.id}`);
  const fila = r.json.data.rows.find((x) => x.employee_id === EMP().aliceAlfa.id);
  assert.ok(fila, 'no aparecio Alicia en el indicador 8');
  assert.strictEqual(fila.budgeted, 30, 'fact1+3+4+7+11 (13 excluida por ser permiso)');
  assert.strictEqual(fila.executed, 27);
  assert.strictEqual(fila.compliance_pct, 90);
  assert.strictEqual(fila.total_tasks, 7);
  assert.strictEqual(fila.blocked_tasks, 1);
  assert.strictEqual(fila.semaphore, 'red', 'blocked_tasks > 0 siempre pinta rojo, sin importar el cumplimiento');
});

conBase(ctx, '#8: Carlos (inactivo) nunca aparece', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/8');
  assert.ok(!r.json.data.rows.some((x) => x.employee_id === EMP().carlosBaja.id), 'Carlos aparecio pese a estar inactivo');
});

// ---------------------------------------------------------------
// #9 — Semáforo de gestión
// ---------------------------------------------------------------

conBase(ctx, '#9: el global se pinta rojo apenas hay una tarea bloqueada', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/9?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.json.data.global.blocked, 1);
  assert.strictEqual(r.json.data.global.semaphore, 'red');
});

conBase(ctx, '#9: byResource incluye a Alicia en rojo por su tarea bloqueada', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/9');
  const fila = r.json.data.byResource.find((x) => x.employee_id === EMP().aliceAlfa.id);
  assert.strictEqual(fila.semaphore, 'red');
  assert.strictEqual(fila.blocked, 1);
});

conBase(ctx, '#9: byTask cuenta la bloqueada en "red", separado de las de bajo cumplimiento', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/9?employee_id=${EMP().aliceAlfa.id}`);
  // red = bloqueadas + (no bloqueadas con ratio < 0.8). Bloqueada: fact7.
  // Por debajo de 80%: ninguna otra de Alicia (fact1=100%,fact3=120%,fact4=100%,fact11=100%,fact13 sin budgeted<>0... en realidad fact13 tiene budgeted=8,executed=0 -> ratio 0 -> tambien "red_low"!).
  assert.ok(r.json.data.byTask.red >= 2, `esperaba al menos la bloqueada + fact13 (ratio 0): ${JSON.stringify(r.json.data.byTask)}`);
});

// ---------------------------------------------------------------
// #10 — Recursos compartidos entre proyectos
// ---------------------------------------------------------------

conBase(ctx, '#10: Arturo aparece por tener tareas en dos project_name distintos', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/10');
  const fila = r.json.data.rows.find((x) => x.employee_id === EMP().arturoAlfa.id);
  assert.ok(fila, `Arturo deberia aparecer en #10: ${JSON.stringify(r.json.data.rows)}`);
  assert.strictEqual(fila.project_count, 2);
  assert.strictEqual(fila.projects_list, 'ALFA, SUECO CRM');
});

conBase(ctx, '#10: Alicia y Brenda NO aparecen (un solo proyecto cada una)', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/10');
  assert.ok(!r.json.data.rows.some((x) => x.employee_id === EMP().aliceAlfa.id));
  assert.ok(!r.json.data.rows.some((x) => x.employee_id === EMP().brendaBeta.id));
});

conBase(ctx, '#10: drilldown de Arturo desglosa las horas por cada proyecto, SIN filtrar por scope', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/10/drilldown?employee_id=${EMP().arturoAlfa.id}`);
  const nombres = r.json.data.rows.map((x) => x.project_name).sort();
  assert.deepStrictEqual(nombres, ['ALFA', 'SUECO CRM']);
});

// ---------------------------------------------------------------
// #11 — % Tareas no planeadas
// ---------------------------------------------------------------

conBase(ctx, '#11: 1 de 7 tareas de Arturo es no planeada', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/11?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.json.data.unplanned, 1);
  assert.strictEqual(r.json.data.planned, 6);
  assert.strictEqual(r.json.data.total, 7);
  assert.match(String(r.json.data.pct), /^14\.[23]$/);
});

conBase(ctx, '#11: drilldown de la no planeada trae el motivo (unplanned_task_1)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/11/drilldown?employee_id=${EMP().arturoAlfa.id}`);
  assert.strictEqual(r.json.data.rows.length, 1);
  assert.strictEqual(r.json.data.rows[0].unplanned_task_1, 'Caida del servicio de pagos');
});

// ---------------------------------------------------------------
// #12 — Tasa de reestimación
// ---------------------------------------------------------------

conBase(ctx, '#12: Alicia tiene 1 de 8 tareas reestimadas (incluye la Cancelada en el total, a diferencia de #1/#5)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/12?employee_id=${EMP().aliceAlfa.id}`);
  assert.strictEqual(r.json.data.total, 8, 'a diferencia de otros indicadores, #12 no excluye Cancelado');
  assert.strictEqual(r.json.data.reestimated, 1);
  assert.strictEqual(r.json.data.pct, 12.5);
});

conBase(ctx, '#12: el motivo de reestimacion aparece en top_reasons', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/12?employee_id=${EMP().aliceAlfa.id}`);
  const motivo = r.json.data.top_reasons.find((x) => x.motivo === 'Cliente cambio el alcance');
  assert.ok(motivo, JSON.stringify(r.json.data.top_reasons));
  assert.strictEqual(motivo.count, 1);
});

// ---------------------------------------------------------------
// #13 — % Imprevistos internos vs externos
// ---------------------------------------------------------------

conBase(ctx, '#13: un ajuste interno y uno externo dan 50/50', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/13');
  assert.strictEqual(r.json.data.interno, 1);
  assert.strictEqual(r.json.data.externo, 1);
  assert.strictEqual(r.json.data.total, 2);
  assert.strictEqual(r.json.data.interno_pct, 50);
  assert.strictEqual(r.json.data.externo_pct, 50);
});

conBase(ctx, 'QA-07 corregido: #13 drilldown SI filtra por ?tipo=', async () => {
  // Misma causa y misma correccion que el #5 de arriba: `tipo` ya no se
  // descarta camino a indicator-13.js. "Ver solo los imprevistos internos"
  // ya no devuelve tambien los externos.
  const r = await ctx.clientes.ceo.get('/api/indicator/13/drilldown?tipo=Interno');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.rows.length, 1, 'de las 2 filas de ajuste, solo la Interna');
  assert.ok(
    r.json.data.rows.every((x) => [x.adjustment_type_1, x.adjustment_type_2, x.adjustment_type_3].includes('Interno')),
    'la fila devuelta debe tener el tipo pedido en alguno de sus 3 ajustes'
  );
  assert.strictEqual(r.json.filters.tipo, 'Interno');
});

conBase(ctx, 'QA-07 corregido: #13 drilldown sin ?tipo= sigue trayendo los dos', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/13/drilldown');
  assert.strictEqual(r.json.data.rows.length, 2);
  assert.strictEqual(r.json.filters.tipo, null);
});

// ---------------------------------------------------------------
// #14 — Carga de trabajo por recurso
// ---------------------------------------------------------------

conBase(ctx, '#14: la matriz suma budgeted por semana y compara contra la capacidad real (44h)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/14?employee_id=${EMP().aliceAlfa.id}`);
  // Incluye tambien la semana 4 (fact102, la fixture del indicador #17,
  // que comparte snapshot y cae con Alicia): #14 no filtra por semana.
  assert.deepStrictEqual(r.json.data.weeks, [2, 3, 4]);

  const celdaS2 = r.json.data.matrix[0].find((c) => c.week === 2);
  const celdaS3 = r.json.data.matrix[0].find((c) => c.week === 3);
  // Semana 2: fact1(10)+fact3(5)+fact4(3) = 18. Semana 3: fact7(4)+fact11(8)+fact13(8, no excluida aqui) = 20.
  // (fact9, Cancelado, SI se excluye por notCancelledClause)
  assert.strictEqual(celdaS2.budgeted, 18);
  assert.strictEqual(celdaS3.budgeted, 20);
  assert.strictEqual(r.json.data.capacities[2], 44, 'lun-vie completas, sabado/domingo en 0');
  assert.strictEqual(celdaS2.overload, false);
});

// ---------------------------------------------------------------
// #15 — Velocidad de cierre
// ---------------------------------------------------------------

conBase(ctx, '#15: clasifica cada entrega de Arturo en su balde (anticipada / a tiempo / tarde)', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/15?employee_id=${EMP().arturoAlfa.id}`);
  const fila = r.json.data.rows[0];
  assert.strictEqual(fila.early, 1, 'fact5, 2 dias antes');
  assert.strictEqual(fila.on_time, 1, 'fact14, exacto');
  assert.strictEqual(fila.late_1_3, 0);
  assert.strictEqual(fila.late_4plus, 1, 'fact6, 5 dias tarde');
  assert.strictEqual(fila.avg_days, 1, '(-2 + 5 + 0) / 3');
  assert.strictEqual(fila.finished_count, 3);
});

conBase(ctx, '#15: Alicia cae en late_1_3, no en late_4plus', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/15?employee_id=${EMP().aliceAlfa.id}`);
  const fila = r.json.data.rows[0];
  assert.strictEqual(fila.late_1_3, 1, 'fact3, 3 dias tarde');
  assert.strictEqual(fila.late_4plus, 0);
});

// ---------------------------------------------------------------
// #16 — Actividad diaria por recurso (heatmap)
// ---------------------------------------------------------------

conBase(ctx, '#16: suma las horas por dia de la semana para Alicia', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/16?employee_id=${EMP().aliceAlfa.id}`);
  const fila = r.json.data.employees.find((e) => e.employee_id === EMP().aliceAlfa.id);
  const lunes = fila.days.find((d) => d.label === 'Lun');
  const martes = fila.days.find((d) => d.label === 'Mar');
  assert.strictEqual(lunes.hours, 8, 'fact1.hours_monday');
  assert.strictEqual(martes.hours, 2, 'fact1.hours_tuesday');
  assert.strictEqual(lunes.capacity_ref, 8);
  assert.strictEqual(lunes.intensity, 1);
});

conBase(ctx, '#16: task_count excluye la Cancelada pero cuenta la de permiso', async () => {
  const r = await ctx.clientes.ceo.get(`/api/indicator/16?employee_id=${EMP().aliceAlfa.id}`);
  const fila = r.json.data.employees.find((e) => e.employee_id === EMP().aliceAlfa.id);
  assert.strictEqual(fila.task_count, 7);
});

// ---------------------------------------------------------------
// #17 — Auditoría de cambios en fecha estimada
// ---------------------------------------------------------------

conBase(ctx, '#17: detecta la tarea cuya fecha estimada se movio entre dos snapshots', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/17?month=Agosto');
  assert.strictEqual(r.status, 200);

  const tarea = r.json.data.tasks.find((t) => t.activity === 'Entrega final del modulo');
  assert.ok(tarea, `no se detecto la tarea con fecha movida: ${JSON.stringify(r.json.data.tasks.map((t) => t.activity))}`);
  assert.strictEqual(tarea.employee_id, EMP().aliceAlfa.id);
  assert.strictEqual(tarea.changes_count, 2);
  // Las fechas son relativas a HOY (ver HISTORIA_FECHA_MOVIDA en
  // fixtures-planeacion.js) para que nunca queden "vencidas" frente al
  // indicador #3 a medida que pasa el calendario real -- por eso se
  // recalculan aqui en vez de comparar contra un string fijo.
  assert.strictEqual(tarea.first_estimated_date, plan.fechaFutura(plan.DIAS_FUTURA_1));
  assert.strictEqual(tarea.last_estimated_date, plan.fechaFutura(plan.DIAS_FUTURA_2));
  assert.strictEqual(tarea.days_moved, plan.DIAS_FUTURA_2 - plan.DIAS_FUTURA_1, 'se postergo 5 dias (positivo = hacia adelante)');
});

conBase(ctx, '#17: NINGUNA de las tareas de un solo snapshot aparece (no tienen changes_count > 1)', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/17?month=Agosto');
  // Todas las TAREAS del set principal comparten un unico snapshot: no
  // deberian generar falsos positivos en cambios de fecha.
  const otras = r.json.data.tasks.filter((t) => t.activity !== 'Entrega final del modulo');
  assert.deepStrictEqual(otras, []);
});

conBase(ctx, '#17: el resumen por empleado agrega tasks_modified y distingue postergar de adelantar', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/17?month=Agosto');
  const resumen = r.json.data.employees.find((e) => e.employee_id === EMP().aliceAlfa.id);
  assert.strictEqual(resumen.tasks_modified, 1);
  assert.strictEqual(resumen.pushed_forward, 1);
  assert.strictEqual(resumen.pulled_back, 0);
  assert.strictEqual(r.json.data.totals.total_tasks_modified, 1);
});

// ---------------------------------------------------------------
// #18 — Reconocimientos del mes
// ---------------------------------------------------------------

conBase(ctx, '#18: exige al menos 3 tareas para entrar al ranking — Brenda (1 tarea) queda fuera', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/18');
  assert.strictEqual(r.status, 200);
  const enPodium = r.json.data.podium.some((c) => c.employee_id === EMP().brendaBeta.id);
  const enMenciones = r.json.data.mentions.some((c) => c.employee_id === EMP().brendaBeta.id);
  assert.strictEqual(enPodium || enMenciones, false, 'Brenda tiene solo 1 tarea, no deberia calificar');
});

conBase(ctx, '#18: Alicia (6 tareas) y Arturo (7 tareas) SI son elegibles', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/18');
  assert.strictEqual(r.json.data.total_eligible, 2);
  assert.strictEqual(r.json.data.p75_tasks, 7, 'con [6,7] el percentil 75 (indice floor(2*0.75)=1) es 7');
});

conBase(ctx, '#18: el podium respeta el minimo de 3 tareas y trae badges bien formados', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/18');
  for (const c of [...r.json.data.podium, ...r.json.data.mentions]) {
    assert.ok(c.total_tasks >= 3, `${c.canonical_name} entro con menos de 3 tareas`);
    assert.ok(Array.isArray(c.badges));
    for (const b of c.badges) {
      assert.ok(['perfect_compliance', 'zero_blocked', 'stable_dates', 'always_on_time', 'high_volume'].includes(b.key));
    }
    assert.strictEqual(typeof c.score, 'number');
  }
});

// ---------------------------------------------------------------
// Alcance por rol: un PM (leader) no ve datos de otro proyecto
// ---------------------------------------------------------------

for (const n of [1, 5, 7, 8, 9, 11, 14, 16]) {
  conBase(ctx, `#${n}: Bruno (leader de BETA) no ve datos de Alicia/Arturo (ALFA)`, async () => {
    const r = await ctx.clientes.bruno.get(`/api/indicator/${n}`);
    assert.strictEqual(r.status, 200);
    const texto = JSON.stringify(r.json);
    assert.ok(!texto.includes('Alicia Alfa'), `#${n} filtro datos de Alicia a Bruno`);
    assert.ok(!texto.includes('Arturo Alfa'), `#${n} filtro datos de Arturo a Bruno`);
  });
}

conBase(ctx, 'un indicador que no existe (99) da 501, no 404 ni 500', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/99');
  assert.strictEqual(r.status, 501);
  assert.strictEqual(r.json.indicator, 99);
});

conBase(ctx, 'GET /api/indicator/export/pdf genera un PDF con los 18 indicadores', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/export/pdf');
  assert.strictEqual(r.status, 200);
  assert.ok(r.buffer && r.buffer.length > 500);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});

// El PDF "envio semanal" se puede pedir por proyecto (filtro global
// "Proyecto"), no solo general -- a pedido explicito del cliente (ago 2026).
// El nombre de archivo debe reflejar el proyecto: si no, descargar el PDF
// de dos proyectos distintos el mismo dia produce el mismo nombre y el
// segundo pisa al primero en la carpeta de Descargas sin que se note.
conBase(ctx, 'GET /api/indicator/export/pdf sin filtro: nombre de archivo generico, sin proyecto', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/export/pdf');
  assert.strictEqual(r.status, 200);
  const disposition = r.headers.get('content-disposition') || '';
  assert.match(disposition, /filename="planeacion-semanal-\d{4}-\d{2}-\d{2}\.pdf"/, disposition);
});

conBase(ctx, 'GET /api/indicator/export/pdf?project=ALFA: el nombre de archivo incluye el proyecto filtrado', async () => {
  const r = await ctx.clientes.ceo.get('/api/indicator/export/pdf?project=' + ctx.fixtures.PROYECTOS.alfa);
  assert.strictEqual(r.status, 200);
  const disposition = r.headers.get('content-disposition') || '';
  assert.match(disposition, /filename="planeacion-semanal-alfa-\d{4}-\d{2}-\d{2}\.pdf"/, disposition);
});

conBase(ctx, 'GET /api/indicator/export/pdf?project=ALFA: un leader de otro proyecto (Bruno/BETA) igual recibe su PDF, scopeado a lo suyo', async () => {
  // El filtro de proyecto se combina con el scope del usuario -- Bruno no
  // puede pedir el PDF de un proyecto ajeno y obtener datos reales de ahi
  // (los aggregate() de cada indicador ya scopean por req.scope).
  const r = await ctx.clientes.bruno.get('/api/indicator/export/pdf?project=' + ctx.fixtures.PROYECTOS.alfa);
  assert.strictEqual(r.status, 200, 'el endpoint no debe reventar, solo devolver datos vacios/scopeados');
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});
