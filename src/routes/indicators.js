'use strict';

const express = require('express');
const { parseFilters, parseDrilldownFilters } = require('../queries/_common');
const { summarizeIndicator, streamPlaneacionPdf, streamPlaneacionGraficosPdf } = require('../queries/planeacion-export-pdf');
// La fecha del nombre del archivo descargado es la del día en Colombia,
// no la de UTC (ver src/lib/fecha-negocio.js).
const { fechaNegocioISO } = require('../lib/fecha-negocio');

const router = express.Router();

// Nombre y frecuencia de cada indicador tal como se muestran en las tarjetas
// de public/index.html — el PDF los reproduce en el mismo orden numérico
// (no el orden visual del dashboard) porque es más fácil de auditar en papel.
const INDICATOR_META = {
  1: { name: '% Cumplimiento semanal', badge: 'SEMANAL' },
  2: { name: '% Entrega a tiempo', badge: 'SEMANAL' },
  3: { name: 'Actividades vencidas sin cerrar', badge: 'SEMANAL · DIARIO' },
  4: { name: 'Días de desfase promedio', badge: 'SEMANAL' },
  5: { name: '% Actividades terminadas', badge: 'DIARIO' },
  6: { name: '% Actividades bloqueadas', badge: 'DIARIO' },
  7: { name: 'Horas ejecutadas vs presupuestadas', badge: 'DIARIO' },
  8: { name: 'Indicador general por recurso', badge: 'SEMANAL · DIARIO' },
  9: { name: 'Semáforo de gestión', badge: 'SEMANAL · DIARIO' },
  10: { name: 'Recursos compartidos entre proyectos', badge: 'DIARIO' },
  11: { name: '% Tareas no planeadas', badge: 'SEMANAL' },
  12: { name: 'Tasa de reestimación', badge: 'SEMANAL' },
  13: { name: '% Imprevistos internos vs externos', badge: 'SEMANAL' },
  14: { name: 'Carga de trabajo por recurso', badge: 'DIARIO' },
  15: { name: 'Velocidad de cierre', badge: 'SEMANAL' },
  16: { name: 'Actividad diaria por recurso', badge: 'DIARIO' },
  17: { name: 'Auditoría cambios fecha estimada', badge: 'DIARIO' },
  18: { name: 'Reconocimientos del mes', badge: 'MENSUAL' },
};

// Registro de modulos de indicadores. Cada modulo exporta { aggregate, drilldown }.
const REGISTRY = {
  // DIARIOS
  3:  require('../queries/indicator-03'),
  5:  require('../queries/indicator-05'),
  6:  require('../queries/indicator-06'),
  7:  require('../queries/indicator-07'),
  8:  require('../queries/indicator-08'),
  9:  require('../queries/indicator-09'),
  10: require('../queries/indicator-10'),
  14: require('../queries/indicator-14'),
  16: require('../queries/indicator-16'),
  17: require('../queries/indicator-17'),
  18: require('../queries/indicator-18'),
  // SEMANALES
  1:  require('../queries/indicator-01'),
  2:  require('../queries/indicator-02'),
  4:  require('../queries/indicator-04'),
  11: require('../queries/indicator-11'),
  12: require('../queries/indicator-12'),
  13: require('../queries/indicator-13'),
  15: require('../queries/indicator-15'),
};

router.get('/:n(\\d+)', async (req, res, next) => {
  try {
    const n = Number(req.params.n);
    const mod = REGISTRY[n];
    if (!mod || !mod.aggregate) {
      return res.status(501).json({ error: 'Indicador aun no implementado', indicator: n });
    }
    const filters = parseFilters(req.query);
    const data = await mod.aggregate(req.scope, filters);
    res.json({ indicator: n, filters, data });
  } catch (err) {
    next(err);
  }
});

// Reporte semanal para envío (Bloque 4, ago 2026): PDF con los 18
// indicadores oficiales resumidos en una línea cada uno, respetando los
// mismos filtros (mes/semana/proyecto/recurso/líder) y el scope del usuario
// que ya aplican /api/indicator/:n — un PM solo exporta lo que ya puede ver.
router.get('/export/pdf', async (req, res, next) => {
  try {
    const filters = parseFilters(req.query);

    const partesFiltro = [];
    if (filters.month) partesFiltro.push(`Mes: ${filters.month}`);
    if (filters.week) partesFiltro.push(`Semana ${filters.week}`);
    if (filters.project) partesFiltro.push(`Proyecto: ${filters.project}`);
    if (filters.employee_id) partesFiltro.push(`Recurso #${filters.employee_id}`);
    if (filters.leader) partesFiltro.push(`Líder: ${filters.leader}`);
    const filtrosLabel = partesFiltro.length ? partesFiltro.join(' · ') : 'Todos los proyectos — snapshot más reciente';

    const items = await Promise.all(
      Object.keys(INDICATOR_META).map(async (key) => {
        const n = Number(key);
        const meta = INDICATOR_META[n];
        const mod = REGISTRY[n];
        let value = 'Sin datos.';
        if (mod && mod.aggregate) {
          try {
            const data = await mod.aggregate(req.scope, filters);
            value = summarizeIndicator(n, data);
          } catch {
            value = 'No se pudo calcular con los filtros actuales.';
          }
        }
        return { num: n, name: meta.name, badge: meta.badge, value };
      })
    );
    items.sort((a, b) => a.num - b.num);

    // El nombre del archivo también refleja el proyecto filtrado — si no,
    // descargar el PDF de dos proyectos distintos el mismo día produce el
    // mismo nombre de archivo y el segundo pisa al primero en la carpeta de
    // Descargas sin que se note.
    const filename = `planeacion-semanal${sufijoProyectoParaArchivo(filters.project)}-${fechaNegocioISO()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    streamPlaneacionPdf(res, { filtrosLabel, items });
  } catch (err) {
    next(err);
  }
});

// Nombre de archivo consistente entre /export/pdf y /export/pdf-graficos:
// incluye el proyecto filtrado para que descargar el PDF de dos proyectos
// el mismo día no produzca el mismo nombre (uno pisando al otro).
function sufijoProyectoParaArchivo(project) {
  if (!project) return '';
  return '-' + String(project).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// "Descargar gráficos" del botón "PDF envío semanal" (a pedido explícito:
// además de los datos en texto, poder descargar las imágenes de los
// gráficos tal como se ven en pantalla). El navegador ya calculó y dibujó
// cada chart con echarts — este endpoint no recalcula nada, solo recibe
// las imágenes (PNG en base64, ver exportarGraficos() en
// public/js/indicators.js) y las incrusta en un PDF. Por eso no necesita
// filtros de query: el filtrado ya pasó en el navegador antes de capturar
// la imagen; filtrosLabel/project solo son para el título y el nombre del
// archivo.
router.post('/export/pdf-graficos', async (req, res, next) => {
  try {
    const body = req.body || {};
    const crudas = Array.isArray(body.imagenes) ? body.imagenes.slice(0, 30) : [];
    // Se valida el prefijo del data URL antes de intentar decodificar —
    // cualquier otra cosa que llegue en el campo se descarta en silencio
    // en vez de reventar el PDF entero por una imagen mala.
    const imagenes = crudas
      .filter((img) => img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/png;base64,'))
      .map((img) => ({
        num: Number(img.num) || 0,
        name: String(img.name || '').slice(0, 120),
        dataUrl: img.dataUrl,
        // Tamaño real del chart en pantalla — para que el PDF pueda
        // dibujarlo en su proporción real en vez de encogerlo a la fuerza
        // dentro de una caja fija (ver streamPlaneacionGraficosPdf).
        width: Number(img.width) > 0 ? Number(img.width) : 0,
        height: Number(img.height) > 0 ? Number(img.height) : 0,
      }));

    const filtrosLabel = typeof body.filtrosLabel === 'string' && body.filtrosLabel.trim()
      ? body.filtrosLabel.slice(0, 300)
      : 'Todos los proyectos — snapshot más reciente';

    const filename = `planeacion-graficos${sufijoProyectoParaArchivo(body.project)}-${fechaNegocioISO()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    streamPlaneacionGraficosPdf(res, { filtrosLabel, imagenes });
  } catch (err) {
    next(err);
  }
});

router.get('/:n(\\d+)/drilldown', async (req, res, next) => {
  try {
    const n = Number(req.params.n);
    const mod = REGISTRY[n];
    if (!mod || !mod.drilldown) {
      return res.status(501).json({ error: 'Drilldown aun no implementado', indicator: n });
    }
    // parseDrilldownFilters y no parseFilters: es el único punto del API
    // donde `status` (indicador 5) y `tipo` (indicador 13) significan algo.
    // Ver la nota de QA-07 en src/queries/_common.js.
    const filters = parseDrilldownFilters(req.query);
    const data = await mod.drilldown(req.scope, filters);
    res.json({ indicator: n, filters, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
