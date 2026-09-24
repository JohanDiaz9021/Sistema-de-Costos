'use strict';

/**
 * La fecha de CALENDARIO del negocio a partir de un instante.
 *
 * Por qué existe: el contenedor corre en UTC (docker-compose.yml no le
 * define TZ; `docker exec gtc-dashboard date` lo confirma) y GTC opera en
 * Colombia, UTC-5 todo el año — no hay horario de verano, así que el
 * desfase es fijo.
 *
 * Eso importa para toda fecha derivada de Date.now(). El atajo de siempre,
 * `new Date().toISOString().slice(0, 10)`, corta por UTC: entre las 7:00
 * p.m. y la medianoche hora de Colombia, en UTC ya es el día siguiente, así
 * que la fecha sale un día adelantada. Cinco horas de cada día, todos los
 * días, y nada lo marca como error — el número simplemente está mal.
 *
 * Vive en src/lib/ y no en src/queries/ porque no es de Costeo: lo usan
 * también el cargador de Excel y los nombres de archivo de los exports de
 * Planeación. Es puro, no toca la base ni la configuración.
 */

// Colombia no observa horario de verano: el desfase es -5 todo el año.
const TZ_NEGOCIO = 'America/Bogota';

/**
 * Un instante (ms desde epoch, o Date.now() si no se pasa nada) ->
 * 'YYYY-MM-DD' según el calendario colombiano.
 *
 * Se arma con formatToParts en vez de apoyarse en un locale que
 * "casualmente" imprime en ese orden (el truco de 'en-CA'), para no
 * depender de los datos de locale de la versión de Node con la que se
 * construya la imagen. El formato de salida es el que entiende MySQL y el
 * que parsea formatFecha() en el front.
 */
function fechaNegocioISO(ms = Date.now()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_NEGOCIO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const valor = (tipo) => partes.find((p) => p.type === tipo).value;
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

module.exports = { fechaNegocioISO, TZ_NEGOCIO };
