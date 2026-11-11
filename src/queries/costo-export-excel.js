'use strict';

/**
 * 5.3 — Exportación de indicadores y alertas a Excel (exceljs, generado en
 * memoria). Alcance acordado: Sheet 1 "Indicadores" (17 indicadores) +
 * Sheet 2 "Alertas" (las mismas que ve el usuario en el panel Alertas).
 */

const ExcelJS = require('exceljs');
const { indicatorRows } = require('./costo-export-format');
const { logoBuffer } = require('../lib/brand');

// Deep Blue 500 (#25007A), el azul principal de la marca: el mismo de las
// bandas del PDF y del encabezado del dashboard (ver COLOR.navy en
// src/lib/brand.js).
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25007A' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

// Alto de la fila del logo en puntos. ExcelJS mide imágenes en píxeles pero
// el alto de fila en puntos (1pt ≈ 1.333px) — sin fijar esto la fila nace
// con el alto por defecto (~15pt) y el logo, que no se recorta a la celda,
// se monta visualmente sobre la fila del título de abajo.
const LOGO_ROW_HEIGHT_PT = 58;
const LOGO_HEIGHT_PX = 70;

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
}

// Inserta una fila nueva en el tope de la hoja con el logo de GTC (mismo
// archivo que usa el dashboard, ver src/lib/brand.js). Si el logo no se
// pudo leer, no rompe la exportación: la hoja sale igual, solo sin logo.
function addLogoRow(wb, sheet) {
  const buf = logoBuffer();
  sheet.insertRow(1, []);
  if (!buf) return;
  sheet.getRow(1).height = LOGO_ROW_HEIGHT_PT;
  const imageId = wb.addImage({ buffer: buf, extension: 'png' });
  sheet.addImage(imageId, {
    tl: { col: 0.1, row: 0.08 },
    ext: { width: LOGO_HEIGHT_PX * (216 / 181), height: LOGO_HEIGHT_PX },
  });
}

// ctx: { titulo, ind17, alertas }
function buildIndicadoresWorkbook(ctx) {
  const { titulo, ind17, alertas } = ctx;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GTC — Módulo de Costeo';
  wb.created = new Date();

  const shIndicadores = wb.addWorksheet('Indicadores');
  shIndicadores.columns = [
    { header: '#', key: 'num', width: 6 },
    { header: 'Indicador', key: 'name', width: 40 },
    { header: 'Valor', key: 'value', width: 30 },
  ];
  styleHeaderRow(shIndicadores.getRow(1));
  shIndicadores.addRows(indicatorRows(ind17));
  shIndicadores.insertRow(1, [titulo]);
  shIndicadores.mergeCells('A1:C1');
  shIndicadores.getRow(1).font = { bold: true, size: 13 };
  styleHeaderRow(shIndicadores.getRow(2));
  addLogoRow(wb, shIndicadores);

  const shAlertas = wb.addWorksheet('Alertas');
  shAlertas.columns = [
    { header: 'Severidad', key: 'severidad', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 32 },
    { header: 'Categoría', key: 'categoria', width: 18 },
    { header: 'Proyecto', key: 'project_name', width: 26 },
    { header: 'Detalle', key: 'detalle', width: 55 },
  ];
  styleHeaderRow(shAlertas.getRow(1));
  for (const a of alertas) {
    shAlertas.addRow({
      severidad: a.severidad,
      tipo: a.tipo,
      categoria: a.categoria,
      project_name: a.project_name || 'Global',
      detalle: a.detalle,
    });
  }
  if (!alertas.length) shAlertas.addRow({ severidad: '', tipo: 'Sin alertas abiertas', categoria: '', project_name: '', detalle: '' });
  addLogoRow(wb, shAlertas);

  return wb;
}

module.exports = { buildIndicadoresWorkbook };
