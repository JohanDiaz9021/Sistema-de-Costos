-- ============================================================
--  Bloque 33 — Valor hora desde el salario + tabla de recargos real de GTC
-- ------------------------------------------------------------
--  Hasta ahora el costo/hora se tecleaba a mano (mp_equipo_proyecto.
--  hourly_cost) y los recargos de horas extra estaban sembrados con
--  los porcentajes "de ley genéricos" (sql/25, sql/26). GTC entregó la
--  tabla que usa de verdad en nómina, y de ahí salen dos cambios:
--
--  1) VALOR HORA = SALARIO MENSUAL / 210
--     210 = horas/mes de liquidación de GTC. Ejemplo real (el único
--     dato real cargado hoy, a pedido explícito):
--       Johan Sebastian Diaz Caicedo -> 1.750.950 / 210 = 8.338 $/hora
--     Se guarda el salario (monthly_salary) además del valor hora, para
--     que el número deje de ser un dato suelto sin origen: hourly_cost
--     sigue siendo lo que consume el motor, monthly_salary es de dónde
--     salió. Nadie tiene que volver a dividir a mano.
--
--  2) LOS RECARGOS SE COMPONEN, NO SE ENUMERAN
--     La tabla de GTC (factor sobre la hora ordinaria):
--       Hora extra diurna .......................... 1,25  (125%)
--       Hora extra nocturna ........................ 1,75  (175%)
--       Recargo nocturno en jornada ordinaria ...... 0,35  ( 35%)
--       Dominical/festivo en jornada ordinaria ..... 1,90  (190%)
--       Recargo nocturno en dominical o festivo .... 2,25  (225%)
--       Hora extra diurna en dominical o festivo ... 2,15  (215%)
--       Hora extra nocturna en dominical o festivo . 2,65  (265%)
--
--     Los 7 casos salen de sumar SOLO 4 componentes:
--       1,00 (hora ordinaria)
--       + 0,90 si el día es dominical o festivo
--       + 0,25 hora extra diurna | 0,75 hora extra nocturna
--                                | 0,35 nocturna dentro de la jornada
--     Comprobación: 1 + 0,90 + 0,75 = 2,65 ✓ ; 1 + 0,90 + 0,35 = 2,25 ✓
--
--     Por eso entran dos llaves nuevas (recargo_nocturno_ordinario_pct,
--     recargo_dominical_festivo_pct) y SALEN las dos que enumeraban
--     combinaciones ya calculadas (recargo_extra_festiva_pct = 100 y
--     recargo_extra_festiva_nocturna_pct = 150). Además de estar
--     duplicando información derivable, sus valores estaban MAL contra
--     la tabla real: festivo+extra diurna es 2,15 (no 2,00) y
--     festivo+extra nocturna es 2,65 (no 2,50). Dejarlas sembradas
--     habría dejado dos cifras que ya nadie lee contradiciendo a las
--     que sí mueven dinero. Se borran solo esas dos filas de
--     configuración; no se toca ningún dato de negocio.
--
--  Horario nocturno: 7 p.m. a 6 a.m. según la tabla de GTC (la jornada
--  diurna va de 6 a.m. a 7 p.m.). Ojo: sql/26 había asumido 9 p.m., que
--  es el corte anterior del Código Sustantivo; el código se alinea a la
--  tabla de la empresa (ver HORA_INICIO_NOCTURNO en costo-recargos.js).
--
--  Idempotente: la columna se agrega solo si falta, INSERT IGNORE no
--  pisa valores que el Administrador haya ajustado, y el UPDATE del
--  salario real solo actúa si todavía no tiene salario cargado.
-- ============================================================

-- ---------- 1. monthly_salary en mp_equipo_proyecto ----------
SET @col_salario := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_equipo_proyecto'
     AND COLUMN_NAME = 'monthly_salary'
);
SET @sql := IF(@col_salario = 0,
  'ALTER TABLE mp_equipo_proyecto
     ADD COLUMN monthly_salary DECIMAL(12,2) NULL
     COMMENT ''Salario mensual (sql/33). hourly_cost = ROUND(monthly_salary / horas_mes_liquidacion). NULL = la tarifa se escribió a mano, sin salario de origen.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2. Parámetros de la fórmula ----------
INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('horas_mes_liquidacion', '210',
   'Horas/mes con las que GTC liquida el valor de la hora: valor hora = salario mensual / este número.'),
  ('recargo_nocturno_ordinario_pct', '35',
   'Recargo (%) de una hora ORDINARIA (dentro de la jornada legal) trabajada en horario nocturno 7pm-6am. Factor 1,35.'),
  ('recargo_dominical_festivo_pct', '90',
   'Recargo (%) por trabajar en domingo o festivo, en jornada ordinaria. Factor 1,90. Se SUMA al recargo de hora extra o nocturno cuando aplican (1,90+0,25=2,15; 1,90+0,75=2,65; 1,90+0,35=2,25).');

-- Las dos de sql/25 y sql/26 que sí siguen vigentes se dejan como están
-- (25 y 75), solo se precisa su descripción: ahora son COMPONENTES que se
-- suman al de festivo, no factores finales.
UPDATE mp_costeo_config
   SET description = 'Recargo (%) de una hora EXTRA diurna (6am-7pm). Factor 1,25 en día hábil; en dominical/festivo se suma el 90% y queda 2,15.'
 WHERE config_key = 'recargo_extra_diurna_pct';

UPDATE mp_costeo_config
   SET description = 'Recargo (%) de una hora EXTRA nocturna (7pm-6am). Factor 1,75 en día hábil; en dominical/festivo se suma el 90% y queda 2,65.'
 WHERE config_key = 'recargo_extra_nocturna_pct';

-- Combinaciones ya derivables (y con el valor equivocado): fuera.
DELETE FROM mp_costeo_config
 WHERE config_key IN ('recargo_extra_festiva_pct', 'recargo_extra_festiva_nocturna_pct');

-- ---------- 3. Dato real: Johan Sebastian Diaz Caicedo ----------
-- Único salario real cargado, para poder validar la fórmula punta a punta
-- contra un valor conocido (1.750.950 / 210 = 8.338). Se aplica a sus
-- asignaciones activas y solo si todavía no tienen salario, para que
-- re-ejecutar el bloque no pise un ajuste hecho después desde la app.
UPDATE mp_equipo_proyecto ep
   JOIN mp_employees e ON e.employee_id = ep.employee_id
    SET ep.monthly_salary = 1750950.00,
        ep.hourly_cost    = ROUND(1750950.00 / 210)
  WHERE e.canonical_name = 'Johan Sebastian Diaz Caicedo'
    AND ep.is_active = 1
    AND ep.monthly_salary IS NULL;
