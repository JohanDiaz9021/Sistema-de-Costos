'use strict';

const { query } = require('./db');

function workHoursByDow() {
  const mon = parseFloat(process.env.WORK_HOURS_MONDAY) || 8;
  const tueFri = parseFloat(process.env.WORK_HOURS_TUE_FRI) || 9;
  return { 0: 0, 1: mon, 2: tueFri, 3: tueFri, 4: tueFri, 5: tueFri, 6: 0 };
}

const UN_DIA_MS = 86400000;

// Convención de semanas: la misma de los Excel de Planeación y de WF1
// (docs/n8n/wf1-planeacion/parsear-todos-los-archivos.js, getDateOfWeekInMonth).
// La semana va de lunes a sábado y es del mes que tiene al menos 3 de sus días
// de lunes a viernes, que es lo mismo que decir: del mes en que cae su
// miércoles. Por eso una semana puede cruzar de mes: la semana 5 de septiembre
// de 2026 va del lunes 28 de septiembre al sábado 3 de octubre.
//
// Antes (hasta nov 2026) la semana N eran los días 7(N-1)+1 a 7N del mes, sin
// importar el día de la semana. La semana 5 quedaba reducida a los días 29 en
// adelante y se perdían las horas de las columnas que no caían ahí.
//
// Devuelve [] si ese mes no tiene semana N (octubre de 2026 tiene 4).
function getWeekDays(year, monthNumber, weekNumber) {
  if (!Number.isInteger(weekNumber) || weekNumber < 1) return [];
  const dowDelPrimero = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const primerMiercoles = 1 + ((3 - dowDelPrimero + 7) % 7);
  const miercoles = new Date(Date.UTC(year, monthNumber - 1, primerMiercoles + 7 * (weekNumber - 1)));
  if (miercoles.getUTCMonth() !== monthNumber - 1) return [];

  const lunes = miercoles.getTime() - 2 * UN_DIA_MS;
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const dt = new Date(lunes + i * UN_DIA_MS);
    return { date: dt.toISOString().slice(0, 10), dow: dt.getUTCDay() };
  });
}

// Lo inverso de getWeekDays: a qué año, mes y semana pertenece una fecha
// 'YYYY-MM-DD'. El mes puede no ser el del calendario: el jueves 1 de octubre
// de 2026 es de la semana 5 de septiembre.
function semanaDeFecha(fecha) {
  const [y, m, d] = String(fecha).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  const miercoles = new Date(dt.getTime() + (3 - dow) * UN_DIA_MS);
  return {
    year: miercoles.getUTCFullYear(),
    month: miercoles.getUTCMonth() + 1,
    week: Math.ceil(miercoles.getUTCDate() / 7),
  };
}

function weekCapacity(year, monthNumber, weekNumber, holidaysSet) {
  const hours = workHoursByDow();
  const days = getWeekDays(year, monthNumber, weekNumber);
  let total = 0;
  for (const d of days) {
    if (holidaysSet.has(d.date)) continue;
    total += hours[d.dow] || 0;
  }
  return Number(total.toFixed(2));
}

function isBusinessDay(dateStr, holidaysSet) {
  if (!dateStr) return false;
  const dt = new Date(`${dateStr}T00:00:00`);
  const dow = dt.getDay();
  if (dow === 0 || dow === 6) return false;
  if (holidaysSet.has(dateStr)) return false;
  return true;
}

// Trae también el año anterior y el siguiente porque una semana puede cruzar
// de año: la semana 5 de diciembre de 2026 termina el viernes 1 de enero de 2027.
async function loadHolidaysSet(year) {
  const rows = await query(
    'SELECT holiday_date FROM mp_holidays WHERE YEAR(holiday_date) BETWEEN ? AND ?',
    [year - 1, year + 1]
  );
  return new Set(rows.map((r) => r.holiday_date));
}

// Columna de mp_task_facts para cada día de la semana (dow de Date.getDay():
// 1=lunes .. 6=sábado). Sin entrada para 0 (domingo): el RPA no captura
// hours_sunday, así que ese día no tiene de dónde leer horas — limitación de
// la fuente, no de este cálculo.
const COLUMNA_HORAS_POR_DOW = { 1: 'h_mon', 2: 'h_tue', 3: 'h_wed', 4: 'h_thu', 5: 'h_fri', 6: 'h_sat' };

// Cruza las horas de la fila (una columna por día, h_mon..h_sat) con el
// calendario, que solo sirve para saber si cada día es festivo. Las horas se
// leen siempre: si la fila dice una semana que ese mes no tiene (un Excel mal
// numerado, o filas guardadas antes de usar el mes de la pestaña), cuentan
// como día normal en vez de perderse. Domingo no entra: sin columna, sin dato.
function diasConHorasYFestivo(fila, year, monthNumber, weekNumber, holidaysSet) {
  const fechaPorDow = new Map(getWeekDays(year, monthNumber, weekNumber).map((d) => [d.dow, d.date]));
  return [1, 2, 3, 4, 5, 6].map((dow) => ({
    horas: Number(fila[COLUMNA_HORAS_POR_DOW[dow]]) || 0,
    esFestivo: holidaysSet.has(fechaPorDow.get(dow)),
  }));
}

// Separa las horas de una semana en normales (día hábil, no festivo) y
// festivas (CUALQUIER hora trabajada en un día festivo, sin importar si la
// semana completa se pasó o no del límite legal).
//
// Un festivo no es jornada ordinaria — weekCapacity() de arriba ya trata un
// festivo como 0 horas de capacidad — así que sus horas quedan siempre
// fuera del cómputo de "horas legales" semanales: son extraordinarias por
// definición, no por exceder un umbral.
function separarHorasFestivas(dias) {
  let horasNormales = 0;
  let horasFestivas = 0;
  for (const d of dias) {
    if (d.esFestivo) horasFestivas += d.horas;
    else horasNormales += d.horas;
  }
  return { horasNormales, horasFestivas };
}

module.exports = {
  workHoursByDow,
  getWeekDays,
  semanaDeFecha,
  weekCapacity,
  isBusinessDay,
  loadHolidaysSet,
  diasConHorasYFestivo,
  separarHorasFestivas,
};
