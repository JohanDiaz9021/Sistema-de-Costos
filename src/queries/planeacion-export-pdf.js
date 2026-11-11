'use strict';

/**
 * Exportación a PDF de los 18 indicadores de Planeación, para el envío
 * semanal (Bloque 4 del pedido "1,2,3,4" del 24 ago 2026). Mismo patrón que
 * costo-export-pdf.js: pdfkit en memoria, sin dependencias externas.
 *
 * Cada indicador tiene una forma de dato distinta (aggregate() de
 * src/queries/indicator-XX.js), así que en vez de intentar imprimir toda la
 * estructura, SUMMARIZERS reduce cada una a una sola línea legible — el
 * mismo número que ve el usuario en la tarjeta del dashboard, no un cálculo
 * nuevo. Si un indicador no tiene datos para el filtro elegido, se imprime
 * "Sin datos" en vez de fallar.
 */

const PDFDocument = require('pdfkit');
const { COLOR, drawLogo, LOGO_RATIO } = require('../lib/brand');

const SEMAPHORE_LABEL = { green: 'Verde', amber: 'Ámbar', red: 'Rojo', grey: 'Sin datos' };

function pct(n) {
  return n === null || n === undefined ? 'Sin datos' : `${n}%`;
}

const SUMMARIZERS = {
  1: (d) => {
    const validos = (d.series || []).filter((s) => s.compliance_pct !== null);
    if (!validos.length) return 'Sin datos de cumplimiento en el periodo.';
    const avg = validos.reduce((s, x) => s + x.compliance_pct, 0) / validos.length;
    return `${avg.toFixed(1)}% cumplimiento promedio en ${d.series.length} semana(s) — meta ${d.target_pct}%.`;
  },
  2: (d) => (d.finished ? `${pct(d.pct)} a tiempo (${d.on_time}/${d.finished} entregas).` : 'Sin entregas registradas en el periodo.'),
  3: (d) => `${d.total} actividad(es) vencidas sin cerrar.`,
  4: (d) => (d.finished ? `${d.avg_days ?? 'Sin datos'} día(s) de desfase promedio — ${d.on_time} a tiempo, ${d.late} con retraso (${d.finished} entregadas).` : 'Sin actividades terminadas en el periodo.'),
  5: (d) => `${pct(d.completed_pct)} terminadas (${d.buckets.Terminado}/${d.total}) — ${d.buckets['En Progreso']} en progreso, ${d.buckets.Bloqueado} bloqueada(s).`,
  6: (d) => `${pct(d.pct)} bloqueadas (${d.blocked}/${d.total} actividades).`,
  7: (d) => `${d.totals.executed}h ejecutadas de ${d.totals.budgeted}h presupuestadas (${d.totals.ratio_pct}%).`,
  8: (d) => {
    const validos = (d.rows || []).filter((r) => r.compliance_pct !== null);
    if (!d.rows.length) return 'Sin datos de recursos en el periodo.';
    const avg = validos.length ? validos.reduce((s, x) => s + x.compliance_pct, 0) / validos.length : null;
    return `${d.rows.length} recurso(s) — cumplimiento promedio ${avg === null ? 'sin datos' : avg.toFixed(1) + '%'}.`;
  },
  9: (d) => `Semáforo global: ${SEMAPHORE_LABEL[d.global.semaphore] || d.global.semaphore} — ${pct(d.global.compliance_pct)} cumplimiento, ${d.global.blocked} bloqueada(s).`,
  10: (d) => {
    const compartidos = (d.rows || []).filter((r) => r.project_count > 1).length;
    return `${compartidos} recurso(s) trabajando en más de un proyecto (de ${d.rows.length} en total).`;
  },
  11: (d) => `${pct(d.pct)} no planeadas (${d.unplanned}/${d.total} actividades).`,
  12: (d) => `${pct(d.pct)} tasa de reestimación (${d.reestimated}/${d.total})` + (d.top_reasons?.[0] ? ` — motivo principal: ${d.top_reasons[0].motivo} (${d.top_reasons[0].count}).` : '.'),
  13: (d) => `Interno ${pct(d.interno_pct)} · Externo ${pct(d.externo_pct)} · Otro ${pct(d.otro_pct)} (${d.total} imprevisto(s)).`,
  14: (d) => {
    if (!d.employees.length) return 'Sin datos de carga de trabajo en el periodo.';
    let overloads = 0;
    for (const fila of d.matrix) for (const celda of fila) if (celda.overload) overloads++;
    return `${d.employees.length} recurso(s), ${d.weeks.length} semana(s) — ${overloads} caso(s) de sobrecarga.`;
  },
  15: (d) => {
    if (!d.rows.length) return 'Sin entregas terminadas en el periodo.';
    const onTime = d.rows.reduce((s, r) => s + r.early + r.on_time, 0);
    const tarde = d.rows.reduce((s, r) => s + r.late_1_3 + r.late_4plus, 0);
    return `${onTime} entrega(s) a tiempo o antes, ${tarde} con retraso — ${d.rows.length} recurso(s) con cierres.`;
  },
  16: (d) => {
    if (!d.employees.length) return 'Sin datos de actividad diaria en el periodo.';
    let overloads = 0;
    for (const e of d.employees) for (const dia of e.days) if (dia.overload) overloads++;
    return `${d.employees.length} recurso(s) — ${overloads} día(s)-persona con sobrecarga.`;
  },
  17: (d) => `${d.totals.total_tasks_modified} tarea(s) con fecha estimada modificada — ${d.totals.employees_affected} recurso(s) afectado(s), ${d.totals.total_days_pushed} día(s) de atraso acumulado.`,
  18: (d) => {
    if (!d.podium.length) return `Sin candidatos elegibles este mes (mínimo 3 tareas terminadas). Total evaluados: ${d.total_eligible}.`;
    const top = d.podium[0];
    return `🏆 ${top.canonical_name} lidera el mes (score ${top.score}) — ${d.podium.length} en el podio, ${d.mentions.length} mención(es) honorífica(s).`;
  },
};

function summarizeIndicator(n, data) {
  try {
    const fn = SUMMARIZERS[n];
    if (!fn || !data) return 'Sin datos.';
    return fn(data);
  } catch {
    return 'Sin datos suficientes para resumir.';
  }
}

// ===================== Diseño del PDF =====================
// La paleta oficial GTC vive en src/lib/brand.js — antes estaba copiada
// aquí, y una copia de la marca es una copia que se desactualiza sola el
// día que cambien los colores. El reporte debe verse como una extensión
// del dashboard, no como una plantilla genérica.

// Color de acento por frecuencia — mismo lenguaje visual que las pastillas
// SEMANAL/DIARIO/MENSUAL de las tarjetas del dashboard (public/index.html).
function badgeColor(badge) {
  if (badge.includes('MENSUAL')) return COLOR.purple;
  if (badge.includes('SEMANAL') && badge.includes('DIARIO')) return COLOR.blueMid;
  if (badge.includes('SEMANAL')) return COLOR.teal;
  return COLOR.yellow; // DIARIO
}

const MARGIN = 44;
const PAGE_WIDTH = 595.28; // A4 pt
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const PAGE_BOTTOM = 780;
const HEADER_HEIGHT = 108;

function drawBrandHeader(doc, filtrosLabel, pageNum) {
  doc.rect(0, 0, PAGE_WIDTH, HEADER_HEIGHT).fill(COLOR.navy);
  // Franja de acento — mismo detalle que el borde superior de las tarjetas del dashboard.
  doc.rect(0, HEADER_HEIGHT - 4, PAGE_WIDTH, 4).fill(COLOR.tealBright);

  // Logo real de GTC, alineado a la derecha debajo de la pastilla de
  // página. Reemplaza al texto "GTC" que hacía de marca antes. Va en la
  // franja de 90px que el título ya reservaba a la derecha
  // (width: CONTENT_WIDTH - 90), así que no se monta con nada. y=54 (no 50):
  // con el recuadro blanco del logo (drawLogo agrega su propio padding), a
  // y=50 quedaba a 1.92pt de la pastilla — prácticamente pegados.
  const altoLogo = 36;
  drawLogo(doc, PAGE_WIDTH - MARGIN - altoLogo * LOGO_RATIO - altoLogo * 0.16, 54, altoLogo);

  doc.fillColor('#979CCB').font('Helvetica').fontSize(7.5)
    .text('MONITOREO DE PLANEACIÓN', MARGIN, 30, { characterSpacing: 1 });

  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(19)
    .text('Reporte Semanal de Planeación', MARGIN, 50, { width: CONTENT_WIDTH - 90 });

  doc.fillColor('#B9BCDC').font('Helvetica').fontSize(9.5)
    .text(filtrosLabel, MARGIN, 78, { width: CONTENT_WIDTH - 90 });

  const fecha = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
  doc.fillColor('#686FB3').font('Helvetica').fontSize(7.5)
    .text(`Generado el ${fecha}`, MARGIN, 92);

  // Pill "Pág. N" arriba a la derecha, como el resto de pastillas del sistema.
  doc.roundedRect(PAGE_WIDTH - MARGIN - 58, 24, 58, 18, 9).fillOpacity(0.12).fill(COLOR.white).fillOpacity(1);
  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(8)
    .text(`Pág. ${pageNum}`, PAGE_WIDTH - MARGIN - 58, 29, { width: 58, align: 'center' });
}

function addPage(doc, filtrosLabel, pageNum) {
  doc.addPage();
  drawBrandHeader(doc, filtrosLabel, pageNum);
  return HEADER_HEIGHT + 26;
}

// Una "tarjeta" por indicador: número en badge navy, nombre + pastilla de
// frecuencia coloreada, resumen debajo — el mismo lenguaje visual que las
// cards del dashboard (public/index.html .card / .badge).
function drawIndicatorCard(doc, it, y, zebra) {
  const CARD_PAD = 12;
  const NUM_W = 30;
  const summaryWidth = CONTENT_WIDTH - CARD_PAD * 2 - NUM_W - 10;
  const summaryHeight = doc.font('Helvetica').fontSize(9.5).heightOfString(it.value, { width: summaryWidth });
  const cardHeight = Math.max(52, 30 + summaryHeight);

  if (zebra) {
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, cardHeight, 6).fill(COLOR.grey);
  } else {
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, cardHeight, 6).lineWidth(0.75).strokeColor(COLOR.border).stroke();
  }

  // Badge circular con el número del indicador.
  const cx = MARGIN + CARD_PAD + NUM_W / 2;
  const cy = y + CARD_PAD + 9;
  doc.circle(cx, cy, 12).fill(COLOR.navy);
  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(9.5)
    .text(String(it.num), cx - 12, cy - 5, { width: 24, align: 'center' });

  const textX = MARGIN + CARD_PAD + NUM_W;
  const textWidth = CONTENT_WIDTH - CARD_PAD * 2 - NUM_W;

  doc.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(10.5)
    .text(it.name, textX, y + CARD_PAD - 2, { width: textWidth - 78, lineBreak: false, ellipsis: true });

  // Pastilla de frecuencia, alineada a la derecha del nombre.
  const bColor = badgeColor(it.badge);
  const pillWidth = Math.min(78, 8 + it.badge.length * 4.1);
  const pillX = MARGIN + CONTENT_WIDTH - CARD_PAD - pillWidth;
  doc.roundedRect(pillX, y + CARD_PAD - 4, pillWidth, 14, 7).fillOpacity(0.14).fill(bColor).fillOpacity(1);
  doc.fillColor(bColor).font('Helvetica-Bold').fontSize(6.4)
    .text(it.badge, pillX, y + CARD_PAD, { width: pillWidth, align: 'center', characterSpacing: 0.3 });

  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9.5)
    .text(it.value, textX, y + CARD_PAD + 16, { width: summaryWidth });

  return y + cardHeight + 9;
}

// items: [{ num, name, badge, value }]
function streamPlaneacionPdf(res, { filtrosLabel, items }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  doc.pipe(res);

  let pageNum = 1;
  drawBrandHeader(doc, filtrosLabel, pageNum);
  let y = HEADER_HEIGHT + 26;

  items.forEach((it, i) => {
    // Estimación conservadora de alto antes de dibujar, para no partir una
    // tarjeta entre dos páginas.
    const estHeight = Math.max(52, 30 + doc.font('Helvetica').fontSize(9.5).heightOfString(it.value, { width: CONTENT_WIDTH - 24 - 30 - 10 }));
    if (y + estHeight > PAGE_BOTTOM) {
      pageNum += 1;
      y = addPage(doc, filtrosLabel, pageNum);
    }
    y = drawIndicatorCard(doc, it, y, i % 2 === 0);
  });

  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text(
    'Documento generado automáticamente por el módulo de Planeación (GTC). Los valores reflejan el estado de la base de datos al momento de la descarga.',
    MARGIN, Math.min(y + 10, PAGE_BOTTOM + 4), { width: CONTENT_WIDTH }
  );

  doc.end();
}

// PDF alterno al de arriba: en vez del resumen en texto de cada indicador,
// incrusta la IMAGEN de cada gráfico tal como se ve en pantalla (capturada
// en el navegador con echarts' getDataURL() — ver exportarGraficos() en
// public/js/indicators.js). Es "lo que ya se ve", no un recálculo del lado
// del servidor: si el usuario filtró algo, el gráfico que mandó ya viene
// filtrado.
//
// images: [{ num, name, dataUrl, width, height }] — dataUrl es
// "data:image/png;base64,...". width/height son el tamaño REAL del chart en
// pantalla (inst.getWidth()/getHeight() de ECharts, ver exportarGraficos())
// — sin esto, un gráfico ancho y corto (pocas filas, ej. #15/#16 con pocos
// recursos) se encogía a la fuerza dentro de una caja fija pensada para uno
// cuadrado y quedaba diminuto (caso real reportado). Con la proporción real
// se calcula cuánto puede crecer sin deformarse, usando el espacio que
// quede disponible en la página.
function streamPlaneacionGraficosPdf(res, { filtrosLabel, imagenes }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  doc.pipe(res);

  let pageNum = 1;
  drawBrandHeader(doc, filtrosLabel, pageNum);
  let y = HEADER_HEIGHT + 26;

  if (!imagenes.length) {
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(11)
      .text('No hay gráficos disponibles para exportar con los filtros actuales.', MARGIN, y, { width: CONTENT_WIDTH });
  }

  const TITULO_ALTO = 20;
  // Techo para que un gráfico casi cuadrado (pocos, con mucha altura por
  // categoría) no termine ocupando la página entera él solo.
  const IMG_ALTO_TECHO = 480;
  const ASPECTO_POR_DEFECTO = 0.5; // fallback si por algo no llegó width/height

  imagenes.forEach((img) => {
    const aspecto = img.width > 0 && img.height > 0 ? img.height / img.width : ASPECTO_POR_DEFECTO;
    const altoDeseado = Math.min(CONTENT_WIDTH * aspecto, IMG_ALTO_TECHO);

    // Si en lo que queda de la página actual no entra ni el título ni un
    // tamaño razonable del gráfico, se pasa de página ANTES de dibujar —
    // así el gráfico no queda encogido solo porque abajo quedaba poco aire.
    const espacioDisponible = PAGE_BOTTOM - y - TITULO_ALTO;
    if (espacioDisponible < Math.min(altoDeseado, 160)) {
      pageNum += 1;
      y = addPage(doc, filtrosLabel, pageNum);
    }

    doc.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(11)
      .text(`#${img.num} · ${img.name}`, MARGIN, y, { width: CONTENT_WIDTH });
    y += TITULO_ALTO;

    // Alto final: lo deseado, topado por lo que de verdad quede en esta
    // página (por si el techo de 480 igual no alcanzara a caber completo).
    const altoFinal = Math.min(altoDeseado, PAGE_BOTTOM - y);

    try {
      const base64 = img.dataUrl.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      doc.image(buffer, MARGIN, y, { fit: [CONTENT_WIDTH, altoFinal], align: 'center' });
    } catch (err) {
      doc.fillColor(COLOR.muted).font('Helvetica').fontSize(9)
        .text('No se pudo incrustar esta imagen.', MARGIN, y);
    }
    y += altoFinal + 20;
  });

  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text(
    'Documento generado automáticamente por el módulo de Planeación (GTC) — captura de los gráficos en pantalla al momento de la descarga.',
    MARGIN, Math.min(y + 10, PAGE_BOTTOM + 4), { width: CONTENT_WIDTH }
  );

  doc.end();
}

module.exports = { summarizeIndicator, streamPlaneacionPdf, streamPlaneacionGraficosPdf };
