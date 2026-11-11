'use strict';

/**
 * Historial de acciones y transacciones del módulo de Costeo (Bloque 4, ago
 * 2026). logAudit() se llama desde los routers de src/routes/costeo/ después
 * de cada escritura exitosa en Centro de Costos, Equipo del Proyecto, Gastos
 * no planeados, Horas Extra, Tarifas por Cargo y Accesos — nunca antes, para
 * no registrar una acción que terminó fallando.
 */

const { query } = require('../db');
const { costCenterScopeClause } = require('./costo-common');
const { formatCOP } = require('./costo-export-format');

// Dinero para los textos del historial (7 sep 2026, a pedido explícito):
// antes se guardaba el número crudo — "Presupuesto: 10000000 → 100000000" —
// y con cifras de millones eso no se puede leer de un vistazo. Vacío/null
// queda en "—" en vez de "$ 0": no es lo mismo "no tenía valor de contrato"
// que "el contrato era de cero pesos".
function formatMoneda(valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  return formatCOP(valor);
}

// logAudit() se llama SIEMPRE despues de que la escritura de negocio ya
// ocurrio. Si el INSERT del historial falla, la operacion del usuario ya
// esta hecha y no se puede deshacer desde aqui: propagar el error le
// mostraria un 500 ("no se guardo") sobre un cambio que si se guardo, que es
// peor que perder una linea de historial. Se registra fuerte en el log del
// servidor para que el fallo no pase inadvertido.
//
// Caso concreto que motiva esto: sql/22 amplia el ENUM de entity_type con
// 'tarifa_cargo' y 'acceso'. Si el codigo se despliega antes de correr la
// migracion, guardar una tarifa seguiria funcionando y solo se perderia su
// linea de historial, en vez de romper la pantalla entera.
async function logAudit({ costCenterId, entityType, entityId, action, userId, userName, description }) {
  try {
    await query(
      `INSERT INTO mp_costeo_audit_log (cost_center_id, entity_type, entity_id, action, user_id, user_name, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [costCenterId ?? null, entityType, entityId ?? null, action, userId ?? null, userName || null, description]
    );
  } catch (err) {
    console.error(
      `[audit] NO se pudo registrar en el historial (${entityType}/${action}, centro ${costCenterId}): ${err.message}`,
      '— revisar si falta correr sql/22_audit_log_tarifas_accesos.sql'
    );
  }
}

// Compara un subconjunto de campos "antes" vs "después" y arma una
// descripción legible ("Presupuesto: $10.000 → $12.000, Estado: vigente →
// inactivo"). Solo incluye los campos que de verdad cambiaron.
function describirCambios(antes, despues, etiquetas, formatear = {}) {
  const partes = [];
  for (const [campo, etiqueta] of Object.entries(etiquetas)) {
    if (despues[campo] === undefined) continue;
    const a = antes ? antes[campo] : undefined;
    const d = despues[campo];
    // Compara como string para no marcar cambio falso por tipo (number vs "number").
    if (String(a ?? '') === String(d ?? '')) continue;
    const fmt = formatear[campo] || ((v) => (v === null || v === undefined || v === '' ? '—' : String(v)));
    partes.push(`${etiqueta}: ${fmt(a)} → ${fmt(d)}`);
  }
  return partes.length ? partes.join(', ') : 'Sin cambios detectados';
}

// costCenterId acota el historial a UN proyecto (7 sep 2026): la ventana
// "Historial de cambios" de cada tarjeta de Costo Planeado pide solo el
// rastro de ese centro, en vez de traer los 200 de todos y filtrarlos en el
// navegador — que además se comía cambios viejos de un proyecto poco activo
// cuando otro proyecto llenaba el tope.
async function listAuditLog(scope, { entityType, costCenterId, limit = 100 } = {}) {
  // 'a.cost_center_id' explícito: esta consulta hace JOIN con mp_centro_costo
  // (alias cc), que TAMBIÉN tiene una columna cost_center_id — sin calificar
  // el alias, "cost_center_id" es ambiguo entre las dos tablas. Para
  // admin/ceo nunca se notaba porque su scope no agrega esta cláusula
  // (allowedProjects === null); en cuanto un PM (scope acotado) la
  // disparaba, la consulta entera fallaba y el panel se quedaba
  // "Cargando..." para siempre.
  const scopeF = costCenterScopeClause(scope, 'a.cost_center_id');
  const filtroTipo = entityType ? ' AND entity_type = ?' : '';
  const filtroCentro = costCenterId ? ' AND a.cost_center_id = ?' : '';
  const params = [
    ...scopeF.params,
    ...(entityType ? [entityType] : []),
    ...(costCenterId ? [costCenterId] : []),
  ];
  const rows = await query(
    `SELECT a.log_id, a.cost_center_id, cc.project_name, a.entity_type, a.entity_id,
            a.action, a.user_id, a.user_name, a.description, a.created_at
       FROM mp_costeo_audit_log a
       LEFT JOIN mp_centro_costo cc ON cc.cost_center_id = a.cost_center_id
      WHERE 1=1 ${scopeF.clause} ${filtroTipo} ${filtroCentro}
      ORDER BY a.created_at DESC, a.log_id DESC
      LIMIT ${Number(limit) || 100}`,
    params
  );
  return rows;
}

module.exports = { logAudit, describirCambios, listAuditLog, formatMoneda };
