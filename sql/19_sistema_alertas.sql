-- ============================================================
--  Bloque 19 — Sistema de gestión de alertas
-- ------------------------------------------------------------
--  Hoy las 22 alertas se calculan en vivo en costo-alertas.js y se
--  pintan en el dashboard, pero no se guardan y no le llegan a
--  nadie: quien no abra la pestaña nunca se entera. Estas tres
--  tablas le dan a las alertas lo que les falta —— catálogo
--  configurable, historial y notificación —— sin tocar el motor de
--  reglas, que sigue siendo la única fuente de verdad de CUÁNDO
--  se dispara cada alerta.
--
--  Separación de responsabilidades:
--    mp_alerta_tipo    — QUÉ alertas existen y cómo se comportan.
--                        Editable por el Administrador.
--    mp_alerta_evento  — QUÉ se detectó y cuándo. Da historial y
--                        permite no repetir la misma notificación.
--    mp_alerta_envio   — A QUIÉN se le notificó y si llegó.
--
--  Idempotente: CREATE TABLE IF NOT EXISTS + INSERT IGNORE.
-- ============================================================


-- ------------------------------------------------------------
--  1. Catálogo de tipos de alerta
-- ------------------------------------------------------------
--  Una fila por tipo. Externalizar esto es lo que permite apagar
--  una alerta ruidosa, subirle la severidad o cambiarle el
--  destinatario sin un despliegue.
CREATE TABLE IF NOT EXISTS mp_alerta_tipo (
  codigo             VARCHAR(60) PRIMARY KEY,
  nombre             VARCHAR(120) NOT NULL,
  categoria          ENUM('Presupuesto','Horas extra','Equipo','Calidad',
                          'Vigencia','Costo No Planeado','Centro de Costos') NOT NULL,
  severidad_default  ENUM('critica','alta','media','baja') NOT NULL,
  descripcion        VARCHAR(255) NULL,

  -- Interruptor por tipo: 0 la desaparece del dashboard y de los correos
  -- sin tocar el motor de reglas.
  activa             TINYINT(1) NOT NULL DEFAULT 1,

  -- Canal de entrega. 'dashboard' = solo se ve al entrar; 'correo' = además
  -- se notifica. La mayoría arranca solo en dashboard a propósito: encender
  -- 22 tipos por correo de golpe genera ruido y la gente los filtra.
  canal              SET('dashboard','correo') NOT NULL DEFAULT 'dashboard',

  -- A quién le corresponde actuar. Es una REGLA, no un correo fijo: se
  -- resuelve contra mp_project_owners y mp_dashboard_users en el momento
  -- del envío, así que sigue funcionando cuando cambia el PM de un proyecto.
  destinatario_regla ENUM('pm_del_centro','admin','ceo','pm_y_admin','admin_y_ceo') NOT NULL DEFAULT 'pm_del_centro',

  -- Anti-spam: horas mínimas antes de volver a notificar la MISMA alerta
  -- (misma clave_dedup). Una alerta que sigue abierta no debe mandar un
  -- correo diario; 0 = notificar cada vez que se detecte.
  cooldown_horas     INT NOT NULL DEFAULT 168,

  -- Si el disparo depende de un umbral editable, aquí queda dicho cuál,
  -- para que el panel de Configuración pueda mostrarlos juntos.
  umbral_config_key  VARCHAR(50) NULL,

  updated_by         INT NULL,
  updated_at         DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_alerta_tipo_user FOREIGN KEY (updated_by) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ------------------------------------------------------------
--  2. Eventos: qué se detectó, cuándo, y si sigue vigente
-- ------------------------------------------------------------
--  El motor recalcula en vivo, así que la MISMA alerta reaparece en cada
--  corrida mientras la causa siga ahí. clave_dedup es la identidad estable
--  de esa alerta (tipo + centro + entidad afectada): si ya existe una fila
--  abierta con esa clave, se actualiza ultima_vez_at en vez de crear otra.
--  Eso convierte "22 alertas repetidas cada hora" en un historial legible.
CREATE TABLE IF NOT EXISTS mp_alerta_evento (
  evento_id       INT AUTO_INCREMENT PRIMARY KEY,
  codigo          VARCHAR(60) NOT NULL,
  cost_center_id  INT NULL,              -- NULL = alerta global (cross-proyecto)
  clave_dedup     VARCHAR(255) NOT NULL,
  severidad       ENUM('critica','alta','media','baja') NOT NULL,
  detalle         TEXT NULL,
  valor           DECIMAL(14,2) NULL,

  -- 'abierta'    — la condición sigue dándose.
  -- 'resuelta'   — dejó de detectarse; se cierra sola, no se borra.
  -- 'silenciada' — alguien decidió que no aplica; no vuelve a notificar
  --                aunque se siga detectando.
  estado          ENUM('abierta','resuelta','silenciada') NOT NULL DEFAULT 'abierta',

  primera_vez_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultima_vez_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resuelta_at     DATETIME NULL,
  notificada_at   DATETIME NULL,         -- base del cooldown

  reconocida_por  INT NULL,
  reconocida_at   DATETIME NULL,

  UNIQUE KEY uk_alerta_dedup (clave_dedup),
  INDEX idx_alerta_estado (estado, codigo),
  INDEX idx_alerta_centro (cost_center_id, estado),
  CONSTRAINT fk_alerta_evento_tipo FOREIGN KEY (codigo) REFERENCES mp_alerta_tipo (codigo),
  CONSTRAINT fk_alerta_evento_centro FOREIGN KEY (cost_center_id) REFERENCES mp_centro_costo (cost_center_id) ON DELETE CASCADE,
  CONSTRAINT fk_alerta_evento_user FOREIGN KEY (reconocida_por) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ------------------------------------------------------------
--  3. Envíos: a quién se le notificó y si llegó
-- ------------------------------------------------------------
--  Sin esta tabla no hay forma de responder "¿al PM le avisamos o no?".
--  Guarda el correo textual usado, no solo el user_id: si mañana cambia,
--  el histórico sigue diciendo a dónde se mandó de verdad.
CREATE TABLE IF NOT EXISTS mp_alerta_envio (
  envio_id        INT AUTO_INCREMENT PRIMARY KEY,
  evento_id       INT NOT NULL,
  canal           ENUM('correo','dashboard') NOT NULL DEFAULT 'correo',
  destinatario_email VARCHAR(150) NULL,
  destinatario_user_id INT NULL,
  estado          ENUM('pendiente','enviado','fallido') NOT NULL DEFAULT 'pendiente',
  error_detalle   TEXT NULL,
  intentos        INT NOT NULL DEFAULT 0,
  creado_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enviado_at      DATETIME NULL,
  INDEX idx_envio_estado (estado, creado_at),
  CONSTRAINT fk_alerta_envio_evento FOREIGN KEY (evento_id) REFERENCES mp_alerta_evento (evento_id) ON DELETE CASCADE,
  CONSTRAINT fk_alerta_envio_user FOREIGN KEY (destinatario_user_id) REFERENCES mp_dashboard_users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ------------------------------------------------------------
--  Catálogo inicial: los 22 tipos que hoy emite costo-alertas.js
-- ------------------------------------------------------------
--  Criterio de arranque, conservador a propósito:
--   · canal 'dashboard,correo' SOLO en lo que exige que alguien actúe
--     (plata comprometida, aprobaciones trabadas, proyecto vencido).
--   · el resto arranca en 'dashboard'. Se enciende el correo después,
--     tipo por tipo, según lo que el equipo realmente quiera recibir.
--   · cooldown 168h (una semana) por defecto; más corto donde la demora
--     tiene costo real (aprobaciones de horas extra).
INSERT IGNORE INTO mp_alerta_tipo
  (codigo, nombre, categoria, severidad_default, canal, destinatario_regla, cooldown_horas, umbral_config_key, descripcion)
VALUES
  -- Presupuesto
  ('proyeccion_cierre',        'Proyección de cierre',                'Presupuesto',      'critica','dashboard,correo','pm_y_admin',  72, NULL,
   'El presupuesto se agotaría antes de la fecha fin del proyecto.'),
  ('presupuesto_agotado',      'Presupuesto casi agotado',            'Presupuesto',      'critica','dashboard,correo','pm_y_admin',  72, 'umbral_presupuesto',
   'Se ejecutó un porcentaje del presupuesto por encima del umbral configurado.'),
  ('desviacion_presupuestal',  'Desviación presupuestal',             'Presupuesto',      'alta',   'dashboard',       'pm_del_centro',168, NULL,
   'El gasto va más rápido que el tiempo transcurrido del proyecto.'),

  -- Horas extra
  ('autorizacion_jair',        'Autorización de Jair',                'Horas extra',      'critica','dashboard,correo','admin_y_ceo',  24, 'jair_threshold',
   'Hora extra que supera el umbral y requiere visto bueno de Jair.'),
  ('aprobacion_pendiente',     'Aprobación pendiente',                'Horas extra',      'alta',   'dashboard,correo','admin',        48, NULL,
   'Hora extra decidida por el líder, esperando aprobación del Administrador.'),
  ('decision_pendiente_pm',    'Decisión pendiente del PM',           'Horas extra',      'alta',   'dashboard,correo','pm_del_centro',48, NULL,
   'Falta que el líder decida si se paga esta hora extra.'),
  ('hora_extra_rechazada',     'Hora extra rechazada',                'Horas extra',      'baja',   'dashboard',       'pm_del_centro',168, NULL,
   'Hora extra rechazada por el Administrador (informativo).'),
  ('trabajo_no_remunerado',    'Trabajo no remunerado',               'Horas extra',      'media',  'dashboard',       'pm_del_centro',168, NULL,
   'Hay horas extra trabajadas que el proyecto nunca pagará.'),
  ('exceso_horas_extra',       'Exceso de horas extra',               'Horas extra',      'media',  'dashboard',       'pm_del_centro',168, NULL,
   'Una proporción alta de las horas trabajadas son horas extra.'),
  ('sobrecostos_internos',     'Sobrecostos mayormente internos',     'Horas extra',      'media',  'dashboard',       'pm_del_centro',168, NULL,
   'La mayoría de las horas extra tienen causa interna, no externa.'),

  -- Equipo
  ('talento_sin_tarifa',       'Talento sin costo/hora registrado',   'Equipo',           'critica','dashboard,correo','pm_y_admin',  72, NULL,
   'Alguien registra horas sin tarifa: sus horas se costean en $0 y subestiman el gasto del proyecto.'),
  ('bus_factor',               'Dependencia crítica de una persona',  'Equipo',           'alta',   'dashboard',       'pm_del_centro',168, NULL,
   'Una sola persona concentra la mayoría del costo laboral del proyecto.'),
  ('equipo_una_persona',       'Equipo de una sola persona',          'Equipo',           'media',  'dashboard',       'pm_del_centro',168, NULL,
   'Solo una persona está registrando horas en este proyecto.'),
  ('sobrecarga_cross',         'Sobrecarga cross-proyecto',           'Equipo',           'media',  'dashboard',       'admin',       168, NULL,
   'Un talento registra horas en varios centros de costos a la vez.'),
  ('costo_hora_sobre_promedio','Costo/hora por encima del promedio',  'Equipo',           'baja',   'dashboard',       'admin',       168, NULL,
   'Costo/hora igual o mayor al 125% del promedio de la empresa.'),

  -- Calidad
  ('indice_no_calidad',        'Índice de no-calidad',                'Calidad',          'media',  'dashboard',       'pm_del_centro',168, NULL,
   'Parte del costo del proyecto viene de corregir bugs o reprocesos.'),

  -- Vigencia
  ('proyecto_vencido',         'Vencido',                             'Vigencia',         'critica','dashboard,correo','pm_y_admin',  72, NULL,
   'La fecha fin ya pasó y no hay Fecha Real de Entrega registrada.'),
  ('vencimiento_proximo',      'Vencimiento próximo',                 'Vigencia',         'baja',   'dashboard',       'pm_del_centro',168, 'dias_antes_preventiva',
   'Faltan pocos días para la fecha fin planeada.'),

  -- Costo No Planeado
  ('gasto_atipico',            'Gasto atípico registrado',            'Costo No Planeado','alta',   'dashboard,correo','admin',       168, NULL,
   'Un gasto puntual representa un porcentaje alto del presupuesto del centro.'),
  ('gasto_no_predecible',      'Gasto poco predecible',               'Costo No Planeado','media',  'dashboard',       'pm_del_centro',168, NULL,
   'Buena parte del gasto ejecutado no estaba planeado.'),
  ('dato_desactualizado',      'Dato desactualizado',                 'Costo No Planeado','baja',   'dashboard',       'pm_del_centro',168, NULL,
   'Centro activo sin ningún registro de Costo No Planeado.'),

  -- Centro de Costos
  ('sin_pm_asignado',          'Sin PM asignado',                     'Centro de Costos', 'baja',   'dashboard',       'admin',       168, NULL,
   'Este centro no tiene un líder/PM activo asignado en Planeación.');


-- ------------------------------------------------------------
--  Umbrales de operación del propio sistema de alertas
-- ------------------------------------------------------------
INSERT IGNORE INTO mp_costeo_config (config_key, config_value, description) VALUES
  ('alertas_notificar_activo', '0',  'Interruptor general de notificaciones por correo (0 = apagado). Arranca apagado a propósito: se enciende cuando el catálogo de tipos ya esté afinado.'),
  ('alertas_hora_envio',       '7',  'Hora del día (0-23, hora del servidor) en que se envía el resumen de alertas.');
