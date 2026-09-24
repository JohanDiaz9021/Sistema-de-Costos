-- ============================================================
--  Bloque 22 — mp_costeo_audit_log: auditar Tarifas por Cargo y Accesos
-- ------------------------------------------------------------
--  Hallazgo del code review: las dos escrituras con MAS impacto del
--  modulo no dejaban ningun rastro en el historial.
--
--    1. PUT /tarifas-cargo/:rol y POST /tarifas-cargo/:rol/aplicar
--       reprecian un cargo para toda la empresa y pueden lanzar un
--       UPDATE masivo sobre mp_equipo_proyecto (decenas de personas de
--       golpe). No pasaban por logAudit().
--    2. PUT /accesos/:id cambia contrasenas, correos y activa/desactiva
--       cuentas de PM. Tampoco.
--
--  Un cambio de tarifa sin rastro es indefendible frente a una revision
--  contable: nadie puede responder "quien subio el costo/hora de QA y
--  cuando". Esta migracion agrega los dos tipos de entidad que faltaban.
--
--  entity_id pasa a NULL-able porque una tarifa de cargo no tiene id
--  numerico (su llave es el role_catalog, que va en la descripcion).
--
--  Idempotente: ampliar un ENUM y aflojar un NOT NULL nunca puede fallar
--  por datos existentes, y el IF de abajo evita reejecutarlo.
-- ============================================================

SET @falta_tipos := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'mp_costeo_audit_log'
     AND COLUMN_NAME  = 'entity_type'
     AND COLUMN_TYPE NOT LIKE '%tarifa_cargo%'
);

SET @sql := IF(@falta_tipos > 0,
  'ALTER TABLE mp_costeo_audit_log
     MODIFY COLUMN entity_type ENUM(''centro_costo'',''equipo'',''gasto'',''overtime'',''tarifa_cargo'',''acceso'') NOT NULL,
     MODIFY COLUMN entity_id   INT NULL',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
