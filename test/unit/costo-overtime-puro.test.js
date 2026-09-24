'use strict';

/**
 * Funciones puras de src/queries/costo-overtime.js — el alta manual de
 * horas extra (sql/26): parsear inicio/fin (datetime-local), dividir el
 * turno en diurno/nocturno/festivo, y costearlo con la tabla de recargos
 * de GTC (sql/33). Jornada nocturna 7pm-6am, la que declara esa tabla.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseFechaHora, weekNumberFromDate, dividirTurnoPorDia, costearTurno,
  construirTurnoDesdeBD, clasificarTurno,
} = require('../../src/queries/costo-overtime');

// Componentes que compone factorRecargo() (costo-recargos.js). Todo lo que
// se registra por esta vía es hora EXTRA, así que los factores esperados
// son los de esa mitad de la tabla: 1,25 / 1,75 / 2,15 / 2,65.
const RECARGOS = {
  extraDiurnaPct: 25, extraNocturnaPct: 75,
  nocturnoOrdinarioPct: 35, dominicalFestivoPct: 90,
};
const SIN_FESTIVOS = new Set();

function dt(valor) {
  const d = parseFechaHora(valor);
  assert.ok(d, `${valor} debería parsear`);
  return d;
}

// ---------------------------------------------------------------
// parseFechaHora
// ---------------------------------------------------------------

test('parseFechaHora: formato válido de datetime-local', () => {
  const d = parseFechaHora('2026-08-10T22:00');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7); // agosto, 0-indexado
  assert.strictEqual(d.getDate(), 10);
  assert.strictEqual(d.getHours(), 22);
  assert.strictEqual(d.getMinutes(), 0);
});

test('parseFechaHora: null/undefined/vacío/formato roto dan null', () => {
  for (const v of [null, undefined, '', '2026-08-10', '10:00', '2026/08/10T10:00', 'no es una fecha']) {
    assert.strictEqual(parseFechaHora(v), null, JSON.stringify(v));
  }
});

test('parseFechaHora: mes fuera de 1-12 da null', () => {
  assert.strictEqual(parseFechaHora('2026-13-01T10:00'), null);
  assert.strictEqual(parseFechaHora('2026-00-01T10:00'), null);
});

test('parseFechaHora: hora >23 o minuto >59 dan null (RE_HORA no basta, hay que revisar el rango)', () => {
  assert.strictEqual(parseFechaHora('2026-08-10T24:00'), null);
  assert.strictEqual(parseFechaHora('2026-08-10T10:60'), null);
});

test('parseFechaHora: una fecha que no existe (30 de febrero) da null, no se normaliza en silencio', () => {
  // new Date(2026,1,30) NO da NaN -- JS la corre sola al 2 de marzo. Por
  // eso parseFechaHora reconstruye el Date y compara sus componentes.
  assert.strictEqual(parseFechaHora('2026-02-30T10:00'), null);
  assert.strictEqual(parseFechaHora('2026-04-31T10:00'), null, 'abril no tiene 31 días');
});

test('parseFechaHora: 29 de febrero SÍ es válido en año bisiesto', () => {
  assert.ok(parseFechaHora('2028-02-29T10:00'));
});

test('parseFechaHora: 29 de febrero NO es válido en año no bisiesto', () => {
  assert.strictEqual(parseFechaHora('2026-02-29T10:00'), null);
});

// ---------------------------------------------------------------
// weekNumberFromDate
// ---------------------------------------------------------------

test('weekNumberFromDate: dia 1 al 7 es semana 1, dia 8 ya es semana 2, dia 29 es semana 5', () => {
  assert.strictEqual(weekNumberFromDate('2026-08-01'), 1);
  assert.strictEqual(weekNumberFromDate('2026-08-07'), 1);
  assert.strictEqual(weekNumberFromDate('2026-08-08'), 2);
  assert.strictEqual(weekNumberFromDate('2026-08-29'), 5);
});

// ---------------------------------------------------------------
// dividirTurnoPorDia
// ---------------------------------------------------------------

test('dividirTurnoPorDia: turno de tarde, todo diurno, un solo dia', () => {
  const [s] = dividirTurnoPorDia(dt('2026-08-10T14:00'), dt('2026-08-10T18:00'));
  assert.strictEqual(s.fecha, '2026-08-10');
  assert.strictEqual(s.horasDiurnas, 4);
  assert.strictEqual(s.horasNocturnas, 0);
});

test('dividirTurnoPorDia: turno que cruza las 7pm reparte diurno y nocturno', () => {
  const [s] = dividirTurnoPorDia(dt('2026-08-10T18:00'), dt('2026-08-10T23:00'));
  assert.strictEqual(s.horasDiurnas, 1, '18:00-19:00 es lo único diurno');
  assert.strictEqual(s.horasNocturnas, 4, '19:00-23:00 ya es nocturno según la tabla de GTC');
});

test('dividirTurnoPorDia: turno que cruza medianoche da 2 segmentos, cada uno con su fecha', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T22:00'), dt('2026-08-11T02:00'));
  assert.strictEqual(segmentos.length, 2);
  assert.strictEqual(segmentos[0].fecha, '2026-08-10');
  assert.strictEqual(segmentos[0].horasNocturnas, 2);
  assert.strictEqual(segmentos[1].fecha, '2026-08-11');
  assert.strictEqual(segmentos[1].horasNocturnas, 2);
});

test('dividirTurnoPorDia: fin de mes respeta el mes siguiente (31 -> 1)', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-31T23:00'), dt('2026-09-01T01:00'));
  assert.strictEqual(segmentos[0].fecha, '2026-08-31');
  assert.strictEqual(segmentos[1].fecha, '2026-09-01');
});

test('dividirTurnoPorDia: madrugada (04:00-06:00) es toda nocturna, 06:00 exacto ya no cuenta', () => {
  const [s1] = dividirTurnoPorDia(dt('2026-08-10T04:00'), dt('2026-08-10T06:00'));
  assert.strictEqual(s1.horasNocturnas, 2);
  const [s2] = dividirTurnoPorDia(dt('2026-08-10T05:00'), dt('2026-08-10T07:00'));
  assert.strictEqual(s2.horasNocturnas, 1);
  assert.strictEqual(s2.horasDiurnas, 1);
});

test('dividirTurnoPorDia: turno de mas de 24h reparte 3 dias correctamente', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T10:00'), dt('2026-08-12T10:00'));
  assert.strictEqual(segmentos.length, 3);
  assert.strictEqual(segmentos.map((s) => s.fecha).join(','), '2026-08-10,2026-08-11,2026-08-12');
});

// ---------------------------------------------------------------
// costearTurno
// ---------------------------------------------------------------

test('costearTurno: dia habil, todo diurno -> recargo del 25%', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T14:00'), dt('2026-08-10T18:00'));
  const r = costearTurno(segmentos, SIN_FESTIVOS, 10000, RECARGOS);
  assert.strictEqual(r.extraHours, 4);
  assert.strictEqual(r.extraCostPotential, 4 * 10000 * 1.25);
});

test('costearTurno: dia habil, nocturno -> recargo del 75%', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T22:00'), dt('2026-08-10T23:00'));
  const r = costearTurno(segmentos, SIN_FESTIVOS, 10000, RECARGOS);
  assert.strictEqual(r.extraHours, 1);
  assert.strictEqual(r.extraCostPotential, 1 * 10000 * 1.75);
});

test('costearTurno: festivo, diurno -> factor 2,15 (90% festivo + 25% extra diurna)', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T14:00'), dt('2026-08-10T18:00'));
  const r = costearTurno(segmentos, new Set(['2026-08-10']), 10000, RECARGOS);
  assert.strictEqual(r.extraCostPotential, 4 * 10000 * 2.15);
});

test('costearTurno: festivo, nocturno -> factor 2,65 (90% festivo + 75% extra nocturna)', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T22:00'), dt('2026-08-10T23:00'));
  const r = costearTurno(segmentos, new Set(['2026-08-10']), 10000, RECARGOS);
  assert.strictEqual(r.extraCostPotential, 1 * 10000 * 2.65);
});

test('costearTurno: domingo se trata igual que festivo, aunque no este en holidaysSet', () => {
  // 2026-08-09 es domingo.
  const segmentos = dividirTurnoPorDia(dt('2026-08-09T14:00'), dt('2026-08-09T18:00'));
  const r = costearTurno(segmentos, SIN_FESTIVOS, 10000, RECARGOS);
  assert.strictEqual(r.extraCostPotential, 4 * 10000 * 2.15, 'domingo lleva el recargo dominical (90%) sumado al de extra diurna (25%)');
});

test('costearTurno: turno que cruza medianoche hacia un festivo combina ambos recargos', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T22:00'), dt('2026-08-11T02:00'));
  const r = costearTurno(segmentos, new Set(['2026-08-11']), 10000, RECARGOS);
  // dia1 (normal): 2h nocturnas x 1.75 = 35.000 ; dia2 (festivo): 2h nocturnas x 2.65 = 53.000
  assert.strictEqual(r.extraHours, 4);
  assert.strictEqual(r.extraCostPotential, 35000 + 53000);
});

test('costearTurno: sin segmentos, sin horas y sin costo', () => {
  const r = costearTurno([], SIN_FESTIVOS, 10000, RECARGOS);
  assert.strictEqual(r.extraHours, 0);
  assert.strictEqual(r.extraCostPotential, 0);
});

test('costearTurno: contractType "prestacion_servicios" paga a tarifa plana, sin recargo nocturno/festivo', () => {
  // Mismo turno festivo+nocturno del test de arriba (factor 2,65 en planta),
  // pero por prestación de servicios: factor 1,00 -> se paga la hora tal cual.
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T22:00'), dt('2026-08-10T23:00'));
  const r = costearTurno(segmentos, new Set(['2026-08-10']), 10000, RECARGOS, 'prestacion_servicios');
  assert.strictEqual(r.extraHours, 1);
  assert.strictEqual(r.extraCostPotential, 1 * 10000, 'sin recargo: factor 1,00');
});

test('costearTurno: sin contractType (undefined), se asume planta (comportamiento previo)', () => {
  const segmentos = dividirTurnoPorDia(dt('2026-08-10T14:00'), dt('2026-08-10T18:00'));
  const r = costearTurno(segmentos, SIN_FESTIVOS, 10000, RECARGOS);
  assert.strictEqual(r.extraCostPotential, 4 * 10000 * 1.25);
});

// ---------------------------------------------------------------
// construirTurnoDesdeBD / clasificarTurno — las 6 etiquetas de la tabla
// "Decisión del PM y aprobación" (2 sep 2026, a pedido explícito). SOLO
// visualización: no cambian ni un peso del cálculo de arriba.
//
// Referencia de días en agosto 2026 (mismo calendario que el resto de este
// archivo): 2026-08-08 es sábado, 2026-08-09 es domingo, 2026-08-10 es lunes.
// ---------------------------------------------------------------

test('construirTurnoDesdeBD: reconstruye el turno con la fecha y horas guardadas', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '14:00:00', '18:00:00');
  assert.strictEqual(t.inicioDt.getHours(), 14);
  assert.strictEqual(t.finDt.getHours(), 18);
  assert.strictEqual(t.inicioDt.getDate(), 10);
  assert.strictEqual(t.finDt.getDate(), 10, 'mismo dia: no cruza medianoche');
});

test('construirTurnoDesdeBD: hora_fin <= hora_inicio se infiere que cruzo a la medianoche siguiente', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '22:00:00', '02:00:00');
  assert.strictEqual(t.inicioDt.getDate(), 10);
  assert.strictEqual(t.finDt.getDate(), 11, 'el fin debio pasar al dia siguiente');
});

test('construirTurnoDesdeBD: sin fecha, hora_inicio u hora_fin da null', () => {
  assert.strictEqual(construirTurnoDesdeBD(null, '10:00', '12:00'), null);
  assert.strictEqual(construirTurnoDesdeBD('2026-08-10', null, '12:00'), null);
  assert.strictEqual(construirTurnoDesdeBD('2026-08-10', '10:00', null), null);
});

test('clasificarTurno: dia habil diurno -> "Diurno"', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '14:00:00', '18:00:00'); // lunes
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.deepStrictEqual(r, [{ categoria: 'Diurno', horas: 4 }]);
});

test('clasificarTurno: dia habil nocturno -> "Nocturno"', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '22:00:00', '23:00:00'); // lunes
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.deepStrictEqual(r, [{ categoria: 'Nocturno', horas: 1 }]);
});

test('clasificarTurno: domingo diurno -> "Diurno festivo" (domingo cuenta como festivo)', () => {
  const t = construirTurnoDesdeBD('2026-08-09', '14:00:00', '18:00:00'); // domingo
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.deepStrictEqual(r, [{ categoria: 'Diurno festivo', horas: 4 }]);
});

test('clasificarTurno: un festivo entre semana (no domingo) tambien da "festivo"', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '22:00:00', '23:00:00'); // lunes, marcado festivo
  const r = clasificarTurno(t.inicioDt, t.finDt, new Set(['2026-08-10']));
  assert.deepStrictEqual(r, [{ categoria: 'Nocturno festivo', horas: 1 }]);
});

test('clasificarTurno: sabado diurno -> "Diurno fin de semana" (informativo, no es lo mismo que festivo)', () => {
  const t = construirTurnoDesdeBD('2026-08-08', '14:00:00', '18:00:00'); // sabado
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.deepStrictEqual(r, [{ categoria: 'Diurno fin de semana', horas: 4 }]);
});

test('clasificarTurno: sabado nocturno -> "Nocturno fin de semana"', () => {
  const t = construirTurnoDesdeBD('2026-08-08', '22:00:00', '23:00:00'); // sabado
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.deepStrictEqual(r, [{ categoria: 'Nocturno fin de semana', horas: 1 }]);
});

test('clasificarTurno: un sabado marcado como festivo oficial cuenta como festivo, no como fin de semana', () => {
  // Un sabado puede coincidir con un festivo real del calendario colombiano
  // -- ahi manda "festivo", no la etiqueta informativa de fin de semana.
  const t = construirTurnoDesdeBD('2026-08-08', '14:00:00', '18:00:00'); // sabado
  const r = clasificarTurno(t.inicioDt, t.finDt, new Set(['2026-08-08']));
  assert.deepStrictEqual(r, [{ categoria: 'Diurno festivo', horas: 4 }]);
});

test('clasificarTurno: un turno que cruza de sabado diurno a domingo nocturno da las DOS etiquetas', () => {
  const t = construirTurnoDesdeBD('2026-08-08', '20:00:00', '02:00:00'); // sabado 8pm -> domingo 2am
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  // sabado 20:00-24:00 = 1h diurna (hasta 19:00 ya paso) + ... en realidad
  // 20:00 ya es nocturno (>=19:00): sabado 20:00-24:00 = 4h nocturnas "fin
  // de semana"; domingo 00:00-02:00 = 2h nocturnas "festivo".
  const porCategoria = Object.fromEntries(r.map((x) => [x.categoria, x.horas]));
  assert.strictEqual(porCategoria['Nocturno fin de semana'], 4);
  assert.strictEqual(porCategoria['Nocturno festivo'], 2);
  assert.strictEqual(r.length, 2);
});

test('clasificarTurno: ordena de mayor a menor cantidad de horas', () => {
  const t = construirTurnoDesdeBD('2026-08-10', '17:00:00', '21:00:00'); // lunes: 2h diurnas + 2h nocturnas
  const r = clasificarTurno(t.inicioDt, t.finDt, SIN_FESTIVOS);
  assert.strictEqual(r.length, 2);
  assert.ok(r[0].horas >= r[1].horas);
});
