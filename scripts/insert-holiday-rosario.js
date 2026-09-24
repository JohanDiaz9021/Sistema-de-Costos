'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== ANTES ===');
    const before = await query(
      `SELECT * FROM mp_holidays
       WHERE holiday_date IN ('2026-07-13','2027-07-12')
          OR holiday_name LIKE '%Rosario%'`
    );
    console.table(before);

    console.log('\n=== INSERTANDO festivo de la Ley 2578 (Rosario de Chiquinquirá) ===');

    // 2026-07-13: Ley Emiliani trasladó el jueves 9 julio al lunes 13
    // 2027-07-12: mismo festivo, viernes 9 julio 2027 trasladado al lunes 12
    const r = await query(
      `INSERT INTO mp_holidays (holiday_date, holiday_name) VALUES
         ('2026-07-13', 'Ntra. Sra. del Rosario de Chiquinquirá (Ley 2578)'),
         ('2027-07-12', 'Ntra. Sra. del Rosario de Chiquinquirá (Ley 2578)')
       ON DUPLICATE KEY UPDATE holiday_name = VALUES(holiday_name)`
    );
    console.log(`Insertadas/actualizadas: ${r.affectedRows} filas`);

    console.log('\n=== DESPUÉS ===');
    const after = await query(
      `SELECT * FROM mp_holidays
       WHERE holiday_date IN ('2026-07-13','2027-07-12')
          OR holiday_name LIKE '%Rosario%'`
    );
    console.table(after);

    console.log('\n=== Verificación: ¿el check "ayer fue festivo" ahora daría TRUE si hoy fuera martes 14? ===');
    const chk = await query(
      `SELECT COUNT(*) AS was_holiday FROM mp_holidays WHERE holiday_date = '2026-07-13'`
    );
    console.log(`was_holiday para 2026-07-13:`, chk[0].was_holiday, chk[0].was_holiday ? '✅ SÍ es festivo' : '❌ NO');
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
