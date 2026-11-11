-- ============================================================
--  Bloque 39 — mp_overtime_decisions: índices para costoExtraAprobado
--  y getOvertimeRows
-- ------------------------------------------------------------
--  Dos consultas reales del camino caliente de Indicadores filtran esta
--  tabla sin índice que las cubra:
--
--   - costoExtraAprobado (costo-motor.js): WHERE cost_center_id = ?
--     AND approval_status = 'aprobado' [AND month_number = ? AND
--     year_number = ?]
--   - getOvertimeRows (costo-indicadores-17.js): WHERE cost_center_id
--     IN (...) [AND month_number = ? AND year_number = ?]
--
--  El único índice existente es el UNIQUE de sql/21
--  (employee_id, cost_center_id, week_number, year_number): no sirve de
--  prefijo para ninguna de las dos porque cost_center_id no es la primera
--  columna. Sin índice propio, MySQL barre la tabla completa y filtra a
--  mano — el mismo patrón que ya se resolvió para mp_costo_no_planeado en
--  sql/28 y sql/38.
--
--  Se agregan dos índices separados (no uno solo) porque las columnas que
--  siguen a cost_center_id no anidan: approval_status para la primera
--  consulta, month_number+year_number para la segunda.
--
--  Idempotente: usa CREATE INDEX solo si el índice no existe ya, mismo
--  patrón que sql/37.
-- ============================================================

SET @idx_estado_existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'idx_ot_centro_estado'
);

SET @sql := IF(@idx_estado_existe = 0,
  'CREATE INDEX idx_ot_centro_estado ON mp_overtime_decisions (cost_center_id, approval_status)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_periodo_existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'idx_ot_centro_mes_anio'
);

SET @sql := IF(@idx_periodo_existe = 0,
  'CREATE INDEX idx_ot_centro_mes_anio ON mp_overtime_decisions (cost_center_id, month_number, year_number)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
