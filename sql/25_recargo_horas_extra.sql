-- ============================================================
--  Bloque 25 — Recargo de horas extra por tipo de día
-- ------------------------------------------------------------
--  Hasta ahora el motor costeaba TODA hora extra al mismo valor
--  que la hora normal (1×), sin ningún recargo. Eso subestimaba
--  el costo real: en Colombia una hora extra diurna en día hábil
--  lleva un 25% de recargo, y cualquier hora trabajada en festivo
--  lleva un 100% (Código Sustantivo del Trabajo, arts. 168-179).
--
--  Estos dos porcentajes son los únicos que el motor puede aplicar
--  hoy: mp_task_facts no tiene columna de domingo (el RPA no
--  captura ese dato) ni hora de inicio/fin por tarea, así que no
--  se puede distinguir turno nocturno ni domingo. Cuando esos
--  datos existan, se agregan como llaves nuevas siguiendo este
--  mismo patrón — no hace falta migrar nada de lo que ya esté.
--
--  Valores sembrados = los que confirmó GTC como estándar de ley
--  (25% / 100%). Editables desde Configuración sin necesidad de
--  desplegar código nuevo.
--
--  Idempotente: INSERT IGNORE respeta la PK, así que re-ejecutarlo
--  no pisa ningún valor que el Administrador haya ajustado.
--
--  OJO (sql/33): recargo_extra_festiva_pct ya NO existe. GTC entregó
--  su tabla real y ahí el festivo no es un factor final del 100%, sino
--  un componente del 90% que se SUMA al de hora extra (1,90 la hora
--  ordinaria en festivo; 2,15 si además es extra diurna). sql/33
--  borra esta llave y la reemplaza por recargo_dominical_festivo_pct.
--  recargo_extra_diurna_pct sí sigue vigente, con el mismo 25%.
-- ============================================================

INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('recargo_extra_diurna_pct',  '25',  'Recargo (%) sobre la tarifa/hora para horas extra en día hábil no festivo (ley: 25%).'),
  ('recargo_extra_festiva_pct', '100', 'Recargo (%) sobre la tarifa/hora para CUALQUIER hora trabajada en un día festivo (ley: 100%). No distingue domingo ni horario nocturno: mp_task_facts no captura esos datos.');
