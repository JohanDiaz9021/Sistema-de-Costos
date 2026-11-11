'use strict';

/**
 * src/capacity.js — capacidad semanal de una persona.
 *
 * Alimenta el indicador 14 (sobrecarga) y el 16. Un error aqui no revienta
 * nada: devuelve un numero distinto, y el dashboard reporta sobrecargas
 * que no existen (o calla las que si). Por eso el foco esta en los bordes
 * de mes, que es donde la convencion de "semana N" se rompe.
 *
 * Convencion del modulo: la de los Excel y WF1. La semana va de lunes a
 * sabado y es del mes en que cae su miercoles (el que tiene al menos 3 de sus
 * dias de lunes a viernes), asi que puede cruzar de mes.
 *
 * Funciones puras salvo loadHolidaysSet(), que va contra la base y se
 * cubre en integracion.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  workHoursByDow,
  getWeekDays,
  semanaDeFecha,
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

test('getWeekDays: una semana son los 6 dias de lunes a sabado', () => {
  const dias = getWeekDays(2026, 10, 2);
  assert.deepStrictEqual(dias.map((d) => d.date), [
    '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
  ]);
  assert.deepStrictEqual(dias.map((d) => d.dow), [1, 2, 3, 4, 5, 6]);
});

test('getWeekDays: la semana 5 de septiembre de 2026 arranca el 28 y cruza a octubre', () => {
  const dias = getWeekDays(2026, 9, 5).map((d) => d.date);
  assert.deepStrictEqual(dias, [
    '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
  ]);
});

test('getWeekDays: coincide con el lunes real de cada semana en los Excel de 2026', () => {
  // Lunes observado en las fechas de entrega de todo el equipo, por pestaña.
  const observado = [
    [6, 1, '2026-06-01'], [6, 2, '2026-06-08'], [6, 3, '2026-06-15'], [6, 4, '2026-06-22'],
    [7, 1, '2026-06-29'], [7, 2, '2026-07-06'], [7, 3, '2026-07-13'], [7, 4, '2026-07-20'], [7, 5, '2026-07-27'],
    [8, 1, '2026-08-03'], [8, 2, '2026-08-10'], [8, 3, '2026-08-17'], [8, 4, '2026-08-24'],
    [9, 5, '2026-09-28'],
    [10, 1, '2026-10-05'], [10, 2, '2026-10-12'], [10, 3, '2026-10-19'], [10, 4, '2026-10-26'],
    [11, 1, '2026-11-02'], [11, 2, '2026-11-09'],
  ];
  for (const [mes, semana, lunes] of observado) {
    assert.strictEqual(getWeekDays(2026, mes, semana)[0].date, lunes, `mes ${mes}, semana ${semana}`);
  }
});

test('getWeekDays: aplica la regla de 3 dias de lunes a viernes en cualquier mes', () => {
  // Calculo independiente, recorriendo lunes a lunes como hace WF1.
  function lunesEsperados(anio, mes) {
    const res = [];
    const primero = new Date(Date.UTC(anio, mes - 1, 1));
    let lunes = primero.getTime() - ((primero.getUTCDay() || 7) - 1) * 86400000;
    for (; lunes <= Date.UTC(anio, mes, 0); lunes += 7 * 86400000) {
      let dentro = 0;
      for (let i = 0; i < 5; i++) {
        if (new Date(lunes + i * 86400000).getUTCMonth() === mes - 1) dentro++;
      }
      if (dentro >= 3) res.push(new Date(lunes).toISOString().slice(0, 10));
    }
    return res;
  }
  for (let anio = 2024; anio <= 2030; anio++) {
    for (let mes = 1; mes <= 12; mes++) {
      const esperados = lunesEsperados(anio, mes);
      esperados.forEach((lunes, i) => {
        assert.strictEqual(getWeekDays(anio, mes, i + 1)[0].date, lunes, `${anio}-${mes} semana ${i + 1}`);
      });
      assert.deepStrictEqual(getWeekDays(anio, mes, esperados.length + 1), [], `${anio}-${mes}: una semana de mas`);
    }
  }
});

test('getWeekDays: un mes con 4 semanas no tiene semana 5', () => {
  assert.deepStrictEqual(getWeekDays(2026, 10, 5), []);
  assert.deepStrictEqual(getWeekDays(2026, 2, 5), []);
});

test('getWeekDays: semana 6, semana 0 o semana no numerica estan vacias', () => {
  // Importa porque week_number del RPA llega hasta 6 (ver sql/21).
  for (const mes of [1, 2, 4, 12]) {
    assert.deepStrictEqual(getWeekDays(2026, mes, 6), [], `mes ${mes}`);
  }
  assert.deepStrictEqual(getWeekDays(2026, 10, 0), []);
  assert.deepStrictEqual(getWeekDays(2026, 10, NaN), []);
});

test('getWeekDays: cada dia del mes de lunes a sabado pertenece a una sola semana', () => {
  // Enero a diciembre seguidos: los lunes van de 7 en 7, sin huecos ni repetidos.
  const lunes = [];
  for (let mes = 1; mes <= 12; mes++) {
    for (let semana = 1; semana <= 5; semana++) {
      const dias = getWeekDays(2026, mes, semana);
      if (dias.length) lunes.push(Date.parse(`${dias[0].date}T00:00:00Z`));
    }
  }
  for (let i = 1; i < lunes.length; i++) {
    assert.strictEqual(lunes[i] - lunes[i - 1], 7 * 86400000, new Date(lunes[i]).toISOString());
  }
});

// ---------------------------------------------------------------
// semanaDeFecha — de la fecha a la semana del Excel
// ---------------------------------------------------------------

test('semanaDeFecha: el 1 de octubre de 2026 es de la semana 5 de septiembre', () => {
  assert.deepStrictEqual(semanaDeFecha('2026-10-01'), { year: 2026, month: 9, week: 5 });
});

test('semanaDeFecha: el 31 de agosto de 2026 ya es de la semana 1 de septiembre', () => {
  assert.deepStrictEqual(semanaDeFecha('2026-08-31'), { year: 2026, month: 9, week: 1 });
});

test('semanaDeFecha: el domingo es de la semana que empezo ese lunes', () => {
  assert.deepStrictEqual(semanaDeFecha('2026-10-18'), { year: 2026, month: 10, week: 2 });
});

test('semanaDeFecha: el 1 de enero de 2027 es de la semana 5 de diciembre de 2026', () => {
  assert.deepStrictEqual(semanaDeFecha('2027-01-01'), { year: 2026, month: 12, week: 5 });
});

test('semanaDeFecha: es la inversa de getWeekDays', () => {
  for (let mes = 1; mes <= 12; mes++) {
    for (let semana = 1; semana <= 5; semana++) {
      for (const d of getWeekDays(2026, mes, semana)) {
        assert.deepStrictEqual(semanaDeFecha(d.date), { year: 2026, month: mes, week: semana }, d.date);
      }
    }
  }
});

test('getWeekDays: formatea con cero a la izquierda (no 2026-1-5)', () => {
  // Las fechas se comparan como texto contra mp_holidays.holiday_date.
  // Sin el pad, ningun festivo de enero coincidiria nunca.
  for (const d of getWeekDays(2026, 1, 1)) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/, d.date);
  }
});

// ---------------------------------------------------------------
// weekCapacity — con y sin festivos
// ---------------------------------------------------------------

test('weekCapacity: una semana completa suma la jornada de lunes a viernes', () => {
  // L8 + M9 + X9 + J9 + V9 + S0 = 44
  const dias = getWeekDays(2026, 1, 2).map((d) => d.date);
  assert.deepStrictEqual(dias[0], '2026-01-12');
  assert.deepStrictEqual(dias[5], '2026-01-17');
  assert.strictEqual(weekCapacity(2026, 1, 2, SIN_FESTIVOS), 44);
});

test('weekCapacity: un festivo entre semana descuenta sus horas', () => {
  const sinFestivo = weekCapacity(2026, 1, 2, SIN_FESTIVOS);

  // Lunes 12 de enero de 2026 (dentro de la semana 2, del 12 al 17).
  assert.strictEqual(new Date(2026, 0, 12).getDay(), 1, 'premisa: el 12 es lunes');
  const conLunesFestivo = weekCapacity(2026, 1, 2, new Set(['2026-01-12']));
  assert.strictEqual(sinFestivo - conLunesFestivo, 8, 'el lunes vale 8h');

  // Martes 13.
  assert.strictEqual(new Date(2026, 0, 13).getDay(), 2, 'premisa: el 13 es martes');
  const conMartesFestivo = weekCapacity(2026, 1, 2, new Set(['2026-01-13']));
  assert.strictEqual(sinFestivo - conMartesFestivo, 9, 'el martes vale 9h');
});

test('weekCapacity: un festivo en sabado no cambia nada', () => {
  const sabado = '2026-01-17';
  assert.strictEqual(new Date(2026, 0, 17).getDay(), 6, 'premisa: el 17 es sabado');
  assert.ok(getWeekDays(2026, 1, 2).some((d) => d.date === sabado), 'premisa: cae en la semana 2');
  assert.strictEqual(
    weekCapacity(2026, 1, 2, new Set([sabado])),
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

test('weekCapacity: la semana que cruza de mes cuenta completa', () => {
  // Septiembre 2026, semana 5 = lunes 28 de septiembre a sabado 3 de octubre.
  assert.strictEqual(weekCapacity(2026, 9, 5, SIN_FESTIVOS), 44);
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

// Semana 2 de agosto 2026: lun 10 .. sab 15.
const FILA_SEMANA_2_AGO = { h_mon: 8, h_tue: 9, h_wed: 9, h_thu: 9, h_fri: 9, h_sat: 6 };

test('diasConHorasYFestivo: domingo se descarta (mp_task_facts no tiene esa columna)', () => {
  const dias = diasConHorasYFestivo(FILA_SEMANA_2_AGO, 2026, 8, 2, SIN_FESTIVOS);
  assert.strictEqual(dias.length, 6, 'lun, mar, mie, jue, vie, sab -- sin domingo');
});

test('diasConHorasYFestivo: la semana 5 de septiembre cuenta todas sus columnas', () => {
  // Caso real de Thomas Medina, nov 2026: lunes y jueves se perdian.
  const dias = diasConHorasYFestivo({ h_mon: 1.75, h_tue: 3, h_thu: 2.25 }, 2026, 9, 5, SIN_FESTIVOS);
  assert.strictEqual(separarHorasFestivas(dias).horasNormales, 7);
});

test('diasConHorasYFestivo: si el mes no tiene esa semana, las horas cuentan como dia normal', () => {
  const fila = { h_mon: 1, h_tue: 2 };
  assert.deepStrictEqual(getWeekDays(2026, 10, 5), [], 'premisa: octubre tiene 4 semanas');
  const dias = diasConHorasYFestivo(fila, 2026, 10, 5, new Set(['2026-10-12']));
  const r = separarHorasFestivas(dias);
  assert.strictEqual(r.horasNormales, 3);
  assert.strictEqual(r.horasFestivas, 0);
});

test('diasConHorasYFestivo: el festivo cae en la semana real del Excel', () => {
  // 20 jul 2026 es el lunes de la semana 4. Con los bloques de 7 dias quedaba en la 3.
  const festivo = new Set(['2026-07-20']);
  const semana4 = separarHorasFestivas(diasConHorasYFestivo({ h_mon: 8 }, 2026, 7, 4, festivo));
  const semana3 = separarHorasFestivas(diasConHorasYFestivo({ h_mon: 8 }, 2026, 7, 3, festivo));
  assert.strictEqual(semana4.horasFestivas, 8);
  assert.strictEqual(semana3.horasFestivas, 0);
});

test('diasConHorasYFestivo: reconoce un festivo que cae en el mes siguiente', () => {
  // La semana 5 de diciembre de 2026 termina el viernes 1 de enero de 2027.
  const dias = diasConHorasYFestivo({ h_fri: 4 }, 2026, 12, 5, new Set(['2027-01-01']));
  assert.strictEqual(separarHorasFestivas(dias).horasFestivas, 4);
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
