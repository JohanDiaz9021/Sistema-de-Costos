# Pruebas

Tres capas, cada una con su comando. Las tres usan `node:test`, el runner
nativo de Node — no hay Jest ni Mocha en el proyecto.

| Capa | Comando | Necesita | Duración |
|---|---|---|---|
| Unitarias | `npm test` | nada | ~8 s |
| Integración | `npm run test:integration` | Docker | ~140 s |
| End-to-end | `npm run test:e2e` | Docker + Chrome | ~45 s |
| Todo | `npm run test:all` | Docker + Chrome | ~190 s |

Dependencias de desarrollo usadas (`devDependencies`, no afectan el build de
producción): `playwright` (E2E, usa el Chrome ya instalado en la máquina vía
`channel: 'chrome'`, sin descargar navegadores propios) y `jsdom` (pruebas de
componente del frontend, ver más abajo). `eslint` ya estaba del lote anterior.

```bash
npm test                    # unitarias, sin dependencias externas

npm run db:test:up          # levanta MariaDB desechable en :3399
npm run test:integration
npm run test:e2e
npm run db:test:down        # la borra (los datos viven en RAM)
```

---

## Base de datos de prueba

`docker-compose.test.yml` levanta **MariaDB 10.6** — la misma versión que
corre en producción (`SELECT VERSION()` → `10.6.28-MariaDB`). No es un
detalle menor: las migraciones usan `ADD COLUMN IF NOT EXISTS`, que es
sintaxis exclusiva de MariaDB y MySQL 8 rechazaría.

- Puerto **3399**, no 3306, para no chocar con una base local.
- Proyecto de compose **`gtc-test`**, separado del de la app. Sin eso,
  compose mete el contenedor de pruebas en el mismo grupo que
  `gtc-dashboard` y un `down -v` trataría la app real como huérfana.
- Los datos viven en **tmpfs** (RAM): más rápido y garantizado desechable.

`test/helpers/db.js` construye su propia configuración desde `TEST_DB_*` y
**nunca lee el `.env` del proyecto**. Además se niega a arrancar si el
nombre de la base coincide con `jalo*`, `prod`, `stage` o
`sistema_monitoreo`, o si el puerto es 3306. Las pruebas hacen `TRUNCATE`:
apuntarlas por error a producción la vaciaría.

### Esquema

`prepararEsquema()` aplica, en orden:

1. `test/fixtures/00-schema-externo.sql` — las 5 tablas que las migraciones
   **no** crean (ver hallazgo QA-02).
2. `sql/01` … `sql/22` — las migraciones del repo, tal cual.

Todo es idempotente: correrlo dos veces no falla. `resetearDatos()` vacía
las tablas entre suites y reinicia los `AUTO_INCREMENT`, de forma que los
ids de las fixtures son estables y una prueba puede afirmar sobre ellos.

### Fixtures

`test/helpers/fixtures.js`. Todo inventado — **ni un dato real**; los
`backups/` del repo contienen nombres de personas de la empresa y no se
usan como fixture a propósito.

```
ALFA   → lo lidera Ana (leader)     equipo, gastos, 3 horas extra
BETA   → lo lidera Bruno (leader)   equipo, gastos, 1 hora extra
GAMMA  → sin PM                     solo lo ven ceo/admin
```

Usuarios: `ceo`, `admin`, `ana`, `bruno`, una cuenta **inactiva** y un
leader **sin proyectos** (que ejercita la rama `AND 1=0` de
`projectScopeClause`). Contraseña común en `fixtures.CLAVE`.

Detalles con intención:

- **Alicia aparece en dos `snapshot_date`** con las mismas horas. Si el
  motor dejara de filtrar por el último snapshot, el costo laboral se
  duplicaría — fue un bug real (2,6× medido).
- **Un gasto de agosto de 2025** junto a otros de agosto de 2026, para
  detectar la regresión del filtro por mes que ignoraba el año.
- **Carlos** está inactivo en `mp_employees` pero con horas cargadas: sus
  horas no deben contar.
- **Un integrante con `hourly_cost = 0`**, que dispara la alerta de
  talento sin costo/hora.

### Servidor

`test/helpers/servidor.js` arranca **`node server.js` como proceso hijo**,
sin modificarlo, apuntado a la base de prueba. No monta un Express
sintético a propósito: la mitad de las propiedades que hay que verificar
viven en el orden del middleware de `server.js` (`requireAuth` antes que
las rutas, `attachScope` antes que `requestCache`, la CSP, el redirect de
`/costeo?panel=alertas`). Un app armado a mano las saltaría todas.

`crearCliente()` mantiene la cookie `gtc.sid` como un navegador, y expone
`cookieHeader` para poder inspeccionar `HttpOnly` / `SameSite` / `Secure`.

---

## Qué cubre cada capa

### Unitarias — `test/unit/` (27 archivos, 444 pruebas)

Funciones puras, sin base de datos — salvo `frontend-componentes.test.js`,
que usa un DOM real (jsdom) pero nunca toca red ni base de datos.

| Archivo | Cubre |
|---|---|
| `scope.test.js` | `projectScopeClause` y `costCenterScopeClause` — las tres ramas (null / lista vacía / lista con datos), placeholders, y que los valores nunca se interpolen en el SQL |
| `capacity.test.js` | `getWeekDays` (semana 5 en meses de 28/29/30/31 días), `weekCapacity` con y sin festivos, `isBusinessDay`, `workHoursByDow` desde env vars |
| `export-format.test.js` | Los 17 indicadores formateados: que no impriman `NaN`/`null`, que distingan "sin datos" de cero, y que los nombres coincidan con los del front |
| `safe-html.test.js` | `escapeHtml`, `h\`\`` y `raw()` |
| `request-cache.test.js` | La caché por petición: que no sobreviva entre peticiones |
| `shared-cache.test.js` (7) | La caché de indicadores **entre** peticiones: que dos peticiones simultáneas compartan el cálculo en vuelo, que una escritura invalide, que un cálculo que arrancó **antes** de una escritura no se guarde después de ella, que fuera de una petición (scheduler, scripts) no cachee nada, y que un fallo no quede cacheado |
| `rate-limit.test.js` | El limitador de intentos, en memoria |
| `costeo-logica.test.js` | `rangoMes`, `describirCambios` |
| `front-carga.test.js` | Que los 8 archivos del front carguen en orden en un DOM simulado |
| `frontend-planeacion.test.js` (12) | El front de **Planeación** (`index.html`), que no tenía ninguna prueba: `GTC_FILTERS` (que el desplegable arranque en el mes vigente, que `toQuery()` mande `employee_id` y omita lo vacío, que el filtro de Líder solo lo vean ceo/admin, que cambiar un filtro emita `filters:change`), `GTC_MODAL` (el título nunca interpreta HTML, acepta un `Node`, no acumula drilldowns), que cada botón "i" de `index.html` tenga su texto en `tooltips.js`, y `applyRoleNav` por rol |
| `frontend-componentes.test.js` (20) | Cada función `render*` (centros, gastos, equipo, accesos, horas extra, historial, alertas, tarifas) montada sobre el `costeo.html` real con jsdom: escapado de HTML malicioso, campos ausentes, visibilidad por rol, agrupación de filas. Incluye el borrado múltiple de snapshots (`renderSnapshotBulkbar`/`initSnapshotBulkbar`, 8 sep 2026): contador singular/plural, "Seleccionar todos" en indeterminate, confirmación antes de borrar, y que `Promise.allSettled` borre los que sí pueden aunque uno falle |

### Integración — `test/integration/` (19 archivos, 437 pruebas)

Contra base y servidor reales.

| Archivo | Cubre |
|---|---|
| `aislamiento.test.js` (39) | **La propiedad de seguridad del sistema.** 11 endpoints × 2 leaders, IDOR en PUT/DELETE/POST, filtros con id ajeno, exports PDF y XLSX, y que el scope se recalcule por petición |
| `autorizacion.test.js` (29) | Matriz completa: 54 endpoints dan 401 sin sesión; 11 operaciones administrativas dan 403 a un leader y funcionan para admin/ceo. Incluye una prueba que **falla si alguien agrega un endpoint y no lo clasifica** |
| `costeo-crud.test.js` (27) | CRUD de centros, gastos, equipo, horas extra y configuración, verificando siempre el efecto en la base. Atomicidad de `withTransaction` con rollback provocado |
| `motor-costeo.test.js` (21) | El motor: deduplicación de snapshots, talento inactivo, composición del ejecutado, filtro mes+año, corte de horas extra, portafolio, y que ningún indicador dé `NaN`/`Infinity` |
| `autenticacion.test.js` (16) | Login por correo y por usuario, cuenta inactiva, logout, regeneración de sesión, `/me`, `/me/sidebar` |
| `infraestructura.test.js` (18) | `/healthz` sano y en fallo, redirects, `?panel=alertas` para leader, cabeceras de caché, `COOKIE_SECURE=true`, y que **el servidor no arranque sin `SESSION_SECRET`** |
| `seguridad.test.js` (12) | 10 payloads de inyección × 6 filtros × 7 endpoints (420 combinaciones), más parámetros de ruta, cuerpo de POST y login. Atributos de la cookie |
| `costeo-rutas.test.js` (18) | Humo de las 36 rutas del router de Costeo tras el split en módulos |
| `rate-limit-login.test.js` (5) | El limitador contra el servidor real, con servidor propio por prueba |
| `indicadores-planeacion.test.js` (51) | Los **18 indicadores de Planeación** (`GET /api/indicator/:n`): cada fórmula verificada contra un cálculo hecho a mano sobre `fixtures-planeacion.js`, más drilldowns y scope por leader |
| `validation-resource.test.js` (33) | `/api/validation/*` (filtros, ack/revert/unrevert, resumen) — **exclusivo del CEO desde el 9 sep 2026** (era admin/ceo por igual; la única diferencia real entre esos dos roles hoy), y `GET /api/resource/:id` (scope por leader) |
| `snapshot-scheduler.test.js` (17) | El disparo automático diario: la guarda de horario (antes/después de las 6am, borde exacto), reentrancia, y `guardarSnapshotsAutomaticos()` contra la base real |
| `concurrencia.test.js` (8) | Peticiones HTTP paralelas de verdad (`Promise.all`) sobre las mismas filas: aprobar la misma hora extra 10 veces a la vez, altas duplicadas, ediciones simultáneas de un PM |
| `cache-indicadores.test.js` (3) | La caché de indicadores **entre** peticiones (`src/lib/shared-cache.js`), con servidor propio y la caché **encendida**: que una escritura por la API (aprobar y borrar un gasto) se vea en la lectura siguiente sin esperar el TTL, y que un leader con la caché caliente siga viendo solo sus centros |

### End-to-end — `test/e2e/` (18 pruebas)

Navegador real (Chrome del sistema vía `channel: 'chrome'`, sin descargar
navegadores), servidor real, base real. Es **la única capa que ejercita el
frontend**: un `innerHTML` sin escapar o un panel que no carga no se ven
desde HTTP.

0. **El entorno e2e está disponible** — en CI falla en vez de saltarse (ver
   la sección de CI).
1. CEO entra → los KPI se llenan → hay una tarjeta por indicador → descarga
   el PDF y se verifica su contenido.
2. Un PM solo ve su proyecto en el selector.
3. El breadcrumb dice en qué pantalla estás, no siempre la misma.
4. "Ayuda visible" apaga los textos de ayuda pero no los avisos permanentes.
5. El filtro **Recurso ya no se muestra en ningún panel**; Periodo se
   conserva salvo en Comercial.
6. Simulador: "+ Agregar al equipo" lleva el rol y el costo/hora calculado
   desde el salario al formulario real de Equipo del Proyecto.
7. Un PM registra un gasto → nace **Pendiente** y **no** mueve el ejecutado
   → aprobado, sube exactamente ese monto.
8. El CEO aprueba un gasto desde el navegador y el estado pasa a Aprobado.
9. Hora extra: el PM decide y queda aprobada de una vez, sin paso de admin.
10. En Horas Extra solo se listan las filas aprobadas, sin columna de
    Acciones.
11. **Regresión XSS**: un gasto llamado `<img src=x onerror=…>` se muestra
    escapado, no se ejecuta y no crea ninguna etiqueta.
12. Lo mismo con `<svg onload>` en el nombre de un proyecto.
13. Sin sesión → `/login`.
14. Cookie con firma corrompida → `/login`.
15. Tras el logout, volver atrás en el navegador no da acceso.
16. La cookie no es legible desde `document.cookie`.
17. La CSP bloquea un `<script>` inline inyectado en tiempo de ejecución.

Cada prueba escucha `pageerror`: cualquier error de JS del front rompe la
prueba en vez de manifestarse como "el selector no apareció".

### Cómo se rompió esta capa (y qué se aprendió)

El 9 sep 2026 **5 de las 17 estaban en rojo**, y llevaban así un tiempo:
ninguna era un fallo del producto. Las cinco afirmaban comportamiento que se
había cambiado a propósito y nadie actualizó la prueba — un umbral de "≥10
tarjetas" cuando el catálogo se recortó a 8, el filtro Recurso en Alertas
que se quitó a pedido, un `data-sim-input="costo"` que el Simulador dejó de
usar al pasar a costo/hora derivado del salario, el formulario de gasto que
se movió dentro de un modal, y las columnas de Horas Extra.

La lección práctica: **una prueba E2E que fija un número o un selector
concreto se vuelve deuda apenas cambia la pantalla**. Donde se pudo, las
correcciones dejaron de comparar contra constantes escritas a mano y ahora
derivan el valor esperado del propio front (por ejemplo, se cuentan las
tarjetas contra `INDICATOR_DEFS.length` en vez de contra un 10). Y sin CI
—que llegó el mismo día— nada avisaba de que la capa entera estaba apagada.

---

## Hallazgos

Se reportaron sin corregir (era el encargo de la revisión). **Tres se
corrigieron después, el 2 sep 2026** — quedan documentados aquí con su
estado, porque explican por qué existen las pruebas de regresión que hoy
los cubren:

| Hallazgo | Estado |
|---|---|
| QA-01 · Formateo frágil de #7 y #17 | Abierto (no alcanzable hoy) |
| QA-02 · `sql/` no basta para levantar desde cero | Abierto (decisión de equipo) |
| QA-03 · El limitador de login puede bloquear a toda la empresa | **MITIGADO** (la app avisa sola si el proxy está mal; falta confirmar en producción que el aviso no sale) |
| QA-04 · `PUT /config/:key` acepta vacío como cero | **CORREGIDO** |
| QA-05 · Los tests saltados salían con exit 0 | Corregido en su momento |
| QA-06 · `sql/03` crea `mp_validation_errors` con el esquema equivocado | **CORREGIDO** |
| QA-07 · Los filtros de drilldown nunca se aplican | **CORREGIDO** |
| QA-08 · `POST /centros` da 500 en vez de 409 bajo concurrencia | Abierto (menor) |

### QA-01 · Menor · Formateo frágil de los indicadores #7 y #17

`src/queries/costo-export-format.js`. Con un objeto de indicadores
incompleto, el #7 imprime `"undefined"` y el #17 `"undefined semana(s)"`.
Los otros 15 lo toleran.

**Hoy no es alcanzable** desde los exports: `resolveExportContext()`
siempre pasa por `computeIndicadores17()`, que llena los 17 campos. Queda
como deuda defensiva: si algún día se exportara un snapshot guardado con
una versión vieja del motor, el informe diría "undefined semana(s)".

Prueba: `test/unit/export-format.test.js`.

### QA-02 · Mayor · `sql/` no basta para levantar el sistema desde cero

El código consulta 16 tablas `mp_*`; `sql/01–22` solo crea 14. Estas cinco
las crea el workflow de n8n, fuera de este repositorio:

```
mp_employees            (sql/04 le hace ALTER, asumiendo que existe)
mp_task_facts           (sql/05 documenta un ALTER sobre ella)
mp_project_owners       (sql/16 le cambia la PK)
mp_holidays
mp_validation_overrides
```

Un despliegue nuevo no arranca solo con `sql/`. Para poder correr las
pruebas tuve que extraer el DDL con `SHOW CREATE TABLE` contra la base
real; está en `test/fixtures/00-schema-externo.sql`.

**Lo dejé en `test/fixtures/` y no en `sql/` a propósito**: moverlo a la
carpeta de migraciones define quién es el dueño del esquema (el RPA o el
dashboard), y esa es una decisión del equipo. La recomendación es moverlo
a `sql/00_tablas_externas.sql`.

### QA-03 · Mayor · El limitador de login puede bloquear a toda la empresa

> **MITIGADO el 9 sep 2026.** No se cambió la política del limitador (sigue
> contando por IP y por usuario, que es lo correcto): lo que se corrigió es
> que la configuración peligrosa era **invisible**. Ahora la app la detecta y
> avisa una vez en el log — ver "QA-03 — cómo verificar el proxy sin entrar
> al servidor" al final de este documento. Además, `DEPLOY.md` solo decía
> "añade un `proxy_pass`" y nunca mencionaba `X-Forwarded-For`: ahí nacía el
> riesgo, y ya está documentado con el bloque nginx completo.
>
> Queda un paso que no es código: entrar al dashboard en producción y
> confirmar en `docker logs gtc-dashboard` que el aviso **no** aparece.

`src/middleware/rate-limit.js` cuenta los intentos fallidos por **IP
además de** por usuario: 8 fallos desde una IP bloquean a cualquier
usuario que llegue desde ella durante 15 minutos.

Contra un atacante que prueba muchas cuentas desde una máquina, es lo
correcto. El problema es que la app corre detrás de un proxy
(`app.set('trust proxy', 1)`). **Si ese proxy no reenvía bien el
`X-Forwarded-For`, toda la empresa comparte una sola IP**: ocho errores de
tipeo de cualquiera dejan sin entrar a todos los demás.

Mitigaciones posibles: verificar la configuración del proxy en producción;
subir el umbral por IP y dejar el estricto por usuario; o exceptuar los
rangos internos.

Prueba: `test/integration/rate-limit-login.test.js`.

Efecto lateral en las pruebas: las suites que fallan credenciales comparten
ese cupo. Por eso las del limitador viven en su propio archivo, con un
servidor por prueba (los contadores están en memoria del proceso, así que
un proceso nuevo es la única forma de empezar limpio).

### QA-04 · Mayor · `PUT /config/:key` acepta `null`, `""` y `[]` como cero

> **CORREGIDO el 2 sep 2026.** `src/routes/costeo/config.js` ahora mira el
> *tipo* antes de convertir (solo número o cadena numérica) y rechaza la
> cadena vacía. Además, `CONFIG_DEFS` (`src/routes/costeo/_shared.js`) ganó
> un `min` por umbral: `weekly_legal_hours` y `horas_mes_liquidacion` no
> aceptan ni siquiera un 0 explícito, porque son los dos divisores del
> motor; en los recargos y los días de preaviso el 0 sigue siendo válido.
> Regresión en `test/integration/costeo-crud.test.js` (4 pruebas).

`src/routes/costeo/config.js`:

```js
const value = Number(req.body.config_value);
if (!Number.isFinite(value) || value < 0) { … }
```

`Number(null)` === `Number('')` === `Number([])` === `Number(false)` ===
`0`, que es finito y `>= 0`. El endpoint responde **200** y guarda `"0"`.

Impacto medido sobre las fixtures: poner `weekly_legal_hours` en 0 lleva el
indicador 9 (proporción de horas extra) **del 2,99 % al 100 %** en todo el
portafolio. Cada hora trabajada pasa a contar como hora extra, y de ahí
salen las alertas y el costo extra potencial.

Requiere admin/ceo, así que no es escalada de privilegios: es un fallo de
validación que un formulario mal enviado dispara en silencio.

**Arreglo sugerido** — rechazar antes del `Number()`, igual que ya hace
`PUT /tarifas-cargo/:rol`:

```js
const bruto = req.body.config_value;
if (bruto === null || bruto === undefined || String(bruto).trim() === '') {
  return res.status(400).json({ error: 'config_value es obligatorio' });
}
```

Pruebas: `test/integration/costeo-crud.test.js`.

### QA-06 · Mayor · `sql/03` crea `mp_validation_errors` con el esquema EQUIVOCADO

> **CORREGIDO el 2 sep 2026.** `sql/03_ingestion_and_validation.sql` declara
> ahora el esquema real (el mismo DDL que el fixture). Una base nueva
> levantada solo con `sql/` ya sirve para `/api/validation/*`.
> La regresión es **estática** (`test/unit/sql-migraciones.test.js`): ninguna
> prueba contra la base podía detectar esto, porque ahí la tabla la crea el
> fixture antes de que corra la migración — el error solo es visible
> leyendo el archivo.
>
> Ojo con una base donde ya corrió la versión vieja: el `IF NOT EXISTS` no
> la corrige sola, hay que hacerle `DROP TABLE` (estará vacía) y volver a
> migrar. En la base real de GTC no aplica.

Variante más grave de QA-02: aquí la migración sí existe y sí corre, pero
crea la tabla mal. `sql/03_ingestion_and_validation.sql` trae
`CREATE TABLE IF NOT EXISTS mp_validation_errors` con columnas viejas
(`detected_at`, `workflow_name`, `source_filename`, `acknowledged`…) que no
tienen nada que ver con lo que consulta `src/routes/validation.js`
(`snapshot_date`, `execution_id`, `severity`, `notified`, `week_number`…) —
el propio archivo lo advierte en un comentario: *"el schema real de
mp_validation_errors viene del WF1 de n8n"*.

En producción no se nota: la tabla ya existe con el esquema correcto (la
creó n8n hace tiempo) y el `IF NOT EXISTS` no hace nada. Pero en cualquier
base **nueva** — exactamente el escenario de esta suite, y el de cualquier
entorno provisionado solo con `sql/` — `sql/03` gana la carrera y crea la
tabla mala. El resultado: **todo `/api/validation/*` revienta** con
`Unknown column 'snapshot_date' in 'INSERT INTO'` (o su equivalente en
`SELECT`) apenas alguien intenta usarlo.

Se descubrió escribiendo `test/integration/validation-resource.test.js`.
Se resolvió igual que QA-02: el esquema correcto (extraído con
`SHOW CREATE TABLE` de la base real) vive en
`test/fixtures/00-schema-externo.sql`, aplicado *antes* de `sql/03` para
que su `IF NOT EXISTS` no pise nada. La corrección de fondo — que `sql/03`
deje de traer un `CREATE TABLE` para esta tabla — sigue pendiente; no se
tocó `sql/` a propósito.

### QA-07 · Mayor · Los filtros de drilldown (`?status=`, `?tipo=`) nunca se aplican

> **CORREGIDO el 2 sep 2026.** Se agregó `parseDrilldownFilters()` en
> `src/queries/_common.js` — `parseFilters()` más `status` y `tipo` — y la
> ruta `GET /:n/drilldown` la usa en su lugar. Van en una función aparte a
> propósito: fuera del drilldown esas dos claves no significan nada, y en
> Costeo `status` es el estado del centro de costos, que es otra cosa.
> Regresión en `test/integration/indicadores-planeacion.test.js` (4 pruebas)
> y `test/unit/queries-common.test.js` (4 pruebas).

`src/routes/indicators.js`, la ruta `GET /:n/drilldown`:

```js
const filters = parseFilters({ ...req.query, status: req.query.status });
```

Parece que preserva `status`, pero `parseFilters()`
(`src/queries/_common.js`) tiene una whitelist fija de salida —
`{month, week, project, employee_id, leader}` — y descarta cualquier otra
clave, `status` incluido, sin importar qué se le pase de entrada. Lo mismo
le pasa a `?tipo=` en el drilldown del indicador #13
(`indicator-13.js`, que sí espera `filters.tipo` pero nunca lo recibe).

Efecto real: un usuario que hace clic en "ver solo las bloqueadas" (#5) o
"ver solo los imprevistos internos" (#13) en el drilldown del dashboard
recibe **todas** las filas, no solo las filtradas — puede llevar a leer
mal un problema (creer que hay pocas tareas bloqueadas cuando en realidad
está viendo la lista completa sin filtrar).

**Arreglo sugerido**: `parseFilters()` necesitaría aceptar (o la ruta de
drilldown necesitaría armar su propio objeto de filtros en vez de pasar
por `parseFilters`) las claves específicas de cada indicador —
`status` para #5, `tipo` para #13 — en vez de descartarlas en silencio.

Pruebas (fijadas como regresión, fallan el día que se corrija):
`test/integration/indicadores-planeacion.test.js`.

### QA-08 · Menor · Bajo concurrencia real, `POST /centros` da 500 en vez de 409

`src/routes/costeo/centros.js`. La validación de "¿ya existe un centro
para este `project_folder`?" es un `SELECT` previo al `INSERT`
(check-then-act): bajo dos peticiones simultáneas de verdad (doble clic,
dos admins creando el mismo proyecto a la vez), ambas pueden pasar el
`SELECT` antes de que ninguna haya insertado, y la que pierde la carrera
choca contra la `UNIQUE KEY` (`uk_cc_project_folder`, `sql/06`) directo en
el `INSERT`. El `catch` de esa ruta es genérico (`next(err)`), sin
distinguir `err.code === 'ER_DUP_ENTRY'` — a diferencia de `POST /equipo`
y `POST /overtime`, que sí lo hacen y devuelven un 409 explicando el
motivo. Aquí el perdedor recibe un 500 "Error interno" liso.

Los **datos quedan bien** en los dos casos — la `UNIQUE KEY` sostiene la
integridad pase lo que pase con el código de respuesta; esto es solo
sobre la calidad de la respuesta HTTP bajo la carrera, no una fuga de
datos ni un duplicado real.

Descubierto disparando 6 `POST /centros` idénticos con `Promise.all` real
contra MariaDB. Prueba: `test/integration/concurrencia.test.js`.

### QA-05 · Menor · Los tests saltados salían con exit 0

No es del producto, es de la propia suite, pero merece constancia. Cada
suite se salta sus pruebas cuando la base no responde, para que `npm test`
siga siendo útil sin Docker. Pero `node:test` devuelve **exit 0** con todo
saltado: `npm run test:integration` daba verde **sin ejecutar nada**. En
CI, un contenedor caído se vería igual que un éxito.

Corregido con `test/helpers/verificar-base.js`, que corre antes y aborta
con instrucciones si la base no está.

---

## Notas de testabilidad

Cosas del código de producción que condicionan cómo hay que probarlo.
Ninguna se cambió.

- **`server.js` llama a `app.listen()` al cargarse**, así que no se puede
  `require()` en una prueba. Se ejecuta como proceso hijo — que además es
  más fiel: es el mismo `node server.js` del Dockerfile.
- **El limitador de intentos guarda estado en memoria del proceso** y no
  expone forma de reiniciarlo. Es lo correcto (un endpoint de reset sería
  justo lo que buscaría un atacante), pero obliga a levantar un servidor
  por prueba en esa suite.
- **Las suites comparten una sola base**, así que los archivos **no pueden
  correr en paralelo**: el `TRUNCATE` de una borraría los datos de otra a
  media ejecución. Por eso los scripts usan `--test-concurrency=1`. Para
  paralelizar haría falta un esquema por worker (`gtc_test_1`, `_2`…).
- **`ind2_tiempo_transcurrido_pct` e `ind3` dependen del reloj**: dos
  llamadas seguidas difieren en el último decimal. Es correcto, pero
  impide comparar respuestas con `deepStrictEqual` sin excluirlos.
- **PDFKit comprime los content streams** y escribe el texto como cadenas
  hex. Buscar una cadena en el binario crudo no encuentra nunca nada, así
  que una prueba de "el PDF no contiene datos ajenos" pasaría vacía.
  `test/helpers/pdf.js` infla los streams y decodifica el hex; por eso
  `assertTextoDePdf()` exige un `debeContener` que demuestre que el
  extractor funciona con ese archivo.
- **`express-session` no emite la cookie con `secure: true` sobre HTTP**.
  Probar `COOKIE_SECURE=true` exige simular el `X-Forwarded-Proto: https`
  del proxy.
- **El panel "equipo-gastos" tiene sub-pestañas** y abre la que
  corresponda al rol. En E2E hay que pedir `&subtab=costo-no-planeado`
  explícitamente: si no, el formulario existe en el DOM pero está oculto.
- **`src/services/snapshot-scheduler.js` necesitó un refactor mínimo de
  testeabilidad, documentado in situ.** `tick()` ahora acepta
  `{ ahora, guardar }` como dependencias inyectables (con el mismo
  comportamiento por defecto si no se pasan). Sin eso, probar la guarda
  "no dispara antes de las 6am" exigiría poder mentirle a MariaDB sobre su
  propia hora, y probar la reentrancia exigiría ganar una carrera de
  timing real. También se hizo que `startSnapshotScheduler()` devuelva el
  handle del `setInterval` (antes se descartaba) para poder pararlo con
  `clearInterval()` al terminar la prueba — sin eso, el intervalo de una
  hora quedaba vivo y el proceso de pruebas no terminaba solo.
- **jsdom monta el `costeo.html` real, no un fragmento inventado.** Con
  `runScripts: 'outside-only'` jsdom no ejecuta los `<script src>` del
  HTML por su cuenta (evita que intente hacer `fetch()` de archivos en
  disco), pero SÍ dispara `DOMContentLoaded` de verdad al terminar de
  parsear — así que `costeo-nav.js` (que registra el bootstrap completo de
  la app en ese evento) se excluye a propósito del arnés de componentes;
  ningún `render*` depende de él.
- **Los `fact_id` de las fixtures de Planeación empiezan en 1000+** para
  no chocar con los `fact_id` autoincrementales que ya siembra
  `fixtures.js` (Costeo) en la misma tabla `mp_task_facts`.
- **La suite corre con la caché de indicadores APAGADA** (`COSTEO_CACHE_TTL_MS=0`
  en `test/helpers/servidor.js`). No es comodidad: las pruebas siembran sus
  escenarios escribiendo directo en la base (`ctx.db.query('INSERT …')`), y ese
  es justo el camino que el servidor no puede ver para invalidar — con la caché
  encendida, un `INSERT` así quedaba tapado por lo que hubiera cacheado un GET
  anterior y la prueba fallaba por el reloj, no por la lógica (pasó de verdad
  con "Arturo debería contar en BETA", en `motor-costeo.test.js`). Lo que sí
  depende producción — que una escritura **por la API** invalide de inmediato —
  se verifica aparte, en `cache-indicadores.test.js`, con su propio servidor y
  la caché encendida.
- **`ROUND()` sobre una división en MariaDB vuelve como cadena, no como
  número.** mysql2 devuelve las columnas `DECIMAL` calculadas (como los
  `compliance_pct` de los drilldowns de indicadores) como string por
  defecto. No es un bug — es consistente en todo el motor —, pero las
  pruebas que comparan esos campos usan `Number(...)` a propósito.

---

## Qué NO está cubierto

| Área | Por qué |
|---|---|
| `src/services/sharepoint.js` y `POST /employees/:id/sharepoint` | Habla con Microsoft Graph. Necesitaría credenciales reales o un doble de la API; ninguna de las dos cosas cabía en el encargo |
| `scripts/*.js` | Herramientas de operación que se ejecutan a mano, no código de la app |
| `public/js/indicators.js` (los 18 renderers de Planeación) | Cada renderer termina en `echarts.init(...)`, una librería que viene de un CDN y que jsdom no carga. Un doble de echarts entero dejaría verificado el doble, no el gráfico. Lo cubre la capa E2E, con navegador real |
| `public/js/employees-admin.js` y `validation-admin.js` | Se cargan en el arnés de Planeación (para que la página arranque completa) pero sus `init()` no se ejercitan: dependen de varias peticiones encadenadas. Extenderlo es el mismo patrón |
| Disparo real del `setInterval` de una hora en `snapshot-scheduler.js` | Se prueban sus piezas (`tick`, `guardarSnapshotsAutomaticos`, `ahoraSegunLaBase`) por separado y que `startSnapshotScheduler()` dispara un tick inmediato al arrancar; no se espera una hora real para ver el segundo disparo |
| Concurrencia real con más de una réplica del servidor | `test/integration/concurrencia.test.js` prueba peticiones paralelas contra un único proceso de servidor y un único pool — que es el despliegue actual. Con varias réplicas entrarían en juego cosas que un solo proceso no puede provocar (dos pools distintos compitiendo) |

## Próximos pasos sugeridos

~~1. Arreglar **QA-04** y **QA-07**~~ · ~~2. Mover el DDL de **QA-06** a
`sql/`~~ — hechos el 2 sep 2026.

~~3. Meter las tres capas en CI~~ · ~~4. Verificar **QA-03**~~ — hechos el
9 sep 2026 (ver las dos secciones de abajo).

1. Mover el DDL de las otras cuatro tablas externas de **QA-02**
   (`mp_employees`, `mp_task_facts`, `mp_project_owners`, `mp_holidays`,
   `mp_validation_overrides`) de `test/fixtures/` a `sql/00_tablas_externas.sql`,
   para que el repo levante solo. Sigue pendiendo de la misma decisión de
   equipo: quién es el dueño del esquema, el RPA o el dashboard.
2. Terminar el arnés de componentes del front. El 9 sep 2026 se cubrió
   **Planeación** (`frontend-planeacion.test.js`, 12 pruebas sobre
   `index.html`); queda ejercitar los `init()` de `employees-admin.js` y
   `validation-admin.js` (ver la tabla de "Qué NO está cubierto").
3. Meter las tres capas en CI. Se intentó el 9 sep 2026 y se descartó por
   decisión del equipo: las pruebas se siguen corriendo a mano con
   `npm run test:all`. Notas para quien lo retome, que ya costaron una vuelta
   averiguarlas:
   - El `origin` está en **Bitbucket**, así que el archivo es
     `bitbucket-pipelines.yml`; un `.github/workflows/` ahí no lo lee nadie.
   - En Bitbucket la base va como `service` propio y queda en el **puerto
     3306**, que `test/helpers/db.js` rechaza a propósito (las pruebas hacen
     `TRUNCATE` y ese suele ser el puerto de la base real). La salida es
     `TEST_DB_PERMITIR_3306=1`, y solo ahí.
   - `verificar-base.js` espera 10 s por defecto, que sobra en local pero se
     queda corto cuando la base arranca junto al paso: subirlo con
     `TEST_DB_INTENTOS`.
   - **`CI=true` es obligatorio en el paso de E2E** (ver abajo).

### `CI=true` convierte los saltos en fallos

`node:test` sale con **exit 0 si todo se saltó**. En local eso es lo que se
quiere (`npm run test:e2e` no debe estorbar en una máquina sin Docker ni
Chrome), pero en un CI significa que un navegador que no instaló se vería
idéntico a un éxito — el mismo hallazgo QA-05 que para la base ya cubre
`verificar-base.js`, y que el navegador no tenía.

Por eso la suite E2E abre con una prueba (`el entorno e2e esta disponible`)
que **falla** en vez de saltarse cuando `process.env.CI` está puesto. Eso
sigue en el código aunque hoy no haya CI: sirve igual si alguien corre las
pruebas desde un script automatizado.

---

## QA-03 — cómo verificar el proxy sin entrar al servidor

El limitador de login cuenta por IP además de por usuario, y `req.ip` sale
del `X-Forwarded-For` porque la app hace `trust proxy`. Si nginx no reenvía
ese header, todos los usuarios comparten la IP del proxy y ocho fallos de
cualquiera bloquean a la empresa entera 15 minutos.

Ya no hay que auditar el `nginx.conf` a mano: **la app lo detecta sola**.
`avisarSiElProxyNoReenviaLaIp()` (`src/middleware/rate-limit.js`) mira cada
intento de login y, si viene de una IP privada/loopback (o sea, de un proxy)
y **sin** `X-Forwarded-For`, escribe una vez en el log:

```
[rate-limit] AVISO: llegan intentos de login desde 127.0.0.1 SIN X-Forwarded-For...
```

Verificación en producción: entrar al dashboard y mirar
`docker logs gtc-dashboard`. **Si el aviso no aparece, la configuración está
bien.** Los directivas exactas que deben estar en nginx quedaron
documentadas en `DEPLOY.md` (sección "Proxy inverso — los headers NO son
opcionales"), que antes solo decía "añade un `proxy_pass`" — de ahí venía el
riesgo.

Pruebas: `test/unit/rate-limit.test.js` (5 casos: avisa con proxy local sin
header, calla cuando el header sí está, calla en conexión directa desde IP
pública, reconoce las tres familias de IP privada, y avisa una sola vez).
