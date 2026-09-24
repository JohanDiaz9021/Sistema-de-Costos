'use strict';

/**
 * /api/validation/* y GET /api/resource/:id — solo autorización estaba
 * cubierta (401/403). Aquí se cubre la lógica: filtros, el flujo
 * reconocer/revertir/deshacer de errores de validación, y el scope de
 * /resource.
 *
 * mp_validation_errors y mp_ingestion_runs las llena el WF1 de n8n en
 * producción; aquí se siembran a mano con INSERT directo porque no hay
 * ningún endpoint de escritura para ellas salvo ack/revert/unrevert.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

async function sembrarErroresDeValidacion() {
  await ctx.db.query('DELETE FROM mp_validation_errors');
  await ctx.db.query('DELETE FROM mp_validation_overrides');
  await ctx.db.query('DELETE FROM mp_ingestion_runs');

  await ctx.db.query(
    `INSERT INTO mp_validation_errors
       (error_id, snapshot_date, execution_id, employee_folder_name, employee_id,
        project_folder, file_name, error_type, severity, error_message, week_number, notified, created_at)
     VALUES
       (1, CURDATE(), 'exec-1', 'Alicia Alfa', ?, 'ALFA', 'alicia.xlsx', 'NAME_MISMATCH', 'warning', 'El nombre del archivo no coincide con el catalogo', 2, 0, NOW()),
       (2, CURDATE(), 'exec-1', 'Arturo Alfa', ?, 'ALFA', 'arturo.xlsx', 'EXECUTED_HOURS_IN_FUTURE', 'critical', 'Horas ejecutadas en una fecha futura', 3, 0, NOW()),
       (3, CURDATE(), 'exec-1', 'Brenda Beta', ?, 'BETA', 'brenda.xlsx', 'NAME_MISMATCH', 'info', 'El nombre del archivo no coincide con el catalogo', 2, 1, NOW() - INTERVAL 40 DAY)`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, ctx.fixtures.EMPLEADOS.arturoAlfa.id, ctx.fixtures.EMPLEADOS.brendaBeta.id]
  );

  await ctx.db.query(
    `INSERT INTO mp_ingestion_runs
       (run_id, workflow_name, run_date, started_at, completed_at, status, files_processed, files_rejected, rows_inserted, triggered_by)
     VALUES
       (1, 'WF1', CURDATE(), NOW(), NOW(), 'completed', 12, 1, 340, 'cron'),
       (2, 'WF1', CURDATE() - INTERVAL 20 DAY, NOW(), NOW(), 'completed', 10, 0, 300, 'cron')`
  );
}

// ---------------------------------------------------------------
// GET /errors — filtros
// ---------------------------------------------------------------

conBase(ctx, 'GET /errors sin filtros trae todo dentro de la ventana de dias', async () => {
  await sembrarErroresDeValidacion();
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=30');
  assert.strictEqual(r.status, 200);
  // El error_id=3 tiene created_at hace 40 dias: queda fuera de days=30.
  assert.strictEqual(r.json.rows.length, 2, JSON.stringify(r.json.rows.map((x) => x.error_id)));
  assert.ok(r.json.rows.every((x) => x.error_id !== 3));
});

conBase(ctx, 'GET /errors?days= amplio si incluye el error viejo', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60');
  assert.strictEqual(r.json.rows.length, 3);
});

conBase(ctx, 'GET /errors?ack=0 solo trae los NO reconocidos', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60&ack=0');
  assert.deepStrictEqual(r.json.rows.map((x) => x.error_id).sort(), [1, 2]);
  assert.ok(r.json.rows.every((x) => x.acknowledged === 0 || x.acknowledged === false));
});

conBase(ctx, 'GET /errors?ack=1 solo trae los reconocidos', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60&ack=1');
  assert.deepStrictEqual(r.json.rows.map((x) => x.error_id), [3]);
});

conBase(ctx, 'GET /errors?type= filtra por tipo exacto', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60&type=EXECUTED_HOURS_IN_FUTURE');
  assert.deepStrictEqual(r.json.rows.map((x) => x.error_id), [2]);
});

conBase(ctx, 'GET /errors?severity= filtra por severidad', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60&severity=critical');
  assert.deepStrictEqual(r.json.rows.map((x) => x.error_id), [2]);
});

conBase(ctx, 'GET /errors trae el nombre canonico del empleado via JOIN', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60');
  const fila = r.json.rows.find((x) => x.error_id === 1);
  assert.strictEqual(fila.employee_canonical, 'Alicia Alfa');
});

conBase(ctx, 'GET /errors: days fuera de rango se acota a [1, 365], no rompe', async () => {
  const r1 = await ctx.clientes.ceo.get('/api/validation/errors?days=99999');
  assert.strictEqual(r1.status, 200);
  const r2 = await ctx.clientes.ceo.get('/api/validation/errors?days=-5');
  assert.strictEqual(r2.status, 200);
  const r3 = await ctx.clientes.ceo.get('/api/validation/errors?days=abc');
  assert.strictEqual(r3.status, 200, 'un days no numerico deberia caer al default, no reventar');
});

conBase(ctx, 'GET /errors: limit se acota a [1, 500]', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60&limit=1');
  assert.strictEqual(r.json.rows.length, 1);
});

conBase(ctx, 'GET /errors: un leader no puede verlos (403), aunque tenga acceso a ALFA', async () => {
  const r = await ctx.clientes.ana.get('/api/validation/errors');
  assert.strictEqual(r.status, 403, 'validation es exclusivo del CEO, sin scope por proyecto');
});

// Regresion (9 sep 2026, a pedido explicito): antes /api/validation/* era de
// admin/ceo por igual — era la UNICA diferencia real entre esos dos roles en
// todo el sistema. El admin de Accesos gestiona PMs y proyectos, no la
// ingesta tecnica del RPA, asi que ahora es exclusivo del CEO.
conBase(ctx, 'GET /errors: un admin YA NO puede verlos (403) — es exclusivo del CEO', async () => {
  const r = await ctx.clientes.admin.get('/api/validation/errors');
  assert.strictEqual(r.status, 403);
});

conBase(ctx, 'un admin tampoco puede reconocer, revertir, deshacer, ni ver las corridas del RPA', async () => {
  const casos = [
    ['GET', '/api/validation/errors/summary'],
    ['POST', '/api/validation/errors/1/ack'],
    ['POST', '/api/validation/errors/1/revert'],
    ['POST', '/api/validation/errors/1/unrevert'],
    ['GET', '/api/validation/runs'],
  ];
  for (const [metodo, ruta] of casos) {
    const r = metodo === 'GET' ? await ctx.clientes.admin.get(ruta) : await ctx.clientes.admin.post(ruta, {});
    assert.strictEqual(r.status, 403, `${metodo} ${ruta} deberia dar 403 a un admin`);
  }
});

// ---------------------------------------------------------------
// GET /errors/summary
// ---------------------------------------------------------------

conBase(ctx, 'GET /errors/summary agrupa por tipo y por severidad, y cuenta los no reconocidos', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors/summary?days=60');
  assert.strictEqual(r.status, 200);

  const porTipo = new Map(r.json.by_type.map((x) => [x.error_type, Number(x.n)]));
  assert.strictEqual(porTipo.get('NAME_MISMATCH'), 2);
  assert.strictEqual(porTipo.get('EXECUTED_HOURS_IN_FUTURE'), 1);

  const porSeveridad = new Map(r.json.by_severity.map((x) => [x.severity, Number(x.n)]));
  assert.strictEqual(porSeveridad.get('critical'), 1);

  assert.strictEqual(Number(r.json.unacknowledged), 2, 'solo error_id 1 y 2 no estan reconocidos');
});

conBase(ctx, 'GET /errors/summary respeta la ventana de dias por defecto (7)', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors/summary');
  assert.strictEqual(r.json.days, 7);
  // El error_id=3 (hace 40 dias) queda fuera de la ventana default.
  const total = r.json.by_severity.reduce((s, x) => s + Number(x.n), 0);
  assert.ok(total <= 2, `con la ventana de 7 dias no deberia incluir el error de hace 40 dias: ${JSON.stringify(r.json)}`);
});

// ---------------------------------------------------------------
// POST /errors/:id/ack
// ---------------------------------------------------------------

conBase(ctx, 'ack: reconoce un error pendiente y no se puede reconocer dos veces', async () => {
  const r1 = await ctx.clientes.ceo.post('/api/validation/errors/1/ack', {});
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.json, { acknowledged: 1 });

  const [fila] = await ctx.db.query('SELECT notified FROM mp_validation_errors WHERE error_id = 1');
  assert.strictEqual(Number(fila.notified), 1);

  const r2 = await ctx.clientes.ceo.post('/api/validation/errors/1/ack', {});
  assert.strictEqual(r2.status, 404, 'reconocer un error ya reconocido deberia fallar, no ser idempotente en silencio');
});

conBase(ctx, 'ack: un id inexistente da 404', async () => {
  const r = await ctx.clientes.ceo.post('/api/validation/errors/999999/ack', {});
  assert.strictEqual(r.status, 404);
});

conBase(ctx, 'ack: un id no numerico da 400, no 500', async () => {
  const r = await ctx.clientes.ceo.post('/api/validation/errors/abc/ack', {});
  assert.strictEqual(r.status, 400);
});

// ---------------------------------------------------------------
// POST /errors/:id/revert y /unrevert
// ---------------------------------------------------------------

conBase(ctx, 'revert: marca falso positivo, registra quien y por que, y es idempotente', async () => {
  const r1 = await ctx.clientes.ceo.post('/api/validation/errors/2/revert', { reason: 'Duplicado del RPA' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.reverted, 1);
  assert.ok(r1.json.override_id);

  const [fila] = await ctx.db.query('SELECT reverted_by_email, reason, active FROM mp_validation_overrides WHERE error_id = 2');
  assert.strictEqual(fila.reverted_by_email, ctx.fixtures.USUARIOS.ceo.email);
  assert.strictEqual(fila.reason, 'Duplicado del RPA');
  assert.strictEqual(Number(fila.active), 1);

  // Llamarlo de nuevo NO crea un segundo override: devuelve el existente.
  const r2 = await ctx.clientes.ceo.post('/api/validation/errors/2/revert', { reason: 'otra razon' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.already_reverted, true);
  assert.strictEqual(r2.json.override_id, r1.json.override_id);

  const cuantos = await ctx.db.query('SELECT COUNT(*) n FROM mp_validation_overrides WHERE error_id = 2');
  assert.strictEqual(Number(cuantos[0].n), 1, 'no debio crear un segundo override');
});

conBase(ctx, 'revert: el registro original NO se borra de mp_validation_errors', async () => {
  const filas = await ctx.db.query('SELECT 1 FROM mp_validation_errors WHERE error_id = 2');
  assert.strictEqual(filas.length, 1, 'el error original debe seguir existiendo para el historial');
});

conBase(ctx, 'revert: un error inexistente da 404', async () => {
  const r = await ctx.clientes.ceo.post('/api/validation/errors/999999/revert', {});
  assert.strictEqual(r.status, 404);
});

conBase(ctx, 'GET /errors: un error revertido trae los datos del override', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/errors?days=60');
  const fila = r.json.rows.find((x) => x.error_id === 2);
  assert.ok(fila.override_id, 'deberia traer el override_id');
  assert.strictEqual(fila.reverted_by_email, ctx.fixtures.USUARIOS.ceo.email);
});

conBase(ctx, 'unrevert: deshace la reversion y queda disponible para revertir de nuevo', async () => {
  const r1 = await ctx.clientes.ceo.post('/api/validation/errors/2/unrevert', {});
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.json, { unreverted: 1 });

  const [fila] = await ctx.db.query(
    'SELECT active, undone_by_email FROM mp_validation_overrides WHERE error_id = 2 ORDER BY override_id DESC LIMIT 1'
  );
  assert.strictEqual(Number(fila.active), 0);
  assert.strictEqual(fila.undone_by_email, ctx.fixtures.USUARIOS.ceo.email);

  // Ya no aparece como revertido en la lista.
  const lista = await ctx.clientes.ceo.get('/api/validation/errors?days=60');
  const enLista = lista.json.rows.find((x) => x.error_id === 2);
  assert.strictEqual(enLista.override_id, null);
});

conBase(ctx, 'unrevert: sin override activo da 404, no crea nada', async () => {
  const r = await ctx.clientes.ceo.post('/api/validation/errors/2/unrevert', {});
  assert.strictEqual(r.status, 404, 'ya no hay override activo (se deshizo en la prueba anterior)');
});

conBase(ctx, 'flujo completo: revert -> unrevert -> revert deja SOLO un override activo', async () => {
  await ctx.clientes.ceo.post('/api/validation/errors/1/revert', { reason: 'primera vez' });
  await ctx.clientes.ceo.post('/api/validation/errors/1/unrevert', {});
  await ctx.clientes.ceo.post('/api/validation/errors/1/revert', { reason: 'segunda vez' });

  const activos = await ctx.db.query('SELECT COUNT(*) n FROM mp_validation_overrides WHERE error_id = 1 AND active = 1');
  assert.strictEqual(Number(activos[0].n), 1, 'debe haber exactamente un override activo');

  const total = await ctx.db.query('SELECT COUNT(*) n FROM mp_validation_overrides WHERE error_id = 1');
  assert.strictEqual(Number(total[0].n), 2, 'el historial completo debe conservar las dos filas (activa e inactiva)');
});

// ---------------------------------------------------------------
// GET /runs
// ---------------------------------------------------------------

conBase(ctx, 'GET /runs trae las corridas de ingestion dentro de la ventana', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/runs?days=10');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.rows.length, 1, 'solo la corrida de hoy cae en 10 dias');
  assert.strictEqual(r.json.rows[0].run_id, 1);
});

conBase(ctx, 'GET /runs con ventana amplia trae ambas corridas', async () => {
  const r = await ctx.clientes.ceo.get('/api/validation/runs?days=30');
  assert.strictEqual(r.json.rows.length, 2);
});

conBase(ctx, 'GET /runs: un leader no tiene acceso', async () => {
  assert.strictEqual((await ctx.clientes.ana.get('/api/validation/runs')).status, 403);
});

// ---------------------------------------------------------------
// GET /api/resource/:employeeId
// ---------------------------------------------------------------

conBase(ctx, 'GET /resource/:id exige el filtro month', async () => {
  const r = await ctx.clientes.ceo.get(`/api/resource/${ctx.fixtures.EMPLEADOS.aliceAlfa.id}`);
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /month/i);
});

conBase(ctx, 'GET /resource/:id trae las tareas del empleado en ese mes', async () => {
  const r = await ctx.clientes.ceo.get(`/api/resource/${ctx.fixtures.EMPLEADOS.aliceAlfa.id}?month=Agosto`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.employee.canonical_name, 'Alicia Alfa');
  assert.ok(r.json.tasks.length > 0, 'Alicia tiene horas cargadas en agosto en las fixtures');
});

conBase(ctx, 'GET /resource/:id de un empleado inexistente: employee viene null, tasks vacio', async () => {
  const r = await ctx.clientes.ceo.get('/api/resource/999999?month=Agosto');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.employee, null);
  assert.deepStrictEqual(r.json.tasks, []);
});

conBase(ctx, 'GET /resource/:id: Bruno (leader de BETA) NO ve las tareas de Alicia (ALFA)', async () => {
  const r = await ctx.clientes.bruno.get(`/api/resource/${ctx.fixtures.EMPLEADOS.aliceAlfa.id}?month=Agosto`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.tasks, [], 'el scope deberia dejar las tareas vacias para un lider ajeno');
});

conBase(ctx, 'GET /resource/:id: Ana (leader de ALFA) SI ve las tareas de Alicia', async () => {
  const r = await ctx.clientes.ana.get(`/api/resource/${ctx.fixtures.EMPLEADOS.aliceAlfa.id}?month=Agosto`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.tasks.length > 0);
});

conBase(ctx, 'GET /resource/:id: Bruno SI ve las tareas de su propia gente (Brenda)', async () => {
  const r = await ctx.clientes.bruno.get(`/api/resource/${ctx.fixtures.EMPLEADOS.brendaBeta.id}?month=Agosto`);
  assert.ok(r.json.tasks.length > 0, 'Bruno deberia ver las tareas de Brenda, que es de su proyecto');
});
