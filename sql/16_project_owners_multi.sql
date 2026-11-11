-- ============================================================
--  mp_project_owners: permitir varios PM por proyecto
-- ------------------------------------------------------------
--  Antes project_folder era PRIMARY KEY, así que solo podía haber un
--  dueño activo por proyecto (asignar un segundo PM sobrescribía al
--  primero). Cambiamos a llave compuesta (project_folder, pmo_email)
--  para que 2+ PMs puedan compartir el mismo proyecto.
--  Ningún query del backend asume unicidad por project_folder solo
--  (todos filtran también por pmo_email o solo verifican existencia),
--  así que el cambio es seguro.
--  Idempotente vía procedimiento (mismo patrón que sql/14 y sql/15).
-- ============================================================

SET @pk_is_single_col := (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_project_owners'
     AND CONSTRAINT_NAME = 'PRIMARY'
);

SET @sql := IF(@pk_is_single_col = 1,
  'ALTER TABLE mp_project_owners
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (project_folder, pmo_email)',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
