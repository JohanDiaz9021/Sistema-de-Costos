-- ============================================================
--  mp_dashboard_users.username (Fase 3.4 — Gestión de PMs)
-- ------------------------------------------------------------
--  Permite que un PM inicie sesión con un "usuario" corto (ej: mbastidas)
--  además de su correo. Nullable y único cuando se define — las cuentas
--  existentes (CEO, admin, líderes actuales) no se ven afectadas, siguen
--  entrando con su correo igual que siempre.
--  Idempotente vía procedimiento (mismo patrón que sql/14).
-- ============================================================

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_dashboard_users'
     AND COLUMN_NAME = 'username'
);

SET @sql := IF(@col_exists = 0,
  'ALTER TABLE mp_dashboard_users
     ADD COLUMN username VARCHAR(50) NULL UNIQUE AFTER email',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
