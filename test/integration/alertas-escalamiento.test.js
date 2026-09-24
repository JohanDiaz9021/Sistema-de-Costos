'use strict';

/**
 * Seguimiento y escalamiento de alertas (sql/19 + costo-alertas-eventos.js,
 * ajustado 21 sep 2026): cada GET /alertas sincroniza lo detectado contra
 * mp_alerta_evento, y desde el día 0 (recién detectada) aparece en
 * `escalamientos`. El día 5 exacto trae es_ultimo_aviso (última oportunidad
 * del PM); recién el día 6 también le llega a admin/ceo.
 *
 * fixtures.EQUIPO.sinTarifaEnAlfa (Carlos, centro ALFA, tarifa 0) dispara
 * de forma confiable "Talento sin costo/hora registrado" — se usa como la
 * alerta de prueba en todo este archivo.
 */

const assert = require('node:assert');

const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

conBase(ctx, 'GET /alertas: la primera vez que se detecta una alerta, se abre un evento en mp_alerta_evento', async () => {
  const r = await ctx.clientes.ana.get('/api/costeo/alertas');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.alertas.some((a) => a.tipo === 'Talento sin costo/hora registrado'));

  const [evento] = await ctx.db.query(
    "SELECT * FROM mp_alerta_evento WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.ok(evento, 'deberia haber quedado un evento abierto');
  assert.strictEqual(evento.estado, 'abierta');
});

conBase(ctx, 'GET /alertas: recién detectada, ya aparece en escalamientos con 0 días y nivel "pm"', async () => {
  // 21 sep 2026: "Sin corregir" muestra la alerta desde que se detecta, no
  // desde el día 3 -- el umbral que de verdad importa es cuándo escala al
  // CEO (día 6), no cuándo el PM la ve.
  const r = await ctx.clientes.ana.get('/api/costeo/alertas');
  assert.strictEqual(r.status, 200);
  const esc = r.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.ok(esc, 'deberia aparecer desde el dia 0');
  assert.strictEqual(esc.dias_abierta, 0);
  assert.strictEqual(esc.nivel, 'pm');
});

conBase(ctx, 'GET /alertas: una alerta que lleva 3+ dias abierta aparece en escalamientos con nivel "pm"', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas'); // abre el evento

  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const r = await ctx.clientes.ana.get('/api/costeo/alertas');
  const esc = r.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.ok(esc, 'deberia aparecer escalada a los 3 dias');
  assert.strictEqual(esc.nivel, 'pm');
  assert.ok(esc.dias_abierta >= 3);
});

conBase(ctx, 'GET /alertas: al dia 5 exacto sigue en nivel "pm" pero trae es_ultimo_aviso, y el CEO todavia NO la ve', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const rAna = await ctx.clientes.ana.get('/api/costeo/alertas');
  const escAna = rAna.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.ok(escAna, 'deberia seguir apareciendo para el PM al dia 5');
  assert.strictEqual(escAna.nivel, 'pm', 'el dia 5 completo todavia es del PM, no del CEO');
  assert.strictEqual(escAna.es_ultimo_aviso, true, 'el dia 5 es la ultima oportunidad antes de escalar');

  // El endpoint le manda al CEO TODOS los escalamientos que puede ver (no
  // solo los de nivel 'ceo') — es el front (renderEscalamientos en
  // costeo-alertas.js) el que filtra a nivel 'ceo' para no mostrarle al
  // CEO cada recordatorio de PM uno por uno. Por eso aquí se verifica el
  // nivel del dato, no su ausencia.
  const rCeo = await ctx.clientes.ceo.get('/api/costeo/alertas');
  const escCeo = rCeo.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa' && e.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.ok(escCeo, 'el CEO deberia recibir el dato (aunque el front no lo resalte todavia)');
  assert.strictEqual(escCeo.nivel, 'pm', 'al dia 5 el nivel sigue siendo pm, incluso en la respuesta que recibe el CEO');
});

conBase(ctx, 'GET /alertas: a los 6+ dias el nivel sube a "ceo", ya no es_ultimo_aviso, y admin/ceo SI la ve', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const rAna = await ctx.clientes.ana.get('/api/costeo/alertas');
  const escAna = rAna.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.strictEqual(escAna.nivel, 'ceo');
  assert.strictEqual(escAna.es_ultimo_aviso, false, 'ya paso el dia 5: ya no es "ultimo aviso", ya escalo');

  const rCeo = await ctx.clientes.ceo.get('/api/costeo/alertas');
  const escCeo = rCeo.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa' && e.cost_center_id === ctx.fixtures.CENTROS.alfa.id);
  assert.ok(escCeo, 'el CEO deberia ver la escalada de 6+ dias de un proyecto ajeno');
  assert.strictEqual(escCeo.nivel, 'ceo');
});

conBase(ctx, 'GET /alertas: Bruno (lider de BETA) NO ve el escalamiento de ALFA', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const r = await ctx.clientes.bruno.get('/api/costeo/alertas');
  assert.strictEqual(r.json.escalamientos.filter((e) => e.cost_center_id === ctx.fixtures.CENTROS.alfa.id).length, 0);
});

conBase(ctx, 'GET /alertas: si Carlos ya tiene tarifa, la alerta deja de detectarse y el evento se marca resuelta', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas'); // abre el evento

  await ctx.clientes.ana.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.sinTarifaEnAlfa.id}`, { hourly_cost: 5000 });
  await ctx.clientes.ana.get('/api/costeo/alertas'); // sincroniza de nuevo, ya sin la causa

  const [evento] = await ctx.db.query(
    "SELECT estado FROM mp_alerta_evento WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.strictEqual(evento.estado, 'resuelta');

  await ctx.resembrar();
});

conBase(ctx, 'GET /alertas: si vuelve a fallar despues de resuelta, el contador de dias arranca de nuevo en 0', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.clientes.ana.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.sinTarifaEnAlfa.id}`, { hourly_cost: 5000 });
  await ctx.clientes.ana.get('/api/costeo/alertas'); // se resuelve

  await ctx.clientes.ana.put(`/api/costeo/equipo/${ctx.fixtures.EQUIPO.sinTarifaEnAlfa.id}`, { hourly_cost: 0 });
  await ctx.clientes.ana.get('/api/costeo/alertas'); // recae

  const [evento] = await ctx.db.query(
    "SELECT estado, primera_vez_at FROM mp_alerta_evento WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.strictEqual(evento.estado, 'abierta');
  const minutos = (Date.now() - new Date(evento.primera_vez_at).getTime()) / 60000;
  assert.ok(minutos < 2, 'primera_vez_at deberia ser de ahora, no la de la primera vez que se detecto');

  await ctx.resembrar();
});

conBase(ctx, 'GET /alertas: sincronizar los centros de un leader NO cierra alertas de centros ajenos que no vio', async () => {
  // Bruno (BETA) sincroniza SUS alertas; eso no puede tocar el evento de
  // ALFA que abrio Ana, aunque ese evento no aparezca en la respuesta de Bruno.
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.clientes.bruno.get('/api/costeo/alertas');

  const [evento] = await ctx.db.query(
    "SELECT estado FROM mp_alerta_evento WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.strictEqual(evento.estado, 'abierta', 'el evento de ALFA no debio cerrarse por una peticion que ni lo miro');

  await ctx.resembrar();
});

// ---------------------------------------------------------------
// "Corregido" — marcar a mano que ya se resolvio (16 sep 2026)
// ---------------------------------------------------------------

// Marcarla NO la cierra: la esconde hoy. Quien decide si de verdad se
// corrigio son los datos, manana.
conBase(ctx, 'POST /alertas/corregida: la oculta de escalamientos el resto del dia', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 4 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const antes = await ctx.clientes.ana.get('/api/costeo/alertas');
  const esc = antes.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.ok(esc, 'antes de marcarla tiene que estar');

  const r = await ctx.clientes.ana.post('/api/costeo/alertas/corregida', { clave_dedup: esc.clave_dedup });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));

  const despues = await ctx.clientes.ana.get('/api/costeo/alertas');
  assert.ok(
    !despues.json.escalamientos.some((e) => e.codigo === 'talento_sin_tarifa'),
    'marcada hoy, no debe seguir en "sin corregir"'
  );

  // Pero NO se cerro: el evento sigue abierto, porque el problema sigue ahi.
  const [ev] = await ctx.db.query(
    "SELECT estado, corregida_at FROM mp_alerta_evento WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  assert.strictEqual(ev.estado, 'abierta', 'marcarla no la cierra, solo la esconde');
  assert.ok(ev.corregida_at, 'queda constancia de cuando se marco');

  await ctx.resembrar();
});

// La regla que sostiene todo el escalamiento: si se marco en falso, la
// alerta vuelve con TODOS los dias que lleva. Si el contador se reiniciara,
// bastaria pulsar "Corregido" cada manana para que nunca llegara a los 6
// dias en que la ve el CEO.
conBase(ctx, 'POST /alertas/corregida: al dia siguiente vuelve, y SIN reiniciar el contador de dias', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  const antes = await ctx.clientes.ana.get('/api/costeo/alertas');
  const esc = antes.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  await ctx.clientes.ana.post('/api/costeo/alertas/corregida', { clave_dedup: esc.clave_dedup });

  // Pasa el dia: la marca queda en ayer.
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET corregida_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const hoy = await ctx.clientes.ana.get('/api/costeo/alertas');
  const vuelta = hoy.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');
  assert.ok(vuelta, 'el problema sigue, asi que la alerta tiene que volver');
  assert.ok(vuelta.dias_abierta >= 5, `deberia conservar los dias (5+), llego con ${vuelta.dias_abierta}`);
  assert.strictEqual(vuelta.nivel, 'pm');

  await ctx.resembrar();
});

conBase(ctx, 'POST /alertas/corregida: un lider no puede marcar una alerta de otro proyecto', async () => {
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 4 DAY) WHERE codigo = 'talento_sin_tarifa' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );
  const r0 = await ctx.clientes.ana.get('/api/costeo/alertas');
  const esc = r0.json.escalamientos.find((e) => e.codigo === 'talento_sin_tarifa');

  // Bruno lidera BETA, no ALFA.
  const r = await ctx.clientes.bruno.post('/api/costeo/alertas/corregida', { clave_dedup: esc.clave_dedup });
  assert.strictEqual(r.status, 403, JSON.stringify(r.json));

  await ctx.resembrar();
});

conBase(ctx, 'POST /alertas/corregida: una clave que no existe da 404, no 500', async () => {
  const r = await ctx.clientes.ceo.post('/api/costeo/alertas/corregida', { clave_dedup: 'no_existe:1:' });
  assert.strictEqual(r.status, 404, JSON.stringify(r.json));

  const vacio = await ctx.clientes.ceo.post('/api/costeo/alertas/corregida', {});
  assert.strictEqual(vacio.status, 400);
});

// ---------------------------------------------------------------
// Alertas que NUNCA se corrigen solas no deben escalar (17 sep 2026, a
// pedido explicito: "las que se puedan solucionar colocalas en Alertas sin
// corregir"). 'gasto_atipico' y 'trabajo_no_remunerado' se disparan por un
// registro YA decidido/aprobado que no vuelve a evaluarse distinto por su
// cuenta -- sin esta exclusion, escalarian al CEO para siempre sin que el
// PM pudiera hacer nada al respecto desde el flujo normal.
// ---------------------------------------------------------------

conBase(ctx, 'gasto_atipico: aunque lleve 6+ dias abierta, NUNCA aparece en escalamientos ni "sin corregir"', async () => {
  // alfa1 (500.000 de un presupuesto de 10.000.000 = 5% >= 3%) ya dispara
  // "Gasto atipico registrado" con solo sembrar los fixtures.
  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE codigo = 'gasto_atipico' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const r = await ctx.clientes.ceo.get('/api/costeo/alertas');
  assert.ok(r.json.alertas.some((a) => a.tipo === 'Gasto atípico registrado'), 'sigue viendose normal, por severidad');
  assert.strictEqual(r.json.escalamientos.filter((e) => e.codigo === 'gasto_atipico').length, 0, 'no debe entrar a escalamientos');

  const propia = r.json.alertas.find((a) => a.tipo === 'Gasto atípico registrado');
  assert.strictEqual(propia.dias_abierta, undefined, 'sin escalamiento, no debe traer dias_abierta ni nivel');
  assert.strictEqual(propia.nivel, undefined);

  await ctx.resembrar();
});

conBase(ctx, 'trabajo_no_remunerado: aunque lleve 6+ dias abierta, NUNCA aparece en escalamientos ni "sin corregir"', async () => {
  // pm_decision='no' es irreversible (decideOvertime): no hay forma de que
  // esta alerta se corrija sola por el flujo normal, asi que no debe poder
  // llegar al CEO por dias abierta.
  await ctx.db.query(
    `INSERT INTO mp_overtime_decisions
       (employee_id, cost_center_id, week_number, month_number, year_number,
        executed_hours, legal_hours, extra_hours, extra_cost_potential,
        pm_decision, approval_status, extra_cost_final, turno_key)
     VALUES (?, ?, 6, 8, 2026, 48, 40, 8, 120000, 'no', 'no_aplica', 0, 'prueba-no-remunerado')`,
    [ctx.fixtures.EMPLEADOS.aliceAlfa.id, ctx.fixtures.CENTROS.alfa.id]
  );

  await ctx.clientes.ana.get('/api/costeo/alertas');
  await ctx.db.query(
    "UPDATE mp_alerta_evento SET primera_vez_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE codigo = 'trabajo_no_remunerado' AND cost_center_id = ?",
    [ctx.fixtures.CENTROS.alfa.id]
  );

  const r = await ctx.clientes.ceo.get('/api/costeo/alertas');
  assert.ok(r.json.alertas.some((a) => a.tipo === 'Trabajo no remunerado'), 'sigue viendose normal, por severidad');
  assert.strictEqual(r.json.escalamientos.filter((e) => e.codigo === 'trabajo_no_remunerado').length, 0, 'no debe entrar a escalamientos');

  await ctx.resembrar();
});
