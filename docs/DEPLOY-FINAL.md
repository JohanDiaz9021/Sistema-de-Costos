# Despliegue final — Dashboard de Planeación + n8n WFs

Pasos de despliegue de **toda la última versión**, en orden. Estimado: 30–45 min si todo va bien.

---

## 0) Pre-flight checklist

- [ ] Tienes acceso SSH/RDP al server donde corre el dashboard.
- [ ] Tienes acceso al MariaDB stage (`<NOMBRE_BD>` #colocar credenciales) con permisos DDL.
- [ ] Tienes acceso a n8n (UI o JSON export/import).
- [ ] Tienes los GRAPH_* del WF1 para el bloque SharePoint (opcional, si vas a activarlo).
- [ ] El `.env` del servidor tiene un `SESSION_SECRET` **propio y aleatorio** (ver paso 0.1).
- [ ] `COOKIE_SECURE` coincide con cómo se sirve de verdad (ver paso 0.1).

### 0.1) Secretos del `.env` (revisar en CADA servidor)

`.env` no está en git (correcto), así que estos dos valores hay que
verificarlos a mano en cada máquina:

**`SESSION_SECRET`** — es con lo que se firman las cookies de sesión. Si
quedó el texto de ejemplo, o es el mismo que en otra máquina, se pueden
falsificar sesiones. Generar uno nuevo:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> Rotarlo **cierra la sesión de todo el mundo** (tienen que volver a entrar).
> Es el efecto esperado; hazlo en una ventana de bajo uso.

**`COOKIE_SECURE`** — decide si la cookie de sesión viaja solo por HTTPS (y de
paso activa HSTS, ver `server.js`):

| Cómo entran los usuarios | Valor |
|---|---|
| `https://…` detrás de nginx/caddy/cloudflare | `true` |
| `http://` plano (IP o LAN) | `false` |

> ⚠️ Poner `true` sirviendo por HTTP plano **bloquea el login de todos**: el
> navegador deja de mandar la cookie y nadie puede entrar. Si pasa, el
> rollback es cambiarlo a `false` y reiniciar.

---

## 1) Migraciones SQL

> **NO las corras a mano, una por una.** Esta guía antes decía "corre sql/03,
> 04 y 05 con `SOURCE`" y eso ya rompió producción **dos veces en el mismo
> día** (28 ago 2026): sql/28 dejó todas las pestañas en "Cargando…" y sql/26
> impidió registrar horas extra, en ambos casos porque el ALTER nunca se
> aplicó allá. Hoy son **35 migraciones**: aplicarlas de memoria garantiza
> que tarde o temprano se olvide alguna.

Desde la carpeta del proyecto, con el `.env` de ese servidor ya configurado:

```bash
# 1. SIMULACRO primero (no escribe nada): dice qué archivos correría.
npm run migrar

# 2. Aplicar de verdad.
npm run migrar:aplicar
```

Todas las migraciones son **idempotentes** a propósito (`CREATE TABLE IF NOT
EXISTS`, `INSERT IGNORE`, y los `ALTER` protegidos por un `SELECT` contra
`information_schema`). Correr el lote entero sobre una base que ya está al día
no hace nada — esa es justamente la propiedad que hace seguro ejecutarlo
**después de cada despliegue**, sin pensar en cuáles faltaban.

Salida esperada al final:

```
Listo. 35 archivo(s) aplicados, N con cambios.
```

Verifica que las últimas migraciones estén en la base:
```sql
SHOW COLUMNS FROM mp_equipo_proyecto LIKE 'planned_hours';   -- sql/35
SHOW COLUMNS FROM mp_equipo_proyecto LIKE 'monthly_salary';  -- sql/33
SHOW COLUMNS FROM mp_plan_recursos   LIKE 'employee_id';     -- sql/34
SHOW TABLES LIKE 'mp_costeo_task_facts';                     -- sql/32
```

El runner se niega solo a ejecutar archivos con `DROP` o `TRUNCATE`, así que
no puede borrar datos por accidente.

---

## 2) Backfill de tipo de contrato (opcional)

Por defecto todos quedan `planta`. Para marcar los de prestación de servicios:

```sql
UPDATE mp_employees
   SET contract_type = 'prestacion_servicios'
 WHERE canonical_name IN (
   'Juan Esteban …',
   '…'
 );
```

O házlo desde el CRUD del dashboard (Gestionar empleados → Editar).

---

## 3) Desplegar el dashboard

```bash
cd /ruta/al/dashboard
git pull        # o copy de la carpeta nueva
```

**Con Docker (es como corre hoy — ver `docker-compose.yml`, contenedor
`gtc-dashboard`):**

```bash
docker compose up -d --build     # reconstruye la imagen y reinicia
docker compose logs -f dashboard # para ver el arranque
```

**Sin Docker (si algún día se corre directo con Node):**

```bash
npm install     # solo si cambió package.json
pm2 restart gtc-dashboard        # si usa pm2
sudo systemctl restart gtc-dashboard  # o systemd
```

> El `.env` se lee **solo al arrancar**: cualquier cambio ahí (incluido
> `SESSION_SECRET` o `COOKIE_SECURE`) no aplica hasta reiniciar.

Verifica:
- `curl http://localhost:8011/healthz` → `{"status":"ok"}`
- Abre el dashboard con un usuario admin → debe aparecer el botón "Errores ingesta" y el form de empleados con el dropdown "Tipo de contrato".

---

## 4) Aplicar cambios en n8n

Sigue [`n8n-workflows-guide.md`](n8n-workflows-guide.md) paso a paso para WF1 y WF3.

Resumen rápido:
1. SQL ya está corrido (paso 1).
2. WF1: agregar guard de idempotencia + reemplazar parser por el multi-semana + switch + cierre de run.
3. WF3: agregar guard de idempotencia + ajustar schedule a sábados.

---

## 5) Pruebas end-to-end

Sigue la sección "Pruebas posteriores a la migración" del guide n8n. Las 9 pruebas son:

1. ✅ Archivo bien formado → procesado en `mp_task_facts`.
2. ✅ Archivo mal nombrado → registrado en `mp_validation_errors`.
3. ✅ Doble ejecución → la 2da queda `skipped`.
4. ✅ Día post-festivo → skip automático.
5. ✅ Permisos no penalizan en cumplimiento (#1).
6. ✅ Tipo contrato PS muestra badge en #8.
7. ✅ Heatmap diario #16 carga colores.
8. ✅ Auditoría fechas #17 detecta cambios.
9. ✅ Reconocimientos #18 muestra podium.

---

## 6) Bloque 5 SharePoint (cuando tengas credentials)

Cuando TI te dé las 3 variables, agrégalas al `.env` del dashboard:

```
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
SHAREPOINT_TEMPLATE_PATH=Planeación 2026/Plantillas/Template.xlsx
```

Y reinicia el dashboard. El botón "SharePoint" del CRUD de empleados ya está cableado.

Para el template (no existe canónico): copiamos el de un empleado existente, lo limpiamos vaciando celdas de datos (manteniendo formato/fórmulas), y lo guardamos como `Template.xlsx` en `Planeación 2026/Plantillas/`. Eso lo hacemos en la siguiente reunión.

---

## 7) Rollback plan

Si algo falla y necesitas regresar:

- **Dashboard**: `git revert` o restaurar la carpeta anterior. No tocó schema viejo.
- **SQL**: las migraciones son aditivas (`IF NOT EXISTS`). No hay rollback estricto necesario.
- **n8n**: exporta los WFs ANTES de modificar; si algo se rompe, importa el backup.

---

## 8) Indicadores nuevos en el dashboard (resumen)

| # | Título | Bloque | Visual |
|---|---|---|---|
| 16 | Actividad diaria por recurso | Bloque 9 | Heatmap Lun-Sáb |
| 17 | Auditoría cambios fecha estimada | Bloque 10 | Tabla wide |
| 18 | Reconocimientos del mes | Bloque 11 | Podium 🥇🥈🥉 + menciones |

Y los existentes que ahora excluyen permisos:
- #1 Cumplimiento semanal
- #8 Tabla por recurso

---

## 9) Datos de contacto / siguiente paso

Cuando termines el despliegue, valida con:
- **CEO**: muéstrale el podium #18 (es lo más visual).
- **Líderes**: muéstrales el #17 (auditoría) para que vean qué tareas se movieron.
- **TI**: el botón "Errores ingesta" cuando dispare alertas.

Pendientes para la siguiente iteración:
- Bloque 5 SharePoint (credentials + template).
- Posibles ajustes a indicadores nuevos según feedback.
- Posibles tooltips/explicaciones adicionales para el board.
