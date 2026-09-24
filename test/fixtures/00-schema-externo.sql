-- ============================================================
--  Esquema de las tablas que las migraciones del repo NO crean.
-- ------------------------------------------------------------
--  HALLAZGO QA-02 (ver docs/testing.md).
--
--  El codigo de src/ consulta 16 tablas mp_*, pero sql/01-22 solo
--  crea 14. Estas cinco las crea el workflow de n8n (el RPA) fuera de
--  este repositorio:
--
--      mp_employees          (sql/04 le hace ALTER, asumiendo que existe)
--      mp_task_facts         (sql/05 documenta un ALTER sobre ella)
--      mp_project_owners     (sql/16 le cambia la PK)
--      mp_holidays
--      mp_validation_overrides
--
--  Consecuencia: `sql/` NO alcanza para levantar el sistema desde
--  cero. Un despliegue nuevo, o cualquiera que quiera correr las
--  pruebas, necesita ademas este archivo.
--
--  Se deja aqui, en test/fixtures/, y NO en sql/, a proposito: meterlo
--  en la carpeta de migraciones es una decision de arquitectura que le
--  corresponde al equipo (define quien es el dueño del esquema, el RPA
--  o el dashboard). La recomendacion es moverlo a sql/00_*.sql.
--
--  Origen: SHOW CREATE TABLE contra la base real (10.6.28-MariaDB),
--  quitando los AUTO_INCREMENT de produccion. Solo esquema: ni una
--  fila de datos reales.
-- ============================================================

-- ================= mp_employees =================
CREATE TABLE IF NOT EXISTS `mp_employees` (
  `employee_id` int(11) NOT NULL AUTO_INCREMENT,
  `canonical_name` varchar(150) NOT NULL,
  `aliases` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`aliases`)),
  `email` varchar(150) NOT NULL,
  `leader_name` varchar(150) DEFAULT NULL,
  `leader_email` varchar(150) DEFAULT NULL,
  `project_folder` varchar(100) DEFAULT NULL,
  `contract_type` enum('planta','prestacion_servicios') NOT NULL DEFAULT 'planta',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `receive_alerts` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`employee_id`),
  UNIQUE KEY `uk_canonical_name` (`canonical_name`),
  KEY `idx_mp_employees_contract_type` (`contract_type`,`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ================= mp_project_owners =================
CREATE TABLE IF NOT EXISTS `mp_project_owners` (
  `project_folder` varchar(50) NOT NULL,
  `pmo_canonical_name` varchar(150) NOT NULL,
  `pmo_email` varchar(150) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`project_folder`,`pmo_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ================= mp_task_facts =================
CREATE TABLE IF NOT EXISTS `mp_task_facts` (
  `fact_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `snapshot_date` date NOT NULL,
  `employee_id` int(11) NOT NULL,
  `project_folder` varchar(50) DEFAULT NULL,
  `leader_name` varchar(150) DEFAULT NULL,
  `month_name` varchar(20) NOT NULL,
  `month_number` tinyint(4) NOT NULL,
  `year_number` smallint(6) NOT NULL,
  `week_number` tinyint(4) DEFAULT NULL,
  `project_name` varchar(100) DEFAULT NULL,
  `activity` text DEFAULT NULL,
  `planned_type` varchar(5) DEFAULT NULL,
  `budgeted_hours` decimal(6,2) DEFAULT NULL,
  `estimated_delivery_date` date DEFAULT NULL,
  `actual_delivery_date` date DEFAULT NULL,
  `hours_monday` decimal(5,2) DEFAULT 0.00,
  `hours_tuesday` decimal(5,2) DEFAULT 0.00,
  `hours_wednesday` decimal(5,2) DEFAULT 0.00,
  `hours_thursday` decimal(5,2) DEFAULT 0.00,
  `hours_friday` decimal(5,2) DEFAULT 0.00,
  `hours_saturday` decimal(5,2) DEFAULT 0.00,
  `total_executed_hours` decimal(6,2) DEFAULT 0.00,
  `task_status` varchar(20) DEFAULT NULL,
  `assigned_to` varchar(150) DEFAULT NULL,
  `observations` text DEFAULT NULL,
  `adjustment_reason_1` text DEFAULT NULL,
  `unplanned_task_1` text DEFAULT NULL,
  `adjustment_type_1` varchar(20) DEFAULT NULL,
  `adjustment_reason_2` text DEFAULT NULL,
  `unplanned_task_2` text DEFAULT NULL,
  `adjustment_type_2` varchar(20) DEFAULT NULL,
  `adjustment_reason_3` text DEFAULT NULL,
  `unplanned_task_3` text DEFAULT NULL,
  `adjustment_type_3` varchar(20) DEFAULT NULL,
  `has_inconsistency` tinyint(1) DEFAULT 0,
  `inconsistency_notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`fact_id`),
  KEY `idx_snapshot_employee` (`snapshot_date`,`employee_id`),
  KEY `idx_tf_project` (`project_folder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ================= mp_holidays =================
CREATE TABLE IF NOT EXISTS `mp_holidays` (
  `holiday_date` date NOT NULL,
  `holiday_name` varchar(100) NOT NULL,
  PRIMARY KEY (`holiday_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ================= mp_validation_overrides =================
CREATE TABLE IF NOT EXISTS `mp_validation_overrides` (
  `override_id` int(11) NOT NULL AUTO_INCREMENT,
  `error_id` int(11) NOT NULL,
  `reverted_by_email` varchar(150) NOT NULL,
  `reverted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `reason` text DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `undone_by_email` varchar(150) DEFAULT NULL,
  `undone_at` datetime DEFAULT NULL,
  PRIMARY KEY (`override_id`),
  KEY `idx_error_active` (`error_id`,`active`),
  KEY `idx_reverted_by` (`reverted_by_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ================= mp_validation_errors =================
-- HALLAZGO QA-06 (ver docs/testing.md) — CORREGIDO el 2 sep 2026.
--
-- Historia: sql/03_ingestion_and_validation.sql traia un
-- `CREATE TABLE IF NOT EXISTS mp_validation_errors` con un esquema VIEJO
-- (detected_at, workflow_name, source_filename, employee_name_guess,
-- acknowledged...) que no tenia nada que ver con lo que consulta
-- src/routes/validation.js (snapshot_date, execution_id, severity,
-- notified, week_number...). En produccion no se notaba —n8n ya habia
-- creado la tabla buena y el IF NOT EXISTS no hacia nada—, pero en una
-- base NUEVA sql/03 ganaba la carrera y TODO /api/validation/* reventaba
-- con "Unknown column 'snapshot_date'".
--
-- Ya no: sql/03 declara el esquema correcto (el mismo de aqui abajo).
-- Este bloque se conserva a proposito por dos razones — deja el DDL real
-- junto al del resto de tablas externas, y hace que la suite siga
-- levantando aunque alguien reordene las migraciones. Como los dos
-- esquemas son ahora identicos, el que corra primero da igual.
CREATE TABLE IF NOT EXISTS `mp_validation_errors` (
  `error_id` int(11) NOT NULL AUTO_INCREMENT,
  `snapshot_date` date NOT NULL,
  `execution_id` varchar(100) NOT NULL,
  `employee_folder_name` varchar(200) DEFAULT NULL,
  `employee_id` int(11) DEFAULT NULL,
  `project_folder` varchar(50) DEFAULT NULL,
  `file_name` varchar(300) DEFAULT NULL,
  `error_type` enum('NO_FILE','MISSING_MONTH_SHEET','DUPLICATE_MONTH_SHEET','INVALID_TALENT_AND_LEADER','NON_SEQUENTIAL_CONSECUTIVE','TEMPLATE_NOT_RENAMED','SHEET_CASE_MISMATCH','EMPTY_SHEET','PARSE_ERROR','EMPLOYEE_NOT_IN_CATALOG','NO_EMPLOYEE_NAME','NAME_MISMATCH','MISSING_LEADER','DUPLICATE_WEEK_TASKS','DUPLICATE_CONSECUTIVE','DUPLICATE_TASK','WEEK_NUMBER_MISMATCH','EXECUTED_HOURS_IN_FUTURE','TASK_OVERDUE_IN_PLANNING','MISSING_CONSECUTIVE','MISSING_WEEK_NUMBER','MISSING_PROJECT','MISSING_ACTIVITY','MISSING_PLANNED_TYPE','MISSING_BUDGETED_HOURS','MISSING_DELIVERY_DATE','MISSING_ASSIGNEE','MISSING_STATUS','INVALID_STATUS','MISSING_OBSERVATIONS_BLOCKED','NO_DATA_INGESTED','EMPLOYEE_MISSING_EMAIL','TERMINATED_WITHOUT_DELIVERY_DATE','EXECUTED_HOURS_WITHOUT_ESTIMATE','TT_INCONSISTENT','ZERO_BUDGETED_HOURS','MISSING_WEEK_PLANNING','ESTIMATED_DATE_MISMATCH_WEEK') NOT NULL,
  `severity` enum('critical','warning','info') NOT NULL DEFAULT 'info',
  `error_message` text DEFAULT NULL,
  `week_number` int(11) DEFAULT NULL,
  `notified` tinyint(1) DEFAULT 0,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`error_id`),
  KEY `idx_snapshot` (`snapshot_date`),
  KEY `idx_execution` (`execution_id`),
  KEY `idx_notified` (`notified`),
  KEY `idx_ve_project` (`project_folder`),
  KEY `idx_week_number` (`week_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

