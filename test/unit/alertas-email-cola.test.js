'use strict';

/**
 * Cola de correos que manda n8n (src/services/alertas-email-cola.js).
 *
 * Misma tecnica que costo-alertas-db-mock.test.js: se parcha db.query ANTES
 * de requerir el modulo, para que su `const { query } = require('../db')`
 * capture la version parchada. Igual con prepararCorreo — aqui no se prueba
 * el contenido del correo (eso es de costo-alertas-email.test.js), se prueba
 * QUIEN recibe, CUANDO se encola y, sobre todo, que no se encole dos veces.
 *
 * Lo que NO se puede probar aqui: que dos procesos simultaneos no manden dos
 * correos. Eso lo garantiza la UNIQUE KEY (job, fecha) de
 * mp_alerta_email_envio, o sea la base. Lo que si se cubre es que el codigo
 * respete esa respuesta cuando la base dice "ya estaba tomado", y que libere
 * el turno cuando no logra encolar.
 */

const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/db');
const alertasEmail = require('../../src/services/alertas-email');

// --- dobles -------------------------------------------------------------

// Cada prueba llena esto antes de actuar. El orden importa: gana la primera
// regla cuyo texto aparezca en el SQL.
let reglas = [];
// Todo lo que el modulo le mando a la base, para poder revisar el SQL y los
// parametros exactos.
let consultas = [];

db.query = async (sql, params) => {
  consultas.push({ sql, params });
  for (const [match, resultado] of reglas) {
    if (sql.includes(match)) {
      return typeof resultado === 'function' ? resultado(sql, params) : resultado;
    }
  }
  return [];
};

let correoFalso = null;
alertasEmail.prepararCorreo = async (opts) => {
  if (typeof correoFalso === 'function') return correoFalso(opts);
  return correoFalso;
};

// Se requiere DESPUES de parchar, nunca antes.
const {
  tick, encolar, encolarPendientesDelDia, enviosDelDia, vencerViejos, RUN_AFTER_HOUR,
} = require('../../src/services/alertas-email-cola');

function reiniciar() {
  reglas = [];
  consultas = [];
  correoFalso = { correo: { asunto: 'Alertas', html: '<p>hola</p>', texto: 'hola' }, alertas: [], enElCorreo: 3 };
}

// Ver la nota gemela en alertas-email-scheduler.test.js: el `await fn()` no
// es decorativo. Sin el, el finally restaura el entorno en cuanto el
// callback llega a su primer await, no cuando termina.
async function conEntorno(vars, fn) {
  const guardado = { ...process.env };
  try {
    Object.assign(process.env, vars);
    return await fn();
  } finally {
    // Estas pruebas corren en serie; no hay carrera que valga.
    // eslint-disable-next-line require-atomic-updates
    process.env = guardado;
  }
}

const ENCENDIDA = { ALERTAS_COLA: '1', ALERTAS_EMAIL_TO: 'ceo@ejemplo.com' };

function errorDuplicado() {
  const err = new Error('Duplicate entry');
  err.code = 'ER_DUP_ENTRY';
  return err;
}

const DOS_PMS = [
  { email: 'ana@ejemplo.com', nombre: 'Ana', proyectos: 7 },
  { email: 'beto@ejemplo.com', nombre: 'Beto', proyectos: 1 },
];

function consultaCon(match) {
  return consultas.find((c) => c.sql.includes(match));
}

// --- el interruptor -----------------------------------------------------

test('apagado por defecto: sin ALERTAS_COLA no encola nada', async () => {
  reiniciar();
  await conEntorno({ ALERTAS_COLA: '' }, async () => {
    let llamado = false;
    const r = await tick({ ahora: async () => ({ hora: 9 }), encolarTodos: async () => { llamado = true; } });
    assert.strictEqual(r.corrio, false);
    assert.strictEqual(r.motivo, 'apagado');
    assert.strictEqual(llamado, false, 'con la cola apagada no debe calcular ni encolar nada');
  });
});

test('antes de las 6am no encola', async () => {
  reiniciar();
  await conEntorno(ENCENDIDA, async () => {
    let llamado = false;
    const r = await tick({
      ahora: async () => ({ hora: RUN_AFTER_HOUR - 1 }),
      encolarTodos: async () => { llamado = true; },
    });
    assert.strictEqual(r.corrio, false);
    assert.strictEqual(r.motivo, 'fuera_de_horario');
    assert.strictEqual(llamado, false);
  });
});

test('una pasada colgada no deja el programador muerto', async () => {
  reiniciar();
  await conEntorno(ENCENDIDA, async () => {
    const r = await tick({
      ahora: async () => ({ hora: 9 }),
      encolarTodos: () => new Promise(() => {}), // nunca resuelve
      timeoutMs: 20,
    });
    assert.strictEqual(r.corrio, false);
    assert.strictEqual(r.motivo, 'error');

    // Lo que de verdad importa: la pasada siguiente SI corre.
    const siguiente = await tick({ ahora: async () => ({ hora: 9 }), encolarTodos: async () => [] });
    assert.strictEqual(siguiente.corrio, true, 'el cuelgue anterior no debe bloquear las pasadas siguientes');
  });
});

// --- a quien se le manda ------------------------------------------------

test('un correo por PM aunque tenga varios proyectos, mas el del CEO', async () => {
  reiniciar();
  reglas = [['FROM mp_project_owners', DOS_PMS.map((p) => ({ email: p.email, nombre: p.nombre, proyectos: p.proyectos }))]];

  await conEntorno(ENCENDIDA, async () => {
    const envios = await enviosDelDia();

    assert.deepStrictEqual(envios.map((e) => e.job), ['ceo', 'pm:ana@ejemplo.com', 'pm:beto@ejemplo.com']);
    assert.strictEqual(envios[0].opciones.nivel, 'ceo');
    assert.strictEqual(envios[0].opciones.lider, null);
    // El PM recibe su tramo (3-5 dias) y acotado a SUS proyectos.
    assert.strictEqual(envios[1].opciones.nivel, 'pm');
    assert.strictEqual(envios[1].opciones.lider, 'ana@ejemplo.com');
    assert.strictEqual(envios[1].to, 'ana@ejemplo.com');
  });

  // Ana tiene 7 proyectos y aun asi es UN envio: el agrupado va en el SQL.
  const sql = consultaCon('FROM mp_project_owners').sql;
  assert.match(sql, /GROUP BY pmo_email/);
  assert.match(sql, /is_active = 1/);
});

test('sin ALERTAS_EMAIL_TO no se encola el del CEO, pero los PMs siguen', async () => {
  reiniciar();
  reglas = [['FROM mp_project_owners', [DOS_PMS[0]]]];

  await conEntorno({ ALERTAS_COLA: '1', ALERTAS_EMAIL_TO: '' }, async () => {
    const envios = await enviosDelDia();
    assert.deepStrictEqual(envios.map((e) => e.job), ['pm:ana@ejemplo.com']);
  });
});

// --- el candado compartido ---------------------------------------------

test('si el turno del dia ya estaba tomado no se encola nada', async () => {
  reiniciar();
  reglas = [['INSERT INTO mp_alerta_email_envio', () => { throw errorDuplicado(); }]];

  const r = await encolar({ job: 'ceo', to: 'ceo@ejemplo.com', opciones: { nivel: 'ceo', lider: null } });

  assert.strictEqual(r.encolado, false);
  assert.strictEqual(r.motivo, 'turno_tomado');
  assert.strictEqual(consultaCon('INSERT INTO mp_alerta_email_cola'), undefined,
    'el turno lo tomo el envio por SMTP (u otra pasada): no puede salir un segundo correo');
});

test('el turno se reserva ANTES de armar el correo', async () => {
  reiniciar();
  let turnoReservadoPrimero = false;
  correoFalso = () => {
    turnoReservadoPrimero = Boolean(consultaCon('INSERT INTO mp_alerta_email_envio'));
    return { correo: { asunto: 'A', html: '<p>x</p>', texto: 'x' }, alertas: [], enElCorreo: 1 };
  };

  await encolar({ job: 'ceo', to: 'ceo@ejemplo.com', opciones: { nivel: 'ceo', lider: null } });

  assert.strictEqual(turnoReservadoPrimero, true,
    'armar primero y reservar despues abre la ventana para dos correos iguales');
});

test('si no se puede encolar se libera el turno para reintentar', async () => {
  reiniciar();
  correoFalso = () => { throw new Error('la base remota no dio conexiones'); };

  const r = await encolar({ job: 'pm:ana@ejemplo.com', to: 'ana@ejemplo.com', opciones: { nivel: 'pm', lider: 'ana@ejemplo.com' } });

  assert.strictEqual(r.encolado, false);
  assert.strictEqual(r.motivo, 'error');
  const liberado = consultaCon('DELETE FROM mp_alerta_email_envio');
  assert.ok(liberado, 'sin liberar el turno, ese PM se queda sin correo el resto del dia');
  assert.deepStrictEqual(liberado.params, ['pm:ana@ejemplo.com']);
});

// --- que se encola ------------------------------------------------------

test('encola el correo ya armado, sin logo', async () => {
  reiniciar();
  let logoRecibido = 'no se llamo';
  correoFalso = (opts) => {
    logoRecibido = opts.logoSrc;
    return { correo: { asunto: 'Alertas sin corregir (3)', html: '<p>cuerpo</p>', texto: 'cuerpo' }, alertas: [], enElCorreo: 3 };
  };

  const r = await encolar({ job: 'pm:ana@ejemplo.com', to: 'ana@ejemplo.com', opciones: { nivel: 'pm', lider: 'ana@ejemplo.com' } });

  assert.strictEqual(r.encolado, true);
  assert.strictEqual(r.alertas, 3);

  const ins = consultaCon('INSERT INTO mp_alerta_email_cola');
  assert.ok(ins, 'deberia haber dejado la fila para n8n');
  assert.deepStrictEqual(ins.params, ['pm:ana@ejemplo.com', 'ana@ejemplo.com', 'Alertas sin corregir (3)', '<p>cuerpo</p>', 'cuerpo', 3]);
  // La fecha la pone la base, no Node: el reloj que decide que dia es tiene
  // que ser el mismo que reservo el turno (ver sql/40).
  assert.match(ins.sql, /CURDATE\(\)/);

  // Ni adjunto `cid:` (no hay nodemailer por aqui) ni data URI: Outlook
  // bloquea el base64 y en su lugar pinta un cuadro roto. Probado el 22 sep
  // 2026 contra el Outlook real del usuario.
  assert.ok(!logoRecibido, `no debe mandarse logo, y llego: ${logoRecibido}`);
});

test('sin alertas sin corregir no se manda correo', async () => {
  reiniciar();
  correoFalso = { correo: { asunto: 'Alertas', html: '<p>nada</p>', texto: 'nada' }, alertas: [], enElCorreo: 0 };

  const r = await encolar({ job: 'pm:ana@ejemplo.com', to: 'ana@ejemplo.com', opciones: { nivel: 'pm', lider: 'ana@ejemplo.com' } });

  assert.strictEqual(r.encolado, false);
  assert.strictEqual(r.motivo, 'sin_alertas');
  assert.strictEqual(consultaCon('INSERT INTO mp_alerta_email_cola'), undefined);
  // El turno queda tomado a proposito: hoy no hay nada que mandar y no tiene
  // sentido recalcularlo cada hora.
  assert.strictEqual(consultaCon('DELETE FROM mp_alerta_email_envio'), undefined);
});

test('que un PM falle no deja sin correo a los demas', async () => {
  reiniciar();
  reglas = [['FROM mp_project_owners', DOS_PMS]];
  correoFalso = (opts) => {
    if (opts.lider === 'ana@ejemplo.com') throw new Error('Ana no tiene proyectos activos');
    return { correo: { asunto: 'A', html: '<p>x</p>', texto: 'x' }, alertas: [], enElCorreo: 2 };
  };

  const resultados = await conEntorno(ENCENDIDA, () => encolarPendientesDelDia());

  const porJob = Object.fromEntries(resultados.map((r) => [r.job, r]));
  assert.strictEqual(porJob['pm:ana@ejemplo.com'].motivo, 'error');
  assert.strictEqual(porJob['ceo'].encolado, true);
  assert.strictEqual(porJob['pm:beto@ejemplo.com'].encolado, true);
});

// --- los que nunca salieron --------------------------------------------

test('los pendientes de dias anteriores se vencen, no se mandan tarde', async () => {
  reiniciar();
  reglas = [["UPDATE mp_alerta_email_cola SET estado = 'vencido'", { affectedRows: 2 }]];

  const vencidos = await vencerViejos();

  assert.strictEqual(vencidos, 2);
  const upd = consultaCon("SET estado = 'vencido'");
  assert.match(upd.sql, /estado = 'pendiente'/, 'solo se vencen los que nunca salieron');
  assert.match(upd.sql, /fecha < CURDATE\(\)/, 'los de hoy todavia pueden salir');
});

test('si no se pueden vencer los viejos igual se encola el correo de hoy', async () => {
  reiniciar();
  reglas = [
    ["UPDATE mp_alerta_email_cola SET estado = 'vencido'", () => { throw new Error('tabla bloqueada'); }],
    ['FROM mp_project_owners', []],
  ];

  const resultados = await conEntorno(ENCENDIDA, () => encolarPendientesDelDia());

  assert.strictEqual(resultados.length, 1);
  assert.strictEqual(resultados[0].encolado, true, 'la limpieza es accesoria: no puede costar el aviso del dia');
});
