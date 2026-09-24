-- Tabla de usuarios del dashboard.
-- Es la UNICA tabla nueva que crea el dashboard. Las demas (mp_*) son del sistema RPA y solo se leen.
CREATE TABLE IF NOT EXISTS mp_dashboard_users (
  user_id        INT AUTO_INCREMENT PRIMARY KEY,
  email          VARCHAR(150) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  full_name      VARCHAR(150),
  role           ENUM('ceo','leader','admin') NOT NULL DEFAULT 'leader',
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
