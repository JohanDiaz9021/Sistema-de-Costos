'use strict';

/**
 * Envio de correo por Microsoft Graph o por SMTP.
 *
 * Toda la configuracion sale de variables de entorno (.env), como el resto
 * del proyecto: aqui NO hay ningun servidor, usuario ni destinatario
 * hardcoded. Mientras falten, el sistema no se cae ni intenta enviar — lo
 * dice y sigue. Asi el modulo queda montado y probado desde ya, y el dia que
 * existan las credenciales solo hay que rellenar el .env y reiniciar.
 *
 *   MAIL_GRAPH_TENANT_ID, MAIL_GRAPH_CLIENT_ID, MAIL_GRAPH_CLIENT_SECRET
 *                          envio por Graph (ver configGraph)
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD
 *                          envio por SMTP, si no hay nada de Graph
 *   MAIL_FROM              remitente ("GTC Costeo <costeo@gtc...>")
 *   ALERTAS_EMAIL_TO       destinatario(s) por defecto, separados por coma
 *
 * nodemailer se carga PEREZOSAMENTE (dentro de la funcion, no arriba): si el
 * paquete no esta instalado todavia, el resto del sistema arranca igual y el
 * error solo aparece cuando alguien intenta enviar de verdad.
 */

const fs = require('fs/promises');
const path = require('path');

// Un campo vacio o con espacios cuenta como "sin configurar": es lo que deja
// el .env.example cuando todavia no hay credenciales.
function valor(nombre) {
  const v = process.env[nombre];
  return v && String(v).trim() ? String(v).trim() : null;
}

// Envio por Microsoft Graph (26 oct 2026). Los correos dejan de salir de una
// cuenta de Gmail y pasan a salir de notificaciones@empresa.com, con
// la app CostosPlaneacion-Notificaciones de Entra ID (permiso Mail.Send de
// aplicacion, restringido por Application Access Policy a ese unico buzon).
//
// Por que Graph y no SMTP con usuario y contraseña: Microsoft esta retirando
// la autenticacion basica de SMTP en Exchange Online, y un buzon compartido
// ni siquiera tiene contraseña propia. Con Graph no hay contraseña de nadie:
// el servidor pide un token con el client secret y el token vence solo.
//
// Son variables PROPIAS y no las GRAPH_* de sharepoint.js a proposito: son
// dos apps distintas en Entra ID, con permisos distintos. Mezclarlas obligaria
// a darle Mail.Send a la que lee SharePoint, o al reves.
//
// Basta con que UNA de las tres este definida para elegir Graph: asi, si a
// alguien se le olvida una, faltaParaEnviar() lo dice en vez de caer en
// silencio al SMTP viejo.
function configGraph() {
  return {
    tenantId: valor('MAIL_GRAPH_TENANT_ID'),
    clientId: valor('MAIL_GRAPH_CLIENT_ID'),
    clientSecret: valor('MAIL_GRAPH_CLIENT_SECRET'),
  };
}

function usaGraph() {
  const g = configGraph();
  return Boolean(g.tenantId || g.clientId || g.clientSecret);
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
  const falta = [];
  if (usaGraph()) {
    const g = configGraph();
    if (!g.tenantId) falta.push('MAIL_GRAPH_TENANT_ID');
    if (!g.clientId) falta.push('MAIL_GRAPH_CLIENT_ID');
    if (!g.clientSecret) falta.push('MAIL_GRAPH_CLIENT_SECRET');
    if (!valor('MAIL_FROM')) falta.push('MAIL_FROM');
    return falta;
  }
  const cfg = configSmtp();
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

// "GTC Costeo <notificaciones@gtc...>" -> { nombre, direccion }. Graph necesita
// la direccion sola para la URL (/users/{direccion}/sendMail); el nombre va
// aparte, en `from`.
function partirRemitente(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { nombre: m[1].trim() || null, direccion: m[2].trim() };
  return { nombre: null, direccion: String(from || '').trim() };
}

// El token de Graph dura ~1 hora: se reusa mientras le quede al menos un
// minuto, en vez de pedir uno nuevo por cada correo.
let tokenGraph = { token: null, expira: 0 };

async function tokenDeGraph(g) {
  if (tokenGraph.token && tokenGraph.expira > Date.now() + 60_000) return tokenGraph.token;

  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(g.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    // El detalle de Microsoft (secret vencido, tenant mal escrito...) va al
    // log; al cliente solo le llega que fallo la autenticacion.
    const err = new Error(`Graph: no se pudo obtener el token (${json.error_description || json.error || r.status})`);
    err.status = 502;
    err.publicMessage = 'No se pudo autenticar con Microsoft para enviar el correo.';
    throw err;
  }
  const nuevo = { token: json.access_token, expira: Date.now() + Number(json.expires_in || 3600) * 1000 };
  tokenGraph = nuevo;
  return nuevo.token;
}

const TIPOS_ADJUNTO = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf' };

// Adjunto de nodemailer ({ filename, path, cid }) -> fileAttachment de Graph.
// Con `cid` va en linea (isInline + contentId), que es como el HTML lo pinta
// con <img src="cid:...">: el logo de los correos de alertas.
async function adjuntoParaGraph(a) {
  const nombre = a.filename || path.basename(a.path || 'adjunto');
  const contenido = a.content !== undefined ? Buffer.from(a.content) : await fs.readFile(a.path);
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: nombre,
    contentType: a.contentType || TIPOS_ADJUNTO[path.extname(nombre).toLowerCase()] || 'application/octet-stream',
    contentBytes: contenido.toString('base64'),
    ...(a.cid ? { contentId: a.cid, isInline: true } : {}),
  };
}

// Graph no arma un correo multiparte con HTML y texto a la vez: se manda el
// HTML, y el texto plano solo cuando no hay HTML.
async function enviarPorGraph({ para, subject, html, text, attachments }) {
  const g = configGraph();
  const remitente = partirRemitente(valor('MAIL_FROM'));
  const token = await tokenDeGraph(g);

  const message = {
    subject,
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: para.map((address) => ({ emailAddress: { address } })),
    attachments: await Promise.all((attachments || []).map(adjuntoParaGraph)),
  };
  if (remitente.nombre) {
    message.from = { emailAddress: { name: remitente.nombre, address: remitente.direccion } };
  }

  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(remitente.direccion)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  // 202 Accepted, sin cuerpo: Exchange lo tomo y lo entrega por su cuenta.
  if (r.status !== 202) {
    const json = await r.json().catch(() => ({}));
    // Un 401 puede ser un token revocado antes de tiempo (secret rotado): se
    // descarta para que el siguiente intento pida uno nuevo.
    if (r.status === 401) tokenGraph = { token: null, expira: 0 };
    const err = new Error(`Graph rechazo el correo (${r.status}): ${json.error?.message || r.statusText}`);
    err.status = 502;
    err.publicMessage = 'Microsoft rechazo el envio del correo.';
    throw err;
  }
  return { enviadoA: para, messageId: r.headers.get('request-id') };
}

// Solo para las pruebas: olvida el token guardado.
function _resetTokenGraph() {
  tokenGraph = { token: null, expira: 0 };
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

  if (usaGraph()) return enviarPorGraph({ para, subject, html, text, attachments });

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

module.exports = {
  enviarCorreo, mailerConfigurado, faltaParaEnviar, destinatarios, correosInvalidos,
  usaGraph, partirRemitente, _resetTokenGraph,
};
