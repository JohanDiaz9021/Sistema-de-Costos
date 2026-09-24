'use strict';

/**
 * Punto de montaje de /api/costeo.
 *
 * Antes todo esto era un unico src/routes/costeo.js de 1.514 lineas con
 * ocho dominios mezclados (centros, tarifas, equipo, gastos, horas extra,
 * indicadores, accesos, configuracion). Buscar una ruta ahi era scrollear,
 * y dos cambios en dominios distintos chocaban en el mismo archivo.
 *
 * El orden de montaje NO es indiferente: express prueba las rutas en el
 * orden en que se registran. Se mantiene el mismo orden que tenia el
 * archivo original para que ninguna ruta pase a taparse con otra
 * (por ejemplo /indicadores-17/export/pdf frente a /indicadores-17).
 */

const express = require('express');

const router = express.Router();

router.use(require('./centros'));
router.use(require('./tarifas'));
router.use(require('./equipo'));
router.use(require('./gastos'));
router.use(require('./overtime'));
router.use(require('./indicadores'));
router.use(require('./comercial'));
router.use(require('./snapshots'));
router.use(require('./accesos'));
router.use(require('./historial'));
router.use(require('./config'));

module.exports = router;
