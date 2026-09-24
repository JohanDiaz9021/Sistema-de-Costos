-- ============================================================
--  Bloque 7 — Tipo de contrato del empleado
-- ------------------------------------------------------------
--  Agregamos `contract_type` a `mp_employees`. Los empleados
--  por prestación de servicios se analizan igual en los KPIs
--  pero el dashboard les pinta un tooltip indicando su modalidad
--  para que el lector entienda por qué pueden tener criticidades
--  esperadas (no cumplen jornada de planta).
-- ============================================================

-- Idempotente: solo agrega la columna si no existe.
ALTER TABLE mp_employees
  ADD COLUMN IF NOT EXISTS contract_type
    ENUM('planta','prestacion_servicios') NOT NULL DEFAULT 'planta'
    AFTER project_folder;

-- Índice para que los filtros de "solo planta" sean rápidos.
CREATE INDEX IF NOT EXISTS idx_mp_employees_contract_type
  ON mp_employees (contract_type, is_active);
