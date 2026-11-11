'use strict';
require('dotenv').config();
const { pool } = require('../src/db');
const ind16 = require('../src/queries/indicator-16');

(async () => {
  try {
    const scope = { role: 'ceo', allowedProjects: null };

    for (const filters of [
      { month: 'Julio', week: null, project: null, employee_id: null, leader: null },
      { month: 'Julio', week: 3,   project: null, employee_id: null, leader: null },
      { month: 'Julio', week: 2,   project: null, employee_id: null, leader: null },
      { month: 'Julio', week: 1,   project: null, employee_id: null, leader: null },
    ]) {
      console.log('\n=== indicator-16 con filtro:', JSON.stringify(filters), '===');
      const r = await ind16.aggregate(scope, filters);
      // Solo mostrar Emily, Daniel, Jeyson
      const emps = r.employees.filter(e => /Emily Tench|Daniel Felipe|Jeyson Fernando/i.test(e.canonical_name));
      for (const e of emps) {
        const summary = { emp: e.canonical_name.slice(0, 25) };
        for (const d of e.days) summary[d.label] = d.hours;
        console.log(JSON.stringify(summary));
      }
    }
  } catch (err) {
    console.error(err.stack);
  } finally {
    await pool.end();
  }
})();
