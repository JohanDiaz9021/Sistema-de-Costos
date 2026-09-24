# Sistema de Costos

Dashboard web para monitorear la planeación, ejecución y costo de los proyectos de GTC. El sistema combina indicadores operativos, costos planeados y no planeados, horas extra, alertas y controles de acceso para apoyar decisiones oportunas sobre presupuesto, capacidad y rentabilidad.

## Por qué es importante

Este proyecto convierte datos operativos dispersos en una vista única y accionable del estado de la empresa. Su valor principal es que permite:

- Detectar temprano proyectos que pueden quedarse sin presupuesto.
- Comparar presupuesto contra ejecución real y costo laboral.
- Identificar actividades vencidas, bloqueadas, no planeadas o con desviaciones.
- Controlar gastos no planeados, horas extra y tarifas por cargo.
- Asignar responsabilidades por proyecto y restringir la información según el rol.
- Conservar trazabilidad mediante snapshots, historial y auditoría de cambios.
- Estandarizar la información que llega desde archivos operativos procesados por n8n.

En la práctica, el sistema ayuda a pasar de una revisión manual y reactiva a una gestión basada en datos: los líderes pueden actuar sobre sus proyectos y la gerencia puede ver el portafolio completo con sus riesgos financieros y operativos.

## Qué hace el sistema

### 1. Planeación

El dashboard principal presenta 18 indicadores de planeación, con filtros por mes, semana, proyecto, recurso y líder. Incluye, entre otros:

- Cumplimiento semanal y entrega a tiempo.
- Actividades vencidas, bloqueadas y terminadas.
- Días de desfase promedio y tasa de reestimación.
- Horas ejecutadas frente a horas presupuestadas.
- Tareas no planeadas e imprevistos internos o externos.
- Carga de trabajo y actividad diaria por recurso.
- Recursos compartidos entre proyectos.
- Auditoría de cambios en fechas estimadas.
- Reconocimientos del mes y velocidad de cierre.
- Semáforo general de gestión e indicador por recurso.

Los indicadores se pueden consultar en pantalla y exportar a PDF, incluyendo datos resumidos o gráficos.

### 2. Costeo

El módulo de Costeo calcula y presenta información sobre los centros de costos y proyectos:

- Indicadores oficiales de costo, calculados en vivo.
- Presupuesto total, ejecutado, porcentaje consumido y proyectos en riesgo.
- Comparación de indicadores por semana o periodo.
- Gráficos de comportamiento del costo.
- Alertas abiertas, alertas por severidad y seguimiento de escalamiento.
- Centros de costos y proyectos.
- Equipo asignado a cada proyecto.
- Costos no planeados, con flujo de registro y aprobación.
- Horas extra, decisión del líder y aprobación administrativa.
- Catálogo de cargos y tarifas.
- Historial de acciones y auditoría.
- Snapshots históricos para comparar estados del costo.
- Configuración de umbrales y recargos.
- Gestión de accesos de líderes o PMs.

El módulo permite exportar indicadores y alertas a PDF y Excel.

### 3. Ingesta y validación

Los workflows de n8n procesan los archivos operativos y alimentan la base de datos. El flujo contempla:

- Procesamiento diario de archivos de Excel.
- Lectura de varias semanas por archivo.
- Validación del nombre y contenido de los archivos.
- Registro de errores de ingesta.
- Protección contra ejecuciones duplicadas mediante idempotencia.
- Exclusión de días festivos cuando corresponde.
- Actualización de indicadores a partir de los datos cargados.

Los administradores pueden consultar los errores de ingesta desde la aplicación.

## Roles y seguridad

La aplicación usa autenticación por sesión y controla el alcance de los datos en cada petición.

| Rol | Alcance principal |
|---|---|
| `ceo` | Acceso global a proyectos, costos, indicadores, alertas y administración. Puede aprobar horas extra y administrar configuraciones. |
| `admin` | Acceso global y funciones administrativas, incluyendo usuarios, empleados, configuraciones y validación. |
| `leader` | Acceso limitado a los proyectos asignados en `mp_project_owners`. Puede gestionar la información permitida de sus centros y tomar decisiones operativas, pero no aprobar horas extra administrativas. |

El alcance de un líder se calcula en el servidor a partir de sus asignaciones activas. No se confía únicamente en los filtros enviados por el navegador. Las sesiones usan cookies `HttpOnly`, `SameSite` y, cuando corresponde, `Secure`; además, el servidor aplica cabeceras de seguridad y limita los intentos de login.

## Arquitectura

```text
Usuario
   |
   v
Frontend HTML/CSS/JS (public/)
   |
   v
API Express (server.js y src/routes/)
   |                  \
   v                   v
MariaDB/MySQL       Workflows n8n
   ^                   |
   |                   v
   +------------ Datos operativos y snapshots
```

### Componentes principales

- `server.js`: inicia Express, configura sesiones, seguridad, rutas, archivos estáticos y el scheduler de snapshots.
- `src/routes/`: endpoints de autenticación, filtros, indicadores, recursos, empleados, validación y Costeo.
- `src/queries/`: consultas SQL y motor de cálculo de indicadores y costos.
- `src/services/`: servicios auxiliares, incluyendo snapshots y conexión con SharePoint cuando aplica.
- `public/`: frontend del login, Planeación y Costeo.
- `sql/`: migraciones y cambios incrementales del esquema.
- `scripts/`: semillas, migraciones, diagnósticos y utilidades operativas.
- `test/`: pruebas unitarias, de integración y end-to-end.
- `docs/`: despliegue, pruebas, modelo de datos y configuración de n8n.

## Requisitos

- Node.js 20 o superior.
- npm.
- MariaDB/MySQL accesible desde la aplicación.
- Docker y Docker Compose para el despliegue recomendado y las pruebas de integración.
- Workflows n8n configurados para la ingesta de datos.

## Configuración local

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Crea un archivo `.env` en la raíz. Como mínimo debe contener:

   ```env
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=usuario_mysql
   DB_PASSWORD=contrasena_mysql
   DB_NAME=sistema_monitoreo
   SESSION_SECRET=una-cadena-aleatoria-de-al-menos-32-caracteres
   PORT=8011
   COOKIE_SECURE=false
   ```

   Genera un secreto robusto con:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

3. Verifica que la base de datos tenga las tablas externas que alimentan el sistema, especialmente `mp_employees`, `mp_task_facts`, `mp_project_owners`, `mp_holidays` y `mp_validation_overrides`.

4. Aplica las migraciones requeridas en el orden indicado por sus nombres. El script automatizado disponible es:

   ```bash
   npm run migrar
   ```

   Para aplicar cambios:

   ```bash
   npm run migrar:aplicar
   ```

   La carpeta `sql/` no crea por sí sola todas las tablas externas; esas tablas normalmente son responsabilidad del esquema operativo o de n8n. Consulta `docs/testing.md` y `docs/n8n-workflows-guide.md` antes de levantar una instalación desde cero.

5. Crea los usuarios iniciales una sola vez:

   ```bash
   npm run seed
   ```

   Después cambia las contraseñas temporales:

   ```bash
   npm run set-password -- usuario@empresa.com NuevaContrasenaSegura
   ```

## Cómo ejecutar

### Desarrollo

```bash
npm run dev
```

El servidor queda disponible en `http://localhost:8011`.

### Producción con Node

```bash
npm install --omit=dev
npm start
```

Para un servidor Linux se recomienda usar un proceso supervisor como systemd o pm2.

### Producción con Docker

Configura `.env` y ejecuta:

```bash
docker compose build
docker compose up -d
docker compose logs -f dashboard
```

Comprueba el estado de la aplicación:

```bash
curl http://localhost:8011/healthz
```

La respuesta esperada es:

```json
{"status":"ok"}
```

Para detenerla:

```bash
docker compose down
```

Si la base de datos corre en el mismo equipo que Docker, puede usarse `DB_HOST=host.docker.internal`. Si corre en otro contenedor, conecta ambos servicios a la misma red Docker.

La guía completa de despliegue se encuentra en [DEPLOY.md](DEPLOY.md).

## Pruebas y calidad

El proyecto utiliza el runner nativo `node:test`; no depende de Jest ni Mocha.

```bash
npm test                    # pruebas unitarias
npm run lint                # ESLint
npm run db:test:up         # MariaDB de pruebas desechable
npm run test:integration   # API, base de datos, permisos y aislamiento
npm run test:e2e           # flujo en navegador real
npm run test:all           # unitarias + integración + E2E
npm run db:test:down       # elimina la base de pruebas
```

La base de pruebas usa MariaDB en el puerto `3399` y datos temporales en memoria. Nunca deben apuntarse las pruebas a la base de producción.

## Flujo de datos operativo

1. n8n recibe o detecta los archivos operativos.
2. WF1 valida y transforma la información en hechos de tareas y errores de ingesta.
3. La aplicación consulta la base y aplica filtros, alcance por rol y reglas de negocio.
4. El motor calcula indicadores de Planeación y Costeo.
5. El usuario revisa riesgos, registra cambios o toma decisiones.
6. Los snapshots, aprobaciones, alertas e historial conservan la trazabilidad.

Para configurar los workflows, consulta [docs/n8n-workflows-guide.md](docs/n8n-workflows-guide.md). Para conocer la estrategia completa de pruebas, consulta [docs/testing.md](docs/testing.md).

## Operación y mantenimiento

- Revisar `docker compose logs -f dashboard` ante errores de arranque o conexión.
- Mantener `SESSION_SECRET` fuera del repositorio y con al menos 32 caracteres.
- Usar `COOKIE_SECURE=true` cuando la aplicación esté detrás de HTTPS.
- Confirmar que n8n y el dashboard apunten a la misma base de datos.
- Verificar periódicamente `GET /healthz` y el estado de los workflows.
- Aplicar las migraciones SQL antes de desplegar una versión que agregue tablas o columnas.
- No ejecutar scripts de diagnóstico o limpieza sobre producción sin revisar primero sus parámetros.

## Documentación relacionada

- [Despliegue](DEPLOY.md)
- [Despliegue final](docs/DEPLOY-FINAL.md)
- [Pruebas](docs/testing.md)
- [Guía de workflows n8n](docs/n8n-workflows-guide.md)
- [Parser de WF1](docs/n8n-wf1-parser.js)
- [Guard de idempotencia](docs/n8n-idempotency-guard.js)

## Licencia y uso

Este proyecto es una herramienta interna de GTC. Su código, datos, credenciales y archivos operativos deben manejarse de acuerdo con las políticas internas de seguridad y confidencialidad de la organización.
