'use strict';

/**
 * Indicadores, alertas y exportacion — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { buildIndicadoresWorkbook } = require('../../queries/costo-export-excel');
const { desgloseEjecutado } = require('../../queries/costo-motor');
const { parseFilters } = require('../../queries/_common');
const { projectScopeClause } = require('../../middleware/scope');
const { query } = require('../../db');
const { streamIndicadoresPdf } = require('../../queries/costo-export-pdf');
const { computeIndicadores17, computeIndicadoresPortafolio } = require('../../queries/costo-indicadores-17');
const {
  generarAlertasParaCentro, generarAlertasGlobales, ordenarPorSeveridad,
  getDuenosPorCentro, anotarDuenoDeProyecto,
} = require('../../queries/costo-alertas');
const {
  sincronizarEventos, getEscalamientos, anotarDiasAbierta,
  buscarEventoAbierto, guardarCorregida,
} = require('../../queries/costo-alertas-eventos');
const { getCentrosVisibles, canWriteCenter } = require('./_shared');
const { logAudit } = require('../../queries/costo-audit');
const { requireRole } = require('../../middleware/auth');
const { construirCorreoAlertas } = require('../../queries/costo-alertas-email');
const { enviarCorreo, mailerConfigurado, faltaParaEnviar } = require('../../lib/mailer');
const { logoDataUri, LOGO_PATH } = require('../../lib/brand');
// La fecha del nombre del archivo descargado es la del día en Colombia,
// no la de UTC (ver src/lib/fecha-negocio.js).
const { fechaNegocioISO } = require('../../lib/fecha-negocio');

const router = express.Router();

// ---------------------------------------------------------------
// Meses disponibles PARA COSTEO (8 sep 2026, a pedido explícito): el
// desplegable de Periodo usaba /api/filters, que lee mp_task_facts (la
// tabla de PLANEACIÓN, que recibe horas a diario por el RPA) — no
// mp_costeo_task_facts (la que de verdad usa este motor, que depende de
// que alguien suba el Excel a mano por proyecto). Resultado: el
// desplegable ofrecía meses como "Junio" que Costeo nunca tuvo, y
// filtrar por ellos daba una falsa sensación de que sí había datos (bug
// aparte, ya corregido en costo-motor.js: mesYAnio() no resolvía esos
// meses y el filtro de horas extra/gastos se saltaba en silencio).
// ---------------------------------------------------------------

router.get('/meses', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT DISTINCT month_name, month_number, year_number
         FROM mp_costeo_task_facts
        WHERE month_name IS NOT NULL
        ORDER BY year_number, month_number`
    );
    res.json({ months: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Indicadores (HU 2.4) — costoLaboralEjecutado, costoExtraAprobado,
// costoNoPlaneadoTotal y ejecutadoTotal por cada centro visible.
// ---------------------------------------------------------------

router.get('/indicadores', async (req, res, next) => {
  try {
    const scopeF = projectScopeClause(req.scope, 'project_folder');
    const centros = await query(
      `SELECT cost_center_id, project_name, budget
         FROM mp_centro_costo
        WHERE 1=1 ${scopeF.clause}
        ORDER BY project_name`,
      scopeF.params
    );

    const porCentro = await Promise.all(
      centros.map(async (c) => {
        const desglose = await desgloseEjecutado(c.cost_center_id);
        return {
          cost_center_id: c.cost_center_id,
          project_name: c.project_name,
          budget: Number(c.budget) || 0,
          costo_laboral_ejecutado: desglose.laboral,
          costo_extra_aprobado: desglose.extra,
          costo_no_planeado_total: desglose.noPlaneado,
          ejecutado_total: desglose.total,
        };
      })
    );

    const totales = porCentro.reduce(
      (acc, c) => ({
        presupuesto: acc.presupuesto + c.budget,
        costo_laboral_ejecutado: acc.costo_laboral_ejecutado + c.costo_laboral_ejecutado,
        costo_extra_aprobado: acc.costo_extra_aprobado + c.costo_extra_aprobado,
        costo_no_planeado_total: acc.costo_no_planeado_total + c.costo_no_planeado_total,
        ejecutado_total: acc.ejecutado_total + c.ejecutado_total,
      }),
      { presupuesto: 0, costo_laboral_ejecutado: 0, costo_extra_aprobado: 0, costo_no_planeado_total: 0, ejecutado_total: 0 }
    );

    res.json({ centros: porCentro, totales });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Los 17 indicadores (Fase 2.5) — fórmula exacta de la Especificación
// Técnica/Maestra, por cada centro visible para el usuario.
// ---------------------------------------------------------------

router.get('/indicadores-17', async (req, res, next) => {
  try {
    const centros = await getCentrosVisibles(req.scope);
    // Periodo (mes/semana) y Recurso (talento) recortan el GASTO; el
    // presupuesto y el valor de contrato del centro no se filtran, porque
    // son propiedades del proyecto y no del recorte que se esté mirando.
    const filters = parseFilters(req.query);

    const [porCentro, portafolio] = await Promise.all([
      Promise.all(centros.map((c) => computeIndicadores17(c, filters))),
      computeIndicadoresPortafolio(centros.filter((c) => c.status !== 'inactivo'), filters),
    ]);
    res.json({ centros: porCentro, portafolio });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Las 21 alertas (Fase 2.6) — se recalculan en vivo, sin nadie que las pida.
// ---------------------------------------------------------------

// El calculo vive aparte de la ruta porque lo necesitan DOS salidas: la
// pantalla (GET /alertas) y el correo (POST /alertas/email). Duplicarlo
// significaria que un dia el correo avise de algo distinto de lo que se ve en
// el panel, que es la peor forma de perderle la confianza a una alerta.
async function calcularAlertas(scope, filters) {
  const centros = await getCentrosVisibles(scope);

  const porCentro = await Promise.all(
    centros.map(async (c) => {
      const ind17 = await computeIndicadores17(c, filters);
      return generarAlertasParaCentro(c, ind17, filters);
    })
  );

  // Las alertas que cruzan varios proyectos solo tienen sentido para quien
  // puede ver mas de un centro de costos (admin/ceo).
  const incluyeGlobales = scope.allowedProjects === null;
  const globales = incluyeGlobales ? await generarAlertasGlobales() : [];
  const todas = ordenarPorSeveridad([...porCentro.flat(), ...globales]);

  await sincronizarEventos(todas, { costCenterIds: centros.map((c) => c.cost_center_id), incluyeGlobales });

  const scopeF = projectScopeClause(scope, 'cc.project_folder');
  const [escalamientos, duenos] = await Promise.all([
    getEscalamientos(scopeF),
    getDuenosPorCentro(scopeF),
  ]);
  // El correo dice de quien es cada alerta. Va aqui y no en GET /alertas
  // porque el panel ya agrupa por proyecto y el dueno se sabe por contexto;
  // en el correo, que se reenvia y se lee fuera de la herramienta, no.
  return {
    alertas: anotarDuenoDeProyecto(anotarDiasAbierta(todas, escalamientos), duenos),
    escalamientos,
    centros,
  };
}

router.get('/alertas', async (req, res, next) => {
  try {
    const centros = await getCentrosVisibles(req.scope);
    const filters = parseFilters(req.query);

    const porCentro = await Promise.all(
      centros.map(async (c) => {
        const ind17 = await computeIndicadores17(c, filters);
        const alertas = await generarAlertasParaCentro(c, ind17, filters);
        return alertas;
      })
    );

    // Las alertas que cruzan varios proyectos solo tienen sentido para
    // quien puede ver más de un centro de costos (admin/ceo).
    const incluyeGlobales = req.scope.allowedProjects === null;
    const globales = incluyeGlobales ? await generarAlertasGlobales() : [];

    const todas = ordenarPorSeveridad([...porCentro.flat(), ...globales]);

    // Seguimiento/escalamiento (a pedido explícito, 1 sep 2026): cada vez
    // que alguien abre Alertas, se sincroniza lo detectado AHORA contra el
    // historial (mp_alerta_evento) — así "lleva 3 días sin corregirse" se
    // puede responder de verdad. Solo se sincroniza lo que ESTE usuario
    // puede ver (sus centros, o todos si es admin/ceo) — sincronizar no
    // debe poder cerrar por accidente la alerta de un centro ajeno que ni
    // se recalculó en esta llamada (ver sincronizarEventos).
    await sincronizarEventos(todas, { costCenterIds: centros.map((c) => c.cost_center_id), incluyeGlobales });

    const scopeF = projectScopeClause(req.scope, 'cc.project_folder');
    const escalamientos = await getEscalamientos(scopeF);

    // Las alertas viajan ya marcadas con los días que llevan abiertas: el
    // panel las resalta dentro de la lista completa en vez de repetirlas en
    // una lista aparte.
    res.json({ alertas: anotarDiasAbierta(todas, escalamientos), escalamientos });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Alertas por correo (HTML). Queda montado y probado desde ya; el envio
// real arranca el dia que el .env tenga las credenciales SMTP — hasta
// entonces responde 503 diciendo QUE campo falta, no un error generico.
//
// El destinatario se deja libre a proposito: llega en el cuerpo (`to`) o,
// si no viene, sale de ALERTAS_EMAIL_TO. Asi el mismo endpoint sirve para
// "mandamelo a mi ahora" y para el envio automatico de scripts/.
//
// Solo admin/ceo: mandar correo es una accion hacia afuera, y el scope de un
// PM haria que el mismo endpoint enviara contenidos distintos segun quien lo
// llame, que es justo lo que no se quiere de un aviso corporativo.
// ---------------------------------------------------------------

// Identificador del logo adjunto en linea (<img src="cid:logo-gtc">). El
// mismo que usa scripts/enviar-alertas-email.js.
const LOGO_CID = 'logo-gtc';

// "Corregido" — quien atiende una alerta afirma que ya la resolvió
// (16 sep 2026, a pedido explícito).
//
// NO cierra la alerta, y esa es toda la idea: el motor recalcula desde los
// datos en cada pasada, así que si el problema sigue ahí la vuelve a
// detectar. Marcarla la esconde de "sin corregir" el resto del día; mañana
// lo confirman los datos, no la persona. Si se corrigió de verdad, muere
// sola; si no, reaparece — y con TODOS los días que lleva, porque
// primera_vez_at no se toca (ver sql/41: reiniciarlo dejaría esquivar el
// escalamiento al CEO marcando cada mañana).
//
// Abierto a leader además de admin/ceo: quien tiene el problema es quien lo
// corrige. El alcance lo acota igual — canWriteCenter impide marcar una
// alerta de un proyecto ajeno.
router.post('/alertas/corregida', requireRole('admin', 'ceo', 'leader'), async (req, res, next) => {
  try {
    const clave = String(req.body?.clave_dedup || '').trim();
    if (!clave) return res.status(400).json({ error: 'Falta clave_dedup' });

    const evento = await buscarEventoAbierto(clave);
    // 404 y no 409: para quien mira la pantalla, una alerta que ya se cerró
    // sola entre que cargó la página y pulsó el botón es indistinguible de
    // una que nunca existió — en los dos casos ya no hay nada que corregir.
    if (!evento) return res.status(404).json({ error: 'Esa alerta ya no está abierta.' });

    if (!(await canWriteCenter(req.scope, evento.cost_center_id))) {
      return res.status(403).json({ error: 'No tienes permiso sobre ese centro de costos' });
    }

    await guardarCorregida(evento.evento_id, req.session.user.user_id);

    await logAudit({
      costCenterId: evento.cost_center_id, entityType: 'alerta', entityId: evento.evento_id, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `Marcó como corregida la alerta "${evento.tipo}" — se confirma mañana con los datos`,
    });

    res.json({ ok: true, tipo: evento.tipo });
  } catch (err) {
    next(err);
  }
});

router.get('/alertas/email/estado', requireRole('admin', 'ceo'), (_req, res) => {
  res.json({ configurado: mailerConfigurado(), falta: faltaParaEnviar() });
});

// ?previsualizar=1 devuelve el HTML sin enviar nada: sirve para ver como
// queda el correo AHORA, sin credenciales y sin molestar a nadie.
router.post('/alertas/email', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const previsualizar = req.query.previsualizar === '1';
    const filters = parseFilters(req.query);
    const { alertas } = await calcularAlertas(req.scope, filters);

    const cuerpo = req.body || {};
    const correo = construirCorreoAlertas(alertas, {
      proyecto: cuerpo.proyecto ? String(cuerpo.proyecto) : null,
      urlPanel: cuerpo.urlPanel || `${req.protocol}://${req.get('host')}/costeo?panel=alertas`,
      // Por defecto el correo lleva lo MISMO que la pestaña "sin corregir"
      // del panel le muestra a quien puede llamar esta ruta (solo admin/ceo,
      // ver requireRole arriba): las que ya escalaron a nivel ceo, 6+ dias.
      // Antes el defecto era `undefined`, que ademas incluia la ventana de 3
      // a 5 dias que el panel le reserva al PM — el CEO recibia por correo
      // alertas que su propio panel no le mostraba (ver esSinCorregir en
      // public/js/costeo-alertas.js). Un `nivel` explicito en el cuerpo sigue
      // mandando, y `incluirTodas: true` manda el listado completo.
      nivel: cuerpo.nivel === undefined ? 'ceo' : cuerpo.nivel,
      incluirTodas: cuerpo.incluirTodas === true,
      // En el navegador el logo tiene que ir como data: URI (un cid solo
      // existe dentro de un correo); al enviar va adjunto en linea.
      logoSrc: previsualizar ? logoDataUri() : `cid:${LOGO_CID}`,
    });

    if (previsualizar) {
      return res.type('html').send(correo.html);
    }

    const resultado = await enviarCorreo({
      to: req.body && req.body.to,
      subject: correo.asunto,
      html: correo.html,
      text: correo.texto,
      // contentDisposition: 'inline' es obligatorio para que el logo se vea
      // EN el cuerpo del correo (mismo motivo documentado en
      // scripts/enviar-alertas-email.js): nodemailer lo manda como
      // 'attachment' por defecto aunque se le pase `cid`.
      attachments: [{ filename: 'logo_gtc.png', path: LOGO_PATH, cid: LOGO_CID, contentDisposition: 'inline' }],
    });
    return res.json({ enviado: true, alertas: alertas.length, ...resultado });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------
// Exportación de indicadores (5.2 PDF / 5.3 Excel). Mismo scope y misma
// selección de centro/portafolio que /indicadores-17 y /alertas — sin
// ?centro= exporta el portafolio agregado, con ?centro=ID exporta solo
// ese centro (y valida que esté dentro del scope del usuario).
// ---------------------------------------------------------------

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'reporte';
}

// Resuelve qué se va a exportar: un centro puntual (?centro=ID, validado
// contra el scope) o el portafolio agregado de todos los centros activos
// visibles. Devuelve null si no hay nada que exportar (centro inexistente,
// fuera de scope, o sin ningún centro activo para el portafolio).
async function resolveExportContext(req) {
  const centroId = req.query.centro ? Number(req.query.centro) : null;
  const centros = await getCentrosVisibles(req.scope);

  if (centroId) {
    const centro = centros.find((c) => c.cost_center_id === centroId);
    if (!centro) return null;
    const ind17 = await computeIndicadores17(centro);
    const alertas = await generarAlertasParaCentro(centro, ind17);
    return { titulo: centro.project_name, ind17, alertas };
  }

  const activos = centros.filter((c) => c.status !== 'inactivo');
  const ind17 = await computeIndicadoresPortafolio(activos);
  if (!ind17) return null;

  const porCentroAlertas = await Promise.all(
    activos.map(async (c) => generarAlertasParaCentro(c, await computeIndicadores17(c)))
  );
  const globales = req.scope.allowedProjects === null ? await generarAlertasGlobales() : [];
  const alertas = ordenarPorSeveridad([...porCentroAlertas.flat(), ...globales]);

  return { titulo: 'Todos los proyectos (portafolio)', ind17, alertas };
}

router.get('/indicadores-17/export/pdf', async (req, res, next) => {
  try {
    const ctx = await resolveExportContext(req);
    if (!ctx) return res.status(404).json({ error: 'Centro de costos no encontrado o sin datos para exportar' });

    const filename = `indicadores-costeo-${slugify(ctx.titulo)}-${fechaNegocioISO()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    streamIndicadoresPdf(res, ctx);
  } catch (err) {
    next(err);
  }
});

router.get('/indicadores-17/export/xlsx', async (req, res, next) => {
  try {
    const ctx = await resolveExportContext(req);
    if (!ctx) return res.status(404).json({ error: 'Centro de costos no encontrado o sin datos para exportar' });

    const wb = buildIndicadoresWorkbook(ctx);
    const filename = `indicadores-costeo-${slugify(ctx.titulo)}-${fechaNegocioISO()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
