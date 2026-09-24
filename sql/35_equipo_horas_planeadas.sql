-- ============================================================
--  Bloque 35 — Horas planeadas por persona en Equipo del Proyecto
-- ------------------------------------------------------------
--  A pedido explícito (3 sep 2026): al agregar a alguien al equipo (talento
--  existente o persona nueva), o al editarlo después, se puede indicar
--  cuántas horas va a trabajar en el proyecto — cada persona puede tener
--  una carga distinta (50h, 35h, 10h...) y por lo tanto un costo distinto.
--
--  Vive en mp_equipo_proyecto (no en mp_plan_recursos, que es un mecanismo
--  aparte para armar el presupuesto de un proyecto NUEVO desde cero): esta
--  es la fuente que usa el indicador "Costo Planeado (Mano de Obra)"
--  (costo_planeado_mano_obra en costo-indicadores-17.js), porque es el
--  equipo REAL y actual del proyecto — con su cargo y costo/hora ya ahí — y
--  se edita en el mismo lugar donde ya se agrega/edita a cada persona.
--
--  NULL = todavía no se definieron horas para esa persona (no cuenta en el
--  indicador, no es lo mismo que 0).
--
--  Idempotente: la columna se agrega solo si falta.
-- ============================================================

SET @col_horas := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_equipo_proyecto' AND COLUMN_NAME = 'planned_hours'
);
SET @sql := IF(@col_horas = 0,
  'ALTER TABLE mp_equipo_proyecto
     ADD COLUMN planned_hours DECIMAL(8,2) NULL
       COMMENT ''Horas planeadas para esta persona en este proyecto (sql/35). NULL = sin definir.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
