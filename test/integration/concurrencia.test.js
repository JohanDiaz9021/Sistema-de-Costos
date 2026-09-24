'use strict';

/**
 * Concurrencia REAL contra MariaDB: peticiones HTTP disparadas en
 * paralelo de verdad (Promise.all), no simuladas ni serializadas a mano.
 * Lo que se verifica es el estado FINAL en la base — que no haya
 * duplicados, dinero contado dos veces, o una fila a medio escribir —
 * no solo los códigos de estado de las respuestas.
 *
 * No se modifica ningún código de producción para esto: las carreras se
 * provocan con paralelismo genuino sobre las mismas filas, apoyándose en
 * las protecciones que ya existen (UNIQUE KEY, UPDATE con guarda en el
 * WHERE, transacciones). Es exactamente lo que un usuario real podría
 * disparar con doble clic, dos pestañas abiertas, o dos PMs editando a
 * la vez.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

/** Cuenta cuántas de las N respuestas tuvieron el status dado. */
function contarStatus(respuestas, status) {
  return respuestas.filter((r) => r.status === status).length;
}

// ---------------------------------------------------------------
// UPDATE con guarda atómica: aprobar la misma hora extra en paralelo
// ---------------------------------------------------------------

conBase(ctx, 'aprobar la misma hora extra 10 veces EN PARALELO: solo una gana, sin dinero duplicado', async () => {
  // Se prepara una fila "decidida" (pm_decision='si') recien nacida, para
  // que las 10 peticiones compitan por ser la primera en aprobarla.
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;
  await ctx.db.query(
    `UPDATE mp_overtime_decisions
        SET pm_decision='si', approval_status='pendiente', extra_cost_final=0, approved_by=NULL, approved_at=NULL
      WHERE decision_id = ?`,
    [id]
  );

  const N = 10;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ceo.post(`/api/costeo/overtime/${id}/approve`, { approved: true }))
  );

  // costo-overtime.js hace el UPDATE con la guarda `approval_status IN
  // ('pendiente','requiere_jair')` dentro del propio WHERE — es lo que
  // convierte "aprobar" en una operacion atomica a nivel de fila. Si esa
  // guarda viviera en JavaScript (SELECT -> if -> UPDATE) en vez de en el
  // SQL, las N peticiones leerian 'pendiente' A LA VEZ y las N pasarian
  // la validacion.
  assert.strictEqual(contarStatus(respuestas, 200), 1, `deberia ganar exactamente 1 de ${N}: ${JSON.stringify(respuestas.map((r) => r.status))}`);
  assert.strictEqual(contarStatus(respuestas, 409), N - 1, 'las demas deben perder con 409, no con un error generico');

  const [fila] = await ctx.db.query(
    'SELECT approval_status, extra_cost_final FROM mp_overtime_decisions WHERE decision_id = ?', [id]
  );
  assert.strictEqual(fila.approval_status, 'aprobado');
  assert.strictEqual(
    Number(fila.extra_cost_final), ctx.fixtures.OVERTIME.alfaSinDecidir.potencial,
    'el costo final debe quedar en el potencial UNA sola vez, no multiplicado por los intentos'
  );

  await ctx.resembrar();
});

conBase(ctx, 'decidir la misma hora extra en paralelo con decisiones CONTRARIAS: "si" se auto-aprueba y bloquea al resto', async () => {
  const id = ctx.fixtures.OVERTIME.alfaSinDecidir.id;

  const respuestas = await Promise.all([
    ctx.clientes.ana.post(`/api/costeo/overtime/${id}/decision`, { decision: 'si', motivo: 'interno', calidad: false }),
    ctx.clientes.ana.post(`/api/costeo/overtime/${id}/decision`, { decision: 'no', note: 'no autorizado por el cliente' }),
    ctx.clientes.ana.post(`/api/costeo/overtime/${id}/decision`, { decision: 'si', motivo: 'externo', calidad: true }),
  ]);

  // Con la auto-aprobación (26 ago 2026), "si" ya deja la fila en
  // 'aprobado' — un estado por fuera de la guarda
  // `approval_status NOT IN ('aprobado','rechazado')`. Apenas UNO de los
  // dos "si" gana la carrera, bloquea a las demás peticiones con 409 (antes
  // las tres siempre pasaban, porque "si" dejaba la fila en 'pendiente',
  // que no bloqueaba nada). "no" nunca bloquea (deja 'no_aplica'), así que
  // no puede ser el ganador final si hay al menos un "si" en la carrera —
  // por eso el resultado siempre termina en "si", nunca en "no".
  const exitosas = respuestas.filter((r) => r.status === 200);
  const bloqueadas = respuestas.filter((r) => r.status === 409);
  assert.strictEqual(exitosas.length + bloqueadas.length, 3, `alguna respuesta no fue 200 ni 409: ${JSON.stringify(respuestas.map((r) => r.status))}`);
  assert.ok(exitosas.length >= 1, 'al menos una decision debe ganar la carrera');

  const [fila] = await ctx.db.query(
    'SELECT pm_decision, pm_decision_note, motivo, calidad, approval_status FROM mp_overtime_decisions WHERE decision_id = ?', [id]
  );
  assert.strictEqual(fila.pm_decision, 'si');
  assert.strictEqual(fila.approval_status, 'aprobado');
  assert.ok(['interno', 'externo'].includes(fila.motivo), `motivo inconsistente: ${fila.motivo}`);
  assert.strictEqual(fila.pm_decision_note, null, 'un "si" final no deberia dejar la nota de la decision "no"');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// UNIQUE KEY real: alta manual de horas extra duplicada en paralelo
// ---------------------------------------------------------------

conBase(ctx, 'registrar la misma hora extra manual 8 veces EN PARALELO: solo una fila en la base', async () => {
  // 2026-08-29 (semana 5) -- Alicia/ALFA no tiene ninguna fila fija de
  // fixtures ahi (alfaAprobada usa semana 2, alfaSinDecidir semana 4).
  const payload = {
    employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id,
    cost_center_id: ctx.fixtures.CENTROS.alfa.id,
    inicio: '2026-08-29T18:00', fin: '2026-08-29T21:00',
  };

  const N = 8;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ana.post('/api/costeo/overtime', payload))
  );

  assert.strictEqual(contarStatus(respuestas, 201), 1, `solo una debe crear la fila: ${JSON.stringify(respuestas.map((r) => r.status))}`);
  assert.strictEqual(contarStatus(respuestas, 409), N - 1, 'las demas deben chocar con la unique key (mismo turno_key, sql/42)');

  const filas = await ctx.db.query(
    `SELECT decision_id FROM mp_overtime_decisions
      WHERE employee_id=? AND cost_center_id=? AND week_number=5 AND month_number=8 AND year_number=2026`,
    [payload.employee_id, payload.cost_center_id]
  );
  assert.strictEqual(filas.length, 1, 'la unique key debio impedir que se colara una segunda fila');

  await ctx.resembrar();
});

// Una persona puede hacer varias horas extra en la misma semana (sql/42):
// la unique key solo debe frenar el MISMO turno, no otro turno distinto.
conBase(ctx, 'dos turnos DISTINTOS de horas extra en la misma semana: se guardan los dos', async () => {
  const base = { employee_id: ctx.fixtures.EMPLEADOS.aliceAlfa.id, cost_center_id: ctx.fixtures.CENTROS.alfa.id };
  const r1 = await ctx.clientes.ana.post('/api/costeo/overtime', { ...base, inicio: '2026-08-29T18:00', fin: '2026-08-29T21:00' });
  const r2 = await ctx.clientes.ana.post('/api/costeo/overtime', { ...base, inicio: '2026-08-30T18:00', fin: '2026-08-30T20:00' });
  const r3 = await ctx.clientes.ana.post('/api/costeo/overtime', { ...base, inicio: '2026-08-29T22:00', fin: '2026-08-29T23:00' });
  assert.deepStrictEqual([r1.status, r2.status, r3.status], [201, 201, 201]);

  const filas = await ctx.db.query(
    `SELECT decision_id FROM mp_overtime_decisions
      WHERE employee_id=? AND cost_center_id=? AND week_number=5 AND month_number=8 AND year_number=2026`,
    [base.employee_id, base.cost_center_id]
  );
  assert.strictEqual(filas.length, 3, 'cada turno es su propia fila');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// UNIQUE KEY real: crear el mismo centro de costos en paralelo
// ---------------------------------------------------------------

conBase(ctx, 'crear el mismo centro de costos 6 veces EN PARALELO: la BASE queda consistente (un solo centro)', async () => {
  // La consistencia de los DATOS se sostiene: la UNIQUE KEY
  // uk_cc_project_folder (sql/06) garantiza que nunca queden dos centros
  // para el mismo project_folder, pase lo que pase con las respuestas HTTP.
  const payload = {
    project_folder: 'CONCURRENTE', project_name: 'Centro concurrente',
    budget: 1000, start_date: '2026-01-01', planned_end_date: '2026-12-31',
  };

  const N = 6;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ceo.post('/api/costeo/centros', payload))
  );

  assert.strictEqual(contarStatus(respuestas, 201), 1, `solo una debe crear el centro: ${JSON.stringify(respuestas.map((r) => r.status))}`);

  const filas = await ctx.db.query('SELECT cost_center_id, codigo FROM mp_centro_costo WHERE project_folder = ?', ['CONCURRENTE']);
  assert.strictEqual(filas.length, 1, 'no puede haber dos centros para el mismo project_folder');

  // Limpieza: primero el rastro de auditoria (FK), despues el centro.
  await ctx.db.query(
    'DELETE a FROM mp_costeo_audit_log a JOIN mp_centro_costo c ON c.cost_center_id=a.cost_center_id WHERE c.project_folder=?',
    ['CONCURRENTE']
  );
  await ctx.db.query('DELETE FROM mp_centro_costo WHERE project_folder = ?', ['CONCURRENTE']);
});

conBase(ctx, 'HALLAZGO QA-08: bajo carrera real, las peticiones que pierden reciben 500 en vez de 409', async () => {
  // BUG REAL, no corregido a proposito (la consigna era reportarlo).
  //
  // POST /api/costeo/centros valida el duplicado con un SELECT PREVIO
  // ("¿ya existe un centro para este project_folder?") y solo despues hace
  // el INSERT. Es un patron check-then-act: bajo concurrencia real, TODAS
  // las peticiones pueden pasar el SELECT a la vez (ninguna ha insertado
  // todavia), y la que pierde la carrera choca contra la UNIQUE KEY
  // (uk_cc_project_folder, sql/06) en el INSERT mismo.
  //
  // El problema es que el catch de esa ruta es generico:
  //   } catch (err) { next(err); }
  // sin distinguir err.code === 'ER_DUP_ENTRY' — a diferencia de POST
  // /equipo y POST /overtime, que SI lo hacen y devuelven un 409 con un
  // mensaje explicando el motivo real. Aqui el usuario que pierde la
  // carrera (un doble clic, dos admins creando el mismo proyecto a la
  // vez) recibe un 500 "Error interno" sin explicacion.
  //
  // Los DATOS quedan bien (la prueba de arriba lo confirma: nunca hay dos
  // centros duplicados) — este hallazgo es solo sobre la CALIDAD de la
  // respuesta HTTP en la carrera, no sobre integridad de datos.
  //
  // Arreglo sugerido: envolver el INSERT en un try/catch que revise
  // err.code === 'ER_DUP_ENTRY' y responda 409, igual que ya hacen
  // POST /equipo (routes/costeo/equipo.js) y POST /overtime
  // (routes/costeo/overtime.js).
  const payload = {
    project_folder: 'CONCURRENTE2', project_name: 'Centro concurrente 2',
    budget: 1000, start_date: '2026-01-01', planned_end_date: '2026-12-31',
  };
  const N = 6;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ceo.post('/api/costeo/centros', payload))
  );

  const perdedores = respuestas.filter((r) => r.status !== 201);
  assert.ok(perdedores.length > 0, 'la carrera no se disparo: revisar si el entorno de pruebas serializo las peticiones');

  // La carrera es no determinista: segun como se entrelacen las N
  // peticiones, algunas pierden en el SELECT previo (409 limpio) y otras
  // pierden en el INSERT mismo, chocando contra la UNIQUE KEY sin que el
  // codigo lo atrape (500). Lo que prueba el bug es que aparezca AL MENOS
  // un 500 entre las perdedoras — si algun dia todas dieran 409, es que
  // se agrego el catch de ER_DUP_ENTRY que hoy falta.
  assert.ok(
    perdedores.some((r) => r.status === 500),
    `cambio el comportamiento: revisar QA-08 en docs/testing.md -- ya no aparece ningun 500: ${JSON.stringify(respuestas.map((r) => r.status))}`
  );
  assert.ok(
    perdedores.every((r) => r.status === 409 || r.status === 500),
    `una perdedora dio un status inesperado: ${JSON.stringify(respuestas.map((r) => r.status))}`
  );

  await ctx.db.query(
    'DELETE a FROM mp_costeo_audit_log a JOIN mp_centro_costo c ON c.cost_center_id=a.cost_center_id WHERE c.project_folder=?',
    ['CONCURRENTE2']
  );
  await ctx.db.query('DELETE FROM mp_centro_costo WHERE project_folder = ?', ['CONCURRENTE2']);
});

// ---------------------------------------------------------------
// UNIQUE KEY real: meter al mismo talento dos veces al mismo centro
// ---------------------------------------------------------------

conBase(ctx, 'agregar al mismo talento al mismo centro 5 veces EN PARALELO: una sola fila de equipo', async () => {
  const payload = {
    cost_center_id: ctx.fixtures.CENTROS.beta.id,
    employee_id: ctx.fixtures.EMPLEADOS.brendaBeta.id,
    role_catalog: 'qa', hourly_cost: 15000,
  };
  // Brenda ya esta en el equipo de BETA (fixtures); se prueba con Alicia
  // (ALFA) contra el centro BETA para no chocar con la fixture existente.
  payload.employee_id = ctx.fixtures.EMPLEADOS.aliceAlfa.id;

  const N = 5;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ceo.post('/api/costeo/equipo', payload))
  );

  assert.strictEqual(contarStatus(respuestas, 201), 1, `solo una debe crear la fila: ${JSON.stringify(respuestas.map((r) => r.status))}`);
  assert.strictEqual(contarStatus(respuestas, 409), N - 1);

  const filas = await ctx.db.query(
    'SELECT COUNT(*) n FROM mp_equipo_proyecto WHERE cost_center_id=? AND employee_id=?',
    [payload.cost_center_id, payload.employee_id]
  );
  assert.strictEqual(Number(filas[0].n), 1);

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// withTransaction(): dos ediciones de PM en paralelo no dejan basura
// ---------------------------------------------------------------

conBase(ctx, 'dos ediciones de proyectos del mismo PM EN PARALELO no dejan asignaciones duplicadas', async () => {
  const id = ctx.fixtures.USUARIOS.liderBeta.id;

  // PUT /accesos/:id desactiva TODO lo anterior y reinserta lo nuevo
  // dentro de una transaccion. Dos ediciones simultaneas con conjuntos
  // DISTINTOS de proyectos no pueden dejar una mezcla de las dos, ni
  // duplicar filas activas para el mismo (project_folder, email).
  const [r1, r2] = await Promise.all([
    ctx.clientes.ceo.put(`/api/costeo/accesos/${id}`, { project_folders: ['BETA'] }),
    ctx.clientes.ceo.put(`/api/costeo/accesos/${id}`, { project_folders: ['BETA', 'ALFA'] }),
  ]);
  assert.ok(r1.status < 400 && r2.status < 400, `las dos ediciones deberian ser validas: ${r1.status} ${r2.status}`);

  const activos = await ctx.db.query(
    'SELECT project_folder, COUNT(*) n FROM mp_project_owners WHERE pmo_email=? AND is_active=1 GROUP BY project_folder',
    [ctx.fixtures.USUARIOS.liderBeta.email]
  );
  for (const fila of activos) {
    assert.strictEqual(Number(fila.n), 1, `${fila.project_folder} quedo duplicado para el mismo PM: ${JSON.stringify(activos)}`);
  }
  // El resultado final tiene que ser EXACTAMENTE uno de los dos payloads
  // enviados, nunca una mezcla rara de ambos (p. ej. ninguno, o los dos a
  // la vez mas alguno de mas).
  const foldersFinales = activos.map((f) => f.project_folder).sort();
  const esPayload1 = JSON.stringify(foldersFinales) === JSON.stringify(['BETA']);
  const esPayload2 = JSON.stringify(foldersFinales) === JSON.stringify(['ALFA', 'BETA']);
  assert.ok(esPayload1 || esPayload2, `estado final invalido, no coincide con ninguno de los dos payloads: ${JSON.stringify(foldersFinales)}`);

  await ctx.resembrar();
});

conBase(ctx, 'diez peticiones simultaneas NO dejan al pool de conexiones agotado ni al servidor caido', async () => {
  // No es una carrera de datos: es un smoke test de que el servidor
  // sostiene concurrencia real sin caerse. connectionLimit del pool es 10
  // (src/db.js); disparar bastante mas que eso a la vez es la forma mas
  // directa de detectar un deadlock o una fuga de conexiones.
  const N = 25;
  const respuestas = await Promise.all(
    Array.from({ length: N }, () => ctx.clientes.ceo.get('/api/costeo/indicadores-17'))
  );
  assert.ok(respuestas.every((r) => r.status === 200), `alguna peticion fallo bajo carga: ${JSON.stringify(respuestas.map((r) => r.status))}`);

  // Y el servidor sigue respondiendo despues.
  assert.strictEqual((await ctx.clientes.ceo.get('/healthz')).status, 200);
});
