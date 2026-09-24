'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  // 1) Errores de validación de Mateo (snapshot más reciente)
  const [errs] = await conn.query(`
    SELECT error_type, error_message, severity
      FROM mp_validation_errors
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_validation_errors)
       AND employee_id = 16
     ORDER BY error_type, error_message
  `);
  console.log(`Errores de Mateo Ramos (id=16) en último snapshot: ${errs.length}`);
  const byType = {};
  for (const e of errs) byType[e.error_type] = (byType[e.error_type] || 0) + 1;
  console.log('Por tipo:', byType);

  // 2) Tareas de Mateo con consecutivos en cada semana
  const [consecs] = await conn.query(`
    SELECT week_number, COUNT(*) AS total_tareas,
           GROUP_CONCAT(DISTINCT activity ORDER BY activity SEPARATOR ' || ') AS sample_activities
      FROM mp_task_facts
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name='Junio')
       AND employee_id = 16
       AND month_name = 'Junio'
     GROUP BY week_number
     ORDER BY week_number
  `);
  console.log('\n=== Tareas de Mateo por semana ===');
  console.log(consecs);

  // 3) Detalle de duplicados sospechosos
  const [dupes] = await conn.query(`
    SELECT week_number, project_name, activity, COUNT(*) AS occurrencias
      FROM mp_task_facts
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name='Junio')
       AND employee_id = 16
       AND month_name = 'Junio'
     GROUP BY week_number, project_name, activity
     HAVING occurrencias > 1
     ORDER BY occurrencias DESC, week_number
     LIMIT 10
  `);
  console.log('\n=== Tareas duplicadas en mismo (week, project, activity) ===');
  console.log(dupes);

  // 4) Total de filas en mp_task_facts para Mateo
  const [tot] = await conn.query(`
    SELECT COUNT(*) AS cnt
      FROM mp_task_facts
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts WHERE month_name='Junio')
       AND employee_id = 16
       AND month_name = 'Junio'
  `);
  console.log(`\nTotal filas de Mateo en mp_task_facts (último snapshot): ${tot[0].cnt}`);

  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
