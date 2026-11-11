-- ============================================================
--  Bloque 6 + Bloque 8 — Tablas de validación e idempotencia
-- ------------------------------------------------------------
--  mp_validation_errors: hallazgos del WF1 al parsear los Excel de
--      planeación (archivo faltante, hoja del mes ausente, horas en
--      el futuro, etc). La CREA y la LLENA el workflow de n8n, no
--      este repositorio — aquí se declara solo para que una base
--      nueva levante completa (ver la nota de abajo).
--  mp_ingestion_runs:    una fila por (workflow, fecha) — el
--      UNIQUE bloquea la doble ejecución del mismo día.
-- ============================================================

-- ------------------------------------------------------------
--  CORRECCIÓN (2 sep 2026) — hallazgo QA-06
-- ------------------------------------------------------------
--  Este archivo traía un CREATE TABLE con un esquema VIEJO e
--  incompatible (detected_at, workflow_name, source_filename,
--  employee_name_guess, cedula_guess, acknowledged...) que no tiene
--  nada que ver con el que consulta src/routes/validation.js
--  (snapshot_date, execution_id, project_folder, severity, notified,
--  week_number...).
--
--  En producción no se notaba: n8n ya había creado la tabla buena y
--  el IF NOT EXISTS no hacía nada. Pero en una base NUEVA —levantada
--  solo con sql/— este archivo ganaba la carrera, creaba la tabla con
--  las columnas equivocadas, y TODO /api/validation/* respondía
--  "Unknown column 'snapshot_date'". O sea: el repo no podía levantar
--  un entorno funcional por sí solo.
--
--  El DDL de abajo es el REAL, extraído con SHOW CREATE TABLE contra
--  la base de producción (es el mismo que test/fixtures/00-schema-
--  externo.sql usa para las pruebas).
--
--  OJO si tienes una base donde ya corrió la versión vieja de este
--  archivo: el IF NOT EXISTS no la va a corregir sola. En ese caso la
--  tabla estará vacía y con las columnas viejas — hay que borrarla a
--  mano (DROP TABLE mp_validation_errors) y volver a correr la
--  migración. En la base real de GTC no aplica: ahí la tabla la creó
--  n8n con el esquema correcto desde el principio.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mp_validation_errors (
  error_id              INT(11) NOT NULL AUTO_INCREMENT,
  snapshot_date         DATE NOT NULL,
  execution_id          VARCHAR(100) NOT NULL,
  employee_folder_name  VARCHAR(200) DEFAULT NULL,
  employee_id           INT(11) DEFAULT NULL,
  project_folder        VARCHAR(50) DEFAULT NULL,
  file_name             VARCHAR(300) DEFAULT NULL,
  error_type            ENUM(
                          'NO_FILE','MISSING_MONTH_SHEET','DUPLICATE_MONTH_SHEET',
                          'INVALID_TALENT_AND_LEADER','NON_SEQUENTIAL_CONSECUTIVE',
                          'TEMPLATE_NOT_RENAMED','SHEET_CASE_MISMATCH','EMPTY_SHEET',
                          'PARSE_ERROR','EMPLOYEE_NOT_IN_CATALOG','NO_EMPLOYEE_NAME',
                          'NAME_MISMATCH','MISSING_LEADER','DUPLICATE_WEEK_TASKS',
                          'DUPLICATE_CONSECUTIVE','DUPLICATE_TASK','WEEK_NUMBER_MISMATCH',
                          'EXECUTED_HOURS_IN_FUTURE','TASK_OVERDUE_IN_PLANNING',
                          'MISSING_CONSECUTIVE','MISSING_WEEK_NUMBER','MISSING_PROJECT',
                          'MISSING_ACTIVITY','MISSING_PLANNED_TYPE','MISSING_BUDGETED_HOURS',
                          'MISSING_DELIVERY_DATE','MISSING_ASSIGNEE','MISSING_STATUS',
                          'INVALID_STATUS','MISSING_OBSERVATIONS_BLOCKED','NO_DATA_INGESTED',
                          'EMPLOYEE_MISSING_EMAIL','TERMINATED_WITHOUT_DELIVERY_DATE',
                          'EXECUTED_HOURS_WITHOUT_ESTIMATE','TT_INCONSISTENT',
                          'ZERO_BUDGETED_HOURS','MISSING_WEEK_PLANNING',
                          'ESTIMATED_DATE_MISMATCH_WEEK'
                        ) NOT NULL,
  severity              ENUM('critical','warning','info') NOT NULL DEFAULT 'info',
  error_message         TEXT DEFAULT NULL,
  week_number           INT(11) DEFAULT NULL,
  notified              TINYINT(1) DEFAULT 0,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (error_id),
  KEY idx_snapshot (snapshot_date),
  KEY idx_execution (execution_id),
  KEY idx_notified (notified),
  KEY idx_ve_project (project_folder),
  KEY idx_week_number (week_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


CREATE TABLE IF NOT EXISTS mp_ingestion_runs (
  run_id          INT AUTO_INCREMENT PRIMARY KEY,
  workflow_name   VARCHAR(50) NOT NULL,           -- WF1 / WF2 / WF3
  run_date        DATE        NOT NULL,           -- fecha lógica de corrida
  started_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME    NULL,
  status          ENUM('running','completed','failed','skipped') NOT NULL DEFAULT 'running',
  skip_reason     VARCHAR(255) NULL,              -- por qué se saltó (festivo, duplicada, etc)
  files_processed INT NOT NULL DEFAULT 0,
  files_rejected  INT NOT NULL DEFAULT 0,
  rows_inserted   INT NOT NULL DEFAULT 0,
  triggered_by    VARCHAR(50)  NULL,              -- 'cron' / 'manual:<email>' / 'webhook'
  -- ¡EL guard de idempotencia! Solo UNA fila por (workflow, día).
  UNIQUE KEY uk_wf_date (workflow_name, run_date),
  INDEX idx_status (status),
  INDEX idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
