'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== Estructura de mp_holidays ===');
    const cols = await query(`SHOW COLUMNS FROM mp_holidays`);
    console.table(cols);

    console.log('\n=== TODOS los festivos ya cargados en la BD ===');
    const all = await query(`SELECT * FROM mp_holidays ORDER BY holiday_date`);
    console.table(all);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
