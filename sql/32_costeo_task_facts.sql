-- ============================================================
--  Bloque 32 — mp_costeo_task_facts: horas de Sistema de Costos,
--  separadas por completo de mp_task_facts (Planeación)
-- ------------------------------------------------------------
--  Hasta hoy, TODO el motor de Sistema de Costos (ejecutado, horas extra
--  automáticas, indicadores propios, Comercial) leía sus horas de
--  mp_task_facts — la MISMA tabla que llena el RPA/n8n leyendo el Excel
--  compartido de Planeación en SharePoint. A pedido explícito (31 ago
--  2026): Planeación y Sistema de Costos son totalmente independientes.
--  Sistema de Costos no tiene ningún RPA propio — sus horas entran
--  ÚNICAMENTE por la carga manual de Excel (POST
--  /centros/:id/cargar-excel-horas, costo-task-facts-upload.js), y
--  arranca desde CERO: los datos que ya había en mp_task_facts nunca
--  fueron horas "de Costeo" de verdad, eran las de Planeación.
--
--  Por qué es una tabla nueva y no un filtro sobre mp_task_facts:
--  mp_task_facts es propiedad del RPA externo (ver el comentario de
--  test/fixtures/00-schema-externo.sql) — Costeo nunca debió escribir
--  ahí. Esta tabla sí es propiedad de Costeo, así que solo tiene las 21
--  columnas que costo-task-facts-upload.js realmente llena (no las
--  columnas de ajustes/inconsistencias que solo usa el RPA).
--
--  Snapshot POR EMPLEADO, no global: mp_task_facts usa "la fecha de
--  corte más reciente de TODA la tabla" porque un solo RPA sincroniza a
--  TODOS el mismo día. Acá cada persona sube su Excel el día que quiere,
--  de forma independiente — no hay una sincronización conjunta. Por eso
--  "el estado actual" de una persona es SU PROPIO snapshot_date más
--  reciente (ver el nuevo baseWhere en costo-common.js), y cada carga
--  usa la fecha de HOY como snapshot (ya no hace falta la regla de
--  "nunca uses hoy, usa la que ya existía" — esa regla protegía la
--  cadencia del RPA, que aquí no existe).
--
--  Idempotente: CREATE TABLE IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_costeo_task_facts (
  fact_id                bigint(20)     NOT NULL AUTO_INCREMENT,
  snapshot_date          date           NOT NULL,
  employee_id            int(11)        NOT NULL,
  project_folder         varchar(50)    DEFAULT NULL,
  month_name             varchar(20)    NOT NULL,
  month_number           tinyint(4)     NOT NULL,
  year_number             smallint(6)    NOT NULL,
  week_number            tinyint(4)     DEFAULT NULL,
  project_name           varchar(100)   DEFAULT NULL,
  activity               text           DEFAULT NULL,
  planned_type           varchar(5)     DEFAULT NULL,
  budgeted_hours         decimal(6,2)   DEFAULT NULL,
  estimated_delivery_date date          DEFAULT NULL,
  actual_delivery_date   date           DEFAULT NULL,
  hours_monday           decimal(5,2)   NOT NULL DEFAULT 0.00,
  hours_tuesday          decimal(5,2)   NOT NULL DEFAULT 0.00,
  hours_wednesday        decimal(5,2)   NOT NULL DEFAULT 0.00,
  hours_thursday         decimal(5,2)   NOT NULL DEFAULT 0.00,
  hours_friday           decimal(5,2)   NOT NULL DEFAULT 0.00,
  hours_saturday         decimal(5,2)   NOT NULL DEFAULT 0.00,
  total_executed_hours   decimal(6,2)   NOT NULL DEFAULT 0.00,
  task_status            varchar(20)    DEFAULT NULL,
  observations            text           DEFAULT NULL,
  created_at             datetime       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fact_id),
  KEY idx_costeo_tf_snapshot_employee (snapshot_date, employee_id),
  KEY idx_costeo_tf_employee (employee_id),
  KEY idx_costeo_tf_project (project_folder)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
