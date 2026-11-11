-- ============================================================
--  Bloque 4 (ago 2026) — mp_costeo_audit_log
-- ------------------------------------------------------------
--  Historial de acciones y transacciones del módulo de Costeo:
--  quién hizo qué, cuándo y sobre qué centro de costos. Cubre las
--  4 áreas pedidas: Centro de Costos, Equipo del Proyecto, Gastos
--  no planeados y Horas Extra (decisión + aprobación).
--
--  cost_center_id permite scopear la vista igual que el resto del
--  módulo (un PM solo ve el historial de sus propios proyectos);
--  queda NULL solo si el centro se borró de verdad después (no
--  aplica hoy: DELETE /centros/:id sólo borra si no tiene datos
--  asociados, y esta tabla sí cuenta como dato asociado en la
--  práctica porque queda huérfana — se deja NULL-able por si acaso).
--  Idempotente: si la tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_costeo_audit_log (
  log_id          INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id  INT NULL,
  entity_type     ENUM('centro_costo','equipo','gasto','overtime') NOT NULL,
  entity_id       INT NOT NULL,
  action          ENUM('crear','editar','eliminar','desactivar','reactivar','decidir','aprobar','rechazar') NOT NULL,
  user_id         INT NULL,
  user_name       VARCHAR(150) NULL,
  description     TEXT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_cost_center FOREIGN KEY (cost_center_id) REFERENCES mp_centro_costo (cost_center_id),
  INDEX idx_audit_centro (cost_center_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
