'use strict';

/**
 * Envio de correo por SMTP.
 *
 * Toda la configuracion sale de variables de entorno (.env), como el resto
 * del proyecto: aqui NO hay ningun servidor, usuario ni destinatario
 * hardcoded. Mientras falten, el sistema no se cae ni intenta enviar — lo
 * dice y sigue. Asi el modulo queda montado y probado desde ya, y el dia que
 * existan las credenciales solo hay que rellenar el .env y reiniciar.
 *
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD
 *   MAIL_FROM              remitente ("GTC Costeo <costeo@gtc...>")
 *   ALERTAS_EMAIL_TO       destinatario(s) por defecto, separados por coma
 *
 * nodemailer se carga PEREZOSAMENTE (dentro de la funcion, no arriba): si el
 * paquete no esta instalado todavia, el resto del sistema arranca igual y el
 * error solo aparece cuando alguien intenta enviar de verdad.
 */

// Un campo vacio o con espacios cuenta como "sin configurar": es lo que deja
// el .env.example cuando todavia no hay credenciales.
function valor(nombre) {
  const v = process.env[nombre];
  return v && String(v).trim() ? String(v).trim() : null;
}

function configSmtp() {
  return {
    host: valor('SMTP_HOST'),
    port: Number(valor('SMTP_PORT')) || 587,
    // 465 es SMTPS (TLS desde el saludo); 587 y 25 usan STARTTLS, que
    // nodemailer negocia solo con secure:false. Se puede forzar con
    // SMTP_SECURE=true por si el servidor no sigue la convencion.
    secure: valor('SMTP_SECURE') === 'true' || Number(valor('SMTP_PORT')) === 465,
    user: valor('SMTP_USER'),
    password: valor('SMTP_PASSWORD'),
    from: valor('MAIL_FROM'),
    // Nombre contra el que se valida el certificado TLS, cuando NO es el
    // mismo con el que se conecta. Es opcional y normalmente sobra.
    //
    // Hace falta con Brevo por su cambio de marca: el certificado sigue
    // emitido a nombre de smtp-relay.sendinblue.com y NO cubre
    // smtp-relay.brevo.com, pero el DNS interno de Docker resuelve el
    // nombre nuevo y no el viejo — o sea que por un nombre no se conecta y
    // por el otro no valida. Apuntando el SNI al nombre que el certificado
    // sí cubre, la verificación se hace completa contra el servidor real.
    //
    // NO es lo mismo que apagar la verificación (rejectUnauthorized:false):
    // un certificado invalido, vencido o de otro emisor sigue tumbando la
    // conexion igual que antes.
    tlsServername: valor('SMTP_TLS_SERVERNAME'),
  };
}

// Que falta para poder enviar. Devuelve [] cuando esta todo listo, para que
// quien llame pueda decir exactamente que campo del .env rellenar en vez de
// un "error de correo" generico.
function faltaParaEnviar() {
  const cfg = configSmtp();
  const falta = [];
  if (!cfg.host) falta.push('SMTP_HOST');
  if (!cfg.user) falta.push('SMTP_USER');
  if (!cfg.password) falta.push('SMTP_PASSWORD');
  if (!cfg.from) falta.push('MAIL_FROM');
  return falta;
}

function mailerConfigurado() {
  return faltaParaEnviar().length === 0;
}

// Destinatarios: los que lleguen por parametro o, si no, los de
// ALERTAS_EMAIL_TO. Se acepta una lista separada por comas o punto y coma
// (es como la gente los pega desde Outlook) y se limpia lo que sobre.
function destinatarios(entrada) {
  const crudo = entrada || valor('ALERTAS_EMAIL_TO') || '';
  return String(crudo)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Validacion deliberadamente simple: algo@algo.algo. No se pretende cubrir
// el RFC entero — solo atajar el dedazo obvio antes de abrir la conexion.
const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function correosInvalidos(lista) {
  return lista.filter((c) => !RE_CORREO.test(c));
}

// `attachments` es el formato de nodemailer. Se usa para el logo en linea:
// { filename, path, cid } + <img src="cid:...">. Va adjunto y no como URL
// porque Outlook y Gmail bloquean las imagenes remotas hasta que el lector
// pulsa "mostrar imagenes", y un logo que no se ve es peor que no ponerlo.
async function enviarCorreo({ to, subject, html, text, attachments }) {
  const falta = faltaParaEnviar();
  if (falta.length) {
    // El mensaje al cliente NO nombra las variables de entorno que faltan
    // (mismo criterio ya aplicado en employees.js para SharePoint/Graph):
    // un error no tiene por qué enumerar el esquema de configuración
    // interna del servidor. El detalle completo sigue disponible para
    // quien tiene que arreglarlo de verdad: queda en el log del servidor,
    // y también en GET /alertas/email/estado (admin/ceo), que a propósito
    // sí expone `falta` como parte de una pantalla de estado, no de un error.
    console.error(`[mailer] Correo sin configurar: falta ${falta.join(', ')} en el .env`);
    const err = new Error(`Correo sin configurar: falta ${falta.join(', ')} en el .env`);
    err.status = 503;
    err.publicMessage = 'El envio de correo todavia no esta configurado en el servidor.';
    throw err;
  }

  const para = destinatarios(to);
  if (!para.length) {
    const err = new Error('Sin destinatario: ni parametro `to` ni ALERTAS_EMAIL_TO');
    err.status = 400;
    err.publicMessage = 'No hay a quien enviarle: indica un correo o define ALERTAS_EMAIL_TO en el .env.';
    throw err;
  }
  const malos = correosInvalidos(para);
  if (malos.length) {
    const err = new Error(`Correo(s) invalido(s): ${malos.join(', ')}`);
    err.status = 400;
    err.publicMessage = `Estos correos no son validos: ${malos.join(', ')}`;
    throw err;
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    const err = new Error('Falta el paquete nodemailer (npm install nodemailer)');
    err.status = 500;
    err.publicMessage = 'El servidor no tiene instalado el paquete de correo (nodemailer).';
    throw err;
  }

  const cfg = configSmtp();
  const transporte = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    ...(cfg.tlsServername ? { tls: { servername: cfg.tlsServername } } : {}),
  });

  const info = await transporte.sendMail({
    from: cfg.from,
    to: para.join(', '),
    subject,
    html,
    // Alternativa en texto plano: hay clientes (y reglas de correo
    // corporativo) que descartan un HTML sin su version de texto.
    text,
    attachments: attachments || [],
  });

  return { enviadoA: para, messageId: info.messageId };
}

module.exports = { enviarCorreo, mailerConfigurado, faltaParaEnviar, destinatarios, correosInvalidos };
