-- ============================================================
--  WF-COSTEO — Nodo "Revisar festivo" (n8n, MySQL, Execute SQL)
-- ------------------------------------------------------------
--  Va justo después del Schedule Trigger. Devuelve una sola fila:
--    festivo = 'si' | 'no'
--  y "Generar contexto ejecución" corta la corrida si es 'si'.
--
--  Texto y no número a propósito: n8n a veces entrega un COUNT(*) como
--  "0" (texto) y otras como 0 (número), y una comparación de tipo
--  estricto fallaría en silencio. 'si' / 'no' no tiene esa ambigüedad.
--
--  CURDATE() es la fecha de Colombia: el reloj de la base está en
--  UTC-5 (verificado el 21 sep 2026: NOW() = UTC_TIMESTAMP() - 5 h).
--
--  Los fines de semana no llegan aquí: los descarta el horario del
--  Schedule Trigger (cron 0 7 * * 1-5).
-- ============================================================
SELECT IF(COUNT(*) = 0, 'no', 'si') AS festivo
  FROM mp_holidays
 WHERE holiday_date = CURDATE()
