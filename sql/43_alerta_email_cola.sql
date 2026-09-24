-- ============================================================
--  Bloque 43 — mp_alerta_email_cola: los correos que manda n8n
-- ------------------------------------------------------------
--  Las alertas sin corregir tienen que salir por n8n (pedido explicito,
--  22 sep 2026: "me dijeron que tiene que ser con n8n"). El flujo WF1 ya
--  tiene las credenciales de Office365 y un nodo "Send" que funciona, asi
--  que lo que falta no es logica de correo sino un punto de encuentro.
--
--  Esta tabla es ese punto. El reparto de trabajo es deliberado:
--
--    La app  -> decide A QUIEN, CUANDO y QUE dice el correo. Ahi ya viven
--               las 22 reglas de alertas, el conteo de dias por tramo y el
--               armado del HTML, todo probado (src/services/alertas-email.js).
--               Deja aqui el correo ya listo para mandar.
--    n8n     -> lo lee, lo manda y lo marca. Nada mas.
--
--  Duplicar las reglas dentro de nodos Code habria significado mantener dos
--  versiones de la misma logica, y la de n8n sin pruebas.
--
--  POR QUE EL HTML VIAJA COMPLETO EN UNA COLUMNA, y no una URL o un id que
--  n8n resuelva: n8n no tiene forma de alcanzar la app por HTTP hoy, y una
--  alerta es una foto de un momento — si n8n reconstruyera el correo horas
--  despues podria mandar numeros distintos a los que se decidio mandar.
--  Lo que se encola es exactamente lo que se envia.
--
--  El correo va SIN logo. Por aqui no pasa nodemailer, asi que no hay
--  adjunto al que apuntar con `cid:`, y el reemplazo obvio (incrustarlo como
--  data URI) se probo el 22 sep 2026 y no sirve: Outlook bloquea las
--  imagenes en base64 y en su lugar pinta un cuadro roto.
--
--  NO LLEVA LLAVE UNICA (job, fecha) a proposito, aunque parezca la gemela
--  de mp_alerta_email_envio. La garantia de "un correo por dia y por job"
--  sigue siendo de ESA tabla: el servicio reserva alli el turno ANTES de
--  encolar aqui (ver alertas-email-cola.js). Asi el envio por SMTP y el de
--  n8n comparten el mismo candado y no pueden mandarle dos correos a la
--  misma persona el mismo dia, sin importar cual de los dos llegue primero.
--  Poner otra llave unica aqui daria una falsa sensacion de proteccion y
--  ademas impediria reencolar a mano un correo puntual.
--
--  Estados:
--    pendiente -> encolado, n8n todavia no lo tomo.
--    enviado   -> n8n lo mando (marca enviado_at).
--    fallido   -> n8n lo intento y el SMTP lo rechazo (deja el motivo en `error`).
--    vencido   -> se encolo y nunca salio ese dia. Una alerta es de un dia;
--                 mandarla al dia siguiente confunde mas de lo que ayuda, y
--                 ademas el correo de hoy ya trae la foto al dia. El propio
--                 servicio los vence al encolar los del dia siguiente.
--
--  Idempotente: CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- Los turnos se reservan por job, y ahora hay un job por PM con el correo
-- dentro ('pm:correo_del_pm_largo@empresa.com.co' = 37 caracteres). Con los
-- VARCHAR(40) originales no cabe cualquier correo, y un job cortado es el
-- peor de los fallos posibles aqui: dos PMs distintos podrian quedar con el
-- mismo job y uno de los dos dejaria de recibir su correo en silencio.
-- MODIFY se puede repetir sin consecuencias.
ALTER TABLE mp_alerta_email_envio MODIFY COLUMN job VARCHAR(120) NOT NULL;

CREATE TABLE IF NOT EXISTS mp_alerta_email_cola (
  cola_id       INT AUTO_INCREMENT PRIMARY KEY,
  -- Mismo `job` que mp_alerta_email_envio ('ceo', 'pm:correo@...'): es lo
  -- que permite cruzar la cola con el turno que la autorizo.
  job           VARCHAR(120)  NOT NULL,
  fecha         DATE          NOT NULL,
  destinatario  VARCHAR(255)  NOT NULL,
  asunto        VARCHAR(255)  NOT NULL,
  -- MEDIUMTEXT y no TEXT: el correo del CEO con todas las alertas y el logo
  -- incrustado pasa comodo de los 64 KB que aguanta TEXT, y pasarse no da
  -- error sino un HTML cortado a la mitad.
  html          MEDIUMTEXT    NOT NULL,
  -- Version en texto plano, para el lector que no muestra HTML.
  texto         MEDIUMTEXT    NULL,
  -- Cuantas alertas viajan. Mismo motivo que en mp_alerta_email_envio:
  -- poder explicar despues por que un correo salio vacio.
  alertas       INT           NOT NULL DEFAULT 0,
  estado        ENUM('pendiente','enviado','fallido','vencido') NOT NULL DEFAULT 'pendiente',
  error         VARCHAR(500)  NULL,
  creado_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enviado_at    DATETIME      NULL,
  -- El SELECT que corre n8n en cada pasada: los pendientes de hoy.
  KEY idx_alerta_cola_estado_fecha (estado, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
