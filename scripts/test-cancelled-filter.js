'use strict';

require('dotenv').config();
const { query, pool } = require('../src/db');

(async () => {
  try {
    console.log('=== 1) ¿Hay canceladas en el último snapshot? ===');
    const c = await query(
      `SELECT task_status, COUNT(*) n, SUM(budgeted_hours) budgeted, SUM(total_executed_hours) executed
       FROM mp_task_facts
       WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
       GROUP BY task_status
       ORDER BY task_status`
    );
    console.table(c);

    console.log('\n=== 2) Ejemplo: cumplimiento SIN filtro vs CON filtro para el mes actual ===');
    // Approach: usar la lógica del indicator-01
    const noFilter = await query(
      `SELECT t.week_number,
              SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted_incl_cancelled,
              SUM(COALESCE(t.total_executed_hours, 0)) AS executed_incl_cancelled
       FROM mp_task_facts t
       WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND t.week_number IS NOT NULL
       GROUP BY t.week_number
       ORDER BY t.week_number`
    );

    const withFilter = await query(
      `SELECT t.week_number,
              SUM(COALESCE(t.budgeted_hours, 0))       AS budgeted_excl_cancelled,
              SUM(COALESCE(t.total_executed_hours, 0)) AS executed_excl_cancelled
       FROM mp_task_facts t
       WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND t.week_number IS NOT NULL
         AND (t.task_status IS NULL OR LOWER(TRIM(t.task_status)) <> 'cancelado')
       GROUP BY t.week_number
       ORDER BY t.week_number`
    );

    console.log('\nSemana | budget CON | exec CON | cumpl CON |  budget SIN | exec SIN | cumpl SIN | diff');
    console.log('-------|-----------|----------|-----------|-------------|----------|-----------|------');
    const semanas = new Set([...noFilter.map(r => r.week_number), ...withFilter.map(r => r.week_number)]);
    for (const w of [...semanas].sort()) {
      const a = noFilter.find(r => r.week_number === w) || { budgeted_incl_cancelled: 0, executed_incl_cancelled: 0 };
      const b = withFilter.find(r => r.week_number === w) || { budgeted_excl_cancelled: 0, executed_excl_cancelled: 0 };
      const bA = Number(a.budgeted_incl_cancelled) || 0;
      const eA = Number(a.executed_incl_cancelled) || 0;
      const bB = Number(b.budgeted_excl_cancelled) || 0;
      const eB = Number(b.executed_excl_cancelled) || 0;
      const cA = bA > 0 ? (eA / bA * 100).toFixed(1) : 'N/A';
      const cB = bB > 0 ? (eB / bB * 100).toFixed(1) : 'N/A';
      const diff = (bA > 0 && bB > 0) ? (Number(cB) - Number(cA)).toFixed(1) : 'N/A';
      console.log(`  ${w}    | ${bA.toFixed(1).padStart(9)} | ${eA.toFixed(1).padStart(8)} | ${(cA + '%').padStart(9)} | ${bB.toFixed(1).padStart(11)} | ${eB.toFixed(1).padStart(8)} | ${(cB + '%').padStart(9)} | ${diff}${diff !== 'N/A' ? 'pp' : ''}`);
    }

    console.log('\n=== 3) Empleados con canceladas activas (para ver a quién le afecta) ===');
    const affected = await query(
      `SELECT e.canonical_name, t.week_number, COUNT(*) n_cancelled,
              SUM(COALESCE(t.budgeted_hours,0)) budgeted_cancelled,
              SUM(COALESCE(t.total_executed_hours,0)) executed_cancelled
       FROM mp_task_facts t
       JOIN mp_employees e ON e.employee_id = t.employee_id
       WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM mp_task_facts)
         AND LOWER(TRIM(t.task_status)) = 'cancelado'
       GROUP BY e.canonical_name, t.week_number
       ORDER BY budgeted_cancelled DESC LIMIT 20`
    );
    console.table(affected);

    console.log('\n=== 4) Cargar indicator-01 real (con fix aplicado) y correr para verificar ===');
    const ind01 = require('../src/queries/indicator-01');
    const result = await ind01.aggregate({ role: 'ceo', allowedProjects: null }, { month: null, week: null, project: null, employee_id: null });
    console.table(result.series);
    console.log('target_pct:', result.target_pct);
  } catch (err) {
    console.error('ERROR:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
