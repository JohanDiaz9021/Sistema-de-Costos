-- ============================================================
--  Bloque 42 — Horas extra: varios registros por persona/centro/semana
-- ------------------------------------------------------------
--  A pedido explícito (17 sep 2026): una persona puede hacer varias
--  horas extra en la misma semana (martes 18-21, jueves 19-22...). La
--  llave uk_ot_talento_proyecto_semana (sql/21) solo admitía UNA fila
--  por persona/centro/semana/mes/año, así que el segundo turno manual
--  se rechazaba con "Ya existe un registro...".
--
--  POR QUÉ NO SE BORRA LA LLAVE: syncOvertimeDecisions() inserta con
--  ON DUPLICATE KEY UPDATE y depende de ella para no duplicar filas (y
--  costos) cada vez que corre.
--
--  La llave se amplía con turno_key:
--    - filas automáticas (sync)  -> turno_key = ''  (siguen siendo 1 por semana)
--    - filas manuales            -> turno_key = 'AAAA-MM-DD HH:MM-HH:MM'
--  Así caben todos los turnos manuales que se quieran, y solo se rechaza
--  el MISMO turno exacto registrado dos veces (doble clic).
--
--  NOT NULL a propósito: en MySQL/MariaDB los NULL no chocan en una llave
--  única, y las filas automáticas dejarían de deduplicarse.
--
--  Ampliar una llave única nunca falla por duplicados. Idempotente.
-- ============================================================

ALTER TABLE mp_overtime_decisions
  ADD COLUMN IF NOT EXISTS turno_key VARCHAR(40) NOT NULL DEFAULT '' AFTER hora_fin;

-- Filas manuales ya existentes: mismo formato que createManualOvertime.
UPDATE mp_overtime_decisions
   SET turno_key = CONCAT(DATE_FORMAT(fecha, '%Y-%m-%d'), ' ',
                          TIME_FORMAT(hora_inicio, '%H:%i'), '-',
                          TIME_FORMAT(hora_fin, '%H:%i'))
 WHERE turno_key = '' AND fecha IS NOT NULL AND hora_inicio IS NOT NULL AND hora_fin IS NOT NULL;

SET @key_con_turno := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'uk_ot_talento_proyecto_semana'
     AND COLUMN_NAME = 'turno_key'
);

SET @key_existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND INDEX_NAME = 'uk_ot_talento_proyecto_semana'
);

SET @sql := IF(@key_con_turno = 0,
  IF(@key_existe > 0,
    'ALTER TABLE mp_overtime_decisions
       DROP INDEX uk_ot_talento_proyecto_semana,
       ADD UNIQUE KEY uk_ot_talento_proyecto_semana (employee_id, cost_center_id, week_number, month_number, year_number, turno_key)',
    'ALTER TABLE mp_overtime_decisions
       ADD UNIQUE KEY uk_ot_talento_proyecto_semana (employee_id, cost_center_id, week_number, month_number, year_number, turno_key)'),
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
