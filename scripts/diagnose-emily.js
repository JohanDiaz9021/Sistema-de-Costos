'use strict';
require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    const emp = (await query(`SELECT employee_id FROM mp_employees WHERE canonical_name = 'Emily Tench'`))[0];
    const empId = emp.employee_id;

    console.log('=================================================');
    console.log('DIAGNÓSTICO EMILY TENCH (id=' + empId + ')');
    console.log('Snapshot: 2026-07-17 (hoy)');
    console.log('=================================================\n');

    console.log('=== 1) Resumen por estado ===');
    const byStatus = await query(
      `SELECT task_status, COUNT(*) tareas,
              ROUND(SUM(budgeted_hours), 1) presup,
              ROUND(SUM(total_executed_hours), 1) ejec,
              ROUND(AVG(budgeted_hours), 1) promedio_presup
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
       GROUP BY task_status ORDER BY tareas DESC`,
      [empId]
    );
    console.table(byStatus);

    console.log('\n=== 2) Cálculo del 73.4% y del 29.4% ===');
    const summary = await query(
      `SELECT
         COUNT(*) total_tareas,
         SUM(CASE WHEN task_status = 'Terminado' THEN 1 ELSE 0 END) terminadas,
         SUM(CASE WHEN task_status = 'Cancelado' THEN 1 ELSE 0 END) canceladas,
         ROUND(SUM(CASE WHEN LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL THEN budgeted_hours ELSE 0 END), 1) presup_sin_cancel,
         ROUND(SUM(CASE WHEN LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL THEN total_executed_hours ELSE 0 END), 1) ejec_sin_cancel
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)`,
      [empId]
    );
    const s = summary[0];
    console.log(`  Tareas totales: ${s.total_tareas}`);
    console.log(`  Terminadas: ${s.terminadas} (${(s.terminadas/s.total_tareas*100).toFixed(1)}%)`);
    console.log(`  Canceladas: ${s.canceladas}`);
    console.log(`  Presupuestado (sin canceladas): ${s.presup_sin_cancel}h`);
    console.log(`  Ejecutado (sin canceladas): ${s.ejec_sin_cancel}h`);
    console.log(`  → Cumplimiento (horas): ${(s.ejec_sin_cancel/s.presup_sin_cancel*100).toFixed(1)}%`);
    console.log(`  → % Terminadas (excluyendo canceladas): ${(s.terminadas/(s.total_tareas-s.canceladas)*100).toFixed(1)}%`);

    console.log('\n=== 3) Top tareas "En Progreso" con más horas ejecutadas (candidatas a cerrar) ===');
    const enProgreso = await query(
      `SELECT week_number, LEFT(activity, 55) activity, LEFT(project_name, 15) project,
              budgeted_hours presup, total_executed_hours ejec,
              ROUND(total_executed_hours/NULLIF(budgeted_hours,0)*100, 0) cumpl_pct,
              estimated_delivery_date estim
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND task_status = 'En Progreso'
       ORDER BY total_executed_hours DESC LIMIT 10`,
      [empId]
    );
    console.table(enProgreso);

    console.log('\n=== 4) Pendientes con horas presupuestadas altas (podrían no arrancar) ===');
    const pendientes = await query(
      `SELECT week_number, LEFT(activity, 55) activity, LEFT(project_name, 15) project,
              budgeted_hours presup, total_executed_hours ejec, estimated_delivery_date estim
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND task_status = 'Pendiente'
       ORDER BY budgeted_hours DESC LIMIT 10`,
      [empId]
    );
    console.table(pendientes);

    console.log('\n=== 5) Distribución por tamaño de tarea ===');
    const size = await query(
      `SELECT
         SUM(CASE WHEN budgeted_hours <= 0.5 THEN 1 ELSE 0 END) muy_chicas,
         SUM(CASE WHEN budgeted_hours > 0.5 AND budgeted_hours <= 2 THEN 1 ELSE 0 END) chicas,
         SUM(CASE WHEN budgeted_hours > 2 AND budgeted_hours <= 5 THEN 1 ELSE 0 END) medianas,
         SUM(CASE WHEN budgeted_hours > 5 AND budgeted_hours <= 10 THEN 1 ELSE 0 END) grandes,
         SUM(CASE WHEN budgeted_hours > 10 THEN 1 ELSE 0 END) muy_grandes
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND (LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL)`,
      [empId]
    );
    console.log('  <=0.5h:', size[0].muy_chicas, ' | 0.5-2h:', size[0].chicas, ' | 2-5h:', size[0].medianas, ' | 5-10h:', size[0].grandes, ' | >10h:', size[0].muy_grandes);

    console.log('\n=== 6) Cumplimiento y estado por semana ===');
    const weekly = await query(
      `SELECT week_number,
              COUNT(*) tareas,
              SUM(CASE WHEN task_status = 'Terminado' THEN 1 ELSE 0 END) term,
              ROUND(SUM(budgeted_hours), 1) presup,
              ROUND(SUM(total_executed_hours), 1) ejec,
              ROUND(SUM(total_executed_hours)/NULLIF(SUM(budgeted_hours),0)*100, 1) cumpl_pct
       FROM mp_task_facts
       WHERE employee_id = ? AND snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND (LOWER(TRIM(task_status)) <> 'cancelado' OR task_status IS NULL)
       GROUP BY week_number ORDER BY week_number`,
      [empId]
    );
    console.table(weekly);
  } catch (e) { console.error(e); }
  finally { await pool.end(); }
})();
