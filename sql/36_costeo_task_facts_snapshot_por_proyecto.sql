-- Índice para el snapshot vigente POR (empleado, proyecto).
--
-- Desde que la carga del Excel es por centro de costos (se sube el mismo
-- archivo a Sistema de costos y luego a Management, y cada carga lee solo
-- las filas de SU proyecto), el "corte vigente" de una persona dejó de ser
-- uno solo: puede tener Sistema de costos cargado el lunes y Management el
-- miércoles, y las dos cargas siguen vigentes.
--
-- baseWhere() (src/queries/costo-common.js) pasó a resolver ese MAX por
-- empleado Y proyecto, con una subconsulta correlacionada que corre por
-- cada fila candidata. El índice existente (employee_id) la dejaba
-- filtrando project_name a mano fila por fila; este cubre las tres
-- columnas que la subconsulta toca, en el orden en que las usa.

-- Idempotente vía procedimiento, igual que sql/17 y 37: sin el guard,
-- re-ejecutar este bloque sobre una base donde el índice ya existe aborta
-- con "error 1061, duplicate key name" y tumba el resto de la corrida
-- (14 sep 2026: lo destapó la re-aplicación del esquema completo durante
-- el desarrollo de sql/37).
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costeo_task_facts'
     AND INDEX_NAME = 'idx_costeo_tf_employee_project_snapshot'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE mp_costeo_task_facts
     ADD KEY idx_costeo_tf_employee_project_snapshot (employee_id, project_name, snapshot_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;