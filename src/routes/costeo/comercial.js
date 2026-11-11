'use strict';

/**
 * Comercial — utilidad y viabilidad — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { computeComercial } = require('../../queries/costo-comercial');
const { getLegalHoursPerWeek } = require('../../queries/costo-weekly-hours');
const { parseFilters } = require('../../queries/_common');
const { getCentrosVisibles } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Comercial — utilidad por proyecto (contract_value vs. costo proyectado de
// cierre) y Estado real = Ejecución Presupuestal (Costo Estimado vs.
// Presupuesto), esta última para todo el portafolio, con o sin contrato.
// ---------------------------------------------------------------

router.get('/comercial', async (req, res, next) => {
  try {
    const centros = await getCentrosVisibles(req.scope);
    const activos = centros.filter((c) => c.status !== 'inactivo');
    const filters = parseFilters(req.query);
    const proyectos = await Promise.all(activos.map((c) => computeComercial(c, filters)));

    // Utilidad sigue siendo solo de los proyectos con contrato (contract_value
    // > 0, no solo "no nulo"): un contrato en 0 no genera utilidad real.
    const conContrato = proyectos.filter((p) => p.contract_value !== null && p.contract_value > 0);
    const utilidadTotal = conContrato.reduce((s, p) => s + (p.utilidad || 0), 0);
    // Estado real (Ejecución Presupuestal) sí cuenta TODO el portafolio: a
    // diferencia del margen, el presupuesto existe con o sin contrato.
    const sinRiesgo = proyectos.filter((p) => p.estado === 'sin_riesgo').length;
    const enRiesgo = proyectos.filter((p) => p.estado === 'en_riesgo').length;
    const perdida = proyectos.filter((p) => p.estado === 'perdida').length;

    res.json({
      proyectos,
      // Default de "horas/semana por persona" del Simulador — el mismo
      // umbral legal que usa el motor de Indicadores, para que el escenario
      // arranque alineado con el cálculo real.
      horas_semana_legal: await getLegalHoursPerWeek(),
      resumen: {
        utilidad_total: Number(utilidadTotal.toFixed(2)),
        proyectos_con_contrato: conContrato.length,
        sin_riesgo: sinRiesgo,
        en_riesgo: enRiesgo,
        perdida,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Snapshots históricos (5.1) — fotografía fija de los 17 indicadores en un
// momento dado, para comparar "entonces vs. ahora" sin que el número cambie
// cuando el motor recalcula. Mismo scope/selección centro-o-portafolio que
// los exports (resolveExportContext no aplica aquí porque además necesitamos
// el cost_center_id crudo para guardarlo, no solo el título).

module.exports = router;
