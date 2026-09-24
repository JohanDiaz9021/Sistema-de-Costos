-- ============================================================
--  Bloque 16 — mp_centro_costo.codigo / tipo / client_name
-- ------------------------------------------------------------
--  Campos que faltaban para el grid de tarjetas de Centro de
--  Costos (ver Especificación Técnica sección 6.1 / Maestra 6.1):
--  - codigo: CC-{año}-{consecutivo 3 dígitos}, autogenerado, único.
--  - tipo: catálogo cerrado (Desarrollo/Consultoria/Soporte/Overhead).
--  - client_name: a quién se le factura (puede ser "GTC Interno").
--  Idempotente vía procedimiento.
-- ============================================================

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_centro_costo'
     AND COLUMN_NAME = 'codigo'
);

SET @sql := IF(@col_exists = 0,
  'ALTER TABLE mp_centro_costo
     ADD COLUMN codigo VARCHAR(20) NULL AFTER cost_center_id,
     ADD COLUMN tipo ENUM(''Desarrollo'',''Consultoria'',''Soporte'',''Overhead'') NOT NULL DEFAULT ''Desarrollo'' AFTER project_name,
     ADD COLUMN client_name VARCHAR(150) NULL AFTER tipo,
     ADD UNIQUE KEY uk_cc_codigo (codigo)',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
