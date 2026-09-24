-- ============================================================
--  Bloque 27 — Plan de Recursos (presupuesto calculado, no escrito a mano)
-- ------------------------------------------------------------
--  Hasta ahora "Presupuesto" era un número que alguien escribía sin que
--  el sistema supiera de dónde salió. La idea (a pedido explícito): en vez
--  de escribir una cifra a ciegas, el PM define QUIÉN va a trabajar, a QUÉ
--  tarifa y CUÁNTAS HORAS TOTALES del proyecto necesita cada rol — y el
--  presupuesto se calcula solo, sumando personas × horas_totales × costo_hora.
--
--  Un centro de costos SIN plan guardado sigue funcionando exactamente
--  igual que hoy (presupuesto editable a mano) — esto no rompe nada de lo
--  que ya está cargado. Solo en cuanto se guarda un plan por primera vez,
--  ese centro pasa a modo "calculado" (budget_from_plan = 1) y el
--  presupuesto deja de poder tocarse directo: hay que editar el plan.
--
--  Idempotente: la tabla se crea solo si no existe, y la columna nueva de
--  mp_centro_costo se agrega solo si no existe todavía.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_plan_recursos (
  plan_id         INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id  INT NOT NULL,
  role_catalog    VARCHAR(50) NOT NULL,
  personas        INT NOT NULL DEFAULT 1,
  horas_totales   DECIMAL(10,2) NOT NULL,
  costo_hora      DECIMAL(10,2) NOT NULL,
  created_by      INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  -- Un rol aparece una sola vez por centro: si necesitas 2 analistas,
  -- sube "Personas" a 2 en esa misma fila, no dupliques la fila.
  UNIQUE KEY uk_plan_centro_rol (cost_center_id, role_catalog),
  CONSTRAINT fk_pr_cost_center FOREIGN KEY (cost_center_id)
    REFERENCES mp_centro_costo (cost_center_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @col_bfp := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mp_centro_costo' AND COLUMN_NAME = 'budget_from_plan'
);
SET @sql := IF(@col_bfp = 0,
  'ALTER TABLE mp_centro_costo
     ADD COLUMN budget_from_plan TINYINT(1) NOT NULL DEFAULT 0
       COMMENT ''1 = el presupuesto lo calcula mp_plan_recursos, no se edita a mano''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- entity_type de mp_costeo_audit_log es un ENUM cerrado (sql/18, ampliado
-- en sql/22) — sin esto, logAudit() con entityType:'plan_recursos' fallaría
-- al guardar en el historial. Mismo patrón idempotente de sql/22.
SET @falta_tipo := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'mp_costeo_audit_log'
     AND COLUMN_NAME  = 'entity_type'
     AND COLUMN_TYPE NOT LIKE '%plan_recursos%'
);
SET @sql2 := IF(@falta_tipo > 0,
  'ALTER TABLE mp_costeo_audit_log
     MODIFY COLUMN entity_type ENUM(''centro_costo'',''equipo'',''gasto'',''overtime'',''tarifa_cargo'',''acceso'',''plan_recursos'') NOT NULL',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
