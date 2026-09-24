'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const EMPLOYEE_ID = 17; // Juan José Vera Valencia
    const TODAY = (await query(`SELECT CURDATE() AS d`))[0].d;
    const YESTERDAY = (await query(`SELECT DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS d`))[0].d;

    console.log(`=== FIX solo para Juan Vera (id=${EMPLOYEE_ID}) ===`);
    console.log(`  Hoy: ${TODAY} | Ayer: ${YESTERDAY}\n`);

    console.log('=== ANTES ===');
    const before = await query(
      `SELECT snapshot_date, COUNT(*) tareas
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date IN (?, ?)
       GROUP BY snapshot_date ORDER BY snapshot_date`,
      [EMPLOYEE_ID, YESTERDAY, TODAY]
    );
    console.table(before);

    const errBefore = await query(
      `SELECT error_id, error_type, LEFT(error_message, 80) msg
       FROM mp_validation_errors
       WHERE snapshot_date = ?
         AND (employee_id = ? OR employee_folder_name LIKE '%Vera%')`,
      [TODAY, EMPLOYEE_ID]
    );
    console.log('Errores del día para Juan:');
    console.table(errBefore);

    // Verificar que Juan tenga data de ayer
    const yesterdayCount = before.find(r => r.snapshot_date === YESTERDAY);
    if (!yesterdayCount || yesterdayCount.tareas === 0) {
      console.log('❌ ABORT: Juan no tiene task_facts para ayer. No hay data que clonar.');
      return;
    }

    console.log(`\n=== APLICANDO FIX ===`);

    // 1) Borrar cualquier task_fact que ya tenga hoy (por seguridad)
    const del1 = await query(
      `DELETE FROM mp_task_facts WHERE employee_id = ? AND snapshot_date = ?`,
      [EMPLOYEE_ID, TODAY]
    );
    console.log(`  1) DELETE task_facts de Juan del ${TODAY}: ${del1.affectedRows} filas`);

    // 2) Clonar task_facts de ayer, cambiando snapshot_date a hoy
    // NOTA: fact_id es auto_increment, así que no lo incluimos. created_at usa default NOW().
    const cloneSql = `
      INSERT INTO mp_task_facts (
        snapshot_date, employee_id, project_folder, leader_name, month_name, month_number,
        year_number, week_number, project_name, activity, planned_type, budgeted_hours,
        estimated_delivery_date, actual_delivery_date, hours_monday, hours_tuesday, hours_wednesday,
        hours_thursday, hours_friday, hours_saturday, total_executed_hours, task_status, assigned_to,
        observations, adjustment_reason_1, unplanned_task_1, adjustment_type_1, adjustment_reason_2,
        unplanned_task_2, adjustment_type_2, adjustment_reason_3, unplanned_task_3, adjustment_type_3,
        has_inconsistency, inconsistency_notes
      )
      SELECT
        ? AS snapshot_date, employee_id, project_folder, leader_name, month_name, month_number,
        year_number, week_number, project_name, activity, planned_type, budgeted_hours,
        estimated_delivery_date, actual_delivery_date, hours_monday, hours_tuesday, hours_wednesday,
        hours_thursday, hours_friday, hours_saturday, total_executed_hours, task_status, assigned_to,
        observations, adjustment_reason_1, unplanned_task_1, adjustment_type_1, adjustment_reason_2,
        unplanned_task_2, adjustment_type_2, adjustment_reason_3, unplanned_task_3, adjustment_type_3,
        has_inconsistency, inconsistency_notes
      FROM mp_task_facts
      WHERE employee_id = ? AND snapshot_date = ?
    `;
    const ins = await query(cloneSql, [TODAY, EMPLOYEE_ID, YESTERDAY]);
    console.log(`  2) INSERT task_facts clonando ${YESTERDAY} → ${TODAY}: ${ins.affectedRows} filas`);

    // 3) Borrar el validation_error MISSING_MONTH_SHEET de Juan del día
    const del2 = await query(
      `DELETE FROM mp_validation_errors
       WHERE snapshot_date = ?
         AND (employee_id = ? OR employee_folder_name LIKE '%Vera%')
         AND error_type = 'MISSING_MONTH_SHEET'`,
      [TODAY, EMPLOYEE_ID]
    );
    console.log(`  3) DELETE validation_error MISSING_MONTH_SHEET de Juan: ${del2.affectedRows} filas`);

    console.log('\n=== DESPUÉS ===');
    const after = await query(
      `SELECT snapshot_date, COUNT(*) tareas
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date IN (?, ?)
       GROUP BY snapshot_date ORDER BY snapshot_date`,
      [EMPLOYEE_ID, YESTERDAY, TODAY]
    );
    console.table(after);

    const errAfter = await query(
      `SELECT error_id, error_type FROM mp_validation_errors
       WHERE snapshot_date = ? AND (employee_id = ? OR employee_folder_name LIKE '%Vera%')`,
      [TODAY, EMPLOYEE_ID]
    );
    console.log('Errores restantes para Juan hoy:');
    console.table(errAfter);

    console.log('\n✅ Fix aplicado. Juan Vera ya aparece en el tablero con la data de ayer.');
    console.log('   Los demás recursos NO fueron tocados.');
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
