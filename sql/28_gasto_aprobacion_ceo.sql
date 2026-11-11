-- ============================================================
--  Bloque 28 — mp_costo_no_planeado: aprobación del CEO
-- ------------------------------------------------------------
--  Hasta ahora un gasto no planeado que registraba el PM entraba
--  directo al presupuesto ejecutado, sin que nadie lo autorizara
--  (ver el encabezado de sql/08). A pedido explícito (28 ago 2026)
--  ese gasto pasa a ser una SOLICITUD: queda 'pendiente' hasta que
--  admin/ceo la apruebe o la rechace, y solo el gasto aprobado suma
--  dinero al ejecutado (ver costoNoPlaneadoTotal en costo-motor.js).
--
--  Backfill: las filas que ya existían se registraron cuando el
--  gasto SÍ contaba de una — si quedaran en 'pendiente', el
--  ejecutado de todos los centros bajaría de golpe y los
--  indicadores históricos cambiarían solos. Por eso la columna se
--  agrega con DEFAULT 'aprobado' (así MySQL llena lo viejo como
--  aprobado) y enseguida se le cambia el DEFAULT a 'pendiente',
--  que es el estado con el que nace todo gasto nuevo.
--
--  Idempotente: las columnas se agregan solo si no existen, y
--  volver a fijar el DEFAULT no puede fallar.
-- ============================================================

SET @col_estado := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costo_no_planeado'
     AND COLUMN_NAME = 'approval_status'
);
SET @sql := IF(@col_estado = 0,
  'ALTER TABLE mp_costo_no_planeado
     ADD COLUMN approval_status ENUM(''pendiente'',''aprobado'',''rechazado'') NOT NULL DEFAULT ''aprobado''
       COMMENT ''sql/28: solo el gasto aprobado suma al ejecutado.'',
     ADD COLUMN approved_by     INT NULL COMMENT ''sql/28: quién aprobó o rechazó (admin/ceo).'',
     ADD COLUMN approved_at     DATETIME NULL COMMENT ''sql/28: cuándo se resolvió.'',
     ADD COLUMN rejection_note  VARCHAR(255) NULL COMMENT ''sql/28: motivo del rechazo, obligatorio al rechazar.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Lo viejo quedó en 'aprobado' por el DEFAULT de arriba; de aquí en
-- adelante todo gasto nuevo nace 'pendiente'.
ALTER TABLE mp_costo_no_planeado
  ALTER COLUMN approval_status SET DEFAULT 'pendiente';

-- El listado de Costo No Planeado filtra y ordena por estado dentro de
-- un centro; el índice evita el scan cuando un centro acumula gastos.
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'mp_costo_no_planeado'
     AND INDEX_NAME = 'idx_cn_centro_estado'
);
SET @sql := IF(@idx = 0,
  'ALTER TABLE mp_costo_no_planeado ADD INDEX idx_cn_centro_estado (cost_center_id, approval_status)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
