'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) Festivos configurados en julio 2026 ===');
    const holidays = await query(
      `SELECT * FROM mp_holidays WHERE YEAR(holiday_date) = 2026 AND MONTH(holiday_date) = 7 ORDER BY holiday_date`
    );
    console.table(holidays);

    console.log('\n=== 2) ¿El check "ayer fue festivo" daría TRUE hoy? ===');
    const check = await query(
      `SELECT
         CURDATE() AS hoy,
         DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS ayer,
         (SELECT COUNT(*) FROM mp_holidays WHERE holiday_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)) AS was_holiday_yesterday`
    );
    console.table(check);

    console.log('\n=== 3) Últimos runs del WF1 (para ver si algún día se saltó) ===');
    const runs = await query(
      `SELECT run_id, workflow_name, run_date, started_at, completed_at, status, skip_reason
       FROM mp_ingestion_runs ORDER BY run_id DESC LIMIT 10`
    );
    console.table(runs);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
