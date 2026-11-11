'use strict';

const { query } = require('../db');
const { resolveScope, buildFilterClause } = require('./_common');

// baseWhere PROPIO de Costeo (31 ago 2026, a pedido explícito) — antes este
// archivo reexportaba el baseWhere() de _common.js sin cambios, que filtra
// contra mp_task_facts (la tabla del RPA de Planeación) usando "la fecha de
// corte MÁS RECIENTE DE TODA LA TABLA": eso tiene sentido para Planeación
// porque un solo RPA sincroniza a TODOS el mismo día, así que hay un único
// "momento actual" compartido.
//
// Costeo ya no lee mp_task_facts — lee mp_costeo_task_facts, que se llena
// solo con la carga manual de Excel (costo-task-facts-upload.js), persona
// por persona, cada quien el día que quiera. No hay un "momento actual"
// compartido: el estado vigente de una persona es SU PROPIO snapshot_date
// más reciente, sin importar cuándo subieron el suyo los demás. Por eso la
// condición va correlacionada por employee_id en vez de un MAX() global —
// si no, la carga de una sola persona en un día nuevo "envejecería" a
// todos los demás fuera de ese día y los dejaría sin datos en la vista
// actual (el mismo bug que ya se vio con Johan, pero permanente en vez de
// accidental).
//
// Y va correlacionada TAMBIÉN por project_name (10 sep 2026, a pedido
// explícito): desde que cada carga de Excel lee solo las filas del centro
// al que se sube, una persona tiene un corte vigente POR PROYECTO, no uno
// solo. Con el MAX() por empleado a secas, subir Management el miércoles
// dejaba fuera lo de Sistema de costos cargado el lunes — las horas
// seguían en la tabla pero desaparecían de todos los indicadores, sin
// ningún error. Es el mismo razonamiento de arriba, un nivel más fino.
function baseWhere(filters, alias = 't') {
  if (filters.month) {
    return {
      clause: `${alias}.snapshot_date = (
        SELECT MAX(t2.snapshot_date) FROM mp_costeo_task_facts t2
         WHERE t2.employee_id = ${alias}.employee_id
           AND t2.project_name = ${alias}.project_name
           AND t2.month_name = ?
      ) AND ${alias}.month_name = ?`,
      params: [filters.month, filters.month],
    };
  }
  return {
    clause: `${alias}.snapshot_date = (
      SELECT MAX(t2.snapshot_date) FROM mp_costeo_task_facts t2
       WHERE t2.employee_id = ${alias}.employee_id
         AND t2.project_name = ${alias}.project_name
    )`,
    params: [],
  };
}

// Valor aplicado cuando la fila del umbral todavía no existe en
// mp_costeo_config. Fuente única a propósito: el motor los usa como fallback
// de cálculo y el panel de Configuración (routes/costeo/config.js) los muestra como
// "Valor por defecto". Si se declararan por separado pueden divergir, y la UI
// terminaría anunciando un umbral distinto al que se está aplicando de verdad.
// weekly_legal_hours va en 46, no 42: es el valor oficial de GTC, el que
// siembra sql/10_costeo_config.sql y el que está aplicado en la base. Un
// respaldo distinto al valor sembrado es peligroso — si la fila llegara a
// faltar, el motor cambiaría el umbral de horas extra sin avisar y toda hora
// entre 42 y 46 pasaría a contar como extra en todos los proyectos.
const CONFIG_DEFAULTS = {
  weekly_legal_hours: 46,
  umbral_presupuesto: 85,
  dias_antes_preventiva: 30,
  margin_viable_pct: 25,
  margin_risk_pct: 10,
  // Horas/mes con las que GTC liquida el valor de la hora (sql/33):
  // valor hora = salario mensual / 210. Es la cuenta con la que la empresa
  // ya trabaja en su hoja de nómina, no una aproximación nuestra.
  horas_mes_liquidacion: 210,
  // Componentes de la tabla de recargos de GTC (sql/33). NO son los
  // factores finales: se suman entre sí según el tipo de hora (ver
  // factorRecargo en costo-recargos.js, que reproduce los 7 casos de la
  // tabla). Los recargos nocturnos solo se pueden aplicar donde hay hora
  // exacta (alta manual, sql/26) — mp_costeo_task_facts trae un total por
  // día, sin hora de inicio/fin, así que la vía automática solo distingue
  // día hábil de festivo.
  recargo_extra_diurna_pct: 25,
  recargo_extra_nocturna_pct: 75,
  recargo_nocturno_ordinario_pct: 35,
  recargo_dominical_festivo_pct: 90,
};

// Lee un umbral numérico de mp_costeo_config (weekly_legal_hours, umbral_presupuesto, etc).
async function getConfigNumber(key, fallback = CONFIG_DEFAULTS[key]) {
  const rows = await query('SELECT config_value FROM mp_costeo_config WHERE config_key = ?', [key]);
  return rows[0] ? Number(rows[0].config_value) : fallback;
}

// Igual que projectScopeClause (middleware/scope.js) pero para el módulo de
// Costeo, donde las tablas nuevas (mp_equipo_proyecto, mp_costo_no_planeado,
// mp_overtime_decisions) filtran por cost_center_id en vez de project_folder.
// El puente es mp_centro_costo.project_folder, que ya trae el scope resuelto
// por resolveScope/attachScope (lista de project_folder permitidos).
function costCenterScopeClause(scope, columnAlias = 'cost_center_id') {
  if (!scope || scope.allowedProjects === null) {
    return { clause: '', params: [] };
  }
  if (scope.allowedProjects.length === 0) {
    return { clause: ` AND 1=0 `, params: [] };
  }
  const placeholders = scope.allowedProjects.map(() => '?').join(',');
  return {
    clause: ` AND ${columnAlias} IN (SELECT cost_center_id FROM mp_centro_costo WHERE project_folder IN (${placeholders})) `,
    params: scope.allowedProjects.slice(),
  };
}

module.exports = { resolveScope, buildFilterClause, baseWhere, costCenterScopeClause, getConfigNumber, CONFIG_DEFAULTS };
