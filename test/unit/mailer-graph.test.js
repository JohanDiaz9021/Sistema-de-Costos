'use strict';

/**
 * Envio de correo por Microsoft Graph (src/lib/mailer.js, 26 oct 2026).
 *
 * No sale nada a internet: se reemplaza global.fetch por uno que anota cada
 * peticion y responde lo que responderia Microsoft. Asi se comprueba lo que
 * importa — que se pida el token con las credenciales correctas, que se
 * envie desde el buzon de MAIL_FROM y que el logo vaya en linea — sin
 * depender de la red ni de un secret real.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const mailer = require('../../src/lib/mailer');

const VARS = [
  'MAIL_GRAPH_TENANT_ID', 'MAIL_GRAPH_CLIENT_ID', 'MAIL_GRAPH_CLIENT_SECRET', 'MAIL_FROM',
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD',
];

// Corre `fn` con exactamente estas variables (las demas de VARS, borradas) y
// con fetch reemplazado; deja todo como estaba al terminar.
async function conEntorno(vars, respuestas, fn) {
  const guardado = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  const fetchOriginal = global.fetch;
  const llamadas = [];
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, vars);
  mailer._resetTokenGraph();
  global.fetch = async (url, opts) => {
    llamadas.push({ url: String(url), opts });
    const r = respuestas.shift();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: '',
      json: async () => r.json || {},
      headers: { get: (h) => (h === 'request-id' ? 'req-123' : null) },
    };
  };
  try {
    await fn(llamadas);
  } finally {
    global.fetch = fetchOriginal;
    for (const k of VARS) {
      if (guardado[k] === undefined) delete process.env[k];
      else process.env[k] = guardado[k];
    }
    mailer._resetTokenGraph();
  }
}

const GRAPH = {
  MAIL_GRAPH_TENANT_ID: 'tenant-x',
  MAIL_GRAPH_CLIENT_ID: 'cliente-x',
  MAIL_GRAPH_CLIENT_SECRET: 'secreto-x',
  MAIL_FROM: 'GTC Costeo <notificaciones@empresa.com>',
};
const TOKEN_OK = { status: 200, json: { access_token: 'tok-1', expires_in: 3600 } };

test('faltaParaEnviar: con una sola variable de Graph pide las demas, no cae al SMTP', async () => {
  await conEntorno({ MAIL_GRAPH_CLIENT_ID: 'x', SMTP_HOST: 'smtp.office365.com' }, [], async () => {
    assert.strictEqual(mailer.usaGraph(), true);
    assert.deepStrictEqual(mailer.faltaParaEnviar(), ['MAIL_GRAPH_TENANT_ID', 'MAIL_GRAPH_CLIENT_SECRET', 'MAIL_FROM']);
  });
  await conEntorno(GRAPH, [], async () => {
    assert.deepStrictEqual(mailer.faltaParaEnviar(), []);
  });
});

test('sin variables de Graph sigue mandando por SMTP como antes', async () => {
  await conEntorno({ SMTP_HOST: 'smtp.x.com' }, [], async () => {
    assert.strictEqual(mailer.usaGraph(), false);
    assert.deepStrictEqual(mailer.faltaParaEnviar(), ['SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']);
  });
});

test('partirRemitente: separa nombre y direccion, o deja la direccion sola', () => {
  assert.deepStrictEqual(
    mailer.partirRemitente('GTC Costeo <notificaciones@empresa.com>'),
    { nombre: 'GTC Costeo', direccion: 'notificaciones@empresa.com' }
  );
  assert.deepStrictEqual(
    mailer.partirRemitente('"GTC, Costeo" <a@b.com>'),
    { nombre: 'GTC, Costeo', direccion: 'a@b.com' }
  );
  assert.deepStrictEqual(mailer.partirRemitente('a@b.com'), { nombre: null, direccion: 'a@b.com' });
});

test('enviarCorreo por Graph: pide token y envia desde el buzon de MAIL_FROM con el logo en linea', async () => {
  await conEntorno(GRAPH, [TOKEN_OK, { status: 202 }], async (llamadas) => {
    const r = await mailer.enviarCorreo({
      to: 'pm@empresa.com; ceo@empresa.com',
      subject: 'Alertas',
      html: '<img src="cid:logo"> hola',
      text: 'hola',
      attachments: [{ filename: 'logo_gtc.png', path: path.join(__dirname, '..', '..', 'public', 'img', 'logo_gtc.png'), cid: 'logo' }],
    });

    assert.deepStrictEqual(r, { enviadoA: ['pm@empresa.com', 'ceo@empresa.com'], messageId: 'req-123' });
    assert.strictEqual(llamadas.length, 2);

    const [token, envio] = llamadas;
    assert.strictEqual(token.url, 'https://login.microsoftonline.com/tenant-x/oauth2/v2.0/token');
    const form = new URLSearchParams(String(token.opts.body));
    assert.strictEqual(form.get('client_id'), 'cliente-x');
    assert.strictEqual(form.get('client_secret'), 'secreto-x');
    assert.strictEqual(form.get('grant_type'), 'client_credentials');
    assert.strictEqual(form.get('scope'), 'https://graph.microsoft.com/.default');

    assert.strictEqual(envio.url, 'https://graph.microsoft.com/v1.0/users/notificaciones%40empresa.com/sendMail');
    assert.strictEqual(envio.opts.headers.Authorization, 'Bearer tok-1');
    const { message } = JSON.parse(envio.opts.body);
    assert.strictEqual(message.subject, 'Alertas');
    assert.deepStrictEqual(message.body, { contentType: 'HTML', content: '<img src="cid:logo"> hola' });
    assert.deepStrictEqual(message.toRecipients.map((x) => x.emailAddress.address), ['pm@empresa.com', 'ceo@empresa.com']);
    assert.deepStrictEqual(message.from, { emailAddress: { name: 'GTC Costeo', address: 'notificaciones@empresa.com' } });
    assert.strictEqual(message.attachments.length, 1);
    assert.strictEqual(message.attachments[0].contentId, 'logo');
    assert.strictEqual(message.attachments[0].isInline, true);
    assert.strictEqual(message.attachments[0].contentType, 'image/png');
    assert.ok(message.attachments[0].contentBytes.length > 0);
  });
});

test('reusa el token entre correos en vez de pedir uno por envio', async () => {
  await conEntorno(GRAPH, [TOKEN_OK, { status: 202 }, { status: 202 }], async (llamadas) => {
    await mailer.enviarCorreo({ to: 'a@gtc.com', subject: 's', html: 'h' });
    await mailer.enviarCorreo({ to: 'b@gtc.com', subject: 's', html: 'h' });
    assert.strictEqual(llamadas.filter((l) => l.url.includes('/oauth2/')).length, 1);
  });
});

test('si Microsoft rechaza el token o el envio, falla con un mensaje publico sin detalles internos', async () => {
  await conEntorno(GRAPH, [{ status: 401, json: { error: 'invalid_client', error_description: 'secret vencido' } }], async () => {
    await assert.rejects(
      mailer.enviarCorreo({ to: 'a@gtc.com', subject: 's', html: 'h' }),
      (err) => err.status === 502 && /secret vencido/.test(err.message) && !/secret/.test(err.publicMessage)
    );
  });
  await conEntorno(GRAPH, [TOKEN_OK, { status: 403, json: { error: { message: 'Access denied by policy' } } }], async () => {
    await assert.rejects(
      mailer.enviarCorreo({ to: 'a@gtc.com', subject: 's', html: 'h' }),
      (err) => err.status === 502 && /403/.test(err.message) && /Access denied/.test(err.message)
    );
  });
});
