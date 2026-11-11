'use strict';

/**
 * Horas extra programadas (20 oct 2026): cuándo termina un turno y si ya
 * cuenta. Ver src/queries/costo-overtime-turno.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const { finTurnoISO, esProgramada, ahoraSql } = require('../../src/queries/costo-overtime-turno');

test('finTurnoISO: un turno del mismo día termina ese día a la hora de fin', () => {
  assert.strictEqual(finTurnoISO('2026-10-21', '17:00:00', '19:00:00'), '2026-10-21T19:00');
});

test('finTurnoISO: un turno que cruza la medianoche termina al día siguiente', () => {
  assert.strictEqual(finTurnoISO('2026-10-21', '22:00:00', '02:00:00'), '2026-10-22T02:00');
  // Fin de mes y de año también.
  assert.strictEqual(finTurnoISO('2026-12-31', '23:00', '01:00'), '2027-01-01T01:00');
});

test('finTurnoISO: una fila sin turno (las viejas del RPA) no tiene fin', () => {
  assert.strictEqual(finTurnoISO(null, null, null), null);
});

test('esProgramada: el ejemplo de Johan — 21 oct de 5 a 7 pm', () => {
  const fila = { fecha: '2026-10-21', hora_inicio: '17:00:00', hora_fin: '19:00:00' };
  assert.strictEqual(esProgramada(fila, '2026-10-20T10:00'), true, 'el día antes: programada');
  assert.strictEqual(esProgramada(fila, '2026-10-21T18:00'), true, 'a mitad del turno: todavía programada');
  assert.strictEqual(esProgramada(fila, '2026-10-21T19:00'), false, 'justo al terminar: ya cuenta');
  assert.strictEqual(esProgramada(fila, '2026-10-23T08:00'), false, 'días después: cuenta');
});

test('esProgramada: una fila sin turno nunca está programada', () => {
  assert.strictEqual(esProgramada({ fecha: null }, '2026-10-20T10:00'), false);
});

test('ahoraSql: la hora colombiana en el formato que compara MySQL', () => {
  // 21 oct 00:00 UTC = 20 oct 7:00 p.m. en Colombia.
  assert.strictEqual(ahoraSql(Date.UTC(2026, 9, 21, 0, 0)), '2026-10-20 19:00:00');
});
