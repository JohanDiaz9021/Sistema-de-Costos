-- ============================================================
--  mp_dashboard_users.sidebar_collapsed (Fase 2.5, ítem 5.5)
-- ------------------------------------------------------------
--  Persiste si el usuario prefiere el sidebar colapsado o expandido,
--  para que la preferencia sobreviva entre sesiones (hoy se pierde
--  al recargar porque solo vive en una clase CSS en memoria).
--  Idempotente vía procedimiento (mismo patrón que sql/12).
-- ============================================================

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_dashboard_users'
     AND COLUMN_NAME = 'sidebar_collapsed'
);

SET @sql := IF(@col_exists = 0,
  'ALTER TABLE mp_dashboard_users
     ADD COLUMN sidebar_collapsed TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
