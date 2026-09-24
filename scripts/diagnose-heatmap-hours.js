'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const emps = ['Emily Tench', 'Daniel Felipe Gómez Ferreira', 'Jeyson Fernando Núñez Mosquera'];
    for (const name of emps) {
      console.log('\n=================================================');
      console.log('EMPLEADO:', name);
      console.log('=================================================');

      const empRow = await query(
        `SELECT employee_id FROM mp_employees WHERE canonical_name = ?`, [name]
      );
      if (!empRow.length) { console.log('  no encontrado'); continue; }
      const empId = empRow[0].employee_id;

      console.log('\n--- Suma directa de horas L-M-X-J-V-S para HOY snapshot ---');
      const totals = await query(
        `SELECT
           SUM(COALESCE(hours_monday, 0))    AS lun,
           SUM(COALESCE(hours_tuesday, 0))   AS mar,
           SUM(COALESCE(hours_wednesday, 0)) AS mie,
           SUM(COALESCE(hours_thursday, 0))  AS jue,
           SUM(COALESCE(hours_friday, 0))    AS vie,
           SUM(COALESCE(hours_saturday, 0))  AS sab,
           COUNT(*) AS tareas
         FROM mp_task_facts
         WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)`,
        [empId]
      );
      console.table(totals);

      console.log('\n--- Con exclusión de permisos (como hace indicator-16) ---');
      const noPermiso = await query(
        `SELECT
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_monday, 0) ELSE 0 END) AS lun,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_tuesday, 0) ELSE 0 END) AS mar,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_wednesday, 0) ELSE 0 END) AS mie,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_thursday, 0) ELSE 0 END) AS jue,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_friday, 0) ELSE 0 END) AS vie,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                    THEN COALESCE(hours_saturday, 0) ELSE 0 END) AS sab,
           COUNT(*) AS tareas
         FROM mp_task_facts
         WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)`,
        [empId]
      );
      console.table(noPermiso);

      console.log('\n--- CON filtro Cancelado excluido (como el fix reciente) ---');
      const noCancel = await query(
        `SELECT
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_monday, 0) ELSE 0 END) AS lun,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_tuesday, 0) ELSE 0 END) AS mar,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_wednesday, 0) ELSE 0 END) AS mie,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_thursday, 0) ELSE 0 END) AS jue,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_friday, 0) ELSE 0 END) AS vie,
           SUM(CASE WHEN (activity IS NULL OR activity NOT REGEXP 'permiso|festivo|festividad|vacacion|vacaciones|incapacidad|licencia')
                        AND (task_status IS NULL OR LOWER(TRIM(task_status)) <> 'cancelado')
                    THEN COALESCE(hours_saturday, 0) ELSE 0 END) AS sab
         FROM mp_task_facts
         WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)`,
        [empId]
      );
      console.table(noCancel);
    }
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
