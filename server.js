'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');

const { pool } = require('./src/db');
const { requireAuth } = require('./src/middleware/auth');
const { attachScope } = require('./src/middleware/scope');
const { requestCache } = require('./src/lib/request-cache');
const { invalidarIndicadores } = require('./src/lib/shared-cache');

const authRoutes = require('./src/routes/auth');
const filterRoutes = require('./src/routes/filters');
const indicatorRoutes = require('./src/routes/indicators');
const resourceRoutes = require('./src/routes/resource');
const employeesRoutes = require('./src/routes/employees');
const validationRoutes = require('./src/routes/validation');
const costeoRoutes = require('./src/routes/costeo');
const { startSnapshotScheduler } = require('./src/services/snapshot-scheduler');
const { startAlertasEmailScheduler } = require('./src/services/alertas-email-scheduler');
const { startAlertasEmailCola } = require('./src/services/alertas-email-cola');
const { startVigiaHorasExternas } = require('./src/services/vigia-horas-externas');

// El secreto de sesion NO puede tener fallback: si la variable falta en un
// despliegue, express-session firmaria las cookies con un valor publico y
// cualquiera podria fabricarse una sesion de CEO. Antes se caia en
// 'dev-secret-change-me' y el servidor arrancaba igual, sin avisar. Ahora
// no arranca: es preferible un contenedor que no levanta (se nota de
// inmediato) a uno que levanta inseguro (no se nota nunca).
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('[FATAL] SESSION_SECRET ausente o de menos de 32 caracteres. Definelo en .env.');
  console.error('        Generar uno nuevo con:');
  console.error('          node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();

// Detras de nginx/caddy/cloudflare, sin esto express-session no ve que la
// conexion original era HTTPS y descarta la cookie cuando COOKIE_SECURE=true.
//
// Pero activarlo SIN un proxy delante es peor que no tenerlo (16 sep 2026,
// tras auditoria): con `trust proxy`, req.ip sale del header
// X-Forwarded-For, y si no hay ningun proxy que lo reescriba, ese header lo
// pone el CLIENTE. Comprobado: mandando X-Forwarded-For: 1.2.3.4 la app ve
// esa IP. Eso deja el limitador de login por IP (src/middleware/rate-limit.js)
// sin efecto — basta rotar la cabecera para no agotar nunca el contador.
// El limite por CUENTA sigue en pie, que es el que de verdad protege una
// contrasena concreta, pero el de IP se evapora.
//
// Por defecto se deduce de COOKIE_SECURE, porque es el mismo hecho contado
// dos veces: "hay un proxy que termina TLS delante". Asi no se puede
// configurar una mitad y olvidar la otra. TRUST_PROXY lo fuerza si algun dia
// hace falta separarlos (un proxy sin HTTPS, por ejemplo).
const COOKIE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
const TRUST_PROXY_ENV = String(process.env.TRUST_PROXY ?? '').toLowerCase();
const confiarEnProxy = TRUST_PROXY_ENV
  ? (TRUST_PROXY_ENV === 'true' || TRUST_PROXY_ENV === '1')
  : COOKIE_SECURE;

if (confiarEnProxy) app.set('trust proxy', 1);

app.disable('x-powered-by');

// Cabeceras de seguridad. Antes no se mandaba ninguna: sin X-Frame-Options
// el dashboard se puede meter en un <iframe> ajeno (clickjacking: el usuario
// cree que hace clic en otra cosa y en realidad aprueba una hora extra), y
// sin nosniff el navegador adivina el tipo de un archivo servido.
//
// La CSP es la segunda linea de defensa contra el XSS que se corrigio
// escapando el HTML: aunque se colara una etiqueta <script> en un dato,
// el navegador se negaria a ejecutarla.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // echarts se sirve desde jsdelivr (index.html), y ese <script> lleva
        // integrity/SRI: si el CDN devolviera un archivo alterado, el
        // navegador lo rechaza. Sin 'unsafe-inline': el unico script inline
        // que quedaba (login.html) se movio a /js/login.js justamente para
        // poder prohibirlos todos.
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        // 'unsafe-inline' SOLO para estilos, y es una concesion consciente:
        // los graficos y las barras de progreso escriben style="width:N%"
        // calculado en JavaScript (indicators.js, costeo.js). Un estilo
        // inyectado puede afear la pagina, no ejecutar codigo, asi que el
        // riesgo no se parece al de permitir scripts inline. Quitarlo exige
        // pasar esos anchos a variables CSS; queda como mejora pendiente.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // data: lo necesita echarts para exportar el grafico como imagen.
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        // El front solo habla con su propio backend (/api/...).
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Nadie puede embeber este dashboard en un iframe.
        frameAncestors: ["'none'"],
        // upgradeInsecureRequests se desactiva a proposito: en HTTP plano
        // (COOKIE_SECURE=false, despliegue en LAN) forzaria https:// y
        // romperia la carga de los propios archivos.
        upgradeInsecureRequests: null,
      },
    },
    // El dashboard carga echarts desde otro origen; la politica estricta por
    // defecto (require-corp) bloquearia ese <script>.
    crossOriginEmbedderPolicy: false,
    // HSTS solo tiene sentido detras de HTTPS. Mandarlo en un despliegue
    // HTTP plano no hace nada; mandarlo mal puede dejar un dominio inaccesible.
    hsts: COOKIE_SECURE,
  })
);

// 15mb en vez de 256kb: POST /api/indicator/export/pdf-graficos manda las
// imágenes PNG (en base64) de hasta 18 gráficos capturados en el navegador
// con echarts' getDataURL() — un solo gráfico ya puede pesar varios cientos
// de KB, así que 256kb se quedaba corto para el lote completo. El resto de
// endpoints POST/PUT de la app son formularios chicos, muy por debajo de
// este techo, así que subirlo no les cambia nada.
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: false, limit: '15mb' }));

// Las sesiones se guardan en ARCHIVO, no en memoria (16 sep 2026, tras
// auditoría). Con el MemoryStore por defecto, cada despliegue o reinicio del
// contenedor echaba a todos los conectados — y express-session lo advierte
// él mismo al arrancar.
//
// Por qué en archivo y NO en MariaDB, que es lo que parecería natural
// teniendo ya un pool: la base está en otro servidor y cada consulta cuesta
// ~100 ms MEDIDOS (99,5 desde el host, 100,6 desde dentro del contenedor).
// Este middleware corre ANTES que express.static, así que un store en base
// añadiría esos 100 ms a CADA petición — incluidos los CSS, JS e imágenes.
// Sería cambiar un problema que aparece en cada despliegue por uno
// permanente en cada clic, y encima apretaría el cupo de 50 conexiones
// simultáneas del usuario de la base. Un archivo local no cuesta red.
//
// El límite de esta decisión: no vale para más de una réplica, porque cada
// contenedor tendría su propio directorio. Hoy corre una sola; el día que
// haya varias, esto hay que cambiarlo (y ahí sí, Redis o la base).
//
// SESSION_DIR apunta al volumen de docker-compose. Sin volumen los archivos
// viven dentro del contenedor y se pierden igual al recrearlo — el volumen
// es lo que de verdad hace que sobrevivan.
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '.sesiones');

app.use(
  session({
    name: 'gtc.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new FileStore({
      path: SESSION_DIR,
      // En segundos, a diferencia de cookie.maxAge que va en milisegundos.
      // Tienen que coincidir: si el archivo caducara antes, al usuario le
      // quedaría una cookie válida sin sesión detrás y lo sacaría sin motivo.
      ttl: 8 * 60 * 60,
      // Por defecto reintenta 5 veces leer un archivo que no existe, con
      // esperas entre medias. Un archivo que no está es el caso NORMAL (una
      // cookie vieja tras caducar la sesión), no un fallo: reintentar solo
      // retrasa la respuesta para acabar en lo mismo.
      retries: 0,
      // Barre las caducadas una vez por hora.
      reapInterval: 60 * 60,
      // Su log por defecto escribe una línea por cada sesión que no
      // encuentra, que con cookies viejas es ruido constante. Perderlo no
      // oculta fallos reales: si el store no puede leer, express-session
      // trata la petición como sin sesión y el usuario acaba en /login,
      // que es justo el síntoma visible.
      logFn: () => {},
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.get('/healthz', async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    res.json({ status: 'ok' });
  } catch (err) {
    // El detalle del driver (host, puerto, nombre de la base) va al log del
    // servidor, no a la respuesta: /healthz no pide sesion y lo consulta
    // cualquiera que llegue al puerto.
    console.error('[healthz] la base no responde:', err.message);
    res.status(503).json({ status: 'error' });
  }
});

app.use('/api/auth', authRoutes);

// requestCache abre una cache que vive solo lo que dura esta peticion, para
// que los paneles de Costeo no repitan la misma query pesada una vez por
// centro de costos (ver src/lib/request-cache.js). No altera ningun calculo.
app.use('/api', requireAuth, attachScope, requestCache);

// Los 17 indicadores se cachean unos segundos ENTRE peticiones
// (src/lib/shared-cache.js) porque calcularlos cuesta ~2,4s y abrir Costeo los
// pedia dos veces seguidas. Esa cache no puede sobrevivir a un cambio hecho
// desde la aplicacion: cualquier peticion que no sea GET la borra apenas
// termina de responder, así la siguiente lectura recalcula con el dato nuevo.
//
// Va sobre /api entero y no solo sobre /api/costeo a proposito: aprobar un
// gasto, editar un empleado o revertir una validacion mueven los mismos
// numeros, y una lista de rutas "que si invalidan" es justo el tipo de lista
// que alguien olvida actualizar al agregar un endpoint.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  res.on('finish', invalidarIndicadores);
  next();
});
app.use('/api/filters', filterRoutes);
app.use('/api/indicator', indicatorRoutes);
app.use('/api/resource', resourceRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/validation', validationRoutes);
app.use('/api/costeo', costeoRoutes);

// Sin Cache-Control explícito, express.static no manda ninguno — el
// navegador queda libre de aplicar caché heurístico (RFC 7234) y guardarse
// costeo.js/costeo.css/costeo.html por días sin volver a preguntar. En un
// sistema que se actualiza tan seguido como este, eso se traduce en gente
// viendo pantallas viejas y pensando que un cambio no se aplicó. 'no-cache'
// no significa "no guardes nada": el navegador sigue guardando el archivo,
// pero antes de usarlo SIEMPRE revalida contra el servidor (If-None-Match /
// ETag) — si no cambió, responde 304 sin volver a bajar el archivo; si
// cambió, sí lo trae. Mejor esto que 'no-store' (bajaría todo siempre).
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Las tres paginas se sirven por ruta (sendFile), NO por express.static, asi
// que el Cache-Control 'no-cache' de arriba no las alcanzaba: el navegador
// les aplicaba cache heuristico y podia quedarse con un HTML viejo mientras
// bajaba el JS nuevo (que si revalida). Eso deja la pantalla en blanco de la
// peor forma posible — un <script> que el HTML viejo no conoce no se carga,
// y el primer render revienta con ReferenceError. Mismo criterio que el
// resto de estaticos: guardalo, pero pregunta siempre antes de usarlo.
function enviarPagina(res, archivo) {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', archivo));
}

app.get('/login', (_req, res) => {
  enviarPagina(res, 'login.html');
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  enviarPagina(res, 'index.html');
});

app.get('/costeo', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  // Alertas ya no es exclusivo de CEO/admin (26 ago 2026): el PM ve el
  // conteo de alertas en el encabezado de Costo Planeado desde siempre, así
  // que también necesita poder abrir la pestaña para ver cuáles son —
  // GET /api/costeo/alertas ya las scopea a su propio proyecto (req.scope),
  // igual que el resto de paneles.
  enviarPagina(res, 'costeo.html');
});

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.publicMessage || 'Error interno' });
});

const port = Number(process.env.PORT) || 8011;
app.listen(port, () => {
  console.log(`[gtc-dashboard] escuchando en :${port}`);
  startSnapshotScheduler();
  startAlertasEmailScheduler();
  // Deja los correos de alertas listos en mp_alerta_email_cola para que los
  // mande n8n. Apagado salvo que ALERTAS_COLA=1; comparte el candado del
  // programador de arriba, así que nadie recibe el correo dos veces.
  startAlertasEmailCola();
  // Lo que carga n8n (WF-COSTEO) no pasa por el servidor: sin esto la caché
  // de indicadores lo mostraba hasta 60 s tarde (ver el archivo).
  startVigiaHorasExternas();
});
