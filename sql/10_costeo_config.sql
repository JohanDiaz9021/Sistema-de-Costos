-- ============================================================
--  Bloque 14 — mp_costeo_config (módulo de Costeo)
-- ------------------------------------------------------------
--  Tabla key-value de umbrales del módulo de Costeo (sección 6.6
--  de la Especificación Maestra), editable por el Administrador
--  sin intervención de desarrollo. Trae 'weekly_legal_hours' (46h
--  semanales, valor oficial de GTC) y 'jair_threshold' ($25.000,
--  umbral de aprobación de horas extra). Los demás umbrales
--  (margin_viable_pct, etc.) se agregan con su propio INSERT
--  cuando la HU correspondiente los necesite. Idempotente: si la
--  tabla ya existe, no hace nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_costeo_config (
  config_key    VARCHAR(50) PRIMARY KEY,
  config_value  VARCHAR(100) NOT NULL,
  description   VARCHAR(255) NULL,
  updated_by    INT NULL,
  updated_at    DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cfg_updated_by FOREIGN KEY (updated_by) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('weekly_legal_hours', '46', 'Horas legales semanales (config. GTC oficial) usadas para calcular hExtra.'),
  ('jair_threshold', '25000', 'Monto de costo extra potencial ($) a partir del cual la aprobación requiere el visto bueno de Jair.');
