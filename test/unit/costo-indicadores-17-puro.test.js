'use strict';

/**
 * Funciones puras de src/queries/costo-indicadores-17.js — la clave de
 * semana usada por #5/#16/#17 y serie_semanal. Regresión del bug de
 * indicadores (17 sep 2026): week_number es la SEMANA DEL MES (sql/21),
 * y una clave año*100+semana mezclaba enero-semana-3 con febrero-semana-3
 * cuando el rango abarcaba más de un mes (la vista por defecto, sin
 * filtro de Periodo, toma el último snapshot POR EMPLEADO/PROYECTO, que
 * pueden ser de meses distintos).
 */

const test = require('node:test');
const assert = require('node:assert');

const { weekKey, descomponerWeekKey } = require('../../src/queries/costo-indicadores-17');

// ---------------------------------------------------------------
// weekKey — año*10000 + mes*100 + semana
// ---------------------------------------------------------------

test('weekKey: la MISMA semana en meses distintos NO colisiona (el bug)', () => {
  assert.notStrictEqual(weekKey(8, 2, 2026), weekKey(9, 2, 2026),
    'agosto-semana-2 y septiembre-semana-2 deben vivir en buckets distintos');
});

test('weekKey: el orden numerico ES el cronologico (anio > mes > semana)', () => {
  const orden = [
    weekKey(12, 5, 2025), // dic-2025, semana 5
    weekKey(1, 1, 2026),  // ene-2026, semana 1
    weekKey(1, 3, 2026),  // ene-2026, semana 3
    weekKey(2, 1, 2026),  // feb-2026, semana 1
    weekKey(9, 2, 2026),  // sep-2026, semana 2
  ];
  for (let i = 1; i < orden.length; i++) {
    assert.ok(orden[i - 1] < orden[i], `posicion ${i} rompe el orden cronologico`);
  }
});

test('weekKey: distingue el mismo bucket del mismo anio/mes/semana (es una clave)', () => {
  assert.strictEqual(weekKey(8, 2, 2026), weekKey(8, 2, 2026));
  assert.strictEqual(weekKey(8, 2, 2026), 20260802);
});

// ---------------------------------------------------------------
// descomponerWeekKey — ida y vuelta para serie_semanal
// ---------------------------------------------------------------

test('descomponerWeekKey: recupera year/month/week de la clave compuesta', () => {
  assert.deepStrictEqual(descomponerWeekKey(20260802), { year: 2026, month: 8, week: 2 });
  assert.deepStrictEqual(descomponerWeekKey(20260902), { year: 2026, month: 9, week: 2 });
  assert.deepStrictEqual(descomponerWeekKey(20251205), { year: 2025, month: 12, week: 5 });
});

test('descomponerWeekKey: redondea correcto (idem round-trip)', () => {
  for (const m of [1, 6, 9, 12]) {
    for (const w of [1, 2, 5]) {
      const wk = weekKey(m, w, 2026);
      assert.deepStrictEqual(descomponerWeekKey(wk), { year: 2026, month: m, week: w });
    }
  }
});