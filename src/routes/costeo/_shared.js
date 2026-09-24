'use strict';

/**
 * Piezas que comparten varios dominios de /api/costeo: los catalogos de
 * valores validos, los defaults del panel de Configuracion y los tres
 * helpers de permisos/consulta que se usan desde mas de un archivo.
 *
 * Vive aparte para que centros.js, equipo.js, gastos.js y overtime.js
 * puedan usar canWriteCenter() sin que ninguno tenga que importar a otro
 * (dependencias circulares entre routers).
 */

const { query } = require('../../db');
const { projectScopeClause } = require('../../middleware/scope');

// El catálogo de cargos YA NO es una lista fija: mp_tarifa_cargo (sql/23)
// es la fuente única, y cualquier PM puede agregar una fila (ver
// POST /tarifas-cargo). rolesValidos() reemplaza al viejo
// ROLE_CATALOG.includes(x) en equipo.js y tarifas.js.
async function rolesValidos() {
  const rows = await query('SELECT role_catalog FROM mp_tarifa_cargo');
  return new Set(rows.map((r) => r.role_catalog));
}

// role_catalog ("lider_proyecto") es la llave interna, no algo para
// mostrar — nombreVisibleDeRoles() resuelve al nombre legible
// ("Líder de proyecto") para el texto del historial de auditoría. Sin
// esto, cada ruta que arma una descripción con un cargo (crear/editar
// equipo, guardar Plan de Recursos, repreciar un cargo) tenía que acordarse
// de resolverlo por su cuenta, y varias no lo hacían — el slug crudo
// quedaba grabado para siempre en mp_costeo_audit_log.description.
async function nombreVisibleDeRoles() {
  const rows = await query('SELECT role_catalog, nombre_visible FROM mp_tarifa_cargo');
  const mapa = new Map(rows.map((r) => [r.role_catalog, r.nombre_visible]));
  return (roleCatalog) => {
    if (roleCatalog === null || roleCatalog === undefined || roleCatalog === '') return '—';
    return mapa.get(roleCatalog) || roleCatalog;
  };
}

// Convierte un nombre libre ("UX Designer") en una llave de catálogo
// ("ux_designer"): minúsculas, sin acentos, espacios y símbolos a guion
// bajo. Es la misma llave que despues queda en mp_equipo_proyecto.role_catalog,
// asi que tiene que ser estable y sin espacios.
function slugRole(nombreVisible) {
  return String(nombreVisible)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50) || 'cargo';
}

// 'QA' y 'UX' (y cualquier otra que resulte ser lo mismo) NO son proyectos
// reales: son la carpeta de SharePoint de una persona que trabaja
// transversalmente en varios proyectos (un QA, un diseñador UX), y el
// project_folder de sus tareas en mp_task_facts queda con ese nombre. No
// deben poder convertirse en un Centro de Costos (con presupuesto propio)
// ni ofrecerse como "proyecto disponible" al crear accesos de PM — eso es
// justamente lo que paso con CC-2026-010/011 y se corrigio a mano.
const CARPETAS_NO_SON_PROYECTOS = ['QA', 'UX'];

const EXPENSE_CATEGORIES = ['licencia', 'viatico', 'tercero', 'capacitacion', 'otro'];
const CENTRO_TIPOS = ['Desarrollo', 'Consultoria', 'Soporte', 'Overhead'];
const CENTRO_ESTADOS = ['vigente', 'por_vencer', 'vencido', 'cerrado', 'inactivo'];

// Solo para texto legible (ej. el historial de auditoría, con
// describirCambios): CENTRO_TIPOS/CENTRO_ESTADOS de arriba son los valores
// válidos que guarda la base, no lo que se le muestra a un humano —
// 'por_vencer' y 'Consultoria' (sin tilde) se veían crudos en el detalle
// de un cambio de estado o tipo, mismo problema que role_catalog.
const CENTRO_TIPO_LABEL = { Desarrollo: 'Desarrollo', Consultoria: 'Consultoría', Soporte: 'Soporte', Overhead: 'Overhead' };
const CENTRO_ESTADO_LABEL = {
  vigente: 'Vigente', por_vencer: 'Por vencer', vencido: 'Vencido', cerrado: 'Cerrado', inactivo: 'Inactivo',
};

// Igual que slugRole pero para texto libre (nombre comercial -> identificador
// interno), separador "-" y sin tope de catálogo. Usado cuando el Simulador
// crea un proyecto nuevo sin project_folder propio (no viene de Planeación,
// así que no hay una carpeta real de SharePoint que cruzar).
function slugTexto(texto) {
  return String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'proyecto';
}

// Repite el slug con un sufijo -2, -3... hasta encontrar uno libre. Sin
// condición de carrera real (solo admin/ceo crean centros, uso esporádico) —
// mismo criterio que generarCodigoCentro().
async function generarProjectFolderUnico(nombreComercial) {
  const base = slugTexto(nombreComercial);
  let candidato = base;
  let n = 1;
  while ((await query('SELECT 1 FROM mp_centro_costo WHERE project_folder = ? LIMIT 1', [candidato])).length) {
    n += 1;
    candidato = `${base}-${n}`;
  }
  return candidato;
}

// Umbrales de mp_costeo_config editables desde el panel de Configuración (4.4).
// Solo la etiqueta/unidad/descripción viven aquí: el default sale de
// CONFIG_DEFAULTS (costo-common.js), que es el mismo valor que getConfigNumber()
// aplica cuando la fila no existe en la tabla. Antes se repetía el número en
// los dos lados y ya habían divergido — el panel anunciaba 46 horas legales
// mientras el motor separaba las horas extra a 42.
//
// `min` es el piso permitido al editar (0 si no se declara). No es cosmético:
// hay dos umbrales que NO pueden valer 0 sin romper la aritmética del motor,
// y hasta ahora nada lo impedía —
//   weekly_legal_hours = 0    -> ninguna hora cabe en la jornada legal, así
//                               que TODAS pasan a contarse como hora extra
//                               (el indicador 9 salta de ~3% a 100% en todo
//                               el portafolio, y con él las alertas y el
//                               costo extra potencial).
//   horas_mes_liquidacion = 0 -> es el divisor de la fórmula de GTC; con 0,
//                               valorHoraDesdeSalario() devuelve 0 a la
//                               defensiva y el costo de TODO el mundo se
//                               vuelve $0 sin ningún error visible.
// En los recargos y en los días de preaviso, 0 sí es un valor legítimo
// ("no aplicamos recargo", "no avisar antes"), así que ahí el piso es 0.
const CONFIG_DEFS = {
  weekly_legal_hours: {
    label: 'Horas legales semanales', unit: 'horas', min: 1,
    description: 'Horas semanales legales usadas para separar horas normales de horas extra en el cálculo de costo laboral.',
  },
  umbral_presupuesto: {
    label: 'Umbral de presupuesto casi agotado', unit: '%',
    description: 'Porcentaje de presupuesto ejecutado a partir del cual se dispara la alerta crítica "Presupuesto casi agotado".',
  },
  dias_antes_preventiva: {
    label: 'Días antes de alerta de vencimiento', unit: 'días',
    description: 'Días antes de la fecha fin planeada en que se dispara la alerta preventiva "Vencimiento próximo".',
  },
  // Fórmula de nómina de GTC (sql/33). Estaban solo en la base de datos:
  // mueven dinero en todos los proyectos y no había forma de verlos ni
  // corregirlos sin entrar a MySQL a mano.
  horas_mes_liquidacion: {
    label: 'Horas al mes para el valor hora', unit: 'horas', min: 1,
    description: 'Divisor de la fórmula de GTC: valor hora = salario mensual ÷ este número. Ej. 1.750.950 ÷ 210 = 8.338 $/hora.',
  },
  recargo_extra_diurna_pct: {
    label: 'Recargo hora extra diurna', unit: '%',
    description: 'Recargo de una hora extra entre 6am y 7pm. Factor 1,25 en día hábil (2,15 si además es dominical o festivo).',
  },
  recargo_extra_nocturna_pct: {
    label: 'Recargo hora extra nocturna', unit: '%',
    description: 'Recargo de una hora extra entre 7pm y 6am. Factor 1,75 en día hábil (2,65 si además es dominical o festivo).',
  },
  recargo_nocturno_ordinario_pct: {
    label: 'Recargo nocturno en jornada ordinaria', unit: '%',
    description: 'Recargo de una hora que NO es extra pero se trabaja entre 7pm y 6am. Factor 1,35 (2,25 si además es dominical o festivo).',
  },
  recargo_dominical_festivo_pct: {
    label: 'Recargo dominical o festivo', unit: '%',
    description: 'Recargo por trabajar en domingo o festivo. Factor 1,90 en jornada ordinaria; se SUMA a los recargos de arriba cuando también aplican.',
  },
};

// CC-{año}-{consecutivo 3 dígitos}, único por año (uk_cc_codigo). No hay
// condición de carrera real aquí (solo admin/ceo crean centros, uso esporádico).
//
// El consecutivo sale del MAX ya emitido, no de COUNT(*): DELETE /centros/:id
// borra la fila de verdad cuando el centro no tiene datos asociados, y con
// COUNT(*) el borrado bajaba el conteo y el siguiente código repetía uno
// existente (CC-2026-001/002/003 → borras el 002 → el siguiente volvía a ser
// CC-2026-003), lo que reventaba el INSERT contra la UNIQUE KEY.
async function generarCodigoCentro() {
  const year = new Date().getFullYear();
  const rows = await query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(codigo, '-', -1) AS UNSIGNED)) AS max_seq
       FROM mp_centro_costo
      WHERE codigo LIKE ?`,
    [`CC-${year}-%`]
  );
  const seq = String(Number(rows[0].max_seq || 0) + 1).padStart(3, '0');
  return `CC-${year}-${seq}`;
}

// Un leader solo puede escribir en centros cuyo project_folder esté en su
// scope (mp_project_owners). admin/ceo (allowedProjects === null) pueden con cualquiera.
async function canWriteCenter(scope, costCenterId) {
  if (!scope || scope.allowedProjects === null) return true;
  const rows = await query('SELECT project_folder FROM mp_centro_costo WHERE cost_center_id = ?', [costCenterId]);
  if (!rows.length) return false;
  return scope.allowedProjects.includes(rows[0].project_folder);
}

// Centros visibles para el scope actual, con los campos que necesitan los
// 17 indicadores. Usada por /indicadores-17, /alertas y los exports (evita
// repetir la misma query 3 veces).
async function getCentrosVisibles(scope) {
  const scopeF = projectScopeClause(scope, 'project_folder');
  return query(
    `SELECT cost_center_id, project_folder, project_name, budget, status,
            contract_value, start_date, planned_end_date, actual_end_date
       FROM mp_centro_costo
      WHERE 1=1 ${scopeF.clause}
      ORDER BY project_name`,
    scopeF.params
  );
}

module.exports = {
  rolesValidos,
  nombreVisibleDeRoles,
  slugRole,
  CARPETAS_NO_SON_PROYECTOS,
  EXPENSE_CATEGORIES,
  CENTRO_TIPOS,
  CENTRO_ESTADOS,
  CENTRO_TIPO_LABEL,
  CENTRO_ESTADO_LABEL,
  CONFIG_DEFS,
  generarCodigoCentro,
  generarProjectFolderUnico,
  canWriteCenter,
  getCentrosVisibles,
};
