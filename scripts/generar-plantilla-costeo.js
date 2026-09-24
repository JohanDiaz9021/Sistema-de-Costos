'use strict';

/**
 * Genera la plantilla Excel con TODO lo que le falta al módulo de Costeo para
 * dejar de reportar costos en cero. Solo lee la base; no escribe nada.
 *
 * Produce plantilla-costeo.xlsx con tres hojas:
 *   1. Tarifas       — integrantes ya cargados pero con costo/hora en $0.
 *   2. Asignaciones  — gente que registra horas en un proyecto donde no está
 *                      en el equipo (sus horas hoy valen $0).
 *   3. Centros       — presupuesto y valor de contrato faltantes.
 *
 * Las columnas en gris ya vienen llenas y NO deben editarse (llevan los IDs
 * que usa el cargador). Las columnas en amarillo son las que hay que
 * diligenciar. Una vez llena, se aplica con:
 *     node scripts/cargar-plantilla-costeo.js            (simulación)
 *     node scripts/cargar-plantilla-costeo.js --aplicar  (escribe)
 *
 * Uso: node scripts/generar-plantilla-costeo.js
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, query } = require('../src/db');

const SALIDA = path.join(process.cwd(), 'plantilla-costeo.xlsx');

const ROLES = ['desarrollador', 'analista', 'lider_proyecto', 'qa', 'disenador', 'scrum_master', 'otro'];

const FILL_BLOQUEADO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const FILL_EDITABLE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3C4' } };
const FILL_HEADER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E6B5C' } };

function estilizarHoja(sheet, columnasEditables) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = FILL_HEADER;
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = sheet.getColumn(colNumber).key;
      cell.fill = columnasEditables.includes(key) ? FILL_EDITABLE : FILL_BLOQUEADO;
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
      };
    });
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GTC — Módulo de Costeo';
  wb.created = new Date();

  // ---------------------------------------------------------------
  // Hoja 1 — Tarifas faltantes
  // ---------------------------------------------------------------
  const tarifas = await query(
    `SELECT ep.team_member_id, cc.project_name, e.canonical_name, ep.role_catalog
       FROM mp_equipo_proyecto ep
       JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
       JOIN mp_employees    e  ON e.employee_id     = ep.employee_id
      WHERE ep.is_active = 1
        AND (ep.hourly_cost IS NULL OR ep.hourly_cost = 0)
      ORDER BY cc.project_name, e.canonical_name`
  );

  const hTarifas = wb.addWorksheet('1. Tarifas');
  hTarifas.columns = [
    { header: 'team_member_id', key: 'team_member_id', width: 16 },
    { header: 'Proyecto', key: 'project_name', width: 24 },
    { header: 'Talento', key: 'canonical_name', width: 32 },
    { header: 'Cargo actual', key: 'role_catalog', width: 18 },
    { header: 'COSTO/HORA (COP)  <-- llenar', key: 'hourly_cost', width: 28 },
    { header: 'CORREGIR CARGO  <-- opcional', key: 'role_nuevo', width: 28 },
  ];
  tarifas.forEach((r) => hTarifas.addRow(r));
  estilizarHoja(hTarifas, ['hourly_cost', 'role_nuevo']);
  hTarifas.getColumn('hourly_cost').numFmt = '#,##0';

  // Hoy casi todo el equipo quedó cargado como 'otro', lo que deja sin
  // efecto la tarifa estándar por cargo (definir "Desarrollador = $X" no
  // alcanza a nadie si nadie tiene ese cargo). Esta columna deja corregirlo
  // en la misma pasada; en blanco significa "dejar el cargo como está".
  for (let r = 2; r <= hTarifas.rowCount; r++) {
    hTarifas.getCell(`F${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${ROLES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Cargo inválido',
      error: `Debe ser uno de: ${ROLES.join(', ')}`,
    };
  }

  // ---------------------------------------------------------------
  // Hoja 2 — Personas con horas pero sin asignación al centro
  // ---------------------------------------------------------------
  const asignaciones = await query(
    `SELECT e.employee_id, cc.cost_center_id, cc.project_name, e.canonical_name,
            ROUND(SUM(COALESCE(t.hours_monday,0) + COALESCE(t.hours_tuesday,0) +
                      COALESCE(t.hours_wednesday,0) + COALESCE(t.hours_thursday,0) +
                      COALESCE(t.hours_friday,0) + COALESCE(t.hours_saturday,0)), 1) AS horas
       FROM mp_task_facts t
       JOIN mp_employees    e  ON e.employee_id     = t.employee_id
       JOIN mp_centro_costo cc ON cc.project_folder = t.project_folder
       LEFT JOIN mp_equipo_proyecto ep
              ON ep.cost_center_id = cc.cost_center_id
             AND ep.employee_id    = t.employee_id
             AND ep.is_active      = 1
      WHERE ep.team_member_id IS NULL
        AND e.is_active = 1
      GROUP BY e.employee_id, cc.cost_center_id, cc.project_name, e.canonical_name
     HAVING horas > 0
      ORDER BY horas DESC`
  );

  const hAsig = wb.addWorksheet('2. Asignaciones');
  hAsig.columns = [
    { header: 'employee_id', key: 'employee_id', width: 13 },
    { header: 'cost_center_id', key: 'cost_center_id', width: 15 },
    { header: 'Proyecto', key: 'project_name', width: 24 },
    { header: 'Talento', key: 'canonical_name', width: 32 },
    { header: 'Horas ya registradas', key: 'horas', width: 20 },
    { header: 'CARGO  <-- llenar', key: 'role_catalog', width: 22 },
    { header: 'COSTO/HORA (COP)  <-- llenar', key: 'hourly_cost', width: 28 },
  ];
  asignaciones.forEach((r) => hAsig.addRow(r));
  estilizarHoja(hAsig, ['role_catalog', 'hourly_cost']);
  hAsig.getColumn('hourly_cost').numFmt = '#,##0';
  hAsig.getColumn('horas').numFmt = '#,##0.0';

  // Lista desplegable de cargos, para que nadie escriba un valor que el ENUM rechace.
  for (let r = 2; r <= hAsig.rowCount; r++) {
    hAsig.getCell(`F${r}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${ROLES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Cargo inválido',
      error: `Debe ser uno de: ${ROLES.join(', ')}`,
    };
  }

  // ---------------------------------------------------------------
  // Hoja 3 — Presupuesto y valor de contrato
  // ---------------------------------------------------------------
  const centros = await query(
    `SELECT cost_center_id, project_name, tipo, client_name, budget, contract_value, status
       FROM mp_centro_costo
      ORDER BY project_name`
  );

  const hCentros = wb.addWorksheet('3. Centros');
  hCentros.columns = [
    { header: 'cost_center_id', key: 'cost_center_id', width: 15 },
    { header: 'Proyecto', key: 'project_name', width: 24 },
    { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Cliente', key: 'client_name', width: 22 },
    { header: 'Presupuesto actual', key: 'budget', width: 19 },
    { header: 'PRESUPUESTO NUEVO  <-- llenar', key: 'budget_nuevo', width: 30 },
    { header: 'Contrato actual', key: 'contract_value', width: 17 },
    { header: 'VALOR CONTRATO NUEVO  <-- llenar', key: 'contract_nuevo', width: 32 },
  ];
  centros.forEach((r) => hCentros.addRow(r));
  estilizarHoja(hCentros, ['budget_nuevo', 'contract_nuevo']);
  ['budget', 'budget_nuevo', 'contract_value', 'contract_nuevo'].forEach((c) => {
    hCentros.getColumn(c).numFmt = '#,##0';
  });

  // ---------------------------------------------------------------
  // Hoja 4 — Instrucciones
  // ---------------------------------------------------------------
  const hInfo = wb.addWorksheet('Léeme');
  hInfo.columns = [{ width: 110 }];
  [
    ['Plantilla de datos faltantes — Módulo de Costeo GTC', true],
    ['', false],
    ['Por qué existe esta plantilla:', true],
    ['El motor de Costeo ya calcula bien, pero le falta el único dato que ningún sistema puede', false],
    ['deducir solo: cuánto cuesta la hora de cada persona. Sin eso, las horas trabajadas entran a', false],
    ['los proyectos costando $0, el gasto se ve más bajo de lo real y el margen sale inflado.', false],
    ['', false],
    ['Cómo se llena:', true],
    ['· Las celdas AMARILLAS son las que hay que diligenciar.', false],
    ['· Las celdas GRISES ya vienen llenas y no se deben editar: llevan los identificadores', false],
    ['  que el cargador usa para saber a quién corresponde cada fila.', false],
    ['· No agregar, borrar ni reordenar filas ni columnas.', false],
    ['· Los montos van en pesos, sin puntos ni símbolo: 12500 (no $12.500).', false],
    ['', false],
    ['Hoja 1 — Tarifas: gente ya cargada en el equipo pero con costo/hora en $0.', false],
    ['            La última columna permite además corregir el cargo. Importa: hoy casi todos', false],
    ['            quedaron como "otro", y con el cargo bien puesto se puede definir una tarifa', false],
    ['            estándar por rol y aplicarla a todos de una vez desde el dashboard.', false],
    ['Hoja 2 — Asignaciones: gente que registra horas en un proyecto donde no está en el equipo.', false],
    ['            Hay que indicarle cargo Y costo/hora.', false],
    ['Hoja 3 — Centros: presupuesto y valor de contrato. Dejar en blanco lo que no cambie.', false],
    ['            Los proyectos internos (Management, Talento Humano) no llevan valor de contrato.', false],
    ['', false],
    ['Cuando esté lista:', true],
    ['Devolver el archivo al equipo de desarrollo. Se carga primero en modo simulación, que', false],
    ['muestra exactamente qué se va a escribir sin tocar la base, y solo después se aplica.', false],
  ].forEach(([texto, bold]) => {
    const row = hInfo.addRow([texto]);
    if (bold) row.font = { bold: true, size: 12 };
  });

  await wb.xlsx.writeFile(SALIDA);

  console.log(`\nPlantilla generada: ${SALIDA}\n`);
  console.log(`  Hoja 1 (Tarifas):      ${tarifas.length} integrantes sin costo/hora`);
  console.log(`  Hoja 2 (Asignaciones): ${asignaciones.length} personas con horas pero sin asignar`);
  console.log(`  Hoja 3 (Centros):      ${centros.length} centros`);
  const sinPpto = centros.filter((c) => !Number(c.budget)).length;
  const sinContrato = centros.filter((c) => c.contract_value === null || Number(c.contract_value) === 0).length;
  console.log(`                         ${sinPpto} sin presupuesto · ${sinContrato} sin valor de contrato\n`);
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
