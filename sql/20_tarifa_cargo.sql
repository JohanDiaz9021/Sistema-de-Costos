-- ============================================================
--  Bloque 20 — mp_tarifa_cargo (tarifa estándar por cargo)
-- ------------------------------------------------------------
--  Hasta ahora el costo/hora se definía persona por persona en
--  mp_equipo_proyecto, lo que obliga a diligenciar decenas de
--  campos uno a uno. Esta tabla guarda la tarifa ESTÁNDAR de cada
--  cargo ("un QA cuesta $X la hora") y sirve para dos cosas:
--
--    1. Prellenar el costo/hora al agregar a alguien al equipo.
--    2. Aplicar en bloque la tarifa a todos los que tengan ese
--       cargo, sin tocarlos de a uno.
--
--  IMPORTANTE — la tarifa individual sigue mandando. Esta tabla NO
--  reemplaza a mp_equipo_proyecto.hourly_cost, que es el valor que
--  el motor de costeo usa de verdad. Es un punto de partida: un
--  senior y un junior comparten el cargo 'desarrollador' pero no
--  la tarifa, así que después de aplicar en bloque siempre se
--  puede ajustar a quien haga falta. Por eso la aplicación masiva
--  ofrece el modo "solo a quienes no tienen tarifa", que respeta
--  los valores ya personalizados.
--
--  hourly_cost NULL = cargo sin tarifa estándar definida todavía
--  (distinto de 0, que sería "cuesta cero").
--
--  Idempotente: CREATE TABLE IF NOT EXISTS + INSERT IGNORE.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_tarifa_cargo (
  role_catalog  ENUM(
                  'desarrollador',
                  'analista',
                  'lider_proyecto',
                  'qa',
                  'disenador',
                  'scrum_master',
                  'otro'
                ) PRIMARY KEY,
  nombre_visible VARCHAR(60) NOT NULL,
  hourly_cost   DECIMAL(10,2) NULL,
  nota          VARCHAR(255) NULL,
  updated_by    INT NULL,
  updated_at    DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tarifa_cargo_user FOREIGN KEY (updated_by) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Los 7 cargos del catálogo, sin tarifa todavía. El nombre visible se
-- guarda aquí para que la UI no tenga que traducir el ENUM en cada pantalla.
INSERT IGNORE INTO mp_tarifa_cargo (role_catalog, nombre_visible, hourly_cost) VALUES
  ('desarrollador',  'Desarrollador',     NULL),
  ('analista',       'Analista',          NULL),
  ('lider_proyecto', 'Líder de proyecto', NULL),
  ('qa',             'QA',                NULL),
  ('disenador',      'Diseñador',         NULL),
  ('scrum_master',   'Scrum Master',      NULL),
  ('otro',           'Otro',              NULL);
