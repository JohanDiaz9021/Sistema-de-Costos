'use strict';

/**
 * Correo HTML de alertas: la plantilla (costo-alertas-email.js) y las
 * comprobaciones previas al envio (lib/mailer.js).
 *
 * Las dos piezas se probaron a proposito sin base de datos ni SMTP: la
 * plantilla es una funcion pura sobre las alertas ya calculadas, y del mailer
 * se prueba lo que decide SI se envia (configuracion, destinatarios), no el
 * envio en si — eso ya es nodemailer.
 */

const test = require('node:test');
const assert = require('node:assert');

const { construirCorreoAlertas } = require('../../src/queries/costo-alertas-email');
const { faltaParaEnviar, destinatarios, correosInvalidos } = require('../../src/lib/mailer');

// dias_abierta por defecto: el correo lleva SOLO las alertas sin corregir, asi
// que una alerta recien detectada (sin dias) no aparece — para eso estan las
// pruebas del filtro, mas abajo.
const alerta = (extra) => ({
  tipo: 'Talento sin costo/hora',
  severidad: 'media',
  categoria: 'Equipo',
  detalle: 'Alicia tiene 40h sin tarifa',
  project_name: 'ALFA',
  dias_abierta: 4,
  nivel: 'pm',
  ...extra,
});

// El asunto se lee en la bandeja sin abrir nada: si no dice cuantas hay, el
// correo termina ignorandose como cualquier automatico.
test('construirCorreoAlertas: el asunto lleva el total y las criticas', () => {
  const { asunto } = construirCorreoAlertas([
    alerta({ severidad: 'critica' }),
    alerta({ severidad: 'alta' }),
    alerta({ severidad: 'baja' }),
  ]);
  assert.match(asunto, /3 alerta\(s\) sin corregir/);
  assert.match(asunto, /1 critica\(s\)/);
});

test('construirCorreoAlertas: sin alertas lo dice en el asunto y en el cuerpo', () => {
  const { asunto, html, texto } = construirCorreoAlertas([]);
  assert.match(asunto, /ninguna alerta lleva dias sin corregirse/);
  assert.match(html, /Ninguna alerta lleva dias sin corregirse/);
  assert.match(texto, /Ninguna alerta lleva dias sin corregirse/);
  assert.doesNotMatch(html, /<th/, 'sin filas no tiene sentido el encabezado de la tabla');
});

// Un correo se lee de arriba hacia abajo, y muchas veces solo las primeras
// lineas: lo urgente tiene que quedar arriba solo.
test('construirCorreoAlertas: ordena criticas primero y, dentro, por dias sin corregir', () => {
  const { texto } = construirCorreoAlertas([
    alerta({ tipo: 'BAJA', severidad: 'baja' }),
    alerta({ tipo: 'CRITICA-2DIAS', severidad: 'critica', dias_abierta: 2 }),
    alerta({ tipo: 'CRITICA-9DIAS', severidad: 'critica', dias_abierta: 9 }),
    alerta({ tipo: 'ALTA', severidad: 'alta' }),
  ]);
  const orden = ['CRITICA-9DIAS', 'CRITICA-2DIAS', 'ALTA', 'BAJA']
    .map((t) => texto.indexOf(t));
  assert.deepStrictEqual([...orden].sort((a, b) => a - b), orden, `quedo en otro orden: ${texto}`);
});

// El detalle de una alerta arrastra texto que escriben usuarios (nombres de
// gasto, de proyecto). En un correo eso viaja a bandejas ajenas, asi que se
// escapa igual que en la pantalla.
test('construirCorreoAlertas: escapa el contenido que viene de datos', () => {
  const { html } = construirCorreoAlertas([
    alerta({ detalle: '<img src=x onerror=alert(1)>', project_name: '<b>ALFA</b>' }),
  ]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;b&gt;ALFA/);
});

// Hay clientes y reglas de correo corporativo que descartan un HTML sin su
// version en texto plano.
test('construirCorreoAlertas: devuelve tambien la version en texto', () => {
  const { texto } = construirCorreoAlertas([alerta({ severidad: 'critica', dias_abierta: 5 })]);
  assert.match(texto, /\[Critica\] Talento sin costo\/hora - ALFA/);
  assert.match(texto, /lleva 5 dia\(s\)/);
});

// El logo va donde le digan: 'cid:...' cuando el correo se envia (adjunto en
// linea, que es lo unico que Outlook y Gmail muestran sin pedir permiso) y un
// data: URI cuando se previsualiza en el navegador. Si no llega, el correo
// sale igual — sin logo, no roto.
test('construirCorreoAlertas: el logo sale con el src que le pasen, y es opcional', () => {
  const conCid = construirCorreoAlertas([alerta()], { logoSrc: 'cid:logo-gtc' });
  assert.match(conCid.html, /<img src="cid:logo-gtc"/);
  // El alt va en MAYUSCULAS a proposito: no es solo texto de accesibilidad,
  // es lo que se VE cuando el cliente de correo bloquea las imagenes (Outlook
  // lo hace por defecto con remitentes que no estan en la lista de seguros).
  assert.match(conCid.html, /alt="GTC CORPORATION"/);
  // Y los estilos de texto sobre el <img> son los que pintan ese alt con la
  // marca en vez de dejar el encabezado en blanco: si alguien los quita, el
  // correo vuelve a verse roto para quien tiene las imagenes bloqueadas.
  assert.match(conCid.html, /font-weight:700/);
  assert.match(conCid.html, /color:#25007A/);

  const conData = construirCorreoAlertas([alerta()], { logoSrc: 'data:image/png;base64,AAA' });
  assert.match(conData.html, /<img src="data:image\/png;base64,AAA"/);

  const sinLogo = construirCorreoAlertas([alerta()]);
  assert.doesNotMatch(sinLogo.html, /<img/);
});

test('construirCorreoAlertas: el boton al panel solo sale si hay URL', () => {
  const con = construirCorreoAlertas([alerta()], { urlPanel: 'https://gtc/costeo?panel=alertas' });
  assert.match(con.html, /Abrir el panel de Alertas/);
  assert.match(con.html, /https:\/\/gtc\/costeo\?panel=alertas/);

  const sin = construirCorreoAlertas([alerta()]);
  assert.doesNotMatch(sin.html, /Abrir el panel de Alertas/);
});

// ---------------------------------------------------------------
// El recorte a "sin corregir": un correo con las 49 alertas del dia se
// archiva sin leer; uno con las que llevan una semana clavadas, no.
// ---------------------------------------------------------------

test('construirCorreoAlertas: deja fuera las alertas recien detectadas', () => {
  const { asunto, texto } = construirCorreoAlertas([
    alerta({ tipo: 'VIEJA', dias_abierta: 7, nivel: 'ceo' }),
    alerta({ tipo: 'DE-HOY', dias_abierta: 0 }),
    alerta({ tipo: 'SIN-CAMPO', dias_abierta: undefined }),
  ]);
  assert.match(asunto, /1 alerta\(s\) sin corregir/);
  assert.match(texto, /VIEJA/);
  assert.doesNotMatch(texto, /DE-HOY/);
  assert.doesNotMatch(texto, /SIN-CAMPO/);
});

// Los dias 3 a 5 son la ventana del PM para resolverlo sin que suba; con
// nivel 'ceo' el correo se recorta a lo que ya escalo (6+ dias).
test('construirCorreoAlertas: nivel "ceo" deja solo las que ya escalaron', () => {
  const entrada = [
    alerta({ tipo: 'PM-4DIAS', dias_abierta: 4, nivel: 'pm' }),
    alerta({ tipo: 'CEO-8DIAS', dias_abierta: 8, nivel: 'ceo' }),
  ];
  const ceo = construirCorreoAlertas(entrada, { nivel: 'ceo' });
  assert.match(ceo.texto, /CEO-8DIAS/);
  assert.doesNotMatch(ceo.texto, /PM-4DIAS/);

  const ambas = construirCorreoAlertas(entrada);
  assert.match(ambas.texto, /PM-4DIAS/, 'sin nivel entran las dos');
});

// El tramo contrario al de arriba. Importa que sean COMPLEMENTARIOS: se manda
// un correo al CEO (6+) y otro al PM (3-5), y ninguna alerta puede salir en
// los dos o alguien la veria duplicada y la contaria dos veces.
test('construirCorreoAlertas: nivel "pm" deja solo la ventana de 3 a 5 dias', () => {
  const entrada = [
    alerta({ tipo: 'PM-4DIAS', dias_abierta: 4, nivel: 'pm' }),
    alerta({ tipo: 'CEO-8DIAS', dias_abierta: 8, nivel: 'ceo' }),
  ];
  const pm = construirCorreoAlertas(entrada, { nivel: 'pm' });
  assert.match(pm.texto, /PM-4DIAS/);
  assert.doesNotMatch(pm.texto, /CEO-8DIAS/, 'lo que ya escalo al CEO no vuelve al PM');

  // Ni una sola alerta en comun entre los dos correos.
  const ceo = construirCorreoAlertas(entrada, { nivel: 'ceo' });
  for (const tipo of ['PM-4DIAS', 'CEO-8DIAS']) {
    const enPm = pm.texto.includes(tipo);
    const enCeo = ceo.texto.includes(tipo);
    assert.ok(enPm !== enCeo, `${tipo} debe salir en exactamente uno de los dos correos`);
  }
});

// El correo se reenvia y se lee fuera de la herramienta, donde nadie sabe de
// quien es cada proyecto: sin el dueno a la vista, una alerta critica no tiene
// a quien reclamarle.
test('construirCorreoAlertas: muestra el dueno del proyecto en el HTML y en el texto', () => {
  const con = construirCorreoAlertas([
    alerta({ tipo: 'Vencido', dias_abierta: 4, dueno: 'Monica Bastidas' }),
  ]);
  assert.match(con.html, /Dueno: Monica Bastidas/);
  assert.match(con.texto, /\[dueno: Monica Bastidas\]/);

  // Las globales (cross-proyecto) no son de nadie en particular: no se
  // inventa un dueno ni se pinta la pastilla vacia.
  const sinDueno = construirCorreoAlertas([alerta({ tipo: 'Vencido', dias_abierta: 4 })]);
  assert.doesNotMatch(sinDueno.html, /Dueno:/);
  assert.doesNotMatch(sinDueno.texto, /dueno:/);
});

test('construirCorreoAlertas: escapa el nombre del dueno', () => {
  const con = construirCorreoAlertas([
    alerta({ tipo: 'Vencido', dias_abierta: 4, dueno: '<script>alert(1)</script>' }),
  ]);
  assert.doesNotMatch(con.html, /<script>/);
});

test('construirCorreoAlertas: incluirTodas manda el listado completo', () => {
  const { asunto, texto } = construirCorreoAlertas([
    alerta({ tipo: 'VIEJA', dias_abierta: 7 }),
    alerta({ tipo: 'DE-HOY', dias_abierta: 0 }),
  ], { incluirTodas: true });
  assert.match(asunto, /2 alerta\(s\)/);
  assert.doesNotMatch(asunto, /sin corregir/);
  assert.match(texto, /DE-HOY/);
});

// ---------------------------------------------------------------
// mailer: lo que decide si se envia o no
// ---------------------------------------------------------------

test('faltaParaEnviar: lista exactamente los campos del .env que faltan', () => {
  const guardado = { ...process.env };
  try {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.MAIL_FROM;
    assert.deepStrictEqual(faltaParaEnviar(), ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']);

    process.env.SMTP_HOST = 'smtp.office365.com';
    process.env.SMTP_USER = 'costeo@gtc.com';
    process.env.SMTP_PASSWORD = 'x';
    process.env.MAIL_FROM = 'GTC <costeo@gtc.com>';
    assert.deepStrictEqual(faltaParaEnviar(), [], 'con todo puesto no deberia faltar nada');

    // Un campo en blanco es lo que deja el .env.example: cuenta como ausente,
    // no como configurado.
    process.env.SMTP_HOST = '   ';
    assert.deepStrictEqual(faltaParaEnviar(), ['SMTP_HOST']);
  } finally {
    process.env = guardado;
  }
});

test('destinatarios: acepta lista separada por coma o punto y coma, y limpia lo que sobra', () => {
  assert.deepStrictEqual(destinatarios('a@gtc.com, b@gtc.com'), ['a@gtc.com', 'b@gtc.com']);
  assert.deepStrictEqual(destinatarios('a@gtc.com; b@gtc.com ;'), ['a@gtc.com', 'b@gtc.com']);
  assert.deepStrictEqual(destinatarios('  '), []);
});

test('destinatarios: sin parametro cae en ALERTAS_EMAIL_TO', () => {
  const guardado = process.env.ALERTAS_EMAIL_TO;
  try {
    process.env.ALERTAS_EMAIL_TO = 'ceo@gtc.com';
    assert.deepStrictEqual(destinatarios(null), ['ceo@gtc.com']);
    assert.deepStrictEqual(destinatarios('otro@gtc.com'), ['otro@gtc.com'], 'el parametro manda');
  } finally {
    if (guardado === undefined) delete process.env.ALERTAS_EMAIL_TO;
    else process.env.ALERTAS_EMAIL_TO = guardado;
  }
});

test('correosInvalidos: caza el dedazo antes de abrir la conexion', () => {
  assert.deepStrictEqual(correosInvalidos(['ok@gtc.com']), []);
  assert.deepStrictEqual(correosInvalidos(['ok@gtc.com', 'sin-arroba', 'a@b']), ['sin-arroba', 'a@b']);
});
