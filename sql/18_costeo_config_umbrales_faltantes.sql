-- ============================================================
--  Bloque 18 — umbrales faltantes en mp_costeo_config
-- ------------------------------------------------------------
--  sql/10 sembró solo 2 de los umbrales del módulo
--  (weekly_legal_hours, jair_threshold). Los otros cuatro que el
--  motor consulta nunca se insertaron, así que getConfigNumber()
--  venía cayendo siempre en el respaldo de código: funcionaban,
--  pero el Administrador no podía cambiarlos desde el panel de
--  Configuración, que era justamente el punto de la tabla.
--
--  Los valores sembrados son exactamente los mismos que el código
--  ya estaba aplicando (CONFIG_DEFAULTS en costo-common.js), así
--  que este bloque NO cambia ningún cálculo: solo vuelve editable
--  lo que estaba fijo.
--
--  Nomenclatura: se usan los nombres que el código lee hoy. El PDF
--  de planeación los llama 'notify_budget_pct' y
--  'notify_days_before_close'; se dejó la forma en español porque
--  es la que está en uso y renombrarla exigiría tocar el motor sin
--  ganar nada. Vale la pena unificar el criterio más adelante.
--
--  Idempotente: INSERT IGNORE respeta la PK, así que re-ejecutarlo
--  no pisa ningún valor que el Administrador haya ajustado.
-- ============================================================

INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('umbral_presupuesto',    '85', 'Porcentaje de presupuesto ejecutado a partir del cual se alerta que el presupuesto está por agotarse.'),
  ('dias_antes_preventiva', '30', 'Días antes de la fecha fin planeada en que se empieza a avisar que el proyecto está por vencer.'),
  ('margin_viable_pct',     '25', 'Margen (%) a partir del cual un proyecto se considera comercialmente viable.'),
  ('margin_risk_pct',       '10', 'Margen (%) mínimo para considerar un proyecto en riesgo; por debajo se marca como no viable.');
