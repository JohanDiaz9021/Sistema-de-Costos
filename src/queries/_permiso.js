'use strict';

/**
 * Detector de filas que NO penalizan al recurso.
 *
 * Cuando una tarea contiene una palabra clave de permiso/festivo en su
 * actividad, no debe contar negativamente en cumplimiento. La lógica vive
 * acá para que los indicadores la apliquen consistentemente.
 *
 * El filtro se aplica vía SQL en las queries (WHERE activity NOT REGEXP ...)
 * o vía clausula condicional al calcular cumplimiento.
 */

const PERMISO_KEYWORDS = [
  'permiso', 'festivo', 'festividad', 'vacacion', 'vacaciones',
  'incapacidad', 'licencia',
];

// Patrón SQL: cada keyword envuelta con \b (límite de palabra) para evitar
// falsos positivos por substring. Ej: 'gestión de permisos' o 'días festivos'
// (tareas legítimas) ya no activan 'permiso'/'festivo', pero 'permiso por
// votación' o 'día festivo' sí. En el literal SQL se escribe \\ para que
// MariaDB reciba \b como límite de palabra.
function sqlPattern() {
  return PERMISO_KEYWORDS.map((k) => `\\\\b${k}\\\\b`).join('|');
}

/** Fragmento SQL para EXCLUIR filas de permiso del cálculo. Usar como:
 *    WHERE ... AND ${notPermisoClause('t.activity')}
 */
function notPermisoClause(activityCol = 't.activity') {
  // REGEXP es case-insensitive con utf8mb4_general_ci (default GTC stage).
  return `(${activityCol} IS NULL OR ${activityCol} NOT REGEXP '${sqlPattern()}')`;
}

/** Fragmento SQL para FILTRAR SOLO filas de permiso. Útil para contarlas. */
function isPermisoClause(activityCol = 't.activity') {
  return `(${activityCol} REGEXP '${sqlPattern()}')`;
}

/** Para uso en JS: ¿esta actividad es un permiso? Aplica el mismo criterio
 *  de límite de palabra (\b) que la versión SQL. */
function isPermiso(activity) {
  if (!activity) return false;
  const re = new RegExp(PERMISO_KEYWORDS.map((k) => `\\b${k}\\b`).join('|'), 'i');
  return re.test(String(activity));
}

module.exports = {
  PERMISO_KEYWORDS,
  notPermisoClause,
  isPermisoClause,
  isPermiso,
};
