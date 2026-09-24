-- ============================================================
--  Bloque 13 — mp_overtime_decisions (módulo de Costeo)
-- ------------------------------------------------------------
--  Corazón del flujo de horas extra: una fila por talento/proyecto/
--  semana con hExtra > 0, con su decisión y su aprobación.
--  Idempotente: si la tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_overtime_decisions (
  decision_id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id          INT NOT NULL,
  cost_center_id       INT NOT NULL,
  week_number          INT NOT NULL,
  month_number         INT NOT NULL,
  year_number          INT NOT NULL,
  executed_hours       DECIMAL(6,2) NULL,
  legal_hours          DECIMAL(6,2) NULL,
  extra_hours          DECIMAL(6,2) NULL,
  extra_cost_potential DECIMAL(14,2) NULL,
  pm_decision          ENUM('pendiente','si','no') NOT NULL DEFAULT 'pendiente',
  pm_decision_note     TEXT NULL,
  approval_status      ENUM('no_aplica','pendiente','requiere_jair','aprobado','rechazado') NOT NULL DEFAULT 'pendiente',
  approved_by          INT NULL,
  approved_at          DATETIME NULL,
  extra_cost_final     DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- "Una fila por talento/proyecto/semana"
  UNIQUE KEY uk_ot_talento_proyecto_semana (employee_id, cost_center_id, week_number, year_number),
  CONSTRAINT fk_ot_employee FOREIGN KEY (employee_id) REFERENCES mp_employees (employee_id),
  CONSTRAINT fk_ot_cost_center FOREIGN KEY (cost_center_id) REFERENCES mp_centro_costo (cost_center_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
