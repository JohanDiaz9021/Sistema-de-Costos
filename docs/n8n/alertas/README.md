# Alertas sin corregir — envío por n8n (WF1)

El correo de alertas sale por n8n, no por el SMTP de la app (pedido del
22 sep 2026: *"me dijeron que tiene que ser con n8n"*). WF1 ya tiene las
credenciales de Office365 y un nodo de envío que funciona, así que lo único
que se le agrega es leer una tabla, mandar y marcar.

## Cómo está repartido el trabajo

```
   LA APP                                  N8N (WF1)
   ─────────────────────────────           ─────────────────────────────
   decide a quién, cuándo y qué      ───▶  mp_alerta_email_cola  ───▶  lo manda
   dice el correo                          (correo ya armado)          y lo marca
```

Las 22 reglas de alertas, el conteo de días por tramo y el armado del HTML ya
viven en la app y están probados. Repetirlos dentro de nodos Code habría
significado mantener dos versiones de lo mismo, y la de n8n sin pruebas.
n8n recibe el correo **ya escrito** y solo lo envía.

Piezas del lado app:

- `sql/43_alerta_email_cola.sql` — la tabla.
- `src/services/alertas-email-cola.js` — la llena, cada hora a partir de las 6.
- `test/unit/alertas-email-cola.test.js` — 13 pruebas.

## Quién recibe

- **CEO** (`ALERTAS_EMAIL_TO`): lo que ya escaló, 6 días o más.
- **Cada PM activo de `mp_project_owners`**: su tramo, de 3 a 5 días, y solo
  de sus proyectos.

Los dos tramos son complementarios: una misma alerta nunca va en los dos
correos. La lista de PMs sale de la base, no del `.env`: dar de alta un PM en
Accesos basta para que empiece a recibir el suyo, sin tocar código.

Al 22 sep 2026 son 5: César Arbeláez (14 proyectos), Mónica Bastidas (7),
Diego Chamorro, Jonathan Anaya y Jonathan Ariza (1 cada uno).

**Si alguien no tiene ninguna alerta sin corregir, no se le encola correo.**
Un "no hay nada" diario se deja de abrir, y entonces tampoco se abre el día
que sí trae algo.

## Nadie recibe el correo dos veces

El turno del día se reserva en `mp_alerta_email_envio` (`UNIQUE (job, fecha)`,
ver `sql/40`) **antes** de encolar nada, con las mismas funciones que usa el
envío por SMTP. Los dos caminos comparten ese candado: el que llegue primero
se queda con el turno y el otro no hace nada. Por eso se pueden dejar los dos
encendidos sin que al CEO le lleguen dos correos.

La cola misma **no** lleva llave única a propósito: la garantía es de la otra
tabla, y una llave aquí impediría reencolar un correo a mano.

## Encenderlo

1. Aplicar la migración:
   ```
   mysql ... < sql/43_alerta_email_cola.sql
   ```
2. Poner `ALERTAS_COLA=1` en el `.env` y reconstruir el contenedor
   (`docker compose build dashboard && docker compose up -d dashboard`).
   Sin esa variable el servicio arranca apagado y no le manda correos a nadie
   — es deliberado: encenderlo empieza a escribirle a PMs reales.
3. Agregar los tres nodos de abajo a WF1.

En el log del contenedor tiene que aparecer `[alertas-email-cola] activo`.

## Los tres nodos en WF1

Se cuelgan del mismo Schedule Trigger que ya tiene WF1, al final de la cadena
(o de la rama que prefieras: no dependen de nada de SharePoint).

### 1. `Leer correos pendientes` — MySQL

Operación **Execute SQL**, credencial la que ya usa WF1, y **Execute Once
encendido** (si no, corre una vez por cada item que le llegue).

```sql
SELECT cola_id, destinatario, asunto, html, texto
  FROM mp_alerta_email_cola
 WHERE estado = 'pendiente' AND fecha = CURDATE()
 ORDER BY cola_id
```

`fecha = CURDATE()` a propósito: una alerta es la foto de un día. Si un
pendiente se quedó de ayer, no se manda tarde — el servicio lo marca
`vencido` al encolar los de hoy.

Si no hay nada pendiente devuelve 0 items y los nodos siguientes no corren.
Eso es lo normal los días sin alertas.

### 2. `Enviar alerta` — Microsoft Outlook / Send Email

El mismo nodo de envío que ya tiene WF1, con su credencial de Office365. Los
campos van en **Expression** (el botón de arriba de cada campo):

| Campo   | Valor                    |
|---------|--------------------------|
| To      | `{{ $json.destinatario }}` |
| Subject | `{{ $json.asunto }}`       |
| Message | `{{ $json.html }}`         |

El **Message** tiene que ir como **HTML**, no como texto plano, o llega el
código a la vista. **No hay que adjuntar nada.**

Estos correos van **sin logo**, a diferencia de los que manda la app. El
motivo: por la cola no pasa nodemailer, así que no hay adjunto al que apuntar
con `cid:`, y meterlo como data URI dentro del HTML no funciona — Outlook
bloquea las imágenes en base64 y pinta un cuadro roto con el texto
alternativo (probado el 22 sep 2026). Se prefirió un correo que se vea bien
siempre antes que uno con logo a veces.

En **Settings** de este nodo, encender **Continue On Fail**: si un correo
rebota (una dirección mal escrita), los demás igual salen.

### 3. `Marcar enviado` — MySQL

Operación **Execute SQL**, **Execute Once apagado** (tiene que correr una vez
por correo). En **Expression**:

```
UPDATE mp_alerta_email_cola SET estado = 'enviado', enviado_at = NOW() WHERE cola_id = {{ $('Leer correos pendientes').item.json.cola_id }}
```

Sin `;` al final: el nodo MySQL parte la consulta en cada punto y coma (misma
lección que WF-COSTEO, ver `docs/n8n/wf-costeo/README.md`).

## Para probar sin mandarle nada a nadie

Encolar a mano un correo de prueba dirigido a uno mismo y ejecutar WF1:

```sql
INSERT INTO mp_alerta_email_cola (job, fecha, destinatario, asunto, html, texto, alertas)
VALUES ('prueba', CURDATE(), 'tu_correo@empresa.com', 'Prueba de la cola', '<p>Si ves esto, el envio por n8n funciona.</p>', 'prueba', 0)
```

Revisar después cómo quedó:

```sql
SELECT cola_id, job, destinatario, estado, alertas, enviado_at, error
  FROM mp_alerta_email_cola ORDER BY cola_id DESC LIMIT 10
```

## Estados de la cola

| Estado      | Significa                                                    |
|-------------|--------------------------------------------------------------|
| `pendiente` | encolado, n8n todavía no lo tomó                              |
| `enviado`   | n8n lo mandó (queda `enviado_at`)                             |
| `fallido`   | n8n lo intentó y el SMTP lo rechazó (el motivo en `error`)    |
| `vencido`   | se encoló y nunca salió ese día; no se manda tarde            |

Si aparecen muchos `pendiente` viejos, WF1 no está llegando a estos nodos.
Si aparecen `fallido`, el problema es de Office365 y el motivo está en `error`.

## Ojo con esto

El sistema de correos **propio** de WF1 (el de la planeación, "Construir
correos líderes") está roto por otra razón: SharePoint se reorganizó por
Equipo y su `projectFolder` ya no identifica un proyecto
(ver `docs/n8n/wf-costeo/wf1-generar-contexto-corregido.js`). Eso **no**
afecta a estos tres nodos — no usan `projectFolder` ni nada de SharePoint,
solo la tabla — pero conviene no confundir un problema con el otro cuando se
revise WF1.
