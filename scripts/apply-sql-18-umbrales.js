'use strict';

/**
 * Aplica sql/18_costeo_config_umbrales_faltantes.sql.
 *
 * Sean explícitos los efectos: solo hace un INSERT IGNORE de 4 filas nuevas
 * en mp_costeo_config. No actualiza ni borra nada, y los valores insertados
 * son los mismos que el código ya venía aplicando como respaldo, así que
 * ningún indicador cambia de resultado. Re-ejecutarlo es inofensivo.
 *
 * Uso: node scripts/apply-sql-18-umbrales.js
 */

require('dotenv').config();
const { pool, query } = require('../src/db');

async function main() {
  const antes = await query('SELECT config_key FROM mp_costeo_config ORDER BY config_key');
  console.log(`\nAntes (${antes.length} umbrales): ${antes.map((r) => r.config_key).join(', ')}`);

  const res = await query(
    `INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
      ('umbral_presupuesto',    '85', 'Porcentaje de presupuesto ejecutado a partir del cual se alerta que el presupuesto está por agotarse.'),
      ('dias_antes_preventiva', '30', 'Días antes de la fecha fin planeada en que se empieza a avisar que el proyecto está por vencer.'),
      ('margin_viable_pct',     '25', 'Margen (%) a partir del cual un proyecto se considera comercialmente viable.'),
      ('margin_risk_pct',       '10', 'Margen (%) mínimo para considerar un proyecto en riesgo; por debajo se marca como no viable.')`
  );
  console.log(`Filas insertadas: ${res.affectedRows}`);

  const despues = await query('SELECT config_key, config_value FROM mp_costeo_config ORDER BY config_key');
  console.log(`\nDespués (${despues.length} umbrales):`);
  despues.forEach((r) => console.log(`   ${r.config_key.padEnd(24)} = ${r.config_value}`));
  console.log();
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
