'use strict';

/**
 * POST /api/indicator/export/pdf-graficos — la opción "Gráficos" del botón
 * "PDF envío semanal" (a pedido explícito, ago 2026): en vez de recalcular
 * nada, incrusta en un PDF las imágenes que el navegador ya capturó de cada
 * chart con echarts' getDataURL() (ver exportarGraficos() en
 * public/js/indicators.js) — es "lo que ya se ve", no un cálculo aparte.
 */

const assert = require('node:assert/strict');
const { prepararSuite, conBase } = require('../helpers/suite');

const ctx = prepararSuite();

// 1x1 pixel PNG blanco, base64 real (el mas chico posible), para probar
// la incrustacion sin depender de una captura real de echarts.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

conBase(ctx, 'genera un PDF valido con las imagenes recibidas, y el nombre de archivo incluye el proyecto', async () => {
  const r = await ctx.clientes.ceo.post('/api/indicator/export/pdf-graficos', {
    filtrosLabel: 'Mes: Agosto',
    project: 'ALFA',
    imagenes: [
      { num: 9, name: 'Semáforo de gestión', dataUrl: PNG_1X1 },
      { num: 1, name: '% Cumplimiento semanal', dataUrl: PNG_1X1 },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.buffer && r.buffer.length > 500);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
  assert.match(r.headers.get('content-disposition') || '', /planeacion-graficos-alfa-\d{4}-\d{2}-\d{2}\.pdf/);
});

conBase(ctx, 'sin imagenes no revienta, genera igual un PDF (con el aviso de "sin gráficos")', async () => {
  const r = await ctx.clientes.ceo.post('/api/indicator/export/pdf-graficos', { imagenes: [] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});

conBase(ctx, 'descarta en silencio una imagen con dataUrl invalido, sin tumbar las demas', async () => {
  const r = await ctx.clientes.ceo.post('/api/indicator/export/pdf-graficos', {
    imagenes: [
      { num: 1, name: 'x', dataUrl: 'esto-no-es-un-data-url' },
      { num: 2, name: 'y', dataUrl: PNG_1X1 },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});

conBase(ctx, 'sin filtrosLabel/project (valores por defecto), igual genera el PDF', async () => {
  const r = await ctx.clientes.ana.post('/api/indicator/export/pdf-graficos', {
    imagenes: [{ num: 1, name: 'Uno', dataUrl: PNG_1X1 }],
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /planeacion-graficos-\d{4}-\d{2}-\d{2}\.pdf/);
});

// HALLAZGO (ago 2026): un gráfico ancho y corto (pocas filas, ej.
// "Velocidad de cierre" con pocos recursos) se veía diminuto en el PDF
// porque se encogía a la fuerza dentro de una caja fija de 260pt de alto.
// El fix manda width/height reales del chart (ver exportarGraficos() en
// indicators.js) para calcular su tamaño en proporción — esta prueba solo
// confirma que mandar esos campos (con distintas proporciones, incluida
// una muy ancha-y-corta) no rompe nada y sigue produciendo un PDF válido.
conBase(ctx, 'con width/height reales (proporciones distintas, incluida una muy ancha) sigue generando un PDF valido', async () => {
  const r = await ctx.clientes.ceo.post('/api/indicator/export/pdf-graficos', {
    filtrosLabel: 'Todos los proyectos',
    imagenes: [
      { num: 9, name: 'Semáforo de gestión', dataUrl: PNG_1X1, width: 800, height: 800 }, // cuadrado
      { num: 15, name: 'Velocidad de cierre', dataUrl: PNG_1X1, width: 900, height: 180 }, // ancho y corto
      { num: 16, name: 'Actividad diaria por recurso', dataUrl: PNG_1X1, width: 900, height: 500 },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.buffer && r.buffer.length > 500);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});

// width/height vienen del navegador (inst.getWidth()/getHeight()), pero el
// endpoint no puede confiar ciegamente en lo que llegue en el body — un
// valor negativo, en texto o ausente no debe romper el cálculo de
// proporción (ver sufijoProyectoParaArchivo / streamPlaneacionGraficosPdf).
conBase(ctx, 'width/height invalidos (negativos, en texto, ausentes) caen al valor por defecto sin romper el PDF', async () => {
  const r = await ctx.clientes.ceo.post('/api/indicator/export/pdf-graficos', {
    imagenes: [
      { num: 1, name: 'Negativo', dataUrl: PNG_1X1, width: -900, height: -180 },
      { num: 2, name: 'Texto', dataUrl: PNG_1X1, width: 'ancho', height: 'alto' },
      { num: 3, name: 'Ausente', dataUrl: PNG_1X1 },
      { num: 4, name: 'Cero', dataUrl: PNG_1X1, width: 0, height: 0 },
    ],
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.buffer && r.buffer.length > 500);
  assert.strictEqual(r.buffer.subarray(0, 4).toString(), '%PDF');
});
