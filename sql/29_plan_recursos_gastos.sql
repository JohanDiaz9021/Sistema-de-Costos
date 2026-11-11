-- ============================================================
--  Bloque 29 — Gastos iniciales del Plan de Recursos
-- ------------------------------------------------------------
--  sql/27 calcula el presupuesto de un proyecto NUEVO sumando solo mano de
--  obra (personas × horas_totales × costo_hora por rol). A pedido explícito
--  (28 ago 2026): el Simulador de "+ Nuevo proyecto" también necesita poder
--  sumarle partidas sueltas conocidas de antemano (licencias, viáticos de
--  arranque, hardware...) — algo con NOMBRE y VALOR, no un rol de la
--  planta.
--
--  mp_plan_recursos_gasto es HERMANA de mp_plan_recursos, no la misma
--  tabla: un rol necesita role_catalog (viene del catálogo de cargos) y se
--  multiplica por horas; un gasto es un monto suelto con una descripción
--  libre. Tampoco es mp_costo_no_planeado: esa tabla es dinero EJECUTADO
--  durante el proyecto que necesita aprobación del CEO (sql/28) — esto es
--  presupuesto PLANEADO antes de que el proyecto exista, sin flujo de
--  aprobación, igual que el resto del Plan de Recursos.
--
--  Presupuesto = Σ (personas × horas_totales × costo_hora) + Σ (gastos)
--
--  Idempotente: la tabla se crea solo si no existe.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_plan_recursos_gasto (
  plan_gasto_id   INT AUTO_INCREMENT PRIMARY KEY,
  cost_center_id  INT NOT NULL,
  description     VARCHAR(255) NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  created_by      INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prg_cost_center FOREIGN KEY (cost_center_id)
    REFERENCES mp_centro_costo (cost_center_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
