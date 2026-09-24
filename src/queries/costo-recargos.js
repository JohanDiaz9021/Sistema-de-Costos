'use strict';

/**
 * Fórmula de nómina de GTC — valor hora y recargos (sql/33).
 *
 * Un solo lugar para las dos cuentas que antes estaban repartidas (y en
 * desacuerdo entre sí) por costo-weekly-hours.js y costo-overtime.js:
 *
 *   1) valor hora   = salario mensual / horas_mes_liquidacion (210)
 *   2) valor de una hora trabajada = valor hora × factor del tipo de hora
 *
 * El factor NO se guarda caso por caso: se compone, que es como está
 * construida la tabla que entregó GTC. Los 7 renglones de esa tabla salen
 * de sumarle a la hora ordinaria (1,00) a lo sumo dos componentes:
 *
 *   +0,90  el día es domingo o festivo
 *   +0,25  es hora EXTRA y cae en horario diurno (6am-7pm)
 *   +0,75  es hora EXTRA y cae en horario nocturno (7pm-6am)
 *   +0,35  NO es extra pero cae en horario nocturno (recargo nocturno
 *          de la jornada ordinaria)
 *
 * y así se reproduce la tabla completa, sin excepciones:
 *
 *   hábil    ordinaria diurna .... 1,00      festivo ordinaria diurna .. 1,90
 *   hábil    ordinaria nocturna .. 1,35      festivo ordinaria nocturna  2,25
 *   hábil    extra diurna ........ 1,25      festivo extra diurna ...... 2,15
 *   hábil    extra nocturna ...... 1,75      festivo extra nocturna .... 2,65
 *
 * Componer en vez de enumerar importa por una razón práctica: si mañana
 * cambia el recargo dominical, se toca UN parámetro y los cuatro factores
 * de la columna derecha se mueven juntos y coherentes. Con las cuatro
 * combinaciones sembradas por separado (como estaban en sql/25 y sql/26)
 * era posible —y de hecho pasaba— que festivo+extra dijera 2,00 mientras
 * la tabla real de la empresa decía 2,15.
 */

const { getConfigNumber, CONFIG_DEFAULTS } = require('./costo-common');
const { memo } = require('../lib/request-cache');

// Jornada diurna 6:00-19:00, nocturna 19:00-6:00 — es el horario que
// declara la tabla de GTC. sql/26 había asumido 21:00 (el corte anterior
// del Código Sustantivo del Trabajo); manda el de la empresa.
const HORA_INICIO_DIURNO = 6;
const HORA_INICIO_NOCTURNO = 19;

// Parámetros de la fórmula, leídos de mp_costeo_config con respaldo en
// CONFIG_DEFAULTS. Memoizados por petición igual que legalHours: son
// umbrales de configuración, no cambian a mitad de un cálculo.
async function getParametrosNomina() {
  return memo('parametrosNomina', async () => {
    const [horasMes, extraDiurnaPct, extraNocturnaPct, nocturnoOrdinarioPct, dominicalFestivoPct] = await Promise.all([
      getConfigNumber('horas_mes_liquidacion'),
      getConfigNumber('recargo_extra_diurna_pct'),
      getConfigNumber('recargo_extra_nocturna_pct'),
      getConfigNumber('recargo_nocturno_ordinario_pct'),
      getConfigNumber('recargo_dominical_festivo_pct'),
    ]);
    return { horasMes, extraDiurnaPct, extraNocturnaPct, nocturnoOrdinarioPct, dominicalFestivoPct };
  });
}

// valor hora = salario mensual / horas de liquidación del mes.
//
// Se redondea al peso: la nómina colombiana no maneja fracciones de peso y
// el resultado se muestra como moneda en toda la app. 1.750.950/210 da
// 8.337,857… -> 8.338, que es exactamente la cifra que GTC tiene en su
// hoja de cálculo. Devuelve 0 (no NaN, no Infinity) ante datos faltantes
// o un divisor en cero, para que un parámetro mal puesto nunca se propague
// como "NaN" a un indicador de dinero.
function valorHoraDesdeSalario(salarioMensual, horasMes = CONFIG_DEFAULTS.horas_mes_liquidacion) {
  const salario = Number(salarioMensual);
  const horas = Number(horasMes);
  if (!(salario > 0) || !(horas > 0)) return 0;
  return Math.round(salario / horas);
}

// Factor por el que se multiplica el valor hora, según el tipo de hora.
// Ver la tabla del encabezado: se suman componentes sobre la hora ordinaria.
//
//   festivo  : el día es domingo o festivo
//   nocturno : la hora cae entre las 7pm y las 6am
//   extra    : está por encima de la jornada legal semanal
//
// contractType (mp_employees.contract_type): los recargos de esta tabla
// (nocturno, dominical/festivo, hora extra) son prestaciones del Código
// Sustantivo del Trabajo — solo cubren a planta. Un talento por prestación
// de servicios se paga a la tarifa plana pactada, sin ellos: factor 1 sea
// cual sea festivo/nocturno/extra. Sin este corte, el sistema le estaba
// aplicando a un contratista el mismo recargo del 25-265% que a un
// empleado de planta, inflando el costo real del proyecto.
function factorRecargo({ festivo = false, nocturno = false, extra = false }, p, contractType = 'planta') {
  if (contractType === 'prestacion_servicios') return 1;
  let pct = 0;
  if (festivo) pct += p.dominicalFestivoPct;
  if (extra) pct += nocturno ? p.extraNocturnaPct : p.extraDiurnaPct;
  else if (nocturno) pct += p.nocturnoOrdinarioPct;
  return 1 + pct / 100;
}

// Los 7 renglones de la tabla de GTC, ya calculados con los parámetros
// vigentes. Lo consume el panel de Configuración para mostrar en pantalla
// exactamente lo que el motor está aplicando — si alguien edita un
// porcentaje, la tabla que ve es la nueva, no una copia escrita a mano en
// el HTML que se quedaría desactualizada en silencio.
function tablaRecargos(p) {
  const casos = [
    { etiqueta: 'Hora ordinaria diurna (6am-7pm)', festivo: false, nocturno: false, extra: false },
    { etiqueta: 'Recargo nocturno en jornada ordinaria (7pm-6am)', festivo: false, nocturno: true, extra: false },
    { etiqueta: 'Hora extra diurna', festivo: false, nocturno: false, extra: true },
    { etiqueta: 'Hora extra nocturna', festivo: false, nocturno: true, extra: true },
    { etiqueta: 'Trabajo dominical o festivo en jornada ordinaria', festivo: true, nocturno: false, extra: false },
    { etiqueta: 'Recargo nocturno en dominical o festivo', festivo: true, nocturno: true, extra: false },
    { etiqueta: 'Hora extra diurna en dominical o festivo', festivo: true, nocturno: false, extra: true },
    { etiqueta: 'Hora extra nocturna en dominical o festivo', festivo: true, nocturno: true, extra: true },
  ];
  return casos.map((c) => {
    const factor = factorRecargo(c, p);
    return { etiqueta: c.etiqueta, factor: Number(factor.toFixed(2)), pct: Math.round(factor * 100) };
  });
}

module.exports = {
  HORA_INICIO_DIURNO,
  HORA_INICIO_NOCTURNO,
  getParametrosNomina,
  valorHoraDesdeSalario,
  factorRecargo,
  tablaRecargos,
};
