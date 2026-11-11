'use strict';

/**
 * Carga plantilla-costeo.xlsx (la que genera generar-plantilla-costeo.js).
 *
 * SIMULA POR DEFECTO. Sin --aplicar no escribe absolutamente nada: valida
 * todo, muestra fila por fila qué haría, y termina. Con --aplicar escribe
 * dentro de una transacción, así que si una fila falla no queda nada a medias.
 *
 * Valida ANTES de escribir: si hay un solo error, no se aplica nada. Es
 * deliberado — una carga parcial de tarifas deja el costeo peor que no
 * haberla hecho, porque unos proyectos quedarían costeados y otros no, sin
 * que se note la diferencia.
 *
 * Uso:
 *   node scripts/cargar-plantilla-costeo.js              (simulación)
 *   node scripts/cargar-plantilla-costeo.js --aplicar    (escribe)
 *   node scripts/cargar-plantilla-costeo.js --archivo=otro.xlsx
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, query } = require('../src/db');

const ROLES = ['desarrollador', 'analista', 'lider_proyecto', 'qa', 'disenador', 'scrum_master', 'otro'];

const APLICAR = process.argv.includes('--aplicar');
const argArchivo = process.argv.find((a) => a.startsWith('--archivo='));
const ARCHIVO = path.resolve(argArchivo ? argArchivo.split('=')[1] : 'plantilla-costeo.xlsx');

const errores = [];
const plan = { tarifas: [], asignaciones: [], centros: [] };

// Las celdas de Excel pueden traer número, texto, o una fórmula ya evaluada.
function valorNumerico(cell) {
  if (cell === null || cell === undefined) return null;
  const v = cell.value;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result !== undefined) return Number(v.result);
  const limpio = String(v).replace(/[$\s.]/g, '').replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : NaN;
}

function valorTexto(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  const v = cell.value;
  if (typeof v === 'object' && v.text !== undefined) return String(v.text).trim();
  if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim();
  return String(v).trim();
}

async function leerHojaTarifas(sheet) {
  if (!sheet) return;
  const validos = await query(
    'SELECT team_member_id FROM mp_equipo_proyecto'
  ).then((rows) => new Set(rows.map((r) => r.team_member_id)));

  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const id = valorNumerico(row.getCell(1));
    const proyecto = valorTexto(row.getCell(2));
    const talento = valorTexto(row.getCell(3));
    const costo = valorNumerico(row.getCell(5));
    const rolNuevo = valorTexto(row.getCell(6)).toLowerCase();

    if (!id) return; // fila vacía
    if (!validos.has(id)) {
      errores.push(`Tarifas fila ${n}: team_member_id ${id} no existe en la base.`);
      return;
    }
    // Corregir el cargo es opcional e independiente de la tarifa: se puede
    // hacer una cosa, la otra, o ambas.
    if (rolNuevo && !ROLES.includes(rolNuevo)) {
      errores.push(`Tarifas fila ${n} (${talento} / ${proyecto}): cargo "${rolNuevo}" inválido. Debe ser uno de: ${ROLES.join(', ')}.`);
      return;
    }
    if (costo === null && !rolNuevo) return; // sin diligenciar: se ignora, no es error
    if (costo !== null && (!Number.isFinite(costo) || costo <= 0)) {
      errores.push(`Tarifas fila ${n} (${talento} / ${proyecto}): costo/hora inválido "${valorTexto(row.getCell(5))}". Debe ser un número mayor que 0.`);
      return;
    }
    plan.tarifas.push({
      team_member_id: id,
      hourly_cost: costo,
      role_catalog: rolNuevo || null,
      talento,
      proyecto,
    });
  });
}

async function leerHojaAsignaciones(sheet) {
  if (!sheet) return;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const employee_id = valorNumerico(row.getCell(1));
    const cost_center_id = valorNumerico(row.getCell(2));
    const proyecto = valorTexto(row.getCell(3));
    const talento = valorTexto(row.getCell(4));
    const rol = valorTexto(row.getCell(6)).toLowerCase();
    const costo = valorNumerico(row.getCell(7));

    if (!employee_id || !cost_center_id) return;
    // Fila sin diligenciar del todo: se ignora en silencio.
    if (!rol && costo === null) return;

    if (!ROLES.includes(rol)) {
      errores.push(`Asignaciones fila ${n} (${talento} / ${proyecto}): cargo "${rol || '(vacío)'}" inválido. Debe ser uno de: ${ROLES.join(', ')}.`);
      return;
    }
    if (costo === null || !Number.isFinite(costo) || costo <= 0) {
      errores.push(`Asignaciones fila ${n} (${talento} / ${proyecto}): costo/hora inválido "${valorTexto(row.getCell(7))}". Debe ser un número mayor que 0.`);
      return;
    }
    plan.asignaciones.push({ employee_id, cost_center_id, role_catalog: rol, hourly_cost: costo, talento, proyecto });
  });
}

async function leerHojaCentros(sheet) {
  if (!sheet) return;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const cost_center_id = valorNumerico(row.getCell(1));
    const proyecto = valorTexto(row.getCell(2));
    const presupuesto = valorNumerico(row.getCell(6));
    const contrato = valorNumerico(row.getCell(8));

    if (!cost_center_id) return;
    if (presupuesto === null && contrato === null) return;

    if (presupuesto !== null && (!Number.isFinite(presupuesto) || presupuesto < 0)) {
      errores.push(`Centros fila ${n} (${proyecto}): presupuesto inválido "${valorTexto(row.getCell(6))}".`);
      return;
    }
    if (contrato !== null && (!Number.isFinite(contrato) || contrato < 0)) {
      errores.push(`Centros fila ${n} (${proyecto}): valor de contrato inválido "${valorTexto(row.getCell(8))}".`);
      return;
    }
    plan.centros.push({ cost_center_id, budget: presupuesto, contract_value: contrato, proyecto });
  });
}

function imprimirPlan() {
  console.log('\n' + '='.repeat(74));
  console.log(APLICAR ? 'APLICANDO CAMBIOS' : 'SIMULACIÓN — no se escribirá nada');
  console.log('='.repeat(74));

  console.log(`\n[1] Tarifas / cargos a actualizar: ${plan.tarifas.length}`);
  plan.tarifas.forEach((t) => {
    const cambios = [];
    if (t.hourly_cost !== null) cambios.push(`$${t.hourly_cost.toLocaleString('es-CO')}/h`);
    if (t.role_catalog) cambios.push(`cargo -> ${t.role_catalog}`);
    console.log(`    ${t.talento.padEnd(32)} ${t.proyecto.padEnd(20)} -> ${cambios.join(' · ')}`);
  });

  console.log(`\n[2] Asignaciones nuevas: ${plan.asignaciones.length}`);
  plan.asignaciones.forEach((a) =>
    console.log(`    ${a.talento.padEnd(32)} ${a.proyecto.padEnd(20)} -> ${a.role_catalog}, $${a.hourly_cost.toLocaleString('es-CO')}/h`)
  );

  console.log(`\n[3] Centros a actualizar: ${plan.centros.length}`);
  plan.centros.forEach((c) => {
    const partes = [];
    if (c.budget !== null) partes.push(`presupuesto $${c.budget.toLocaleString('es-CO')}`);
    if (c.contract_value !== null) partes.push(`contrato $${c.contract_value.toLocaleString('es-CO')}`);
    console.log(`    ${c.proyecto.padEnd(28)} -> ${partes.join(' · ')}`);
  });
}

async function aplicar() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const t of plan.tarifas) {
      const campos = [];
      const params = [];
      if (t.hourly_cost !== null) { campos.push('hourly_cost = ?'); params.push(t.hourly_cost); }
      if (t.role_catalog) { campos.push('role_catalog = ?'); params.push(t.role_catalog); }
      if (!campos.length) continue;
      params.push(t.team_member_id);
      await conn.execute(`UPDATE mp_equipo_proyecto SET ${campos.join(', ')} WHERE team_member_id = ?`, params);
    }

    for (const a of plan.asignaciones) {
      // ON DUPLICATE KEY por uk_equipo_centro_talento (sql/17): si el talento
      // ya tenía una fila inactiva en ese centro, se reactiva con la tarifa
      // nueva en vez de fallar. Insertar otra fila duplicaría sus horas.
      await conn.execute(
        `INSERT INTO mp_equipo_proyecto (cost_center_id, employee_id, role_catalog, hourly_cost, is_active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE role_catalog = VALUES(role_catalog),
                                 hourly_cost  = VALUES(hourly_cost),
                                 is_active    = 1,
                                 removed_at   = NULL`,
        [a.cost_center_id, a.employee_id, a.role_catalog, a.hourly_cost]
      );
    }

    for (const c of plan.centros) {
      const campos = [];
      const params = [];
      if (c.budget !== null) { campos.push('budget = ?'); params.push(c.budget); }
      if (c.contract_value !== null) { campos.push('contract_value = ?'); params.push(c.contract_value); }
      if (!campos.length) continue;
      params.push(c.cost_center_id);
      await conn.execute(`UPDATE mp_centro_costo SET ${campos.join(', ')} WHERE cost_center_id = ?`, params);
    }

    await conn.commit();
    console.log('\nCambios aplicados y confirmados.');
  } catch (err) {
    await conn.rollback();
    console.error('\nERROR al aplicar — se revirtió todo, la base quedó como estaba.');
    throw err;
  } finally {
    conn.release();
  }
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ARCHIVO);
  console.log(`\nArchivo: ${ARCHIVO}`);

  await leerHojaTarifas(wb.getWorksheet('1. Tarifas'));
  await leerHojaAsignaciones(wb.getWorksheet('2. Asignaciones'));
  await leerHojaCentros(wb.getWorksheet('3. Centros'));

  if (errores.length) {
    console.error(`\n${errores.length} error(es) de validación. NO se aplicó nada:\n`);
    errores.forEach((e) => console.error(`  · ${e}`));
    console.error('\nCorregir la plantilla y volver a correr.\n');
    process.exitCode = 1;
    return;
  }

  const total = plan.tarifas.length + plan.asignaciones.length + plan.centros.length;
  if (!total) {
    console.log('\nLa plantilla no tiene ninguna celda diligenciada. Nada que hacer.\n');
    return;
  }

  imprimirPlan();

  if (!APLICAR) {
    console.log(`\n${total} cambio(s) listos. Para escribirlos de verdad:`);
    console.log('    node scripts/cargar-plantilla-costeo.js --aplicar\n');
    return;
  }

  await aplicar();

  // Reporte de cierre: cuánto queda pendiente después de esta carga.
  const [{ n: pendientes }] = await query(
    'SELECT COUNT(*) AS n FROM mp_equipo_proyecto WHERE is_active = 1 AND (hourly_cost IS NULL OR hourly_cost = 0)'
  );
  console.log(`Integrantes que siguen sin tarifa: ${pendientes}`);
  console.log('Verificar el resultado con: node scripts/test-alerta-sin-tarifa.js\n');
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
