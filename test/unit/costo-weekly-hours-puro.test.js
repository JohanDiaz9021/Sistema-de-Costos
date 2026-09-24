'use strict';

/**
 * mapearFilaSemanal() de src/queries/costo-weekly-hours.js — extraída del
 * .map() de weeklyAggregateUncached() para poder probarla sin base de datos.
 *
 * Semana 2 de agosto 2026 (getWeekDays: sáb 8, dom 9 -sin dato-, lun 10,
 * mar 11, mié 12, jue 13, vie 14) — semana completa, sin recortes de mes,
 * usada como referencia estable en todos los tests de este archivo.
 */

const test = require('node:test');
const assert = require('node:assert');

const { mapearFilaSemanal } = require('../../src/queries/costo-weekly-hours');

const FILA_BASE = {
  employee_id: 1,
  canonical_name: 'Ana',
  project_folder: 'ALFA',
  cost_center_id: 5,
  week_number: 2,
  month_number: 8,
  year_number: 2026,
};

// Componentes de la tabla de GTC (sql/33), no factores finales: el factor
// de cada tipo de hora lo compone factorRecargo() en costo-recargos.js.
const RECARGOS = {
  extraDiurnaPct: 25, extraNocturnaPct: 75,
  nocturnoOrdinarioPct: 35, dominicalFestivoPct: 90,
};
const SIN_FESTIVOS = new Set();

function ctx({ legalHours = 45, recargos = RECARGOS, holidaysSet = SIN_FESTIVOS } = {}) {
  return { legalHours, recargos, holidaysSet };
}

test('mapearFilaSemanal: por debajo del límite legal, sin festivos, sin horas extra', () => {
  const fila = { ...FILA_BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx());
  assert.strictEqual(r.h_ejec, 40);
  assert.strictEqual(r.h_extra, 0);
  assert.strictEqual(r.costo_legal, 400);
  assert.strictEqual(r.costo_extra_potencial, 0);
});

test('mapearFilaSemanal: por encima del límite, sin festivos, el excedente lleva el recargo diurno (+25%)', () => {
  const fila = { ...FILA_BASE, h_mon: 9, h_tue: 9, h_wed: 9, h_thu: 9, h_fri: 9, h_sat: 5, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx());
  // 50h totales, legal=45 -> 5h extra diurna. costo_legal = 45*10 = 450.
  // costo_extra = 5*10*1.25 = 62.5 (no 50 plano: ya lleva el recargo).
  assert.strictEqual(r.h_ejec, 50);
  assert.strictEqual(r.h_extra, 5);
  assert.strictEqual(r.costo_legal, 450);
  assert.strictEqual(r.costo_extra_potencial, 62.5);
});

test('mapearFilaSemanal: horas en un día festivo NUNCA cuentan para el límite legal, aunque la semana no lo supere', () => {
  // Lunes 10-ago-2026 es festivo en este test. Total semanal = 40h, muy por
  // debajo de 45 -- pero el lunes no es jornada ordinaria: sus 8h se pagan
  // aparte, con el recargo festivo, y NO se suman al cupo de 45.
  const fila = { ...FILA_BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx({ legalHours: 45, holidaysSet: new Set(['2026-08-10']) }));
  // horasNormales = 32 (mar-vie), horasFestivas = 8 (lunes).
  // costo_legal = 32*10 = 320. costo_extra = 8*10*1.90 (dominical/festivo
  // en jornada ordinaria, tabla de GTC) = 152.
  assert.strictEqual(r.h_ejec, 40);
  assert.strictEqual(r.h_extra, 8, 'las 8h del festivo cuentan como extra, aunque la semana no pase de 45h');
  assert.strictEqual(r.costo_legal, 320);
  assert.strictEqual(r.costo_extra_potencial, 152);
});

test('mapearFilaSemanal: festivo Y exceso de horas normales combinan sus dos recargos', () => {
  // Lunes festivo (8h) + martes..sábado con 50h normales (excede 45 -> 5h extra diurna).
  const fila = { ...FILA_BASE, h_mon: 8, h_tue: 10, h_wed: 10, h_thu: 10, h_fri: 10, h_sat: 10, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx({ legalHours: 45, holidaysSet: new Set(['2026-08-10']) }));
  // horasNormales = 50 (mar-sab), horasFestivas = 8 (lunes).
  // horasLegales = min(50,45) = 45. horasExtraDiurna = 5.
  // costo_legal = 45*10 = 450.
  // costo_extra_diurna = 5*10*1.25 = 62.5 ; costo_extra_festiva = 8*10*1.90 = 152.
  assert.strictEqual(r.h_ejec, 58);
  assert.strictEqual(r.h_extra, 13);
  assert.strictEqual(r.costo_legal, 450);
  assert.strictEqual(r.costo_extra_potencial, 214.5);
});

test('mapearFilaSemanal: hourly_cost NULL cuenta como 0 en ambos costos', () => {
  const fila = { ...FILA_BASE, h_mon: 9, h_tue: 9, h_wed: 9, h_thu: 9, h_fri: 9, h_sat: 5, hourly_cost: null };
  const r = mapearFilaSemanal(fila, ctx());
  assert.strictEqual(r.costo_legal, 0);
  assert.strictEqual(r.costo_extra_potencial, 0);
});

test('mapearFilaSemanal: horas NULL en un día cuentan como 0', () => {
  const fila = { ...FILA_BASE, h_mon: null, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx());
  assert.strictEqual(r.h_ejec, 32);
  assert.strictEqual(r.h_extra, 0);
});

test('mapearFilaSemanal: un recargo distinto al de la tabla se aplica tal cual (viene de Configuración)', () => {
  const fila = { ...FILA_BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const recargos = { ...RECARGOS, dominicalFestivoPct: 120 };
  const r = mapearFilaSemanal(fila, ctx({ legalHours: 45, recargos, holidaysSet: new Set(['2026-08-10']) }));
  // horasFestivas = 8 (lunes). Con dominicalFestivoPct=120 -> 8*10*2.20 = 176.
  assert.strictEqual(r.costo_extra_potencial, 176);
});

test('mapearFilaSemanal: un talento por prestación de servicios NO lleva recargo, ni en el excedente ni en festivo', () => {
  // Mismo escenario que "festivo Y exceso de horas normales" arriba, pero
  // con contract_type prestacion_servicios: costo_extra_potencial se paga
  // a tarifa plana (factor 1), no con los recargos de planta.
  const fila = { ...FILA_BASE, contract_type: 'prestacion_servicios', h_mon: 8, h_tue: 10, h_wed: 10, h_thu: 10, h_fri: 10, h_sat: 10, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx({ legalHours: 45, holidaysSet: new Set(['2026-08-10']) }));
  // horasExtraDiurna = 5, horasFestivas = 8 -> (5+8)*10*1.00 = 130 (vs 214.5 en planta).
  assert.strictEqual(r.h_ejec, 58);
  assert.strictEqual(r.h_extra, 13);
  assert.strictEqual(r.costo_legal, 450);
  assert.strictEqual(r.costo_extra_potencial, 130);
});

test('mapearFilaSemanal: sin contract_type en la fila (undefined), se asume planta (comportamiento previo)', () => {
  const fila = { ...FILA_BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const r = mapearFilaSemanal(fila, ctx({ legalHours: 45, holidaysSet: new Set(['2026-08-10']) }));
  assert.strictEqual(r.costo_extra_potencial, 152, 'debe seguir aplicando el 90% festivo, como antes de este cambio');
});

test('mapearFilaSemanal: castea week/month/year_number a Number y conserva identificadores', () => {
  const fila = { ...FILA_BASE, week_number: '2', month_number: '8', year_number: '2026', h_mon: 5, h_tue: 5, h_wed: 0, h_thu: 0, h_fri: 0, h_sat: 0, hourly_cost: 5 };
  const r = mapearFilaSemanal(fila, ctx());
  assert.strictEqual(r.week_number, 2);
  assert.strictEqual(r.month_number, 8);
  assert.strictEqual(r.year_number, 2026);
  assert.strictEqual(r.employee_id, 1);
  assert.strictEqual(r.canonical_name, 'Ana');
  assert.strictEqual(r.project_folder, 'ALFA');
  assert.strictEqual(r.cost_center_id, 5);
});
