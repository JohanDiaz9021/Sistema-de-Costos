'use strict';

/**
 * 5.2/5.3 — Formateo compartido entre el PDF y el Excel de indicadores.
 *
 * Mismos 17 indicadores y mismas fórmulas de presentación que
 * INDICATOR_DEFS en public/js/costeo.js — se duplica aquí porque el
 * frontend corre en el navegador y el export corre en el servidor
 * (no comparten runtime), pero el criterio de formato es idéntico a
 * propósito: lo que el usuario ve en pantalla es lo que descarga.
 */

function formatCOP(n) {
  const value = Number(n) || 0;
  return '$ ' + Math.round(value).toLocaleString('es-CO');
}

function formatPctSigned(v) {
  if (v === null || v === undefined) return 'Sin datos suficientes';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} pts`;
}

// Mismas variantes que costeo-core.js — el % solo no explica de dónde sale
// el número, así que se muestra junto al valor crudo que lo compone.
function formatPctConMonto(pct, monto, total, suffix = '%') {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}${suffix} (${formatCOP(monto)} de ${formatCOP(total)})`;
}

function formatPctConDias(pct, dias, diasTotales) {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}% (${Math.round(dias)} de ${Math.round(diasTotales)} días)`;
}

function formatPctConHoras(pct, horas, horasTotales) {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}% (${Number(horas).toFixed(1)} de ${Number(horasTotales).toFixed(1)} horas)`;
}

function formatFechaQuiebre(i) {
  if (!i.ind4_fecha_quiebre_presupuestal) return 'Sin datos (sin ritmo de gasto todavía)';
  const riesgo = i.ind4_se_queda_sin_plata_antes === true ? ' - antes de la fecha fin' : '';
  return `${i.ind4_fecha_quiebre_presupuestal}${riesgo}`;
}

// #10, #12-#17 y "Dependencia de una Sola Persona" (bus factor) se
// retiraron (ago-sep 2026, sin dato real o a pedido directo) — quedan 8,
// renumerados 1..8 sin huecos. Ver el mismo comentario en INDICATOR_DEFS
// de costeo-core.js.
const INDICATOR_DEFS = [
  { num: 1, name: 'Presupuesto Ejecutado', value: (i) => formatPctConMonto(i.ind1_presupuesto_ejecutado_pct, i.ejecutado_total, i.presupuesto) },
  { num: 2, name: 'Tiempo Transcurrido', value: (i) => formatPctConDias(i.ind2_tiempo_transcurrido_pct, i.ind2_dias_transcurridos, i.ind2_dias_totales) },
  { num: 3, name: 'Ritmo de Gasto vs. Tiempo', value: (i) => formatPctSigned(i.ind3_ritmo_gasto_vs_tiempo) },
  { num: 4, name: 'Fecha de Quiebre Presupuestal', value: (i) => formatFechaQuiebre(i) },
  { num: 5, name: 'Ritmo de Gasto por Semana', value: (i) => formatCOP(i.ind5_ritmo_gasto_semanal) },
  { num: 6, name: 'Personas Trabajando en el Proyecto', value: (i) => String(i.ind7_personas_trabajando) },
  { num: 7, name: 'Costo Real por Hora del Equipo', value: (i) => formatCOP(i.ind8_costo_real_por_hora) },
  { num: 8, name: 'Proporción de Horas Extra', value: (i) => formatPctConHoras(i.ind9_proporcion_horas_extra_pct, i.ind9_horas_extra, i.ind9_horas_ejecutadas) },
];

function indicatorRows(ind17) {
  return INDICATOR_DEFS.map((def) => ({ num: def.num, name: def.name, value: def.value(ind17) }));
}

module.exports = { INDICATOR_DEFS, indicatorRows, formatCOP };
