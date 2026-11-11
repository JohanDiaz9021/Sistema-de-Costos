-- ============================================================
--  Bloque 40 — mp_alerta_email_envio: el registro de "ya se mando hoy"
-- ------------------------------------------------------------
--  El correo de alertas pasa a salir solo, todos los dias a las 6am
--  (src/services/alertas-email-scheduler.js). El programador revisa cada
--  hora, no una sola vez, para que un fallo puntual (la base remota sin
--  conexiones libres, el SMTP caido) no se coma el aviso del dia: si a las
--  6 no pudo, lo reintenta a las 7.
--
--  Esa politica de reintento es justo la que puede degenerar en una rafaga
--  de correos, que es lo que NO puede pasar (a pedido explicito, 15 sep
--  2026: "solo 1 correo, no que vaya a ser un rafagaso de 20"). Esta tabla
--  es lo que lo impide.
--
--  La UNIQUE KEY (job, fecha) es la garantia de verdad, y no el SELECT que
--  hace el codigo antes de mandar: preguntar "¿ya se mando?" y despues
--  mandar son dos operaciones separadas, asi que dos pasadas simultaneas
--  (dos contenedores, o un tick que se atasca y otro que entra) podrian
--  contestarse las dos que no y mandar dos correos. Con la llave unica, el
--  segundo INSERT lo rechaza la base: no hay ventana donde quepa el
--  duplicado. Es la leccion que dejo anotada snapshot-scheduler.js, que
--  tiene el mismo patron SELECT-then-INSERT SIN esta proteccion.
--
--  Por eso el codigo INSERTA PRIMERO (reserva el turno del dia) y manda
--  despues: si mandara primero, un fallo al registrar dejaria el correo
--  enviado y sin rastro, y la pasada siguiente lo mandaria de nuevo. Al
--  reves, si el envio falla se borra la reserva y el reintento queda
--  habilitado.
--
--  `job` separa los envios que conviven el mismo dia (el del CEO y el de
--  cada PM): cada uno tiene su propio turno y su propio reintento, y que
--  uno falle no bloquea al otro.
--
--  Idempotente: CREATE TABLE IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS mp_alerta_email_envio (
  envio_id      INT AUTO_INCREMENT PRIMARY KEY,
  job           VARCHAR(40)  NOT NULL,
  fecha         DATE         NOT NULL,
  destinatario  VARCHAR(255) NOT NULL,
  -- Cuantas alertas viajaron. No es control de flujo, es para poder
  -- responder "¿por que el correo de ese dia venia vacio?" sin adivinar.
  alertas       INT          NOT NULL DEFAULT 0,
  -- NULL mientras el turno esta reservado pero el correo todavia no salio.
  enviado_at    DATETIME     NULL,
  creado_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_alerta_email_job_fecha (job, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
