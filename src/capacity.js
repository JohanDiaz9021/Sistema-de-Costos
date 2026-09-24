'use strict';

const { query } = require('./db');

function workHoursByDow() {
  const mon = parseFloat(process.env.WORK_HOURS_MONDAY) || 8;
  const tueFri = parseFloat(process.env.WORK_HOURS_TUE_FRI) || 9;
  return { 0: 0, 1: mon, 2: tueFri, 3: tueFri, 4: tueFri, 5: tueFri, 6: 0 };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateString(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// Convención: week N del mes = días [7(N-1)+1 .. min(7N, ultimoDia)].
// Es la convención más común en plantillas mensuales de planeación.
// Si la corrida de n8n usa otra convención (p.ej. ISO weeks que cruzan mes),
// reemplazar esta función aquí en un solo lugar.
function getWeekDays(year, monthNumber, weekNumber) {
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const start = 7 * (weekNumber - 1) + 1;
  const end = Math.min(7 * weekNumber, lastDay);
  if (start > lastDay) return [];
  const days = [];
  for (let d = start; d <= end; d++) {
    const dt = new Date(year, monthNumber - 1, d);
    days.push({ date: toDateString(dt), dow: dt.getDay() });
  }
  return days;
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

async function loadHolidaysSet(year) {
  const rows = await query(
    'SELECT holiday_date FROM mp_holidays WHERE YEAR(holiday_date) = ?',
    [year]
  );
  return new Set(rows.map((r) => r.holiday_date));
}

// Columna de mp_task_facts para cada día de la semana (dow de Date.getDay():
// 1=lunes .. 6=sábado). Sin entrada para 0 (domingo): el RPA no captura
// hours_sunday, así que ese día no tiene de dónde leer horas — limitación de
// la fuente, no de este cálculo.
const COLUMNA_HORAS_POR_DOW = { 1: 'h_mon', 2: 'h_tue', 3: 'h_wed', 4: 'h_thu', 5: 'h_fri', 6: 'h_sat' };

// Cruza los días calendario reales de una semana (getWeekDays) con las horas
// que trae la fila (una columna por día, h_mon..h_sat) y si cada día es
// festivo. Domingo se descarta a propósito: sin columna, sin dato.
function diasConHorasYFestivo(fila, year, monthNumber, weekNumber, holidaysSet) {
  return getWeekDays(year, monthNumber, weekNumber)
    .filter((d) => d.dow !== 0)
    .map((d) => ({
      horas: Number(fila[COLUMNA_HORAS_POR_DOW[d.dow]]) || 0,
      esFestivo: holidaysSet.has(d.date),
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
  weekCapacity,
  isBusinessDay,
  loadHolidaysSet,
  diasConHorasYFestivo,
  separarHorasFestivas,
};
