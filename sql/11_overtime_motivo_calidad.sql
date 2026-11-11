-- ============================================================
--  Bloque 15 — mp_overtime_decisions.motivo / calidad
-- ------------------------------------------------------------
--  Campos que el PM diligencia junto con la decisión 'si' (nunca
--  con 'no', que no tiene impacto en costo). Alimentan:
--  - Indicador #12 Costo de los Errores (calidad=true)
--  - Indicador #13 Responsable del Sobrecosto (motivo interno/externo)
--  - Alerta "Sobrecostos mayormente internos"
--  Ver Especificación Maestra sección 6.3 y 9.
--  Idempotente vía procedimiento (no existe IF NOT EXISTS para
--  ADD COLUMN en MariaDB/MySQL clásico).
-- ============================================================

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND COLUMN_NAME = 'motivo'
);

SET @sql := IF(@col_exists = 0,
  'ALTER TABLE mp_overtime_decisions
     ADD COLUMN motivo ENUM(''interno'',''externo'') NULL AFTER pm_decision_note,
     ADD COLUMN calidad TINYINT(1) NOT NULL DEFAULT 0 AFTER motivo',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
