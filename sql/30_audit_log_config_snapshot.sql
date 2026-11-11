-- ============================================================
--  Bloque 30 — mp_costeo_audit_log: cubre Configuración y Snapshots
-- ------------------------------------------------------------
--  A pedido explícito (28 ago 2026): el Historial debe registrar "hasta
--  el más mínimo" movimiento, para poder rastrear quién hizo qué si algo
--  sale mal más adelante. Se auditó cada ruta de escritura del módulo
--  contra logAudit() y quedaban dos huecos reales:
--
--    - PUT /config/:key   — cambiar un umbral (ej. "Presupuesto casi
--      agotado" o los recargos de horas extra) no dejaba rastro, y mueve
--      dinero real: cambia cuándo dispara la alerta crítica o cuánto
--      cuesta una hora extra en TODOS los proyectos.
--    - POST /snapshot y DELETE /snapshots/:id — crear o borrar una
--      fotografía histórica de los 17 indicadores tampoco quedaba
--      registrado.
--
--  (La sincronización automática de horas extra y el snapshot diario
--  automático del scheduler NO se auditan a propósito: no son una
--  decisión de una persona, son el sistema detectando datos que ya
--  existen en otro lado — auditarlos sería ruido, no rastro de quién
--  hizo qué.)
--
--  Idempotente: MODIFY solo corre si el ENUM todavía no tiene 'config'.
-- ============================================================

SET @falta_tipo := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'mp_costeo_audit_log'
     AND COLUMN_NAME  = 'entity_type'
     AND COLUMN_TYPE NOT LIKE '%config%'
);
SET @sql := IF(@falta_tipo > 0,
  'ALTER TABLE mp_costeo_audit_log
     MODIFY COLUMN entity_type ENUM(''centro_costo'',''equipo'',''gasto'',''overtime'',''tarifa_cargo'',''acceso'',''plan_recursos'',''config'',''snapshot'') NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
