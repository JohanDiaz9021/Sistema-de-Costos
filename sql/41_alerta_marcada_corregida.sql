-- ============================================================
--  Bloque 41 — "Corregido": marcar una alerta como resuelta a mano
-- ------------------------------------------------------------
--  A pedido explícito (16 sep 2026). En la pestaña "sin corregir" cada
--  alerta lleva los días que arrastra; faltaba poder decir "ya lo arreglé".
--
--  LO QUE NO ES: un botón para cerrar la alerta. El motor recalcula las
--  alertas DESDE LOS DATOS en cada pasada (generarAlertasParaCentro), así
--  que si el problema sigue ahí la alerta se vuelve a detectar, la marque
--  quien la marque. Marcarla es una AFIRMACIÓN de quien la atiende ("ya lo
--  corregí"), no un hecho: se esconde por hoy y mañana la confirman los
--  datos, no la persona.
--
--    corregida hoy            -> se oculta de "sin corregir" el resto del día
--    al día siguiente, arreglada -> el motor ya no la detecta y muere sola
--    al día siguiente, sigue    -> reaparece
--
--  POR QUÉ NO SE TOCA primera_vez_at: de ahí sale "días sin corregir"
--  (DATEDIFF en getEscalamientos). Si marcar reiniciara el contador,
--  bastaría con pulsar "Corregido" cada mañana para que una alerta nunca
--  llegara a los 6 días en que escala al CEO. Al dejarlo quieto, el
--  contador mide lo que lleva el problema REAL sin resolverse: si se marcó
--  en falso, reaparece con 5, 6, 7 días, no con cero.
--
--  Distinto de 'silenciada', que ya existía en el ENUM de estado (sql/19) y
--  nunca tuvo interfaz: esa apaga la alerta para siempre y no se reabre
--  sola. Aquí lo que se quiere es lo contrario — que vuelva si no era
--  verdad.
--
--  Idempotente: ADD COLUMN IF NOT EXISTS, igual que sql/04.
-- ============================================================

ALTER TABLE mp_alerta_evento
  -- Cuándo se afirmó que estaba corregida. Solo cuenta el DÍA: la alerta
  -- se oculta mientras DATE(corregida_at) = CURDATE() y reaparece al
  -- siguiente si el motor la vuelve a detectar.
  ADD COLUMN IF NOT EXISTS corregida_at  DATETIME NULL AFTER resuelta_at,
  -- Quién lo afirmó. Sin esto, una alerta que reaparece tres veces no
  -- tiene a quién preguntarle qué se intentó cada vez.
  ADD COLUMN IF NOT EXISTS corregida_por INT NULL AFTER corregida_at;

-- getEscalamientos filtra por estado + corregida_at en cada carga del panel
-- y en cada correo; sin esto recorre la tabla entera para descartar las
-- marcadas hoy.
CREATE INDEX IF NOT EXISTS idx_alerta_evento_corregida
  ON mp_alerta_evento (estado, corregida_at);
