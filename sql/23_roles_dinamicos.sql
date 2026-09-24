-- ============================================================
--  Bloque 23 — Catálogo de cargos abierto (cualquier PM puede crear uno)
-- ------------------------------------------------------------
--  Hasta ahora `role_catalog` era un ENUM fijo en dos tablas
--  (mp_tarifa_cargo, mp_equipo_proyecto) con 7 valores grabados en
--  el esquema: desarrollador, analista, lider_proyecto, qa,
--  disenador, scrum_master, otro. Agregar un cargo nuevo exigía una
--  migración — nadie podía hacerlo desde la aplicación.
--
--  A pedido explícito: un PM debe poder crear un cargo nuevo (ej.
--  "Tester", "UX Designer") sin depender de un despliegue. Un ENUM
--  no lo permite (su lista de valores es parte de la definición de
--  la columna); un VARCHAR sí. mp_tarifa_cargo sigue siendo la
--  fuente única del catálogo — el backend ya no valida contra una
--  lista fija de JS, valida contra las filas que existan ahí.
--
--  Idempotente: solo altera si la columna sigue siendo ENUM.
-- ============================================================

SET @tc_es_enum := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_tarifa_cargo'
     AND COLUMN_NAME = 'role_catalog'
     AND DATA_TYPE = 'enum'
);

SET @sql := IF(@tc_es_enum > 0,
  'ALTER TABLE mp_tarifa_cargo MODIFY COLUMN role_catalog VARCHAR(50) NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ep_es_enum := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_equipo_proyecto'
     AND COLUMN_NAME = 'role_catalog'
     AND DATA_TYPE = 'enum'
);

SET @sql := IF(@ep_es_enum > 0,
  'ALTER TABLE mp_equipo_proyecto MODIFY COLUMN role_catalog VARCHAR(50) NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
