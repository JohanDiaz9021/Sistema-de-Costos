-- ============================================================
--  Bloque 37 — Índices del JOIN de atribución del motor de Costeo
-- ------------------------------------------------------------
--  A pedido explícito (14 sep 2026): el motor atribuye horas cruzando
--  mp_costeo_task_facts contra mp_centro_costo con un OR a propósito (ver
--  costo-motor.js y costo-weekly-hours.js) — el "Proyecto" del Excel unas
--  veces coincide con cc.project_name ("SUECO CRM") y otras con
--  cc.project_folder ("Sistema de costos" -> centro "Costos"). Ambas patas
--  necesitan índice para que MySQL no recorra la tabla completa en cada
--  cálculo:
--
--    cc.project_name   -> SIN índice hoy (la query más pesada del módulo).
--    cc.project_folder -> ya tiene uk_cc_project_folder (UNIQUE).
--    t.project_name    -> SIN índice en la tabla que crece con cada Excel
--                         (una fila por persona×día×carga).
--
--  NO se reescribe el OR como UNION a propósito: si el mismo valor matchea
--  por las dos patas a la vez (nombre = carpeta en un centro, o dos centros
--  distintos — esa colisión pasó de verdad y POST /centros la bloquea desde
--  entonces), el UNION contaría las horas dos veces e inflaría el costo
--  ejecutado. Con las dos columnas indexadas, MySQL resuelve cada pata del
--  OR por su índice y el resultado NO cambia — solo el camino de acceso.
--
--  Idempotente vía procedimiento, igual que sql/17: si el índice ya existe,
--  el guard hace que el ALTER no corra (sin él, re-ejecutar aborta con
--  "error 1061, duplicate key name" y tumba el resto de la corrida).
-- ============================================================

-- 1) mp_centro_costo.project_name — la pata "nombre" del OR.
SET @idx_cc_name := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_centro_costo'
     AND INDEX_NAME = 'idx_cc_project_name'
);
SET @sql := IF(@idx_cc_name = 0,
  'ALTER TABLE mp_centro_costo ADD KEY idx_cc_project_name (project_name)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) mp_costeo_task_facts.project_name — columna de atribución del ejercicio
--    y de la subconsulta de snapshot vigente por (empleado, proyecto).
SET @idx_tf_name := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costeo_task_facts'
     AND INDEX_NAME = 'idx_costeo_tf_project_name'
);
SET @sql := IF(@idx_tf_name = 0,
  'ALTER TABLE mp_costeo_task_facts ADD KEY idx_costeo_tf_project_name (project_name)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;