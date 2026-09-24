-- ============================================================
--  Bloque 12 — mp_costo_no_planeado (módulo de Costeo)
-- ------------------------------------------------------------
--  Gastos que no son horas de talento: licencias, viáticos,
--  terceros, capacitaciones. Se suma directo al ejecutado del
--  centro de costos, sin flujo de aprobación.
--  Idempotente: si la tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_costo_no_planeado (
  expense_id       INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id   INT NOT NULL,
  description      VARCHAR(255) NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  expense_date     DATE NOT NULL,
  category         ENUM('licencia','viatico','tercero','capacitacion','otro') NOT NULL DEFAULT 'otro',
  created_by       INT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cn_cost_center FOREIGN KEY (cost_center_id) REFERENCES mp_centro_costo (cost_center_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
