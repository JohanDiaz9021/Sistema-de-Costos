'use strict';

/**
 * 5.2 — Exportación de indicadores a PDF (pdfkit, generado en memoria,
 * sin dependencias del sistema operativo ni servicios externos).
 *
 * Lleva la identidad corporativa (logo + paleta de src/lib/brand.js), igual
 * que el PDF de Planeación: es un documento que se reenvía por correo y se
 * imprime para reuniones, así que tiene que verse como un reporte de GTC y
 * no como una tabla suelta.
 */

const PDFDocument = require('pdfkit');
const { indicatorRows } = require('./costo-export-format');
const { COLOR, drawLogo } = require('../lib/brand');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_BOTTOM = 780;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const HEADER_HEIGHT = 104;
const HEADER_HEIGHT_CONT = 46; // páginas de continuación: banda delgada
const COL_NUM = MARGIN;
const COL_NAME = MARGIN + 30;
const COL_VALUE = 360;
const ROW_HEIGHT = 22;

// Banda azul con el logo. `titulo` es el alcance del reporte ("Proyecto
// Alfa" o "Todos los proyectos (portafolio)") — las pruebas de aislamiento
// leen justamente ese texto para verificar que un PM no se lleve datos de
// otro proyecto, así que tiene que seguir escribiéndose.
function drawBrandHeader(doc, titulo) {
  doc.rect(0, 0, PAGE_WIDTH, HEADER_HEIGHT).fill(COLOR.navy);
  doc.rect(0, HEADER_HEIGHT - 4, PAGE_WIDTH, 4).fill(COLOR.tealBright);

  // El logo va primero: devuelve el ancho que ocupó (incluido su recuadro
  // blanco) para que el texto de al lado nunca se le monte encima.
  const altoLogo = 42;
  const anchoLogo = drawLogo(doc, CONTENT_RIGHT - altoLogo * (216 / 181), 30, altoLogo);
  const anchoTexto = PAGE_WIDTH - MARGIN * 2 - anchoLogo - 16;

  doc.fillColor('#979CCB').font('Helvetica').fontSize(7.5)
    .text('MONITOREO DE COSTOS', MARGIN, 24, { characterSpacing: 1 });

  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(18)
    .text('Reporte de Indicadores de Costeo', MARGIN, 38, { width: anchoTexto });

  doc.fillColor('#B9BCDC').font('Helvetica').fontSize(10)
    .text(titulo, MARGIN, 64, { width: anchoTexto });

  const fecha = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
  doc.fillColor('#686FB3').font('Helvetica').fontSize(7.5)
    .text(`Generado el ${fecha} — cálculo en vivo, no es un snapshot guardado`, MARGIN, 84, { width: anchoTexto });

  return HEADER_HEIGHT + 22;
}

// Encabezado reducido para la 2ª página en adelante: mantiene la marca sin
// repetir el bloque completo (que se comería media página útil).
function drawBrandHeaderCont(doc, titulo) {
  doc.rect(0, 0, PAGE_WIDTH, HEADER_HEIGHT_CONT).fill(COLOR.navy);
  doc.rect(0, HEADER_HEIGHT_CONT - 3, PAGE_WIDTH, 3).fill(COLOR.tealBright);

  const altoLogo = 24;
  drawLogo(doc, CONTENT_RIGHT - altoLogo * (216 / 181), 8, altoLogo);

  doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(10)
    .text('Reporte de Indicadores de Costeo', MARGIN, 12);
  doc.fillColor('#979CCB').font('Helvetica').fontSize(8)
    .text(titulo, MARGIN, 26);

  return HEADER_HEIGHT_CONT + 18;
}

function drawTableHeader(doc, y) {
  doc.rect(MARGIN, y - 5, CONTENT_RIGHT - MARGIN, 21).fill(COLOR.grey);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.navy);
  doc.text('#', COL_NUM + 4, y, { width: 25 });
  doc.text('Indicador', COL_NAME, y, { width: COL_VALUE - COL_NAME - 10 });
  doc.text('Valor', COL_VALUE, y, { width: CONTENT_RIGHT - COL_VALUE - 4 });
  doc.moveTo(MARGIN, y + 16).lineTo(CONTENT_RIGHT, y + 16).strokeColor(COLOR.border).stroke();
  return y + 24;
}

// Escribe el PDF directo sobre el response (streaming) — ctx: { titulo, ind17 }.
function streamIndicadoresPdf(res, ctx) {
  const { titulo, ind17 } = ctx;
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  doc.pipe(res);

  let y = drawBrandHeader(doc, titulo);
  y = drawTableHeader(doc, y);

  const filas = indicatorRows(ind17);
  filas.forEach((r, i) => {
    if (y > PAGE_BOTTOM) {
      doc.addPage();
      y = drawTableHeader(doc, drawBrandHeaderCont(doc, titulo));
    }
    // Cebra suave: en una tabla de 17 filas a dos columnas ayuda a no
    // saltarse un renglón al leer en papel.
    if (i % 2 === 1) doc.rect(MARGIN, y - 5, CONTENT_RIGHT - MARGIN, ROW_HEIGHT).fill(COLOR.grey);

    doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted)
      .text(String(r.num), COL_NUM + 4, y, { width: 25 });
    doc.fillColor(COLOR.text)
      .text(r.name, COL_NAME, y, { width: COL_VALUE - COL_NAME - 10 });
    doc.font('Helvetica-Bold').fillColor(COLOR.navy)
      .text(r.value, COL_VALUE, y, { width: CONTENT_RIGHT - COL_VALUE - 4 });
    y += ROW_HEIGHT;
  });

  doc.moveTo(MARGIN, y + 8).lineTo(CONTENT_RIGHT, y + 8).strokeColor(COLOR.border).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted).text(
    'Documento generado automáticamente por el módulo de Costeo (GTC Corporation). Los valores reflejan el estado de la base de datos al momento de la descarga.',
    MARGIN, y + 16, { width: CONTENT_RIGHT - MARGIN }
  );

  doc.end();
}

module.exports = { streamIndicadoresPdf };
