-- ============================================================
--  mp_costeo_snapshot (módulo de Costeo — Fase 2.5, ítem 5.1)
-- ------------------------------------------------------------
--  Fotografía fija de los 17 indicadores en un momento dado, para
--  poder comparar "cómo estaba el proyecto entonces vs. ahora" sin
--  que los números cambien cada vez que el motor recalcula.
--  cost_center_id NULL = snapshot del portafolio agregado (vista
--  "Todos los proyectos"); project_name se guarda como texto plano
--  para que el snapshot siga siendo legible aunque el centro se
--  borre después. Idempotente: si la tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_costeo_snapshot (
  snapshot_id       INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id    INT NULL,
  project_name      VARCHAR(255) NOT NULL,
  snapshot_date     DATE NOT NULL,
  indicadores_json  JSON NOT NULL,
  created_by        INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_snap_centro FOREIGN KEY (cost_center_id)
    REFERENCES mp_centro_costo (cost_center_id) ON DELETE SET NULL,
  CONSTRAINT fk_snap_user FOREIGN KEY (created_by)
    REFERENCES mp_dashboard_users (user_id),
  INDEX idx_snap_centro_fecha (cost_center_id, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
