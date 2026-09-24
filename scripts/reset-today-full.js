'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const today = (await query(`SELECT CURDATE() AS d`))[0].d;
    console.log('=== Borrando snapshot completo de hoy:', today, '===\n');

    console.log('ANTES:');
    const before = await query(
      `SELECT
         (SELECT COUNT(*) FROM mp_task_facts WHERE snapshot_date = CURDATE()) AS task_facts,
         (SELECT COUNT(*) FROM mp_validation_errors WHERE snapshot_date = CURDATE()) AS validation_errors,
         (SELECT COUNT(*) FROM mp_notifications WHERE snapshot_date = CURDATE()) AS notifications,
         (SELECT COUNT(*) FROM mp_ingestion_runs WHERE run_date = CURDATE()) AS ingestion_runs,
         (SELECT COUNT(*) FROM mp_indicators WHERE snapshot_date = CURDATE()) AS indicators,
         (SELECT COUNT(*) FROM mp_ai_recommendations WHERE snapshot_date = CURDATE()) AS ai_recommendations`
    );
    console.table(before);

    console.log('\nBORRANDO...');
    const r1 = await query(`DELETE FROM mp_task_facts WHERE snapshot_date = CURDATE()`);
    console.log(`  mp_task_facts:         ${r1.affectedRows} filas`);
    const r2 = await query(`DELETE FROM mp_validation_errors WHERE snapshot_date = CURDATE()`);
    console.log(`  mp_validation_errors:  ${r2.affectedRows} filas`);
    const r3 = await query(`DELETE FROM mp_notifications WHERE snapshot_date = CURDATE()`);
    console.log(`  mp_notifications:      ${r3.affectedRows} filas`);
    const r4 = await query(`DELETE FROM mp_ingestion_runs WHERE run_date = CURDATE()`);
    console.log(`  mp_ingestion_runs:     ${r4.affectedRows} filas`);
    const r5 = await query(`DELETE FROM mp_indicators WHERE snapshot_date = CURDATE()`);
    console.log(`  mp_indicators:         ${r5.affectedRows} filas`);
    const r6 = await query(`DELETE FROM mp_ai_recommendations WHERE snapshot_date = CURDATE()`);
    console.log(`  mp_ai_recommendations: ${r6.affectedRows} filas`);

    console.log('\nDESPUÉS:');
    const after = await query(
      `SELECT
         (SELECT COUNT(*) FROM mp_task_facts WHERE snapshot_date = CURDATE()) AS task_facts,
         (SELECT COUNT(*) FROM mp_validation_errors WHERE snapshot_date = CURDATE()) AS validation_errors,
         (SELECT COUNT(*) FROM mp_notifications WHERE snapshot_date = CURDATE()) AS notifications,
         (SELECT COUNT(*) FROM mp_ingestion_runs WHERE run_date = CURDATE()) AS ingestion_runs,
         (SELECT COUNT(*) FROM mp_indicators WHERE snapshot_date = CURDATE()) AS indicators,
         (SELECT COUNT(*) FROM mp_ai_recommendations WHERE snapshot_date = CURDATE()) AS ai_recommendations`
    );
    console.table(after);

    console.log('\n=== Último snapshot que quedó en task_facts ===');
    const lastSnap = await query(
      `SELECT MAX(snapshot_date) AS ultimo_snapshot FROM mp_task_facts`
    );
    console.table(lastSnap);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
