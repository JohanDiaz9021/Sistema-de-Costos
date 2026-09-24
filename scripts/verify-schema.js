'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');
(async () => {
  try {
    const cols = await query(`SHOW COLUMNS FROM mp_validation_errors WHERE Field IN ('error_type', 'severity', 'week_number')`);
    console.log('=== Columnas relevantes en mp_validation_errors ===');
    console.table(cols);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
