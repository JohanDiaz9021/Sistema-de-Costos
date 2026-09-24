-- ============================================================
--  WF-COSTEO — Nodo "Limpiar cortes viejos" (n8n, MySQL, Execute SQL)
-- ------------------------------------------------------------
--  Va DESPUÉS de "Guardar en Costeo", con "Execute Once" encendido.
--  Como n8n se detiene ante el primer error, solo corre si la carga del
--  día terminó bien.
--
--  Por qué existe: cada corrida guarda un corte completo nuevo (~11.000
--  filas al día con los 9 equipos). El motor solo lee el corte MÁS
--  RECIENTE de cada persona y proyecto (baseWhere en costo-common.js),
--  así que los viejos solo ocupan espacio y hacen más lenta una base
--  remota que ya es lenta. Sin esto, en un año serían millones de filas.
--
--  Qué borra, con tres candados:
--    1. Solo cortes de más de 7 días. Se deja una semana de historia
--       para poder comparar si algo sale raro.
--    2. Solo de pares (persona, proyecto) que HOY recibieron un corte
--       nuevo. Lo que alguien haya subido a mano y la automatización no
--       reemplazó (p. ej. un proyecto que ya no está en su Excel) no se
--       toca: sigue siendo su corte vigente.
--    3. Nunca el corte de hoy.
--
--  Nada más en la app lee cortes viejos: las únicas consultas sin
--  MAX(snapshot_date) son la lista de meses disponibles (/meses y
--  mesYAnio en costo-motor.js), y el corte de hoy ya trae todos los meses.
-- ============================================================
DELETE t
  FROM mp_costeo_task_facts t
  JOIN (SELECT DISTINCT employee_id, project_name
          FROM mp_costeo_task_facts
         WHERE snapshot_date = CURDATE()) hoy
    ON hoy.employee_id = t.employee_id
   AND hoy.project_name = t.project_name
 WHERE t.snapshot_date < CURDATE() - INTERVAL 7 DAY
