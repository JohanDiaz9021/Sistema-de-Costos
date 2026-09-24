'use strict';

/**
 * Prueba de solo lectura de la alerta 4 "Talento sin costo/hora registrado".
 *
 * Recorre los centros de costo por el mismo camino que GET /api/costeo/alertas
 * (computeIndicadores17 -> generarAlertasParaCentro) y reporta cuántas alertas
 * salen, cuántas son la nueva, y cuánto dinero está quedando sin costear.
 * No escribe nada.
 *
 * Uso: node scripts/test-alerta-sin-tarifa.js
 */

require('dotenv').config();
const { pool, query } = require('../src/db');
const { computeIndicadores17 } = require('../src/queries/costo-indicadores-17');
const { generarAlertasParaCentro, generarAlertasGlobales, ordenarPorSeveridad } = require('../src/queries/costo-alertas');

const TIPO = 'Talento sin costo/hora registrado';

async function main() {
  const centros = await query(
    `SELECT cost_center_id, project_folder, project_name, budget, contract_value,
            start_date, planned_end_date, actual_end_date, status
       FROM mp_centro_costo
      ORDER BY project_name`
  );
  console.log(`\nEvaluando ${centros.length} centros de costo...\n`);

  let totalAlertas = 0;
  let totalSinTarifa = 0;
  const afectados = [];

  for (const c of centros) {
    const ind17 = await computeIndicadores17(c);
    const alertas = await generarAlertasParaCentro(c, ind17);
    totalAlertas += alertas.length;

    const nuevas = alertas.filter((a) => a.tipo === TIPO);
    totalSinTarifa += nuevas.length;

    const marca = nuevas.length ? '!!' : '  ';
    console.log(`${marca} ${c.project_name.padEnd(28)} ${String(alertas.length).padStart(3)} alertas` +
                (nuevas.length ? `  ->  ${nuevas.length} sin tarifa` : ''));

    nuevas.forEach((a) => {
      afectados.push(a);
      console.log(`      · ${a.detalle}`);
    });
  }

  const globales = await generarAlertasGlobales();
  const todas = ordenarPorSeveridad([...afectados, ...globales]);

  console.log('\n' + '-'.repeat(72));
  console.log(`Alertas totales en el portafolio: ${totalAlertas + globales.length}`);
  console.log(`De ellas, "${TIPO}": ${totalSinTarifa}`);
  console.log(`Alertas globales (cross-proyecto): ${globales.length}`);

  // Severidad correcta y orden: la nueva alerta es crítica, debe salir arriba.
  if (todas.length) {
    console.log(`Primera alerta tras ordenar por severidad: [${todas[0].severidad}] ${todas[0].tipo}`);
  }

  // Cuánto dinero está sin costear: horas huérfanas x tarifa promedio real.
  const [prom] = await query(
    'SELECT ROUND(AVG(hourly_cost)) AS t FROM mp_equipo_proyecto WHERE is_active = 1 AND hourly_cost > 0'
  );
  const tarifaProm = Number(prom.t) || 0;
  const horasSinCostear = afectados
    .filter((a) => typeof a.valor === 'number' && a.valor > 0)
    .reduce((s, a) => s + a.valor, 0);

  if (tarifaProm > 0 && horasSinCostear > 0) {
    console.log(`\nHoras registradas que hoy cuestan $0: ${horasSinCostear.toLocaleString('es-CO')}h`);
    console.log(`A la tarifa promedio real ($${tarifaProm.toLocaleString('es-CO')}/h), eso es costo laboral no reflejado por`);
    console.log(`aproximadamente $${Math.round(horasSinCostear * tarifaProm).toLocaleString('es-CO')}.`);
    console.log('(Estimación de magnitud, no una cifra contable: cada talento tiene su propia tarifa.)');
  }
  console.log();
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
