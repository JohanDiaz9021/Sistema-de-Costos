-- ============================================================
--  Bloque 34 — Plan de Recursos por PERSONA real (además de por Cargo)
-- ------------------------------------------------------------
--  sql/27 armaba el Plan de Recursos solo por CARGO ("2 desarrolladores a
--  $9.000/h"): tiene sentido para planear una vacante que todavía no
--  existe, pero no para alguien que ya conoces — a pedido explícito, si
--  ya sabes que es Johan quien va a trabajar en el proyecto, no tiene
--  lógica pedirle a alguien que invente un costo/hora: ya sabemos su
--  salario real (sql/33) y de ahí sale solo.
--
--  employee_id NULL = fila "por Cargo" (comportamiento de siempre, sin
--  cambios). employee_id NOT NULL = fila "por Persona": personas queda
--  fijo en 1 (es ESA persona, no un cupo) y costo_hora lo calcula el
--  servidor desde su salario conocido (ver GET /equipo/salario-conocido y
--  resolverFilasPlan en costo-plan-recursos.js) — el que mande el cliente
--  en esa fila se ignora, para que no puedan quedar dos cifras que no
--  cuadran para la misma persona en dos proyectos.
--
--  La UNIQUE KEY vieja (cost_center_id, role_catalog) obligaba a que cada
--  cargo apareciera una sola vez por centro — eso ya no puede ser cierto
--  con filas "por Persona": dos personas reales pueden compartir cargo.
--  Se reemplaza por (cost_center_id, employee_id): InnoDB trata cada NULL
--  como distinto para efectos de UNIQUE, así que las filas "por Cargo"
--  (employee_id NULL) nunca chocan entre sí por esta llave — su
--  unicidad por rol se valida en el código (resolverFilasPlan), igual que
--  ya se validaba antes.
--
--  Idempotente: la columna y la llave se agregan solo si faltan.
-- ============================================================

SET @col_empleado := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_plan_recursos' AND COLUMN_NAME = 'employee_id'
);
SET @sql := IF(@col_empleado = 0,
  'ALTER TABLE mp_plan_recursos
     ADD COLUMN employee_id INT NULL
       COMMENT ''Persona real de esta fila (sql/34). NULL = fila "por Cargo", sin cambios respecto a sql/27.'',
     ADD CONSTRAINT fk_pr_employee FOREIGN KEY (employee_id) REFERENCES mp_employees (employee_id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Se agrega la llave NUEVA antes de tocar la vieja: uk_plan_centro_rol es
-- la única que respalda hoy la FK de cost_center_id (fk_pr_cost_center), y
-- MySQL/MariaDB no deja soltar un índice del que depende una FK si no queda
-- ningún otro índice que empiece por esa misma columna. uk_plan_centro_persona
-- también empieza por cost_center_id, así que en cuanto existe, la FK queda
-- cubierta por ella y uk_plan_centro_rol ya se puede soltar sin error.
SET @tiene_uk_nueva := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_plan_recursos' AND INDEX_NAME = 'uk_plan_centro_persona'
);
SET @sql3 := IF(@tiene_uk_nueva = 0,
  'ALTER TABLE mp_plan_recursos ADD UNIQUE KEY uk_plan_centro_persona (cost_center_id, employee_id)',
  'SELECT 1'
);
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

SET @tiene_uk_vieja := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_plan_recursos' AND INDEX_NAME = 'uk_plan_centro_rol'
);
SET @sql2 := IF(@tiene_uk_vieja > 0, 'ALTER TABLE mp_plan_recursos DROP INDEX uk_plan_centro_rol', 'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
