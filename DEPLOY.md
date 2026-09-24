# Despliegue del Dashboard GTC en producción

Guía paso a paso. Si el esquema y los catálogos ya están cargados en la BD
(`mp_employees`, `mp_project_owners`, `mp_holidays`) y los workflows de n8n
están corriendo contra esa BD, este documento es lo único que necesitas.

> Repositorio actual del esquema/catálogos/WFs: ya cargado en
> `<NOMBRE_BD>` (servidor `<HOST_BD>`). #colocar credenciales

---

## Pre-requisitos en el servidor

- **Docker + docker-compose** (recomendado), o
- **Node.js ≥ 20** si vas a correrlo sin Docker.
- Acceso de red al MySQL/MariaDB (`<HOST_BD>:3306`) #colocar credenciales.

---

## Paso 1 — Copiar este folder al servidor

Sube el zip al servidor por scp/rsync/SFTP/panel del hosting:

```bash
# desde tu máquina local:
scp dashboard.zip usuario@servidor:/opt/

# en el servidor:
cd /opt
unzip dashboard.zip
cd dashboard
```

---

## Paso 2 — Crear y configurar `.env`

```bash
cp .env.example .env
nano .env
```

Rellena los 5 valores que están vacíos:

```env
DB_HOST=                         #colocar credenciales
DB_USER=                         #colocar credenciales — usuario MySQL con SELECT en la BD + ALL en mp_dashboard_users
DB_PASSWORD=                     #colocar credenciales
DB_NAME=                         #colocar credenciales — BD donde están las tablas mp_*
SESSION_SECRET=<generar uno nuevo, ver abajo>
```

Genera un `SESSION_SECRET` aleatorio:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Copia el output al .env
```

Si vas detrás de HTTPS (nginx/caddy/cloudflare):

```env
COOKIE_SECURE=true
```

---

## Paso 3 — Levantar con Docker (recomendado)

```bash
docker compose build
docker compose up -d
docker compose logs -f dashboard    # ver el arranque, Ctrl+C para salir del log
```

Verificar:

```bash
curl http://localhost:8011/healthz
# Esperado: {"status":"ok"}
```

---

## Paso 4 — Crear los 5 usuarios iniciales (solo la primera vez)

```bash
docker compose exec dashboard npm run seed
```

Te imprimirá las contraseñas temporales:

```
+ <correo_ceo> (rol ceo) — contraseña temporal: <contraseña>        #colocar credenciales
+ <correo_lider> (rol leader) — contraseña temporal: <contraseña>  #colocar credenciales
+ <correo_admin> (rol admin) — contraseña temporal: <contraseña>   #colocar credenciales
```

El seed es **idempotente**: si los usuarios ya existen, NO pisa contraseñas.

---

## Paso 5 — Cambiar las contraseñas temporales

```bash
docker compose exec dashboard npm run set-password -- <correo_ceo> <nueva_contraseña>    #colocar credenciales
docker compose exec dashboard npm run set-password -- <correo_lider> <nueva_contraseña>  #colocar credenciales
# ... etc para los otros
```

---

## Paso 6 — Acceso

- **URL local**: http://localhost:8011
- **Detrás de nginx**: añade un `server` block con `proxy_pass http://localhost:8011`
  y certificado SSL (Let's Encrypt o el cert interno).

### Proxy inverso — los headers NO son opcionales

`proxy_pass` a secas **no basta**. La app hace `app.set('trust proxy', 1)`
(server.js), así que deduce la IP real del visitante del header
`X-Forwarded-For`. Si nginx no lo manda, ese header no llega y la app cree
que **todo el mundo se conecta desde la misma IP: la de nginx**.

Consecuencia concreta: el limitador de intentos de login cuenta por IP
además de por usuario. Con todos compartiendo una sola IP, **ocho errores de
tipeo de cualquier persona dejan sin entrar a toda la empresa durante 15
minutos**.

El bloque mínimo correcto:

```nginx
location / {
    proxy_pass http://localhost:8011;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;  # <- el crítico
    proxy_set_header X-Forwarded-Proto $scheme;                     # <- para COOKIE_SECURE
}
```

`X-Forwarded-Proto` es igual de necesario: sin él, con `COOKIE_SECURE=true`
express-session no emite la cookie de sesión sobre lo que cree que es HTTP,
y **nadie puede iniciar sesión**.

**Cómo verificar que quedó bien**: la app se da cuenta sola. Si detecta
intentos de login llegando desde una IP privada sin `X-Forwarded-For`,
escribe una vez en el log:

```
[rate-limit] AVISO: llegan intentos de login desde 127.0.0.1 SIN X-Forwarded-For...
```

Si ese aviso **no** aparece en `docker logs gtc-dashboard` después de que
alguien entre, la configuración está correcta.

---

## Sin Docker (alternativa con Node directo)

```bash
cd dashboard
npm install --production
npm run seed
npm start
# o con pm2 para que sobreviva reinicios:
# pm2 start npm --name gtc-dashboard -- start
# pm2 save && pm2 startup
```

---

## Actualizaciones futuras

```bash
# Subir nueva versión del zip al servidor
cd /opt/dashboard
docker compose down
unzip -o ../dashboard.zip          # sobreescribe los archivos
docker compose build
docker compose up -d
```

El `.env` no se sobreescribe porque está en `.gitignore` y `.dockerignore`.
La BD se mantiene intacta.

---

## Solución de problemas

### `ER_UNKNOWN_COLLATION 'utf8mb4_0900_ai_ci'`

Servidor MariaDB no soporta esa collation (es exclusiva de MySQL 8).
La tabla `mp_dashboard_users` del seed ya usa `utf8mb4_general_ci` (compatible).
Si cargas `esquema_completo.sql` en MariaDB, primero:

```bash
sed -i 's/utf8mb4_0900_ai_ci/utf8mb4_general_ci/g' esquema_completo.sql
```

### El dashboard arranca pero las cards salen vacías

Verifica que el WF1 de n8n esté apuntando a la **misma BD** que el dashboard.
Las tablas operativas (`mp_task_facts`, `mp_indicators`) las llena el WF, no
el dashboard. Si están vacías, espera a que corra el WF.

### "No autenticado" después de login

Revisa el `SESSION_SECRET`. Si está vacío, las sesiones no persisten.
Asegúrate de regenerarlo y reiniciar el contenedor.

### El contenedor no llega al MySQL

Si MySQL está en el host (no en otro contenedor), usa
`DB_HOST=host.docker.internal`. Si es remoto, asegúrate de que la IP
desde donde sale el contenedor esté en la whitelist del servidor MySQL.

---

## Documentación adicional

- [`README.md`](README.md) — visión general del proyecto, arquitectura.
- [`docs/MANUAL_USUARIO.md`](docs/MANUAL_USUARIO.md) — para compartir con CEO/líderes.
- [`docs/MANUAL_TECNICO_INDICADORES.md`](docs/MANUAL_TECNICO_INDICADORES.md) — solo para Emily / mantenimiento.

---

Si algo falla, los logs siempre dicen la causa exacta:

```bash
docker compose logs -f dashboard
```
