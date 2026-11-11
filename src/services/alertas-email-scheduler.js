'use strict';

/**
 * Envio automatico del correo de alertas, una vez al dia a partir de las
 * 6:00 (a pedido explicito, 15 sep 2026).
 *
 * Corre dentro del proceso de server.js, igual que snapshot-scheduler.js y
 * por los mismos motivos: no suma una dependencia de cron, no depende de que
 * alguien configure el programador de tareas del sistema operativo, y se
 * levanta solo con el contenedor.
 *
 * REGLA QUE MANDA SOBRE TODO LO DEMAS: un correo por dia y por job. Se
 * revisa cada hora — no una sola vez a las 6 — para que un fallo puntual no
 * se coma el aviso del dia: la base remota ya nos ha negado conexiones
 * varias veces, y el SMTP puede estar caido a las 6 y bueno a las 7. Pero
 * ese reintento NO puede convertirse en una rafaga de correos, asi que el
 * turno del dia se reserva en mp_alerta_email_envio, cuya UNIQUE KEY
 * (job, fecha) es la que garantiza de verdad que no haya dos (ver sql/40).
 *
 * Orden de las operaciones, que no es casual:
 *
 *   1. INSERT del turno. Si la base lo rechaza por duplicado, hoy ya se
 *      mando (o se esta mandando) y esta pasada no hace nada mas.
 *   2. Enviar.
 *   3. Si el envio falla, se BORRA el turno para que la pasada siguiente
 *      pueda reintentar.
 *
 * Al reves — mandar y despues registrar — un fallo al registrar dejaria el
 * correo enviado y sin rastro, y la pasada siguiente lo mandaria otra vez.
 * El precio de hacerlo en este orden es que si el proceso muere justo entre
 * el paso 1 y el 3, ese dia no sale el correo: se prefiere perder un aviso
 * antes que mandar duplicados, que es lo que se pidio.
 */

const { query } = require('../db');
const { enviarAlertas } = require('./alertas-email');
const { faltaParaEnviar, destinatarios } = require('../lib/mailer');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // revisa cada hora
const RUN_AFTER_HOUR = 6; // no dispara antes de las 6am

// Tiempo máximo de una pasada (15 sep 2026, tras auditoría). Sin esto, un
// cuelgue deja el programador MUERTO para siempre: la guarda `enCurso` de
// abajo nunca se libera y todas las pasadas siguientes se saltan en
// silencio — ni correo, ni error, ni forma de notarlo salvo reiniciar.
//
// Y colgarse es posible de verdad, no en teoría: el pool de src/db.js va con
// `waitForConnections: true` y `queueLimit: 0`, o sea que espera una conexión
// libre INDEFINIDAMENTE. Ese pool se agotó de hecho el 15 sep 2026 contra el
// tope de 50 conexiones de la base remota.
//
// 15 minutos es holgado: la pasada completa (calcular todos los centros y
// mandar los dos correos) tarda unos segundos. Se pasa de ahí solo si algo
// está realmente atascado.
const TIMEOUT_PASADA_MS = 15 * 60 * 1000;

// No se puede cancelar una promesa en curso: lo que esto consigue es que el
// programador se RECUPERE (libera `enCurso` y reintenta a la hora siguiente),
// aunque el trabajo colgado siga ahí hasta que el driver se rinda.
//
// Es seguro justamente aquí porque el turno del día está reservado en
// mp_alerta_email_envio con una llave única: si la pasada colgada revive, no
// puede mandar un segundo correo. En snapshot-scheduler.js NO se pone lo
// mismo a propósito — ese no tiene llave única (su propio comentario lo
// admite), así que un timeout ahí sí podría duplicar el snapshot del día.
async function conLimiteDeTiempo(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new Error(`la pasada superó los ${Math.round(ms / 60000)} minutos y se dio por perdida`)),
      ms
    );
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

// Ver el comentario gemelo en snapshot-scheduler.js: calcular las alertas de
// todos los centros tarda, y si una pasada se atasca contra la base el
// setInterval dispara igual al cumplirse la hora.
let enCurso = false;

/**
 * Los envios del dia. Cada uno es independiente: tiene su propio turno en
 * mp_alerta_email_envio y su propio reintento, asi que si el del PM falla el
 * del CEO igual sale.
 *
 * El del PM sale de variables de entorno y no esta escrito aqui a proposito:
 * cambiar a quien se le manda no deberia obligar a tocar codigo ni a
 * reconstruir la imagen. Si ALERTAS_PM_LIDER o ALERTAS_PM_TO no estan, ese
 * envio simplemente no existe — no es un error, es que todavia no se
 * configuro.
 */
function enviosConfigurados() {
  const envios = [{
    job: 'ceo',
    // Sin `to`: enviarCorreo cae a ALERTAS_EMAIL_TO (ver mailer.js).
    to: null,
    // Lo que el panel le muestra a un admin/ceo: lo que ya escalo (6+ dias).
    opciones: { nivel: 'ceo', lider: null },
  }];

  const liderPm = (process.env.ALERTAS_PM_LIDER || '').trim();
  const destinoPm = (process.env.ALERTAS_PM_TO || '').trim();
  if (liderPm && destinoPm) {
    envios.push({
      job: `pm:${liderPm}`,
      to: destinoPm,
      // El tramo contrario: la ventana de 3 a 5 dias, que todavia esta en
      // manos del PM. Complementario al del CEO, nunca se solapan.
      opciones: { nivel: 'pm', lider: liderPm },
    });
  }
  return envios;
}

/**
 * Reserva el turno de hoy. Devuelve false si ya estaba tomado.
 *
 * CURDATE() y no una fecha calculada en Node: el reloj que decide que dia es
 * tiene que ser el mismo que guarda la fila, o cerca de medianoche se
 * reservan dos turnos para lo que es un solo dia (es el bug de zonas
 * horarias que ya documenta snapshot-scheduler.js).
 */
async function reservarTurno(job, destinatario) {
  try {
    await query(
      'INSERT INTO mp_alerta_email_envio (job, fecha, destinatario) VALUES (?, CURDATE(), ?)',
      [job, destinatario || process.env.ALERTAS_EMAIL_TO || '(ALERTAS_EMAIL_TO)']
    );
    return true;
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

async function liberarTurno(job) {
  await query('DELETE FROM mp_alerta_email_envio WHERE job = ? AND fecha = CURDATE()', [job]);
}

async function marcarEnviado(job, alertas) {
  await query(
    'UPDATE mp_alerta_email_envio SET enviado_at = NOW(), alertas = ? WHERE job = ? AND fecha = CURDATE()',
    [alertas, job]
  );
}

async function enviarPendientesDelDia() {
  for (const envio of enviosConfigurados()) {
    if (!(await reservarTurno(envio.job, envio.to))) continue; // hoy ya salio

    try {
      const r = await enviarAlertas({ ...envio.opciones, to: envio.to });
      await marcarEnviado(envio.job, r.enElCorreo);
      console.log(`[alertas-email-scheduler] ${envio.job}: enviado a ${r.enviadoA.join(', ')} — ${r.enElCorreo} alerta(s)`);
    } catch (err) {
      // Se libera el turno para que la pasada de la hora siguiente reintente.
      await liberarTurno(envio.job).catch((errLib) => {
        // Si ni siquiera se puede liberar, se deja anotado: hoy ya no sale
        // ese correo, pero no se arrastra el error ni se bloquea el otro.
        console.error(`[alertas-email-scheduler] ${envio.job}: no se pudo liberar el turno:`, errLib.message);
      });
      console.error(`[alertas-email-scheduler] ${envio.job}: fallo el envio, se reintenta en la proxima pasada:`, err.message);
    }
  }
}

async function ahoraSegunLaBase() {
  const rows = await query('SELECT HOUR(NOW()) AS hora');
  return { hora: Number(rows[0].hora) };
}

// Mismas dos dependencias inyectables que snapshot-scheduler.tick(), y por el
// mismo motivo: sin esto, probar "no dispara antes de las 6am" exigiria
// mover la hora real de MariaDB.
// `timeoutMs` se inyecta por el mismo motivo que `ahora` y `enviar`: probar
// que un cuelgue libera el programador no puede costar 15 minutos de reloj.
async function tick({ ahora = ahoraSegunLaBase, enviar = enviarPendientesDelDia, timeoutMs = TIMEOUT_PASADA_MS } = {}) {
  if (enCurso) {
    console.warn('[alertas-email-scheduler] la pasada anterior sigue corriendo, se salta esta');
    return { corrio: false, motivo: 'reentrancia' };
  }
  enCurso = true;
  try {
    // Sin credenciales no se intenta nada: reservar el turno y fallar al
    // enviar dejaria una fila borrada y vuelta a crear cada hora sin que eso
    // sirva de nada.
    const falta = faltaParaEnviar();
    if (falta.length) return { corrio: false, motivo: 'sin_smtp' };
    if (!destinatarios(null).length && !process.env.ALERTAS_PM_TO) {
      return { corrio: false, motivo: 'sin_destinatario' };
    }

    const { hora } = await ahora();
    if (hora < RUN_AFTER_HOUR) return { corrio: false, motivo: 'fuera_de_horario' };

    await conLimiteDeTiempo(enviar(), timeoutMs);
    return { corrio: true };
  } catch (err) {
    console.error('[alertas-email-scheduler] error en la pasada:', err);
    return { corrio: false, motivo: 'error', error: err };
  } finally {
    // Ver la nota de snapshot-scheduler.js: la guarda de arriba no tiene
    // ningun await en medio, asi que es atomica en JavaScript.
    // eslint-disable-next-line require-atomic-updates
    enCurso = false;
  }
}

function startAlertasEmailScheduler() {
  tick(); // por si el contenedor arranca despues de las 6am y hoy no ha salido
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[alertas-email-scheduler] activo — revisa cada hora, manda 1 vez al dia despues de las 06:00');
  return interval;
}

module.exports = {
  startAlertasEmailScheduler,
  // Expuestas para las pruebas; server.js solo llama a start...().
  tick,
  enviarPendientesDelDia,
  enviosConfigurados,
  reservarTurno,
  liberarTurno,
  RUN_AFTER_HOUR,
};
