'use strict';

/**
 * Horas extra PROGRAMADAS (20 oct 2026, a pedido explícito: "si César decide
 * que Johan trabajará pasado mañana 2 horas, que queden registradas de una
 * vez").
 *
 * Una hora extra se puede registrar antes de trabajarse. Mientras su turno
 * no haya terminado (hora de Colombia) es "programada":
 *   - NO suma al ejecutado ni a los indicadores ni a las alertas: todavía no
 *     se ha gastado nada.
 *   - SÍ suma a lo comprometido (Comercial y el "Costo total del proyecto"
 *     del Plan de Recursos), igual que las horas del plan, que también son
 *     futuras.
 * Al terminar el turno pasa sola a contar: no hay que hacer nada. El vigía
 * (src/services/vigia-horas-externas.js) refresca las cachés en ese momento.
 *
 * El fin del turno es fecha + hora_fin, y el día siguiente si hora_fin no
 * es mayor que hora_inicio (turno que cruza la medianoche) — la misma regla
 * que construirTurnoDesdeBD en costo-overtime.js. Las filas sin fecha (las
 * que generaba el RPA antes del 2 sep 2026) cuentan siempre.
 */

const { fechaHoraNegocioISO } = require('../lib/fecha-negocio');

function sqlFinTurno(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `TIMESTAMP(IF(${p}hora_fin <= ${p}hora_inicio, DATE_ADD(${p}fecha, INTERVAL 1 DAY), ${p}fecha), ${p}hora_fin)`;
}

/** Condición SQL "ya se trabajó". Lleva UN parámetro: ahoraSql(). */
function sqlTurnoTerminado(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(${p}fecha IS NULL OR ${sqlFinTurno(alias)} <= ?)`;
}

/** El "ahora" colombiano en el formato que compara MySQL. */
function ahoraSql(ms = Date.now()) {
  return `${fechaHoraNegocioISO(ms).replace('T', ' ')}:00`;
}

/** 'YYYY-MM-DDTHH:MM' del fin del turno, o null si la fila no trae turno. */
function finTurnoISO(fecha, horaInicio, horaFin) {
  if (!fecha || !horaInicio || !horaFin) return null;
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const hi = String(horaInicio).slice(0, 5);
  const hf = String(horaFin).slice(0, 5);
  const dia = new Date(Date.UTC(y, m - 1, d + (hf <= hi ? 1 : 0)));
  return `${dia.toISOString().slice(0, 10)}T${hf}`;
}

/** ¿Todavía no termina su turno? */
function esProgramada(fila, ahora = fechaHoraNegocioISO()) {
  const fin = finTurnoISO(fila.fecha, fila.hora_inicio, fila.hora_fin);
  return fin !== null && fin > ahora;
}

module.exports = { sqlFinTurno, sqlTurnoTerminado, ahoraSql, finTurnoISO, esProgramada };
