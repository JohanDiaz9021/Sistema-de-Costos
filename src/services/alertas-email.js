'use strict';

/**
 * Armado y envio del correo de alertas de Costeo.
 *
 * Vive aqui, y no dentro del script de linea de comandos, porque hay DOS
 * cosas que lo necesitan: scripts/enviar-alertas-email.js (a mano, con
 * flags) y alertas-email-scheduler.js (el envio automatico de las 6am). Si
 * cada uno armara el correo por su cuenta terminarian mandando cosas
 * distintas — que es exactamente lo que ya paso entre el panel y el correo
 * y hubo que corregir: el CEO recibia 31 alertas donde su panel le mostraba
 * 15, porque cada lado aplicaba su propio criterio de "sin corregir".
 *
 * Este modulo NO cierra el pool de la base: el script lo hace al terminar
 * porque es un proceso de un solo uso, pero el servidor lo necesita vivo.
 */

const { computeIndicadores17 } = require('../queries/costo-indicadores-17');
const {
  generarAlertasParaCentro, generarAlertasGlobales, ordenarPorSeveridad,
  getDuenosPorCentro, anotarDuenoDeProyecto,
} = require('../queries/costo-alertas');
const {
  sincronizarEventos, getEscalamientos, anotarDiasAbierta,
} = require('../queries/costo-alertas-eventos');
const { getCentrosVisibles } = require('../routes/costeo/_shared');
const { resolveScope } = require('../queries/_common');
const { projectScopeClause } = require('../middleware/scope');
const { construirCorreoAlertas, sinCorregir } = require('../queries/costo-alertas-email');
const { enviarCorreo } = require('../lib/mailer');
const { LOGO_PATH } = require('../lib/brand');

// El logo viaja ADJUNTO y se referencia con cid desde el HTML. La
// disposicion 'inline' no es opcional: nodemailer manda el adjunto como
// 'attachment' por defecto aunque se le pase un cid, y varios clientes
// (Outlook/Exchange entre ellos) entonces no lo insertan en el cuerpo.
const LOGO_CID = 'logo-gtc';
const ADJUNTO_LOGO = {
  filename: 'logo_gtc.png', path: LOGO_PATH, cid: LOGO_CID, contentDisposition: 'inline',
};

// allowedProjects: null es "todos los centros" en el resto del modulo (ver
// src/middleware/scope.js) — no es un descuido, es el scope de admin/ceo.
const SCOPE_COMPLETO = { allowedProjects: null };
const SIN_FILTROS = {};

/**
 * `scope` acota TODO el calculo a un conjunto de proyectos: con
 * SCOPE_COMPLETO es el portafolio entero; con el scope de un lider, solo lo
 * suyo.
 *
 * Es el mismo camino que recorre GET /alertas para una sesion de leader, y
 * se copia a proposito en las dos decisiones que importan:
 *
 *  1. Sin globales fuera de admin/ceo: las alertas que cruzan proyectos no
 *     tienen a que PM recordarselas.
 *  2. sincronizarEventos recibe SOLO los centros que de verdad se
 *     recalcularon aqui. Esa llamada cierra ('resuelta') todo evento abierto
 *     dentro del alcance que le declaren y que no aparezca en la lista, asi
 *     que declarar un alcance mas ancho que lo calculado cerraria por
 *     accidente alertas de centros ajenos y les reiniciaria el contador de
 *     dias sin corregir.
 */
async function alertasDelPortafolio(scope) {
  const centros = await getCentrosVisibles(scope);
  const porCentro = await Promise.all(
    centros.map(async (c) => generarAlertasParaCentro(c, await computeIndicadores17(c, SIN_FILTROS), SIN_FILTROS))
  );
  const incluyeGlobales = scope.allowedProjects === null;
  const globales = incluyeGlobales ? await generarAlertasGlobales() : [];
  const todas = ordenarPorSeveridad([...porCentro.flat(), ...globales]);

  await sincronizarEventos(todas, {
    costCenterIds: centros.map((c) => c.cost_center_id),
    incluyeGlobales,
  });

  // getEscalamientos espera el {clause, params} que arma projectScopeClause,
  // no una cadena: con scope completo la clausula sale vacia, pero el objeto
  // tiene que existir igual.
  const scopeF = projectScopeClause(scope, 'cc.project_folder');
  const [escalamientos, duenos] = await Promise.all([
    getEscalamientos(scopeF),
    getDuenosPorCentro(scopeF),
  ]);
  return anotarDuenoDeProyecto(anotarDiasAbierta(todas, escalamientos), duenos);
}

/**
 * Scope de un PM a partir de su correo (sus project_folder activos en
 * mp_project_owners). Sin `lider` devuelve el portafolio completo.
 *
 * Lanza si ese correo no tiene ningun proyecto activo: projectScopeClause
 * traduce la lista vacia a "AND 1=0", asi que el envio saldria con cero
 * alertas y se leeria como "este PM no tiene nada pendiente" cuando lo que
 * pasa es que el correo esta mal escrito o el PM no tiene asignaciones.
 */
async function resolverScopeDeLider(lider) {
  if (!lider) return SCOPE_COMPLETO;
  const scope = await resolveScope(SCOPE_COMPLETO, String(lider));
  if (scope.allowedProjects && scope.allowedProjects.length === 0) {
    throw new Error(
      `"${lider}" no tiene ningun proyecto activo en mp_project_owners — `
      + 'revisa el correo o la asignacion antes de programar este envio.'
    );
  }
  return scope;
}

function urlDelPanel() {
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  return base ? `${base}/costeo?panel=alertas` : '';
}

/**
 * Arma el correo sin enviarlo. `logoSrc` lo decide quien llama porque no es
 * el mismo para las dos salidas: en el correo real va el cid del adjunto, y
 * en una vista previa de navegador tiene que ser un data: URI (un cid no
 * existe fuera de un correo y saldria la imagen rota).
 *
 * Devuelve tambien `enElCorreo`: cuantas alertas viajan de verdad, que no es
 * lo mismo que cuantas hay abiertas — el resto se ve en el panel.
 */
async function prepararCorreo({ nivel = 'ceo', lider = null, incluirTodas = false, soloCriticas = false, logoSrc }) {
  const scope = await resolverScopeDeLider(lider);
  let alertas = await alertasDelPortafolio(scope);
  if (soloCriticas) alertas = alertas.filter((a) => a.severidad === 'critica');

  const correo = construirCorreoAlertas(alertas, {
    // El filtro por tramo vive dentro de construirCorreoAlertas (ver
    // sinCorregir en costo-alertas-email.js), no aqui.
    nivel,
    incluirTodas,
    logoSrc,
    urlPanel: urlDelPanel(),
  });

  const enElCorreo = incluirTodas ? alertas.length : sinCorregir(alertas, nivel).length;
  return { correo, alertas, enElCorreo };
}

/** Arma y manda. Devuelve lo que hace falta para dejarlo en un log. */
async function enviarAlertas({ nivel = 'ceo', lider = null, to = null, incluirTodas = false, soloCriticas = false }) {
  const { correo, enElCorreo } = await prepararCorreo({
    nivel, lider, incluirTodas, soloCriticas, logoSrc: `cid:${LOGO_CID}`,
  });

  const r = await enviarCorreo({
    to,
    subject: correo.asunto,
    html: correo.html,
    text: correo.texto,
    attachments: [ADJUNTO_LOGO],
  });
  return { ...r, enElCorreo, asunto: correo.asunto };
}

module.exports = {
  LOGO_CID, ADJUNTO_LOGO, SCOPE_COMPLETO,
  alertasDelPortafolio, resolverScopeDeLider, prepararCorreo, enviarAlertas,
};
