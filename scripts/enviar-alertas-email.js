'use strict';

/**
 * Envia por correo las alertas abiertas de Costeo, a mano.
 *
 * El envio automatico de todos los dias NO pasa por aqui: lo hace
 * src/services/alertas-email-scheduler.js dentro del propio servidor. Este
 * script queda para disparar uno puntual o para previsualizar. Los dos usan
 * el MISMO src/services/alertas-email.js, para que no puedan mandar cosas
 * distintas.
 *
 *   node scripts/enviar-alertas-email.js
 *   node scripts/enviar-alertas-email.js --to alguien@empresa.com
 *   node scripts/enviar-alertas-email.js --previsualizar
 *   node scripts/enviar-alertas-email.js --solo-criticas
 *   node scripts/enviar-alertas-email.js --ventana-pm     (solo las de 3 a 5 dias)
 *   node scripts/enviar-alertas-email.js --todas          (tambien las de hoy)
 *
 * --previsualizar NO envia nada: escribe el HTML en un archivo y dice donde
 * quedo. Es la forma de revisar como se ve el correo HOY, sin credenciales
 * SMTP y sin molestar a nadie.
 *
 * Corre con permisos de CEO (ve todos los centros): un correo automatico no
 * tiene sesion de usuario, y el sentido de este aviso es justamente mirar el
 * portafolio completo.
 *
 * Y por eso manda EXACTAMENTE lo que la pestaña "sin corregir" del panel le
 * muestra a un admin/ceo: solo las que ya escalaron a nivel ceo (6+ dias).
 * Antes mandaba tambien las de 3 a 5 dias — la ventana que el panel le
 * reserva al PM para resolverlas antes de que suban (ver esSinCorregir en
 * public/js/costeo-alertas.js) — asi que el CEO recibia por correo alertas
 * que su propio panel no le mostraba, y los numeros no cuadraban.
 *
 * --ventana-pm manda el tramo contrario: SOLO las de 3 a 5 dias, que son las
 * que todavia estan en manos del PM. Los dos tramos son complementarios (una
 * alerta o lleva 3-5 dias o lleva 6+, nunca las dos), asi que se le puede
 * mandar a cada audiencia su correo sin que nadie reciba la misma dos veces.
 *
 * --lider <correo> acota el correo a los proyectos de UN PM (los que tiene
 * activos en mp_project_owners), en vez del portafolio entero:
 *
 *   node scripts/enviar-alertas-email.js --ventana-pm \
 *     --lider correo_pm@empresa.com --to destinatario@empresa.com
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pool } = require('../src/db');
const { prepararCorreo, enviarAlertas } = require('../src/services/alertas-email');
const { faltaParaEnviar, destinatarios } = require('../src/lib/mailer');
const { logoDataUri } = require('../src/lib/brand');

function argumento(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? (process.argv[i + 1] || true) : null;
}

let salida = 0;

async function main() {
  const previsualizar = process.argv.includes('--previsualizar');
  const to = argumento('--to');
  const lider = argumento('--lider');
  const opciones = {
    nivel: process.argv.includes('--ventana-pm') ? 'pm' : 'ceo',
    lider: lider ? String(lider) : null,
    incluirTodas: process.argv.includes('--todas'),
    soloCriticas: process.argv.includes('--solo-criticas'),
  };

  try {
    if (previsualizar) {
      // En el navegador el logo tiene que ir como data: URI; un cid solo
      // existe dentro de un correo.
      const { correo, alertas, enElCorreo } = await prepararCorreo({ ...opciones, logoSrc: logoDataUri() });
      const destino = path.join(os.tmpdir(), `alertas-costeo-${Date.now()}.html`);
      fs.writeFileSync(destino, correo.html, 'utf8');
      console.log(`Asunto: ${correo.asunto}`);
      console.log(`En el correo: ${enElCorreo} de ${alertas.length} alerta(s) abiertas`);
      console.log(`Vista previa escrita en: ${destino}`);
      console.log('(abrelo en el navegador; NO se envio ningun correo)');
      return;
    }

    // Se comprueba ANTES de calcular nada: armar el correo entero para
    // descubrir al final que no hay con que mandarlo es tiempo (y unas
    // cuantas consultas pesadas) tirados a la basura.
    const falta = faltaParaEnviar();
    if (falta.length) {
      console.error(`No se envio nada: falta ${falta.join(', ')} en el .env.`);
      console.error('Mientras tanto puedes revisar como queda con: --previsualizar');
      salida = 1;
      return;
    }
    if (!destinatarios(to).length) {
      console.error('No se envio nada: indica --to alguien@dominio o define ALERTAS_EMAIL_TO en el .env.');
      salida = 1;
      return;
    }

    const r = await enviarAlertas({ ...opciones, to });
    console.log(`Enviado a ${r.enviadoA.join(', ')} — ${r.enElCorreo} alerta(s) sin corregir. id: ${r.messageId}`);
  } catch (err) {
    console.error('[enviar-alertas-email]', err.message);
    salida = 1;
  } finally {
    await pool.end();
  }
}

// El codigo de salida se fija aqui afuera y no dentro de main(): lo unico que
// ve un programador de tareas es ese codigo, y asi queda puesto pase lo que
// pase con el cierre del pool.
main().finally(() => { process.exitCode = salida; });
