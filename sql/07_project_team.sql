-- ============================================================
--  Bloque 11 — mp_equipo_proyecto (módulo de Costeo)
-- ------------------------------------------------------------
--  El equipo asignado a cada centro de costos con su costo/hora.
--  Reutiliza el catálogo de talentos del RPA (mp_employees.employee_id).
--  Idempotente: si la tabla ya existe, no hace nada.
--
--  role_catalog: catálogo cerrado provisional. Si el equipo define
--  nombres oficiales de cargo, se ajusta con ALTER TABLE (ENUM).
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_equipo_proyecto (
  team_member_id    INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id    INT NOT NULL,
  employee_id       INT NOT NULL,
  role_catalog      ENUM(
                      'desarrollador',
                      'analista',
                      'lider_proyecto',
                      'qa',
                      'disenador',
                      'scrum_master',
                      'otro'
                    ) NOT NULL,
  hourly_cost       DECIMAL(10,2) NOT NULL,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  added_by          INT NULL,
  added_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at        DATETIME NULL,
  CONSTRAINT fk_ep_cost_center FOREIGN KEY (cost_center_id) REFERENCES mp_centro_costo (cost_center_id),
  CONSTRAINT fk_ep_employee FOREIGN KEY (employee_id) REFERENCES mp_employees (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
