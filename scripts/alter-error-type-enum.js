'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== ANTES ===');
    const before = await query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_validation_errors' AND COLUMN_NAME = 'error_type'`
    );
    console.log('Longitud actual del ENUM:', before[0].COLUMN_TYPE.length, 'chars');

    console.log('\n=== APLICANDO ALTER ===');
    // Nuevo ENUM = enum actual + ZERO_BUDGETED_HOURS + MISSING_WEEK_PLANNING
    const alterSql = `
      ALTER TABLE mp_validation_errors
      MODIFY COLUMN error_type ENUM(
        'NO_FILE','MISSING_MONTH_SHEET','DUPLICATE_MONTH_SHEET','INVALID_TALENT_AND_LEADER',
        'NON_SEQUENTIAL_CONSECUTIVE','TEMPLATE_NOT_RENAMED','SHEET_CASE_MISMATCH','EMPTY_SHEET',
        'PARSE_ERROR','EMPLOYEE_NOT_IN_CATALOG','NO_EMPLOYEE_NAME','NAME_MISMATCH','MISSING_LEADER',
        'DUPLICATE_WEEK_TASKS','DUPLICATE_CONSECUTIVE','DUPLICATE_TASK','WEEK_NUMBER_MISMATCH',
        'EXECUTED_HOURS_IN_FUTURE','TASK_OVERDUE_IN_PLANNING','MISSING_CONSECUTIVE','MISSING_WEEK_NUMBER',
        'MISSING_PROJECT','MISSING_ACTIVITY','MISSING_PLANNED_TYPE','MISSING_BUDGETED_HOURS',
        'MISSING_DELIVERY_DATE','MISSING_ASSIGNEE','MISSING_STATUS','INVALID_STATUS',
        'MISSING_OBSERVATIONS_BLOCKED','NO_DATA_INGESTED','EMPLOYEE_MISSING_EMAIL',
        'TERMINATED_WITHOUT_DELIVERY_DATE','EXECUTED_HOURS_WITHOUT_ESTIMATE','TT_INCONSISTENT',
        'ZERO_BUDGETED_HOURS','MISSING_WEEK_PLANNING'
      ) NOT NULL
    `;
    await query(alterSql);
    console.log('ALTER ejecutado ✓');

    console.log('\n=== DESPUÉS ===');
    const after = await query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_validation_errors' AND COLUMN_NAME = 'error_type'`
    );
    const enumStr = after[0].COLUMN_TYPE;
    const hasZero = enumStr.includes("'ZERO_BUDGETED_HOURS'");
    const hasMissing = enumStr.includes("'MISSING_WEEK_PLANNING'");
    console.log('ZERO_BUDGETED_HOURS presente:  ', hasZero ? '✅' : '❌');
    console.log('MISSING_WEEK_PLANNING presente:', hasMissing ? '✅' : '❌');
    console.log('Total valores en ENUM:', (enumStr.match(/'/g).length / 2));
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
