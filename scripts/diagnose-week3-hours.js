'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const names = ['Emily Tench', 'Daniel Felipe Gómez Ferreira', 'Jeyson Fernando Núñez Mosquera'];
    for (const name of names) {
      const emp = (await query(`SELECT employee_id FROM mp_employees WHERE canonical_name = ?`, [name]))[0];
      if (!emp) continue;
      const empId = emp.employee_id;

      console.log('\n=================================================');
      console.log('EMPLEADO:', name, '(id=' + empId + ')');
      console.log('=================================================');

      console.log('\n--- Tareas de SEMANA 3 en el snapshot de hoy ---');
      const tasks = await query(
        `SELECT week_number, LEFT(activity, 45) activity, LEFT(project_name, 15) project, task_status,
                hours_monday AS lun, hours_tuesday AS mar, hours_wednesday AS mie,
                hours_thursday AS jue, hours_friday AS vie, hours_saturday AS sab,
                total_executed_hours AS tt
         FROM mp_task_facts
         WHERE employee_id = ?
           AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
           AND week_number = 3
         ORDER BY task_status, project_name, activity`,
        [empId]
      );
      console.table(tasks);

      console.log('\n--- Totales semana 3 (raw) ---');
      const raw = await query(
        `SELECT
           SUM(COALESCE(hours_monday, 0))    AS lun,
           SUM(COALESCE(hours_tuesday, 0))   AS mar,
           SUM(COALESCE(hours_wednesday, 0)) AS mie,
           SUM(COALESCE(hours_thursday, 0))  AS jue,
           SUM(COALESCE(hours_friday, 0))    AS vie,
           SUM(COALESCE(hours_saturday, 0))  AS sab,
           COUNT(*) AS n
         FROM mp_task_facts
         WHERE employee_id = ?
           AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
           AND week_number = 3`,
        [empId]
      );
      console.table(raw);

      console.log('\n--- Totales semana 3 (con exclusión de permiso + cancelado, como hace indicator-16) ---');
      const filtered = await query(
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
         WHERE employee_id = ?
           AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
           AND week_number = 3`,
        [empId]
      );
      console.table(filtered);
    }
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
