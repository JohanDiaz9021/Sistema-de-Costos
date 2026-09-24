'use strict';

/**
 * Programador del correo diario de alertas (src/services/alertas-email-scheduler.js).
 *
 * Lo que se prueba aqui es la POLITICA, no el envio: a que hora dispara, que
 * hace cuando no hay con que mandar, y que los dos correos del dia sean
 * complementarios. El envio de verdad (SMTP, base) se inyecta.
 *
 * La regla que mas importa — "1 correo por dia, pase lo que pase" — no se
 * puede probar del todo aqui porque quien la garantiza es la UNIQUE KEY
 * (job, fecha) de mp_alerta_email_envio (ver sql/40), o sea la base de datos.
 * Lo que si se cubre es que el codigo no intente nada cuando no debe.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  tick, enviosConfigurados, RUN_AFTER_HOUR,
} = require('../../src/services/alertas-email-scheduler');

// El tick lee las credenciales del entorno para decidir si vale la pena
// intentar. Estas dos ayudas dejan el entorno como lo necesita cada prueba y
// lo devuelven como estaba, para no contaminar a las demas.
// `await fn()` y no `return fn()`: sin el await, el finally restaura el
// entorno EN CUANTO el callback llega a su primer await, no cuando termina.
// Con eso, la primera llamada a tick() alcanzaba a leer las credenciales
// (las mira antes de su primer await) pero la segunda ya las encontraba
// vacías y devolvía 'sin_smtp' — un fallo que parecía del programador y era
// de esta ayuda.
async function conEntorno(vars, fn) {
  const guardado = { ...process.env };
  try {
    Object.assign(process.env, vars);
    return await fn();
  } finally {
    // Restaurar el entorno guardado no es una condicion de carrera: estas
    // pruebas corren en serie. Mismo caso que la bandera `enCurso` de los
    // programadores, donde la regla tampoco distingue el patron.
    // eslint-disable-next-line require-atomic-updates
    process.env = guardado;
  }
}

const SMTP_COMPLETO = {
  SMTP_HOST: 'smtp.ejemplo.com',
  SMTP_USER: 'u',
  SMTP_PASSWORD: 'p',
  MAIL_FROM: 'GTC <costeo@ejemplo.com>',
  ALERTAS_EMAIL_TO: 'ceo@ejemplo.com',
};

test('tick: antes de las 6am no manda nada', async () => {
  await conEntorno(SMTP_COMPLETO, async () => {
    let llamado = false;
    const r = await tick({
      ahora: async () => ({ hora: RUN_AFTER_HOUR - 1 }),
      enviar: async () => { llamado = true; },
    });
    assert.strictEqual(r.corrio, false);
    assert.strictEqual(r.motivo, 'fuera_de_horario');
    assert.strictEqual(llamado, false, 'no puede haber intentado enviar');
  });
});

test('tick: a partir de las 6am si manda', async () => {
  await conEntorno(SMTP_COMPLETO, async () => {
    let llamado = false;
    const r = await tick({
      ahora: async () => ({ hora: RUN_AFTER_HOUR }),
      enviar: async () => { llamado = true; },
    });
    assert.strictEqual(r.corrio, true);
    assert.strictEqual(llamado, true);
  });
});

// Sin credenciales, reservar el turno y fallar al enviar dejaria una fila
// creada y borrada cada hora sin que eso sirva de nada.
test('tick: sin credenciales SMTP ni siquiera mira la hora', async () => {
  await conEntorno({
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', MAIL_FROM: '',
  }, async () => {
    let miroLaHora = false;
    let llamado = false;
    const r = await tick({
      ahora: async () => { miroLaHora = true; return { hora: 9 }; },
      enviar: async () => { llamado = true; },
    });
    assert.strictEqual(r.corrio, false);
    assert.strictEqual(r.motivo, 'sin_smtp');
    assert.strictEqual(llamado, false);
    assert.strictEqual(miroLaHora, false, 'se corta antes de gastar una consulta a la base');
  });
});

test('tick: con SMTP pero sin ningun destinatario configurado, no intenta', async () => {
  await conEntorno({
    ...SMTP_COMPLETO, ALERTAS_EMAIL_TO: '', ALERTAS_PM_TO: '',
  }, async () => {
    let llamado = false;
    const r = await tick({
      ahora: async () => ({ hora: 9 }),
      enviar: async () => { llamado = true; },
    });
    assert.strictEqual(r.motivo, 'sin_destinatario');
    assert.strictEqual(llamado, false);
  });
});

// Una pasada puede tardar (calcula las alertas de todos los centros). Si el
// intervalo dispara otra encima, la segunda tiene que apartarse — dos
// pasadas a la vez compiten por el mismo turno del dia.
test('tick: si la pasada anterior sigue corriendo, la siguiente se salta', async () => {
  await conEntorno(SMTP_COMPLETO, async () => {
    let enviosEnCurso = 0;
    let maxSimultaneos = 0;
    const lento = async () => {
      enviosEnCurso += 1;
      maxSimultaneos = Math.max(maxSimultaneos, enviosEnCurso);
      await new Promise((r) => setTimeout(r, 30));
      enviosEnCurso -= 1;
    };
    const ahora = async () => ({ hora: 9 });

    const [primera, segunda] = await Promise.all([
      tick({ ahora, enviar: lento }),
      tick({ ahora, enviar: lento }),
    ]);

    assert.strictEqual(maxSimultaneos, 1, 'nunca puede haber dos pasadas enviando a la vez');
    const motivos = [primera, segunda].map((r) => r.motivo);
    assert.ok(motivos.includes('reentrancia'), 'una de las dos tuvo que apartarse');
  });
});

// Sin límite de tiempo, una pasada colgada dejaba `enCurso` en true para
// siempre: el programador quedaba mudo hasta reiniciar el contenedor, sin
// error ni forma de notarlo. Y colgarse es posible de verdad — el pool
// espera conexión indefinidamente y se agotó el 15 sep 2026.
test('tick: una pasada colgada NO deja el programador muerto; la siguiente vuelve a intentar', async () => {
  await conEntorno(SMTP_COMPLETO, async () => {
    const ahora = async () => ({ hora: 9 });

    // Se cuelga de verdad: una promesa que no resuelve nunca. Es lo que pasa
    // cuando el pool espera una conexión que no llega.
    const colgada = await tick({ ahora, enviar: () => new Promise(() => {}), timeoutMs: 40 });

    assert.strictEqual(colgada.corrio, false);
    assert.strictEqual(colgada.motivo, 'error', 'el cuelgue se reporta como error, no se traga en silencio');
    assert.match(colgada.error.message, /se dio por perdida/);

    // Lo que de verdad importa: el programador quedó utilizable. Sin el
    // límite de tiempo, esta segunda pasada habría devuelto 'reentrancia'
    // para siempre, y no habría vuelto a salir un correo nunca más.
    let volvioAIntentar = false;
    const siguiente = await tick({ ahora, enviar: async () => { volvioAIntentar = true; } });

    assert.strictEqual(siguiente.corrio, true, 'la pasada siguiente TIENE que poder entrar');
    assert.strictEqual(volvioAIntentar, true);
  });
});

test('enviosConfigurados: sin ALERTAS_PM_* solo existe el correo del CEO', async () => {
  await conEntorno({ ALERTAS_PM_LIDER: '', ALERTAS_PM_TO: '' }, () => {
    const envios = enviosConfigurados();
    assert.strictEqual(envios.length, 1);
    assert.strictEqual(envios[0].job, 'ceo');
    assert.strictEqual(envios[0].opciones.nivel, 'ceo');
  });
});

// Los dos tramos tienen que ser complementarios: si los dos mandaran el
// mismo nivel, alguien recibiria la misma alerta dos veces.
test('enviosConfigurados: con ALERTAS_PM_* se agrega el tramo del PM, acotado a ese lider', async () => {
  await conEntorno({
    ALERTAS_PM_LIDER: 'monica@ejemplo.com',
    ALERTAS_PM_TO: 'destino@ejemplo.com',
  }, () => {
    const envios = enviosConfigurados();
    assert.strictEqual(envios.length, 2);

    const pm = envios.find((e) => e.job.startsWith('pm:'));
    assert.strictEqual(pm.to, 'destino@ejemplo.com');
    assert.strictEqual(pm.opciones.nivel, 'pm');
    assert.strictEqual(pm.opciones.lider, 'monica@ejemplo.com', 'acota a los proyectos de ese PM');

    const niveles = envios.map((e) => e.opciones.nivel);
    assert.deepStrictEqual([...new Set(niveles)].sort(), ['ceo', 'pm'], 'tramos complementarios, no repetidos');

    const jobs = envios.map((e) => e.job);
    assert.strictEqual(new Set(jobs).size, jobs.length, 'cada envio necesita su propio turno del dia');
  });
});

// Si manana se configura un segundo PM, su job no puede chocar con el del
// primero o solo saldria uno de los dos correos.
test('enviosConfigurados: el job del PM lleva su correo, para que dos PM no compartan turno', () => {
  const jobDe = (lider) => conEntorno(
    { ALERTAS_PM_LIDER: lider, ALERTAS_PM_TO: 'destino@ejemplo.com' },
    () => enviosConfigurados().find((e) => e.job.startsWith('pm:')).job
  );
  assert.notStrictEqual(jobDe('monica@ejemplo.com'), jobDe('jonathan@ejemplo.com'));
});
