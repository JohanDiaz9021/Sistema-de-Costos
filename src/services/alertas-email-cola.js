'use strict';

/**
 * Deja los correos de alertas listos en mp_alerta_email_cola para que los
 * mande n8n (flujo WF1, que ya tiene las credenciales de Office365).
 *
 * Es el gemelo de alertas-email-scheduler.js y le copia la estructura a
 * proposito — misma revision cada hora, mismo "no antes de las 6", mismas
 * guardas de reentrancia y de cuelgue. La unica diferencia es el ultimo
 * paso: aquel abre una conexion SMTP, este escribe una fila.
 *
 * LOS DOS COMPARTEN EL CANDADO. El turno del dia se reserva en
 * mp_alerta_email_envio (UNIQUE (job, fecha), ver sql/40) antes de encolar
 * nada, usando las mismas funciones del otro programador. Por eso los dos
 * caminos pueden convivir sin que nadie reciba dos correos: el que llegue
 * primero se queda con el turno y el otro no hace nada. Sin eso, encender
 * este servicio con el SMTP ya configurado le mandaria dos correos al CEO
 * todos los dias.
 *
 * QUE SE ENCOLA Y QUE NO: si una persona no tiene ninguna alerta sin
 * corregir, no se encola correo. Son cinco PMs reales recibiendo esto a
 * diario; un correo que dice "no hay nada" todos los dias se vuelve ruido y
 * se deja de abrir, y entonces tampoco se abre el dia que si trae algo. El
 * turno igual se reserva, asi que la pasada siguiente no lo reintenta.
 *
 * APAGADO POR DEFECTO. Necesita ALERTAS_COLA=1. Encenderlo empieza a
 * mandarle correos a PMs reales (los de mp_project_owners), y eso lo decide
 * el usuario, no el arranque del contenedor.
 */

const { query } = require('../db');
const { prepararCorreo } = require('./alertas-email');
const { destinatarios } = require('../lib/mailer');
// Las mismas funciones, no una copia: es lo que hace que el candado sea de
// verdad compartido y no dos implementaciones que pueden separarse.
const { reservarTurno, liberarTurno } = require('./alertas-email-scheduler');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RUN_AFTER_HOUR = 6;
const TIMEOUT_PASADA_MS = 15 * 60 * 1000;

let enCurso = false;

function colaActivada() {
  return String(process.env.ALERTAS_COLA || '').trim() === '1';
}

// Ver el comentario gemelo en alertas-email-scheduler.js: sin esto, un
// cuelgue contra la base remota deja el programador muerto para siempre.
async function conLimiteDeTiempo(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new Error(`la pasada supero los ${Math.round(ms / 60000)} minutos y se dio por perdida`)),
      ms
    );
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Los PMs que hoy tienen al menos un proyecto activo.
 *
 * Salen de la base y no de variables de entorno (como si hace el otro
 * programador con ALERTAS_PM_LIDER) porque la lista cambia: dar de alta un
 * PM en Accesos deberia bastar para que empiece a recibir su correo, sin
 * tocar el .env ni reconstruir la imagen.
 *
 * Agrupado por correo: un PM con siete proyectos es un correo, no siete.
 */
async function pmsActivos() {
  const rows = await query(
    `SELECT pmo_email AS email, MIN(pmo_canonical_name) AS nombre, COUNT(*) AS proyectos
       FROM mp_project_owners
      WHERE is_active = 1 AND pmo_email IS NOT NULL AND pmo_email <> ''
      GROUP BY pmo_email
      ORDER BY pmo_email`
  );
  return rows.map((r) => ({ email: r.email, nombre: r.nombre, proyectos: Number(r.proyectos) }));
}

/**
 * Un envio por destinatario del dia: el del CEO (lo que ya escalo, 6+ dias)
 * y el de cada PM (la ventana de 3 a 5 dias, que todavia esta en sus manos).
 * Los dos tramos son complementarios y nunca se solapan.
 */
async function enviosDelDia() {
  const envios = [];

  const ceo = destinatarios(null);
  if (ceo.length) {
    envios.push({
      job: 'ceo',
      to: ceo.join(', '),
      opciones: { nivel: 'ceo', lider: null },
    });
  }

  for (const pm of await pmsActivos()) {
    envios.push({
      job: `pm:${pm.email}`,
      to: pm.email,
      opciones: { nivel: 'pm', lider: pm.email },
    });
  }
  return envios;
}

/**
 * Cierra los pendientes que nunca salieron. Una alerta es la foto de un dia:
 * mandarla al dia siguiente confunde, y ademas el correo de hoy ya trae la
 * foto al dia. Se marcan en vez de borrarse para poder responder despues
 * "¿por que ese dia no llego el correo?".
 */
async function vencerViejos() {
  const r = await query(
    "UPDATE mp_alerta_email_cola SET estado = 'vencido', error = ? WHERE estado = 'pendiente' AND fecha < CURDATE()",
    ['no se envio el mismo dia']
  );
  return r && typeof r.affectedRows === 'number' ? r.affectedRows : 0;
}

async function encolar(envio) {
  if (!(await reservarTurno(envio.job, envio.to))) {
    return { job: envio.job, encolado: false, motivo: 'turno_tomado' };
  }

  try {
    // SIN LOGO, y no es un olvido. El correo que manda la app lleva el logo
    // como adjunto con `cid:`, pero por la cola no pasa nodemailer y no hay
    // adjunto al que apuntar. El reemplazo obvio — incrustarlo como data URI
    // dentro del HTML — se probo el 22 sep 2026 y NO SIRVE: Outlook no
    // soporta imagenes en base64 y las bloquea siempre, asi que en vez del
    // logo sale un cuadro roto con el texto alternativo. Y justamente en
    // Outlook es donde lo leen los PMs y el CEO.
    //
    // La otra salida era servir el logo por URL, pero eso obliga a que el
    // dashboard sea alcanzable desde el computador de cada quien y Outlook
    // igual pide "descargar imagenes" la primera vez. Se prefirio un correo
    // que se vea bien siempre antes que uno con logo a veces (decision del
    // usuario, 22 sep 2026).
    //
    // construirCorreoAlertas omite la cabecera de la imagen cuando logoSrc
    // viene vacio (ver cabeceraLogo en costo-alertas-email.js), asi que basta
    // con no pasarlo.
    const { correo, enElCorreo } = await prepararCorreo({ ...envio.opciones });

    if (!enElCorreo) {
      // El turno queda tomado a proposito: no hay nada que mandar hoy y no
      // tiene sentido que la pasada de la hora siguiente lo vuelva a calcular.
      return { job: envio.job, encolado: false, motivo: 'sin_alertas' };
    }

    await query(
      `INSERT INTO mp_alerta_email_cola (job, fecha, destinatario, asunto, html, texto, alertas)
       VALUES (?, CURDATE(), ?, ?, ?, ?, ?)`,
      [envio.job, envio.to, correo.asunto, correo.html, correo.texto || null, enElCorreo]
    );
    return { job: envio.job, encolado: true, alertas: enElCorreo };
  } catch (err) {
    // Se libera el turno para que la pasada siguiente reintente. Mismo
    // criterio que el otro programador: preferimos reintentar que perder el
    // aviso del dia.
    await liberarTurno(envio.job).catch((errLib) => {
      console.error(`[alertas-email-cola] ${envio.job}: no se pudo liberar el turno:`, errLib.message);
    });
    return { job: envio.job, encolado: false, motivo: 'error', error: err };
  }
}

async function encolarPendientesDelDia() {
  const resultados = [];
  await vencerViejos().catch((err) => {
    // Que no se puedan vencer los viejos no justifica dejar sin correo el dia
    // de hoy: se anota y se sigue.
    console.error('[alertas-email-cola] no se pudieron vencer los pendientes viejos:', err.message);
  });

  for (const envio of await enviosDelDia()) {
    const r = await encolar(envio);
    resultados.push(r);
    if (r.encolado) {
      console.log(`[alertas-email-cola] ${r.job}: encolado para ${envio.to} — ${r.alertas} alerta(s)`);
    } else if (r.motivo === 'error') {
      console.error(`[alertas-email-cola] ${r.job}: no se pudo encolar, se reintenta en la proxima pasada:`, r.error.message);
    } else if (r.motivo === 'sin_alertas') {
      console.log(`[alertas-email-cola] ${r.job}: sin alertas sin corregir, no se encola correo`);
    }
  }
  return resultados;
}

async function ahoraSegunLaBase() {
  const rows = await query('SELECT HOUR(NOW()) AS hora');
  return { hora: Number(rows[0].hora) };
}

// Mismas dependencias inyectables que alertas-email-scheduler.tick(), y por
// el mismo motivo: probar "no dispara antes de las 6" no puede depender de
// la hora real de MariaDB, ni probar el cuelgue costar 15 minutos de reloj.
async function tick({ ahora = ahoraSegunLaBase, encolarTodos = encolarPendientesDelDia, timeoutMs = TIMEOUT_PASADA_MS } = {}) {
  if (!colaActivada()) return { corrio: false, motivo: 'apagado' };

  if (enCurso) {
    console.warn('[alertas-email-cola] la pasada anterior sigue corriendo, se salta esta');
    return { corrio: false, motivo: 'reentrancia' };
  }
  enCurso = true;
  try {
    const { hora } = await ahora();
    if (hora < RUN_AFTER_HOUR) return { corrio: false, motivo: 'fuera_de_horario' };

    const resultados = await conLimiteDeTiempo(encolarTodos(), timeoutMs);
    return { corrio: true, resultados };
  } catch (err) {
    console.error('[alertas-email-cola] error en la pasada:', err);
    return { corrio: false, motivo: 'error', error: err };
  } finally {
    // eslint-disable-next-line require-atomic-updates
    enCurso = false;
  }
}

function startAlertasEmailCola() {
  if (!colaActivada()) {
    console.log('[alertas-email-cola] apagado (falta ALERTAS_COLA=1) — n8n no recibira correos que mandar');
    return null;
  }
  tick();
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[alertas-email-cola] activo — deja los correos en mp_alerta_email_cola para que los mande n8n');
  return interval;
}

module.exports = {
  startAlertasEmailCola,
  // Expuestas para las pruebas; server.js solo llama a start...().
  tick,
  encolar,
  encolarPendientesDelDia,
  enviosDelDia,
  pmsActivos,
  vencerViejos,
  colaActivada,
  RUN_AFTER_HOUR,
};
