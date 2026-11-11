'use strict';

/**
 * sumarCostoLegal() de src/queries/costo-motor.js — extraída del bucle de
 * costoLaboralEjecutado() para poder probarla sin base de datos.
 *
 * Semana 2 de agosto 2026 (sáb 8, lun 10 .. vie 14) — referencia estable en
 * todos los tests de este archivo, igual que en
 * costo-weekly-hours-puro.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const { sumarCostoLegal } = require('../../src/queries/costo-motor');

const BASE = { employee_id: 1, week_number: 2, month_number: 8, year_number: 2026 };
const SIN_FESTIVOS = new Set();

test('sumarCostoLegal: sin filas, total 0', () => {
  assert.strictEqual(sumarCostoLegal([], 45, SIN_FESTIVOS), 0);
});

test('sumarCostoLegal: horas por debajo del límite legal, se cobra todo', () => {
  const fila = { ...BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const total = sumarCostoLegal([fila], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 400);
});

test('sumarCostoLegal: horas por encima del límite legal, se topa en legalHours', () => {
  const fila = { ...BASE, h_mon: 10, h_tue: 10, h_wed: 10, h_thu: 10, h_fri: 10, h_sat: 10, hourly_cost: 10 };
  const total = sumarCostoLegal([fila], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 450);
});

test('sumarCostoLegal: hourly_cost NULL cuenta como 0 (talento sin tarifa)', () => {
  const fila = { ...BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: null };
  const total = sumarCostoLegal([fila], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 0);
});

test('sumarCostoLegal: horas NULL en un día cuentan como 0', () => {
  const fila = { ...BASE, h_mon: null, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const total = sumarCostoLegal([fila], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 320);
});

test('sumarCostoLegal: suma varias filas (varios talentos/semanas)', () => {
  const fila1 = { ...BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const fila2 = { ...BASE, employee_id: 2, h_mon: 10, h_tue: 10, h_wed: 10, h_thu: 10, h_fri: 10, h_sat: 10, hourly_cost: 20 };
  // fila1: 40h dentro del limite * 10 = 400 ; fila2: 60h topadas en 45 * 20 = 900
  const total = sumarCostoLegal([fila1, fila2], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 1300);
});

test('sumarCostoLegal: redondea a 2 decimales', () => {
  const fila = { ...BASE, h_mon: 10, h_tue: 0, h_wed: 0, h_thu: 0, h_fri: 0, h_sat: 0, hourly_cost: 3.333 };
  const total = sumarCostoLegal([fila], 45, SIN_FESTIVOS);
  assert.strictEqual(total, 33.33);
});

test('sumarCostoLegal: las horas de un día festivo NUNCA cuentan aquí (se pagan por el flujo de horas extra, no dos veces)', () => {
  // Lunes 10-ago-2026 festivo, 8h ahí + 32h el resto de la semana = 40h
  // totales, muy por debajo del límite de 45. Sin la exclusión, las 40h
  // completas costarían 400 aquí Y las 8h del lunes volverían a costear
  // como "extra festiva" en weeklyAggregate -- pago doble. Con la
  // exclusión, aquí solo entran las 32h normales.
  const fila = { ...BASE, h_mon: 8, h_tue: 8, h_wed: 8, h_thu: 8, h_fri: 8, h_sat: 0, hourly_cost: 10 };
  const total = sumarCostoLegal([fila], 45, new Set(['2026-08-10']));
  assert.strictEqual(total, 320, 'solo las 32h normales, no las 40h totales');
});
