-- Un talento no puede estar dos veces en el MISMO centro de costos.
--
-- Sí puede estar en varios centros a la vez (una fila por centro; la tabla de
-- Equipo lo muestra como filas distintas con su propio cargo y tarifa). Lo que
-- no tiene sentido es repetirlo dentro del mismo proyecto: además de verse
-- duplicado en pantalla, el LEFT JOIN de weeklyAggregate
-- (src/queries/costo-weekly-hours.js) hace match con las dos filas y termina
-- contando sus horas dos veces, inflando el costo ejecutado del centro.
--
-- El índice cubre activos e inactivos a propósito: reactivar una fila vieja
-- debe ser un UPDATE sobre la que ya existe, no un INSERT nuevo.

-- Idempotente vía procedimiento, igual que sql/11, 12, 14, 15 y 16: sin el
-- guard, re-ejecutar este bloque sobre una base donde el índice ya existe
-- aborta con "error 1061, duplicate key name" y tumba el resto de la corrida.
--
-- OJO antes de aplicarlo en una base nueva: si la tabla ya trae un talento
-- repetido en el mismo centro, el ALTER falla con error 1062 y el índice no se
-- crea. Los duplicados se resuelven a mano primero (hay que decidir cuál fila
-- conserva la tarifa correcta); `node scripts/verify-costeo-readonly.js` los
-- lista sin modificar nada.

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_equipo_proyecto'
     AND INDEX_NAME = 'uk_equipo_centro_talento'
);

SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE mp_equipo_proyecto
     ADD UNIQUE KEY uk_equipo_centro_talento (cost_center_id, employee_id)',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
