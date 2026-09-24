-- ============================================================
--  Bloque 24 (ago 2026) — mp_employees.email pasa a ser opcional
-- ------------------------------------------------------------
--  Hasta ahora email era NOT NULL: el alta rápida de un talento
--  desde Equipo del Proyecto (POST /equipo/nueva-persona, a pedido
--  explícito del cliente) no debe obligar a pedir el correo — el
--  PM solo conoce el nombre y el cargo de la persona en ese
--  momento. El correo se puede completar después desde "Gestionar
--  empleados" (admin/ceo) si hace falta para SharePoint o alertas.
--
--  No se toca ningún dato existente: solo se relaja la restricción.
--  Idempotente: solo altera si la columna sigue siendo NOT NULL.
-- ============================================================

SET @email_es_not_null := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_employees'
     AND COLUMN_NAME = 'email'
     AND IS_NULLABLE = 'NO'
);

SET @sql := IF(@email_es_not_null > 0,
  'ALTER TABLE mp_employees MODIFY COLUMN email VARCHAR(150) NULL',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
