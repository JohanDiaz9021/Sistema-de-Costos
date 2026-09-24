-- ============================================================
--  Bloque 10 — mp_centro_costo (módulo de Costeo)
-- ------------------------------------------------------------
--  Un registro por proyecto/centro de costos. `project_folder`
--  es el puente con mp_task_facts.project_folder (datos del RPA).
--  Idempotente: si la tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_centro_costo (
  cost_center_id    INT AUTO_INCREMENT PRIMARY KEY,
  project_folder    VARCHAR(150) NOT NULL,
  project_name      VARCHAR(150) NOT NULL,
  origin            ENUM('planeacion','manual') NOT NULL DEFAULT 'planeacion',
  budget            DECIMAL(14,2) NOT NULL DEFAULT 0,
  contract_value    DECIMAL(14,2) NULL,
  previous_cost     DECIMAL(14,2) NOT NULL DEFAULT 0,
  start_date        DATE NULL,
  planned_end_date  DATE NULL,
  actual_end_date   DATE NULL,
  status            ENUM('vigente','por_vencer','vencido','cerrado','inactivo') NOT NULL DEFAULT 'vigente',
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  -- "Un registro por proyecto/centro de costos"
  UNIQUE KEY uk_cc_project_folder (project_folder),
  CONSTRAINT fk_cc_created_by FOREIGN KEY (created_by) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
