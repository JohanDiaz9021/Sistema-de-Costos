-- ============================================================
--  Bloque 31 — Editar/eliminar una hora extra mientras esté Pendiente
-- ------------------------------------------------------------
--  A pedido explícito (28 ago 2026): el PM puede corregir las horas o
--  eliminar el registro de una hora extra, pero SOLO mientras siga en
--  "Pendiente" (pm_decision Y approval_status en 'pendiente') — una vez
--  decidida (Sí/No pagar) o resuelta, ya no se toca, igual que el resto
--  del flujo de horas extra.
--
--  hours_overridden protege la corrección de la propia sincronización:
--  syncOvertimeDecisions() (costo-overtime.js) vuelve a calcular y
--  SOBRESCRIBE extra_hours/extra_cost_potential de cualquier fila que
--  siga en 'pendiente'/'pendiente' cada vez que alguien abre la pestaña
--  de Horas Extra — sin esta bandera, la corrección del PM se borraría
--  sola en el siguiente refresh. En 0 para toda fila existente (nunca se
--  editó a mano) y en 1 desde el momento en que se edita.
--
--  Idempotente: la columna se agrega solo si no existe todavía.
-- ============================================================

SET @col_overridden := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_overtime_decisions'
     AND COLUMN_NAME = 'hours_overridden'
);
SET @sql := IF(@col_overridden = 0,
  'ALTER TABLE mp_overtime_decisions
     ADD COLUMN hours_overridden TINYINT(1) NOT NULL DEFAULT 0
       COMMENT ''sql/31: 1 = el PM corrigió las horas a mano; la sincronización automática deja de sobrescribirlas.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
