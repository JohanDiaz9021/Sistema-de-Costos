'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== Confirmación: week_number de los errores de Jonathan hoy ===');
    const a = await query(
      `SELECT error_type, week_number, COUNT(*) n
       FROM mp_validation_errors
       WHERE employee_id = 27 AND snapshot_date = '2026-07-09'
       GROUP BY error_type, week_number
       ORDER BY error_type, week_number`
    );
    console.table(a);

    console.log('\n=== ¿Jonathan tiene task_facts para SEMANA 2 con snapshot HOY? ===');
    const b = await query(
      `SELECT snapshot_date, week_number, COUNT(*) n
       FROM mp_task_facts
       WHERE employee_id = 27 AND snapshot_date = '2026-07-09'
       GROUP BY snapshot_date, week_number
       ORDER BY week_number`
    );
    console.table(b);

    console.log('\n=== Jhohan Alarcon (comparativa) — task_facts snapshot HOY ===');
    const c = await query(
      `SELECT snapshot_date, week_number, COUNT(*) n
       FROM mp_task_facts
       WHERE employee_id = 26 AND snapshot_date = '2026-07-09'
       GROUP BY snapshot_date, week_number
       ORDER BY week_number`
    );
    console.table(c);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
