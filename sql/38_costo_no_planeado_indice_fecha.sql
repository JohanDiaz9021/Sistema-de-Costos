-- ============================================================
--  Bloque 38 — mp_costo_no_planeado: idx_cn_centro_estado incluye expense_date
-- ------------------------------------------------------------
--  A pedido explícito (14 sep 2026): tres consultas reales filtran esta
--  tabla por cost_center_id + approval_status + un RANGO de expense_date —
--  costoNoPlaneadoTotal y getMayorGastoNoPlaneado (el ejecutado real de
--  cada centro y el mayor gasto del portafolio, las dos en el camino
--  caliente de abrir Indicadores) y getGastosDeCentro (las alertas).
--
--  El índice de sql/28, idx_cn_centro_estado (cost_center_id,
--  approval_status), ya cubre las dos primeras columnas — MySQL las
--  resuelve por índice y llega a un puñado de filas candidatas por centro.
--  Pero el filtro de fecha (WHERE expense_date >= ? AND expense_date < ?)
--  se aplica DESPUÉS, sin índice, recorriendo a mano esas filas — hoy
--  barato porque son pocas por centro, pero crece con cada gasto que se
--  registra, igual que mp_costeo_task_facts creció hasta necesitar sql/37.
--
--  Los comentarios de costo-motor.js y costo-indicadores-17.js YA dan por
--  hecho que existe "el índice de expense_date" ("deja que MySQL use el
--  índice de expense_date") — se escribieron asumiendo esta migración, que
--  nunca se había hecho.
--
--  Se AMPLÍA el índice existente (se agrega expense_date al final) en vez
--  de crear uno nuevo aparte: las dos primeras columnas ya cubren
--  getGastosDeCentro (que no filtra por fecha, y le sigue sirviendo el
--  mismo índice como prefijo) sin mantener dos índices redundantes que se
--  actualizan en cada INSERT/UPDATE por gusto.
--
--  Idempotente: solo actúa si el índice existe y TODAVÍA no incluye
--  expense_date — mismo patrón que sql/21 (ampliar una llave existente).
-- ============================================================

SET @indice_sin_fecha := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costo_no_planeado'
     AND INDEX_NAME = 'idx_cn_centro_estado'
     AND COLUMN_NAME = 'expense_date'
);

SET @indice_existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costo_no_planeado'
     AND INDEX_NAME = 'idx_cn_centro_estado'
);

-- Solo actúa si el índice existe y todavía NO incluye expense_date.
SET @sql := IF(@indice_existe > 0 AND @indice_sin_fecha = 0,
  'ALTER TABLE mp_costo_no_planeado
     DROP INDEX idx_cn_centro_estado,
     ADD INDEX idx_cn_centro_estado (cost_center_id, approval_status, expense_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
