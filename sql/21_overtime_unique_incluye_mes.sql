-- ============================================================
--  Bloque 21 — mp_overtime_decisions: la llave única debe incluir el mes
-- ------------------------------------------------------------
--  BUG DE DINERO. sql/09 creó la llave como
--      (employee_id, cost_center_id, week_number, year_number)
--  asumiendo que week_number era la semana del AÑO. No lo es: el RPA
--  la escribe como la semana del MES, y va de 1 a 6 repitiéndose cada
--  mes (verificado en datos: junio, julio y agosto tienen todos su
--  "semana 1").
--
--  Consecuencia: para un mismo talento y centro, la semana 1 de junio,
--  la de julio y la de agosto comparten llave. Como
--  syncOvertimeDecisions() inserta con INSERT IGNORE, solo entra la
--  primera y las demás se descartan sin error ni aviso — se pierden
--  horas extra de meses completos, y nadie se entera porque la
--  operación "no falla".
--
--  La corrección es ampliar la llave con month_number. Ampliar una
--  llave única nunca puede fallar por duplicados (solo admite MÁS
--  filas, no menos), así que es segura de aplicar con datos dentro.
--
--  Después de aplicar esto conviene volver a abrir Horas Extra: la
--  sincronización creará las filas de los meses que antes se estaban
--  descartando.
--
--  Idempotente vía procedimiento, mismo patrón que sql/11, 12, 16 y 17.
-- ============================================================

SET @key_sin_mes := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'uk_ot_talento_proyecto_semana'
     AND COLUMN_NAME = 'month_number'
);

SET @key_existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'uk_ot_talento_proyecto_semana'
);

-- Solo actúa si la llave existe y todavía NO incluye month_number.
SET @sql := IF(@key_existe > 0 AND @key_sin_mes = 0,
  'ALTER TABLE mp_overtime_decisions
     DROP INDEX uk_ot_talento_proyecto_semana,
     ADD UNIQUE KEY uk_ot_talento_proyecto_semana (employee_id, cost_center_id, week_number, month_number, year_number)',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
