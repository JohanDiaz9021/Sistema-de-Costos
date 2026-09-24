'use strict';

/**
 * Arma el correo HTML con las alertas de Costeo.
 *
 * Funcion PURA: recibe las alertas ya calculadas (las mismas que devuelve
 * GET /api/costeo/alertas) y devuelve { asunto, html, texto }. No consulta la
 * base ni envia nada — asi se puede probar el correo entero sin credenciales
 * y sin conexion (ver scripts/enviar-alertas-email.js --previsualizar).
 *
 * El correo lleva SOLO las alertas SIN CORREGIR (11 sep 2026, a pedido
 * explicito): las que el motor viene detectando desde hace 3 dias o mas y
 * nadie ha resuelto. Es la misma definicion del panel (ver esSinCorregir en
 * costeo-alertas.js) y la razon de fondo es la misma: un correo con las 49
 * alertas del dia se archiva sin leer; uno con las que llevan una semana
 * clavadas, no. Las alertas recien detectadas ya se ven en pantalla.
 *
 * COMO SE LEE (11 sep 2026, a pedido explicito de mejorar la vista): el
 * correo esta armado para responder tres preguntas en ese orden, sin
 * scrollear de mas —
 *   1. cuanto hay y que tan grave (el bloque de cifras de arriba),
 *   2. a que proyecto le duele (las alertas van agrupadas POR PROYECTO, no
 *      en una lista plana: quien lee decide por proyecto, no por tipo),
 *   3. desde cuando (los dias, a la derecha de cada linea, que es lo que
 *      separa "hay que mirarlo" de "esto lleva dos semanas").
 *
 * El HTML se escribe como se escriben los correos, no como se escribe una
 * pagina: tablas para maquetar y estilos EN LINEA. Outlook ignora buena parte
 * de un <style> y no entiende flex ni grid, asi que un correo hecho con divs
 * se ve bien en el navegador y se desarma en el cliente real.
 */

const { COLOR } = require('../lib/brand');

// Mismos colores y mismo orden de severidad que el panel de Alertas
// (costeo.css / costeo-alertas.js), para que el correo y la pantalla se lean
// como lo mismo.
const SEVERIDAD = {
  critica: { etiqueta: 'Critica', texto: '#B3261E', fondo: '#FDECEC', orden: 0 },
  alta: { etiqueta: 'Alta', texto: '#8A6400', fondo: '#FFF3CD', orden: 1 },
  media: { etiqueta: 'Media', texto: COLOR.blueMid, fondo: '#EDE9F7', orden: 2 },
  baja: { etiqueta: 'Baja', texto: COLOR.muted, fondo: '#F3F4FA', orden: 3 },
};

const GRIS_FONDO = '#F3F4FA';
const BORDE = '#DCDCEA';

function escapar(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function formatFechaLarga(fecha) {
  const f = fecha || new Date();
  return f.getDate() + ' de ' + MESES[f.getMonth()] + ' de ' + f.getFullYear();
}

function severidadDe(a) {
  return SEVERIDAD[a && a.severidad] || SEVERIDAD.baja;
}

function contarPorSeveridad(alertas) {
  return alertas.reduce((acc, a) => {
    const sev = SEVERIDAD[a.severidad] ? a.severidad : 'baja';
    acc[sev] = (acc[sev] || 0) + 1;
    return acc;
  }, {});
}

// Las criticas primero y, dentro de cada severidad, las que llevan mas dias
// sin corregirse: un correo se lee de arriba hacia abajo y muchas veces solo
// las primeras lineas.
function ordenar(alertas) {
  return [...alertas].sort((a, b) => {
    const sa = severidadDe(a).orden;
    const sb = severidadDe(b).orden;
    if (sa !== sb) return sa - sb;
    return (b.dias_abierta || 0) - (a.dias_abierta || 0);
  });
}

// "Sin corregir" es exactamente lo que marca el panel: la alerta trae
// dias_abierta porque tiene un escalamiento abierto (>= 3 dias, ver
// getEscalamientos).
//
// `nivel` recorta ese conjunto al tramo de escalamiento, que es el mismo
// valor que ya calcula getEscalamientos ('pm' de 3 a 5 dias, 'ceo' de 6 en
// adelante — ver costo-alertas-eventos.js):
//
//   'ceo'      -> solo las de 6+ dias: lo que el panel le muestra a admin/ceo.
//   'pm'       -> solo la ventana de 3 a 5 dias: la oportunidad que tiene el
//                 PM de resolverlo ANTES de que suba al CEO. Existe para poder
//                 mandarle a cada audiencia lo suyo sin que se pisen: los dos
//                 tramos son complementarios, ninguna alerta sale en ambos.
//   undefined  -> las dos cosas (todo lo que lleve 3+ dias abierto).
function sinCorregir(alertas, nivel) {
  return (alertas || []).filter((a) => {
    if (!a || !a.dias_abierta) return false;
    if (nivel === 'ceo' || nivel === 'pm') return a.nivel === nivel;
    return true;
  });
}

// Agrupa por proyecto conservando el orden interno (ya viene por severidad y
// dias). Los proyectos se ordenan por la alerta MAS grave que tengan y, a
// igualdad, por cuantas acumulan: arriba queda a quien mas le duele.
function agruparPorProyecto(alertas) {
  const mapa = new Map();
  alertas.forEach((a) => {
    const nombre = a.project_name || 'Sin proyecto';
    if (!mapa.has(nombre)) mapa.set(nombre, []);
    mapa.get(nombre).push(a);
  });
  return [...mapa.entries()]
    .map(([nombre, lista]) => ({
      nombre,
      lista,
      peor: Math.min(...lista.map((a) => severidadDe(a).orden)),
      diasMax: Math.max(...lista.map((a) => a.dias_abierta || 0)),
    }))
    .sort((a, b) => (a.peor !== b.peor ? a.peor - b.peor
      : (b.lista.length !== a.lista.length ? b.lista.length - a.lista.length
        : b.diasMax - a.diasMax)));
}

// Cifra grande + etiqueta. Es lo primero que se ve y muchas veces lo unico
// que se lee, asi que va en celdas de tabla (no en flex) para que Outlook las
// deje en fila.
function tarjetaCifra(valor, etiqueta, color) {
  return '<td width="33%" align="center" style="padding:14px 8px;background:' + GRIS_FONDO
    + ';border-radius:10px;">'
    + '<div style="font-size:30px;line-height:1;font-weight:700;color:' + color + ';">' + valor + '</div>'
    + '<div style="margin-top:6px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:'
    + COLOR.muted + ';">' + etiqueta + '</div>'
    + '</td>';
}

function resumenHTML(conteo, total) {
  const criticas = conteo.critica || 0;
  const altas = conteo.alta || 0;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
    + 'style="border-collapse:separate;border-spacing:8px 0;">'
    + '<tr>'
    + tarjetaCifra(total, 'Sin corregir', COLOR.navy)
    + tarjetaCifra(criticas, 'Criticas', criticas ? SEVERIDAD.critica.texto : COLOR.muted)
    + tarjetaCifra(altas, 'Altas', altas ? SEVERIDAD.alta.texto : COLOR.muted)
    + '</tr></table>';
}

// Encabezado de cada proyecto: nombre a la izquierda, cuantas alertas a la
// derecha. Sirve de separador visual sin necesidad de una tabla por proyecto.
function tituloProyectoHTML(grupo) {
  return '<tr><td colspan="2" style="padding:22px 20px 8px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="font-size:15px;font-weight:700;color:' + COLOR.navy + ';">'
    + escapar(grupo.nombre) + '</td>'
    + '<td align="right" style="font-size:12px;color:' + COLOR.muted + ';">'
    + grupo.lista.length + ' alerta' + (grupo.lista.length === 1 ? '' : 's') + '</td>'
    + '</tr></table></td></tr>';
}

// Una alerta = una fila con barra de color a la izquierda (la severidad se
// reconoce sin leer), el que y el porque en el medio, y los dias a la
// derecha. El borde de color va como celda de 4px y no como border-left
// porque Outlook redondea mal los bordes finos.
function filaHTML(a) {
  const sev = severidadDe(a);
  const dias = a.dias_abierta || 0;
  return '<tr>'
    + '<td width="4" style="background:' + sev.texto + ';font-size:0;line-height:0;">&nbsp;</td>'
    + '<td style="padding:12px 16px;border-bottom:1px solid ' + BORDE + ';background:#ffffff;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="vertical-align:top;">'
    + '<div style="font-size:14px;font-weight:700;color:' + COLOR.text + ';">' + escapar(a.tipo) + '</div>'
    + '<div style="margin-top:3px;font-size:13px;line-height:1.5;color:' + COLOR.muted + ';">'
    + escapar(a.detalle) + '</div>'
    + '<div style="margin-top:7px;">'
    + '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:10.5px;'
    + 'font-weight:700;letter-spacing:.3px;text-transform:uppercase;background:' + sev.fondo
    + ';color:' + sev.texto + ';">' + sev.etiqueta + '</span>'
    // Quien responde por esta alerta, al lado de la severidad. Se repite en
    // cada fila (y no una vez por proyecto) a proposito: el correo se lee en
    // diagonal y muchas veces solo se mira la fila que duele, asi que el
    // responsable tiene que estar AHI y no en un encabezado mas arriba.
    + (a.dueno
      ? '<span style="display:inline-block;margin-left:6px;padding:2px 9px;border-radius:20px;'
        + 'font-size:10.5px;font-weight:700;letter-spacing:.3px;background:' + GRIS_FONDO
        + ';color:' + COLOR.muted + ';">Dueno: ' + escapar(a.dueno) + '</span>'
      : '')
    + '</div>'
    + '</td>'
    + '<td align="right" width="92" style="vertical-align:top;white-space:nowrap;">'
    + (dias
      ? '<div style="font-size:22px;font-weight:700;line-height:1;color:' + sev.texto + ';">' + dias + '</div>'
        + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:'
        + COLOR.muted + ';margin-top:3px;">dia' + (dias === 1 ? '' : 's') + ' sin<br />corregir</div>'
      : '')
    + '</td>'
    + '</tr></table>'
    + '</td></tr>';
}

/**
 * @param {Array}  alertas  las mismas que devuelve GET /api/costeo/alertas
 * @param {Object} opciones { urlPanel, fecha, proyecto, nivel, incluirTodas, logoSrc }
 *   nivel: 'ceo' recorta a las de 6 dias o mas (lo que ve admin/ceo en el panel).
 *   incluirTodas: true manda TODAS las abiertas, no solo las sin corregir.
 *   logoSrc: de donde sale el logo. En el correo real es 'cid:...' (adjunto
 *     en linea); para previsualizar en el navegador, un data: URI. Sin este
 *     dato el correo sale igual, solo que sin logo.
 * @returns {{asunto: string, html: string, texto: string}}
 */
function construirCorreoAlertas(alertas, opciones) {
  const opts = opciones || {};
  const urlPanel = opts.urlPanel || '';
  const fecha = opts.fecha || new Date();
  const proyecto = opts.proyecto || null;
  const logoSrc = opts.logoSrc || '';

  // El filtro va DENTRO y no en quien llama: asi el endpoint y el script
  // mandan lo mismo sin ponerse de acuerdo, que es la unica forma de que el
  // correo diario y el manual no se contradigan.
  const lista = opts.incluirTodas ? (alertas || []) : sinCorregir(alertas, opts.nivel);

  const ordenadas = ordenar(lista);
  const conteo = contarPorSeveridad(ordenadas);
  const criticas = conteo.critica || 0;
  const total = ordenadas.length;
  const grupos = agruparPorProyecto(ordenadas);

  // El asunto se lee en la bandeja sin abrir nada: lleva el numero y, si hay
  // criticas, cuantas. Un asunto fijo hace que el correo se ignore.
  const alcance = proyecto ? ' - ' + proyecto : '';
  const que = opts.incluirTodas ? ' alerta(s)' : ' alerta(s) sin corregir';
  const asunto = total === 0
    ? 'Costeo' + alcance + ': ninguna alerta lleva dias sin corregirse'
    : 'Costeo' + alcance + ': ' + total + que
      + (criticas ? ', ' + criticas + ' critica(s)' : '');

  // Una linea que explique QUE es esto, antes de la lista. Sin ella, quien
  // recibe el correo por primera vez no sabe por que le llegan estas y no
  // las otras.
  const explicacion = opts.incluirTodas
    ? 'Todas las alertas abiertas del modulo de Costeo en este momento.'
    : 'Alertas que el motor viene detectando desde hace 3 dias o mas y siguen sin resolverse. '
      + 'Las detectadas hoy no entran aqui: se ven en el panel.';

  const vacio = '<tr><td style="padding:10px 20px 26px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
    + 'style="background:' + GRIS_FONDO + ';border-radius:10px;"><tr>'
    + '<td align="center" style="padding:28px 20px;font-size:14px;color:' + COLOR.muted + ';">'
    + 'Ninguna alerta lleva dias sin corregirse.<br />'
    + '<span style="font-size:12.5px;">Lo que el motor detecto hoy se ve en el panel.</span>'
    + '</td></tr></table></td></tr>';

  const cuerpo = total === 0
    ? vacio
    : grupos.map((g) => tituloProyectoHTML(g)
      + '<tr><td colspan="2" style="padding:0 20px;">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
      + 'style="border-collapse:collapse;border:1px solid ' + BORDE + ';border-radius:10px;overflow:hidden;">'
      + g.lista.map(filaHTML).join('')
      + '</table></td></tr>').join('');

  const boton = urlPanel
    ? '<tr><td style="padding:24px 20px 4px;" align="center">'
      + '<a href="' + escapar(urlPanel) + '" style="display:inline-block;background:' + COLOR.navy
      + ';color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 26px;'
      + 'border-radius:8px;">Abrir el panel de Alertas</a></td></tr>'
    : '';

  // El <img> lleva los estilos de TEXTO a proposito (color de marca, negrita,
  // espaciado): Outlook y Gmail bloquean las imagenes de remitentes que no
  // estan en la lista de seguros —es politica del cliente de correo, no algo
  // que el que envia pueda desactivar— y en ese caso pintan el `alt` con los
  // estilos del propio <img>. Asi, con imagenes bloqueadas el encabezado dice
  // "GTC CORPORATION" en morado de marca en vez de quedar en blanco, que es
  // como se veia antes y parecia un correo roto.
  const cabeceraLogo = logoSrc
    ? '<tr><td align="center" style="background:#ffffff;padding:20px 24px 16px;border-bottom:1px solid '
      + BORDE + ';"><img src="' + escapar(logoSrc) + '" alt="GTC CORPORATION" width="104" '
      + 'style="display:block;margin:0 auto;width:104px;height:auto;border:0;'
      + 'font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:17px;font-weight:700;'
      + 'letter-spacing:1.5px;color:' + COLOR.navy + ';text-align:center;" /></td></tr>'
    : '';

  const html = [
    '<!doctype html>',
    '<html lang="es">',
    '<head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<title>' + escapar(asunto) + '</title></head>',
    '<body style="margin:0;padding:24px 12px;background:' + GRIS_FONDO
      + ';font-family:Segoe UI,Roboto,Arial,sans-serif;color:' + COLOR.text + ';">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;margin:0 auto;'
      + 'background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ' + BORDE + ';">',

    cabeceraLogo,

    // Banda de marca: que es y de cuando.
    '<tr><td style="background:' + COLOR.navy + ';padding:22px 24px;">',
    '<div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:rgba(255,255,255,.65);'
      + 'font-weight:700;">' + (opts.incluirTodas ? 'Alertas de Costeo' : 'Alertas sin corregir') + '</div>',
    '<div style="font-size:19px;font-weight:700;color:#ffffff;margin-top:4px;">'
      + escapar(proyecto || 'Todos los proyectos') + '</div>',
    '<div style="font-size:12.5px;color:rgba(255,255,255,.7);margin-top:5px;">Corte del '
      + escapar(formatFechaLarga(fecha)) + '</div>',
    '</td></tr>',

    // Cifras + la linea que explica el recorte.
    '<tr><td style="padding:20px 20px 4px;">',
    resumenHTML(conteo, total),
    '</td></tr>',
    '<tr><td style="padding:14px 22px 0;font-size:12.5px;line-height:1.6;color:' + COLOR.muted + ';">',
    explicacion,
    '</td></tr>',

    // Las alertas, agrupadas por proyecto.
    '<tr><td style="padding:0;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">',
    cuerpo,
    '</table>',
    '</td></tr>',

    boton,

    '<tr><td style="padding:22px 24px;font-size:11.5px;color:' + COLOR.muted + ';line-height:1.6;">',
    'Correo automatico del modulo de Costeo. Las alertas se recalculan en vivo sobre Costo Planeado '
      + 'y Costo No Planeado; este corte es el del momento del envio.',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');

  const lineas = [asunto, 'Corte del ' + formatFechaLarga(fecha), ''];
  if (total === 0) {
    lineas.push('Ninguna alerta lleva dias sin corregirse.');
  } else {
    grupos.forEach((g) => {
      lineas.push(g.nombre.toUpperCase() + ' (' + g.lista.length + ')');
      g.lista.forEach((a) => {
        const sev = severidadDe(a).etiqueta;
        const dias = a.dias_abierta ? ' (lleva ' + a.dias_abierta + ' dia(s) sin corregirse)' : '';
        // El mismo dato que la pastilla del HTML: hay clientes que muestran
        // solo esta version, y ahi el responsable no puede desaparecer.
        const dueno = a.dueno ? ' [dueno: ' + a.dueno + ']' : '';
        lineas.push('- [' + sev + '] ' + a.tipo + ' - ' + (a.project_name || 'sin proyecto')
          + ': ' + a.detalle + dias + dueno);
      });
      lineas.push('');
    });
  }
  if (urlPanel) lineas.push('Panel de Alertas: ' + urlPanel);

  return { asunto, html, texto: lineas.join('\n') };
}

module.exports = { construirCorreoAlertas, sinCorregir, SEVERIDAD };
