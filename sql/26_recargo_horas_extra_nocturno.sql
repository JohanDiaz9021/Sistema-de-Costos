-- ============================================================
--  Bloque 26 — Recargo nocturno + registro manual con hora exacta
-- ------------------------------------------------------------
--  sql/25 agregó el recargo diurno/festivo, pero solo se podía aplicar
--  a las horas que llegan del RPA (mp_task_facts), que trae un total
--  por día, sin hora de inicio/fin — ahí es imposible saber cuánto de
--  ese total cayó en horario nocturno.
--
--  Para el alta MANUAL de horas extra (el PM registra a mano una hora
--  extra que el RPA no capturó) sí se le puede pedir fecha + hora
--  inicio + hora fin, y con eso sí se puede calcular el recargo
--  nocturno con precisión. De ahí las dos llaves nuevas y las tres
--  columnas nuevas (solo se llenan en el alta manual; las filas que
--  detecta la sincronización automática las dejan en NULL).
--
--  Horario nocturno: 9:00 p.m. a 6:00 a.m. (Código Sustantivo del
--  Trabajo, vigente desde hace décadas — confirmar con RRHH si GTC
--  tiene un acuerdo distinto).
--
--  Tabla de recargos que queda completa con este bloque:
--    normal  + diurna   -> recargo_extra_diurna_pct          (25%,  sql/25)
--    normal  + nocturna -> recargo_extra_nocturna_pct        (75%)
--    festivo + diurna   -> recargo_extra_festiva_pct         (100%, sql/25)
--    festivo + nocturna -> recargo_extra_festiva_nocturna_pct(150%)
--
--  Domingo sigue sin poder calcularse (mp_task_facts no captura
--  hours_sunday), incluso para el alta manual: si la fecha elegida cae
--  en domingo, hoy no hay tabla de horas de domingo para comparar ni
--  falta que hacerlo aquí — el registro manual es puntual, no depende
--  de esa columna. Se trata igual que festivo (recargo_extra_festiva_pct
--  / recargo_extra_festiva_nocturna_pct) en el código, no aquí en SQL.
--
--  Idempotente: INSERT IGNORE respeta la PK y las columnas se agregan
--  solo si no existen todavía.
--
--  OJO (sql/33): dos cosas de este bloque quedaron atrás cuando GTC
--  entregó su tabla real de nómina.
--    1. recargo_extra_festiva_nocturna_pct ya NO existe: el factor de
--       festivo+extra nocturna no es 2,50 sino 2,65, y sale de sumar
--       0,90 (dominical) + 0,75 (extra nocturna). sql/33 borra esa
--       llave y la deriva.
--    2. El horario nocturno de GTC empieza a las 7 p.m., no a las
--       9 p.m. como se asumió aquí. El código usa el de la empresa
--       (HORA_INICIO_NOCTURNO en costo-recargos.js).
--  recargo_extra_nocturna_pct sí sigue vigente, con el mismo 75%.
-- ============================================================

INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('recargo_extra_nocturna_pct',         '75',  'Recargo (%) sobre la tarifa/hora para horas extra nocturnas (9pm-6am) en día hábil no festivo (ley: 75%).'),
  ('recargo_extra_festiva_nocturna_pct', '150', 'Recargo (%) sobre la tarifa/hora para horas extra nocturnas (9pm-6am) en día festivo o domingo (ley: 150%).');

SET @col_fecha := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_overtime_decisions' AND COLUMN_NAME = 'fecha'
);
SET @sql := IF(@col_fecha = 0,
  'ALTER TABLE mp_overtime_decisions
     ADD COLUMN fecha       DATE NULL COMMENT ''Solo en alta manual (sql/26): fecha exacta trabajada.'',
     ADD COLUMN hora_inicio TIME NULL COMMENT ''Solo en alta manual (sql/26): hora de inicio del turno.'',
     ADD COLUMN hora_fin    TIME NULL COMMENT ''Solo en alta manual (sql/26): hora de fin del turno.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
