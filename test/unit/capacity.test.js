'use strict';

/**
 * src/capacity.js — capacidad semanal de una persona.
 *
 * Alimenta el indicador 14 (sobrecarga) y el 16. Un error aqui no revienta
 * nada: devuelve un numero distinto, y el dashboard reporta sobrecargas
 * que no existen (o calla las que si). Por eso el foco esta en los bordes
 * de mes, que es donde la convencion de "semana N" se rompe.
 *
 * Convencion del modulo: semana N = dias [7(N-1)+1 .. min(7N, ultimoDia)].
 * O sea que la "semana 5" existe solo si el mes tiene 29 dias o mas.
 *
 * Funciones puras salvo loadHolidaysSet(), que va contra la base y se
 * cubre en integracion.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  workHoursByDow,
  getWeekDays,
  weekCapacity,
  isBusinessDay,
  diasConHorasYFestivo,
  separarHorasFestivas,
} = require('../../src/capacity');

const SIN_FESTIVOS = new Set();

// ---------------------------------------------------------------
// workHoursByDow — jornada GTC leida de variables de entorno
// ---------------------------------------------------------------

test('workHoursByDow: sabado y domingo valen 0', () => {
  const h = workHoursByDow();
  assert.strictEqual(h[0], 0, 'domingo');
  assert.strictEqual(h[6], 0, 'sabado');
});

test('workHoursByDow: lunes distinto de martes-viernes (jornada 44h)', () => {
  const previo = { m: process.env.WORK_HOURS_MONDAY, t: process.env.WORK_HOURS_TUE_FRI };
  process.env.WORK_HOURS_MONDAY = '8';
  process.env.WORK_HOURS_TUE_FRI = '9';
  try {
    const h = workHoursByDow();
    assert.strictEqual(h[1], 8);
    assert.deepStrictEqual([h[2], h[3], h[4], h[5]], [9, 9, 9, 9]);
    // 8 + 9*4 = 44, la jornada legal que documenta .env.example
    assert.strictEqual(h[1] + h[2] + h[3] + h[4] + h[5], 44);
  } finally {
    process.env.WORK_HOURS_MONDAY = previo.m;
    process.env.WORK_HOURS_TUE_FRI = previo.t;
  }
});

test('workHoursByDow: se lee en CADA llamada, no al cargar el modulo', () => {
  // Importa porque permite cambiar la jornada sin reiniciar el proceso, y
  // porque si se cacheara al require() estas pruebas se contaminarian.
  const previo = process.env.WORK_HOURS_MONDAY;
  try {
    process.env.WORK_HOURS_MONDAY = '4';
    assert.strictEqual(workHoursByDow()[1], 4);
    process.env.WORK_HOURS_MONDAY = '6';
    assert.strictEqual(workHoursByDow()[1], 6);
  } finally {
    process.env.WORK_HOURS_MONDAY = previo;
  }
});

test('workHoursByDow: valor ausente o no numerico cae al default', () => {
  const previo = { m: process.env.WORK_HOURS_MONDAY, t: process.env.WORK_HOURS_TUE_FRI };
  try {
    delete process.env.WORK_HOURS_MONDAY;
    process.env.WORK_HOURS_TUE_FRI = 'nueve';
    const h = workHoursByDow();
    assert.strictEqual(h[1], 8, 'default de lunes');
    assert.strictEqual(h[2], 9, 'default de martes-viernes');
  } finally {
    process.env.WORK_HOURS_MONDAY = previo.m;
    process.env.WORK_HOURS_TUE_FRI = previo.t;
  }
});

test('workHoursByDow: WORK_HOURS_MONDAY=0 cae al default 8 (comportamiento actual)', () => {
  // `parseFloat(...) || 8` trata el 0 como ausente. Se documenta como es
  // hoy: si algun dia se quisiera configurar un lunes no laboral, habria
  // que cambiar el operador por ?? / Number.isFinite.
  const previo = process.env.WORK_HOURS_MONDAY;
  try {
    process.env.WORK_HOURS_MONDAY = '0';
    assert.strictEqual(workHoursByDow()[1], 8);
  } finally {
    process.env.WORK_HOURS_MONDAY = previo;
  }
});

// ---------------------------------------------------------------
// getWeekDays — bordes de mes
// ---------------------------------------------------------------

test('getWeekDays: semana 1 son los dias 1..7', () => {
  const dias = getWeekDays(2026, 1, 1).map((d) => d.date);
  assert.deepStrictEqual(dias, [
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
    '2026-01-05', '2026-01-06', '2026-01-07',
  ]);
});

test('getWeekDays: mes de 31 dias => la semana 5 trae 3 dias (29,30,31)', () => {
  const dias = getWeekDays(2026, 1, 5).map((d) => d.date);
  assert.deepStrictEqual(dias, ['2026-01-29', '2026-01-30', '2026-01-31']);
});

test('getWeekDays: mes de 30 dias => la semana 5 trae 2 dias', () => {
  const dias = getWeekDays(2026, 4, 5).map((d) => d.date);
  assert.deepStrictEqual(dias, ['2026-04-29', '2026-04-30']);
});

test('getWeekDays: febrero de 28 dias => la semana 5 esta VACIA', () => {
  // 2026 no es bisiesto. start = 29 > lastDay = 28.
  assert.strictEqual(new Date(2026, 2, 0).getDate(), 28, 'premisa: feb 2026 tiene 28 dias');
  assert.deepStrictEqual(getWeekDays(2026, 2, 5), []);
});

test('getWeekDays: febrero bisiesto (29 dias) => la semana 5 trae 1 dia', () => {
  assert.strictEqual(new Date(2024, 2, 0).getDate(), 29, 'premisa: feb 2024 es bisiesto');
  const dias = getWeekDays(2024, 2, 5).map((d) => d.date);
  assert.deepStrictEqual(dias, ['2024-02-29']);
});

test('getWeekDays: semana 6 esta vacia en cualquier mes', () => {
  // start = 36, y ningun mes llega. Importa porque week_number del RPA
  // llega hasta 6 (ver sql/21).
  for (const mes of [1, 2, 4, 12]) {
    assert.deepStrictEqual(getWeekDays(2026, mes, 6), [], `mes ${mes}`);
  }
});

test('getWeekDays: el dow corresponde al dia real del calendario', () => {
  // 1 de enero de 2026 es jueves (dow 4). Si esto se corriera, toda la
  // capacidad quedaria desfasada un dia.
  const [primero] = getWeekDays(2026, 1, 1);
  assert.strictEqual(primero.date, '2026-01-01');
  assert.strictEqual(primero.dow, new Date(2026, 0, 1).getDay());
  assert.strictEqual(primero.dow, 4);
});

test('getWeekDays: las 5 semanas cubren el mes entero sin huecos ni repetidos', () => {
  for (const [anio, mes, esperado] of [[2026, 1, 31], [2026, 2, 28], [2024, 2, 29], [2026, 4, 30]]) {
    const todos = [1, 2, 3, 4, 5].flatMap((w) => getWeekDays(anio, mes, w).map((d) => d.date));
    assert.strictEqual(todos.length, esperado, `${anio}-${mes}: cantidad de dias`);
    assert.strictEqual(new Set(todos).size, esperado, `${anio}-${mes}: dias repetidos`);
  }
});

test('getWeekDays: formatea con cero a la izquierda (no 2026-1-1)', () => {
  // Las fechas se comparan como texto contra mp_holidays.holiday_date.
  // Sin el pad, ningun festivo de enero coincidiria nunca.
  for (const d of getWeekDays(2026, 1, 1)) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/, d.date);
  }
});

// ---------------------------------------------------------------
// weekCapacity — con y sin festivos
// ---------------------------------------------------------------

test('weekCapacity: una semana de 7 dias corridos suma la jornada completa', () => {
  // OJO con la convencion: la "semana 2" NO es lunes-a-domingo, son los
  // dias 8..14 del mes (7(N-1)+1). En enero de 2026 eso cae jueves 8 a
  // miercoles 14, o sea 5 dias habiles y un fin de semana en medio:
  //   J9 + V9 + S0 + D0 + L8 + M9 + X9 = 44
  const dias = getWeekDays(2026, 1, 2).map((d) => d.date);
  assert.deepStrictEqual(dias[0], '2026-01-08');
  assert.deepStrictEqual(dias[6], '2026-01-14');
  assert.strictEqual(weekCapacity(2026, 1, 2, SIN_FESTIVOS), 44);
});

test('weekCapacity: un festivo entre semana descuenta sus horas', () => {
  const sinFestivo = weekCapacity(2026, 1, 2, SIN_FESTIVOS);

  // Lunes 12 de enero de 2026 (dentro de la semana 2, dias 8..14).
  assert.strictEqual(new Date(2026, 0, 12).getDay(), 1, 'premisa: el 12 es lunes');
  const conLunesFestivo = weekCapacity(2026, 1, 2, new Set(['2026-01-12']));
  assert.strictEqual(sinFestivo - conLunesFestivo, 8, 'el lunes vale 8h');

  // Martes 13.
  assert.strictEqual(new Date(2026, 0, 13).getDay(), 2, 'premisa: el 13 es martes');
  const conMartesFestivo = weekCapacity(2026, 1, 2, new Set(['2026-01-13']));
  assert.strictEqual(sinFestivo - conMartesFestivo, 9, 'el martes vale 9h');
});

test('weekCapacity: un festivo en fin de semana no cambia nada', () => {
  const domingo = '2026-01-11';
  assert.strictEqual(new Date(2026, 0, 11).getDay(), 0, 'premisa: el 11 es domingo');
  assert.ok(getWeekDays(2026, 1, 2).some((d) => d.date === domingo), 'premisa: cae en la semana 2');
  assert.strictEqual(
    weekCapacity(2026, 1, 2, new Set([domingo])),
    weekCapacity(2026, 1, 2, SIN_FESTIVOS)
  );
});

test('weekCapacity: una semana entera de festivos da 0', () => {
  const todos = new Set(getWeekDays(2026, 1, 2).map((d) => d.date));
  assert.strictEqual(weekCapacity(2026, 1, 2, todos), 0);
});

test('weekCapacity: una semana inexistente (feb 28 dias, semana 5) da 0', () => {
  assert.strictEqual(weekCapacity(2026, 2, 5, SIN_FESTIVOS), 0);
});

test('weekCapacity: la semana partida del cierre de mes cuenta solo sus dias', () => {
  // Enero 2026, semana 5 = jueves 29, viernes 30, sabado 31 => 9 + 9 + 0.
  assert.strictEqual(weekCapacity(2026, 1, 5, SIN_FESTIVOS), 18);
});

test('weekCapacity: devuelve un numero, no una cadena', () => {
  const c = weekCapacity(2026, 1, 2, SIN_FESTIVOS);
  assert.strictEqual(typeof c, 'number');
  assert.ok(Number.isFinite(c));
});

// ---------------------------------------------------------------
// isBusinessDay
// ---------------------------------------------------------------

test('isBusinessDay: de lunes a viernes es habil', () => {
  for (const d of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) {
    assert.strictEqual(isBusinessDay(d, SIN_FESTIVOS), true, d);
  }
});

test('isBusinessDay: sabado y domingo no', () => {
  assert.strictEqual(isBusinessDay('2026-01-10', SIN_FESTIVOS), false, 'sabado');
  assert.strictEqual(isBusinessDay('2026-01-11', SIN_FESTIVOS), false, 'domingo');
});

test('isBusinessDay: un festivo entre semana no es habil', () => {
  assert.strictEqual(isBusinessDay('2026-01-05', new Set(['2026-01-05'])), false);
});

test('isBusinessDay: fecha vacia o nula devuelve false, no revienta', () => {
  for (const v of [null, undefined, '', 0]) {
    assert.strictEqual(isBusinessDay(v, SIN_FESTIVOS), false, String(v));
  }
});

test('isBusinessDay: interpreta la fecha en hora local, no en UTC', () => {
  // Usa `new Date(fecha + 'T00:00:00')` justamente por esto. Con
  // `new Date('2026-01-05')` (UTC) un servidor al oeste de Greenwich leeria
  // el domingo 4 y marcaria el lunes como no habil.
  assert.strictEqual(isBusinessDay('2026-01-05', SIN_FESTIVOS), true, 'lunes 5');
  assert.strictEqual(isBusinessDay('2026-01-04', SIN_FESTIVOS), false, 'domingo 4');
});

// ---------------------------------------------------------------
// diasConHorasYFestivo / separarHorasFestivas — sql/25, recargo de horas
// extra por tipo de dia (diurno/festivo).
// ---------------------------------------------------------------

// Semana 2 de agosto 2026: sab 8, dom 9 (sin columna), lun 10 .. vie 14.
const FILA_SEMANA_2_AGO = { h_mon: 8, h_tue: 9, h_wed: 9, h_thu: 9, h_fri: 9, h_sat: 6 };

test('diasConHorasYFestivo: domingo se descarta (mp_task_facts no tiene esa columna)', () => {
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, SIN_FESTIVOS);
  assert.strictEqual(dias.length, 6, 'sab, lun, mar, mie, jue, vie -- sin domingo');
});

test('diasConHorasYFestivo: lee la columna que corresponde a cada dia calendario', () => {
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, SIN_FESTIVOS);
  const porHoras = dias.map((d) => d.horas).sort((a, b) => a - b);
  assert.deepStrictEqual(porHoras, [6, 8, 9, 9, 9, 9]);
});

test('diasConHorasYFestivo: marca esFestivo segun la fecha calendario real, no el nombre del dia', () => {
  // Lunes de esta semana es 2026-08-10.
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, new Set(['2026-08-10']));
  const lunes = dias.find((d) => d.horas === 8);
  assert.strictEqual(lunes.esFestivo, true);
  assert.strictEqual(dias.filter((d) => d.esFestivo).length, 1, 'solo el lunes es festivo');
});

test('diasConHorasYFestivo: horas ausentes en la fila cuentan como 0, no como NaN', () => {
  const dias = diasConHorasYFestivo({ h_mon: 8 }, 2026, 8, 2, SIN_FESTIVOS);
  const ceros = dias.filter((d) => d.horas === 0);
  assert.strictEqual(ceros.length, 5, 'los 5 dias sin columna en la fila quedan en 0');
});

test('separarHorasFestivas: sin festivos, todo cae en horasNormales', () => {
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, SIN_FESTIVOS);
  const r = separarHorasFestivas(dias);
  assert.strictEqual(r.horasNormales, 8 + 9 + 9 + 9 + 9 + 6);
  assert.strictEqual(r.horasFestivas, 0);
});

test('separarHorasFestivas: las horas de un dia festivo se sacan de horasNormales, no se descartan', () => {
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, new Set(['2026-08-10']));
  const r = separarHorasFestivas(dias);
  assert.strictEqual(r.horasFestivas, 8, 'las 8h del lunes festivo');
  assert.strictEqual(r.horasNormales, 9 + 9 + 9 + 9 + 6, 'el resto de la semana');
  assert.strictEqual(r.horasNormales + r.horasFestivas, 8 + 9 + 9 + 9 + 9 + 6, 'no se pierde ninguna hora');
});

test('separarHorasFestivas: una semana entera de festivos deja todo en horasFestivas', () => {
  const todosFestivos = new Set(getWeekDays(2026, 8, 2).map((d) => d.date));
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, todosFestivos);
  const r = separarHorasFestivas(dias);
  assert.strictEqual(r.horasNormales, 0);
  assert.strictEqual(r.horasFestivas, 8 + 9 + 9 + 9 + 9 + 6);
});
