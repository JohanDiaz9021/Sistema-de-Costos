# Manual técnico — automatizaciones de n8n

Cubre las dos automatizaciones que sostienen el módulo **Costeo**:

| # | Automatización | Qué produce |
|---|---|---|
| A | **Carga de horas** | La barra de ejecución de cada proyecto |
| B | **Alertas sin corregir** | El correo diario al CEO y a cada PM |

Las dos viven en el mismo workflow de n8n (**WF1**), cada una con su propio
Schedule Trigger, y las dos escriben en la misma base de datos que lee el
dashboard.

Última revisión: 22 de septiembre de 2026.

---

## 0. Antes de tocar nada

Tres cosas que han costado una corrida fallida cada una. Aplican a los dos
flujos.

**Los nombres de los nodos son código.** Varios nodos se buscan entre sí por
nombre exacto (`$('Generar contexto ejecución')`). Renombrar uno rompe la
corrida con `Referenced node doesn't exist`. Pasó el 22 sep 2026: al unir los
flujos se renombró un nodo a `Generar contexto ejecución (Costeo)` y el flujo
dejó de terminar.

**El nodo MySQL parte la consulta en cada `;`** y su separador se confunde con
comillas escapadas. Por eso ninguna sentencia lleva punto y coma final, y los
textos largos viajan en hexadecimal (`CONVERT(X'..' USING utf8mb4)`).

**El sandbox de los nodos Code no tiene `TextEncoder` ni `Buffer`.** Cualquier
conversión a bytes hay que escribirla a mano en JavaScript puro.

Y una cuarta, de operación: **un error sin manejar aborta la ejecución
completa**, incluidas las ramas que no tienen nada que ver. Por eso las dos
automatizaciones tienen triggers separados — así un 404 de SharePoint no se
come el correo de alertas del día.

---

## A. Carga de horas (barra de ejecución)

### A.1 Qué hace

Reemplaza la subida manual del Excel dentro de cada centro de costos. Cada
mañana lee los Excel de todas las personas en SharePoint y escribe en
`mp_costeo_task_facts`, que es de donde sale la **barra de ejecución** de cada
proyecto.

Primera corrida completa: 21 sep 2026 — 9 equipos, 24 personas, 11.260 tareas,
12.883 horas, verificado contra la base.

### A.2 Cadena de nodos

```
Trigger 6 AM diario
 → Iniciar run ................... MySQL
 → Chequear festivo ayer ......... MySQL
 → ¿Ayer fue festivo? ............ IF      (si sí, no se carga nada)
 → Generar contexto ejecución .... Code    01-generar-contexto.js
 → Obtener Drive ID .............. HTTP    Microsoft Graph
 → Guardar Drive ID .............. Code
 → Listar carpetas empleados ..... HTTP    una carpeta por persona
 → Cargar catálogo empleados ..... MySQL
 → Filtrar carpetas válidas ...... Code
 → Listar archivos por carpeta ... HTTP
 → Filtrar carpetas con archivo .. Code
 → Listar hojas del Excel ........ HTTP
 → Resolver hoja del mes ......... Code    01b-resolver-hojas-meses.js
 → Descargar hoja vía Graph ...... HTTP
 → Parsear todos los archivos .... Code    02-parsear-hojas.js
 → Cargar empleados .............. MySQL   Execute Once
 → Cargar centros ................ MySQL   Execute Once
 → Cargar equipo .................. MySQL   Execute Once   (23 sep 2026)
 → Resolver y filtrar ............ Code    03-resolver-y-filtrar.js
 → Construir SQL ................. Code    04-construir-sql.js
 → Guardar en Costeo ............. MySQL   Query: {{ $json.sql }}  (SIN Execute Once)
 → Limpiar cortes viejos ......... MySQL   05-limpiar-cortes-viejos.sql  Execute Once
```

Los tres nodos de lectura:

```sql
-- Cargar empleados
SELECT employee_id, canonical_name, aliases, project_folder, is_active FROM mp_employees

-- Cargar centros
SELECT cost_center_id, project_name, project_folder FROM mp_centro_costo

-- Cargar equipo
SELECT employee_id, cost_center_id FROM mp_equipo_proyecto WHERE is_active = 1
```

### A.3 Las reglas que decide el flujo

**Lee todas las pestañas de meses hasta el actual**, no solo la del mes en
curso. El motor toma el corte más reciente de cada pareja (persona, proyecto):
si la corrida de hoy trajera solo septiembre, los meses anteriores
desaparecerían de la barra. Pasó el 31 ago 2026 — un proyecto cayó de 143,5 h
a 4,7 h.

**El Excel leído es la verdad completa de esa persona.** A quien se le leyó el
archivo entero se le reemplaza todo lo del día, en todos sus proyectos. Si
quitó las horas de un proyecto, ese proyecto le queda en cero, y se borran sus
cortes viejos de ese proyecto para que el motor no los siga usando.

> Hasta el 22 sep 2026 el reemplazo era solo por pareja (persona, proyecto), y
> quitar un proyecto entero del Excel no lo borraba: un proyecto se quedó en
> 5% con filas de una corrida anterior.

**Si una hoja de alguien no llegó, a esa persona no se le toca nada** en esa
corrida, y conserva lo de la anterior. El 22 sep 2026 la hoja de agosto de una
persona no llegó mientras editaba el archivo en el navegador, y sí llegó
completa 7 minutos después; en ese rato esa persona perdió todo agosto.

**Persona sin ficha en `mp_employees`, o proyecto sin centro de costos: se
salta.** Queda anotada en el resumen de `Resolver y filtrar` y no frena a las
demás.

**`project_folder` = la carpeta de la persona**, igual que la carga manual.
Horas Semanales filtra por esa columna lo que ve cada PM.

### A.3.1 El desplegable "Proyecto" del Excel trae módulos, no proyectos

Desde el 23 sep 2026, SharePoint reorganizó la columna "Proyecto" del Excel:
ya no se elige el proyecto directo (`MIA`, `Transversales`...), sino uno de
**35 módulos**, con el formato `Módulo (Proyecto)` — `CRM (Transversales)`,
`Comunicaciones (Document Online)`, `Gestion financiera (MIA)`, etc.
`Management` es el único que se elige directo, sin módulo.

**No hizo falta cambiar código.** `centroParaProyecto()` (en
`03-resolver-y-filtrar.js`) ya resolvía este patrón desde el 21 sep 2026 con
una regla genérica —lee lo que hay entre paréntesis—, no con una lista fija.
Los 35 módulos se verificaron contra los centros reales de la base y todos
resuelven al proyecto correcto. Quedaron fijados como prueba de regresión en
`03-resolver-y-filtrar.test.js` ("los 35 módulos del desplegable nuevo..."):
si SharePoint reorganiza el desplegable otra vez, esa prueba avisa qué módulo
dejó de cuadrar.

El nombre del módulo no se pierde: la fila se guarda bajo el proyecto (para
que el motor la cobre), y el módulo queda al inicio de la actividad —
`[Gestion financiera] ACT-114 ...`. Catálogo completo de los 35 módulos:
`docs/n8n/wf-costeo/README.md`.

Dos decisiones separadas del 23 sep 2026, en dos archivos distintos, con
alcance distinto — fácil de confundir porque las dos hablan de "los
proyectos nuevos":

| Regla | Dónde vive | A quién afecta |
|---|---|---|
| A.3.2 Piso en agosto | `01b-resolver-hojas-meses.js`, por pestaña | Todos los proyectos |
| A.3.3 Exigir módulo | `03-resolver-y-filtrar.js`, por fila | Solo MIA/SESCOL/Document Online/Transversales |

### A.3.2 Piso en agosto 2026 (universal, todos los proyectos)

Mayo, junio y julio de 2026 ya no se leen **para nadie** — Management,
Sistema de costos, GTC Project, SUECO CRM, Talento Humano, Habilitadores, y
los 4 con módulo, todos por igual. Se filtra por **pestaña completa** en
`01b-resolver-hojas-meses.js` (`ANIO_MINIMO`/`MES_MINIMO`): esas hojas ni
se piden a Graph, así que esas filas nunca llegan a "Resolver y filtrar".

> **Se corrigió una vez el mismo día.** El primer intento aplicó el piso
> solo a los 4 proyectos con módulo, en `03-resolver-y-filtrar.js` — el
> usuario avisó que Management y Sistema de Costos también debían perder
> esos meses: *"tanto management y sistema de costo tambien se lee desde
> agosto"*. El piso es universal, no exclusivo de los 4.

> **Efecto real:** ~7.160 horas de mayo+junio+julio (675 h + 2.823 h +
> 3.664 h) desaparecen de la barra en la próxima corrida, en TODOS los
> proyectos.

### A.3.3 `MIA`, `SESCOL`, `Document Online` y `Transversales` ya no se aceptan pelados

Decisión separada, y esta sí es exclusiva de 4 proyectos: si ya solo se
eligen por módulo, una fila que diga el proyecto a secas ("MIA", sin el
módulo) es un resto del desplegable viejo — hay ~10.000 horas así cargadas,
hasta en septiembre. Se decidió **endurecer ya**: esas filas se descartan
(anotadas como `proyecto_requiere_modulo` en el resumen, no se pierden en
silencio) hasta que la persona reescriba su Excel con el módulo correcto.
`Management` (y cualquier otro proyecto) nunca pasa por esta regla —no está
en `REQUIERE_MODULO`— así que se sigue aceptando pelado sin importar el mes;
la única razón por la que pierde mayo/junio/julio es el piso de A.3.2, que
es universal, no esta.

> **Efecto real:** ~4.100 horas de agosto y septiembre (las que todavía no
> tienen módulo) dejan de sumar hasta que se corrija el Excel.

**Total combinado: ~11.260 horas que dejan de sumar en la próxima
corrida.**

### A.3.4 Equipo obligatorio: solo se lee a quien está registrado (todos los proyectos)

Tercera regla, y esta sí para **todos** los proyectos, no solo los 4 con
módulo. Decisión explícita del usuario, con ejemplo concreto: *"en Sistema
de costos solo esta Johan Sebastian Diaz... asi Thomas Medina tenga horas
en Sistema de costos no deben ser leidas a menos que el este registrado...
en Management a los 5 se les lee las horas porque los 5 estan
registrados"*.

Una fila solo se guarda si la persona está en el **Equipo del Proyecto**
(`mp_equipo_proyecto`, activo) de ese centro específico —
`(employee_id, cost_center_id)`. Si no, se descarta
(`empleado_no_registrado_en_equipo`), sin importar que el proyecto exista y
la persona tenga ficha.

Es **distinta** de lo que ya hacía `costo-motor.js`: ahí no estar en el
Equipo significaba "cuesta $0" pero la hora igual aparecía en la barra
(`LEFT JOIN`). Acá la fila no entra: ni horas ni plata, para ningún
proyecto. Requiere un nodo nuevo, `Cargar equipo` (ver A.2).

**Se puede correr varias veces el mismo día sin duplicar.** Nunca borra lo de
personas que esa corrida no leyó.

**Limpieza:** tras cada carga se borran cortes de más de 7 días, solo de
parejas (persona, proyecto) que recibieron corte nuevo hoy.

### A.4 De qué depende la plata

El costo de una hora = horas × la tarifa de esa persona **en el Equipo de ese
proyecto** (`mp_equipo_proyecto`). Es un `LEFT JOIN`: si la persona no está en
el Equipo del proyecto al que reporta, sus horas entran pero **cuestan $0**, y
salta la alerta "Talento sin costo/hora registrado".

Al 21 sep 2026 estaban en ese caso Management (1.940 de 2.212 tareas),
Transversales (637 de 642) y Talento Humano (todas).

### A.5 Cuándo se ve el cambio

Una edición del Excel pasa por tres esperas:

1. **Excel en el navegador guarda solo, pero tarda.** Esperar ~1 minuto
   después de editar antes de correr el flujo.
2. **La corrida tarda un par de minutos** con los 9 equipos.
3. **La caché de la app**: n8n escribe directo en la base, sin pasar por el
   servidor. El vigía `src/services/vigia-horas-externas.js` revisa cada 10 s
   si la tabla cambió y vacía la caché. Después, recargar la página.

Antes del vigía (21 sep 2026) la caché mostraba el valor viejo hasta 60 s, y
eso se veía como *"ejecuto y no sube; ejecuto otra vez y sí"*.

Ojo también con la escala: 10 h en un proyecto de $9.000.000 son ~1%, y la
barra redondea. Para una prueba, mirar el número **Ejecutado**, no la barra.

### A.6 Archivos del repo

Todos en `docs/n8n/wf-costeo/`:

| Archivo | Nodo |
|---|---|
| `00-revisar-festivo.sql` | Revisar festivo |
| `01-generar-contexto.js` | Generar contexto ejecución |
| `01b-resolver-hojas-meses.js` | Resolver hoja del mes |
| `02-parsear-hojas.js` | Parsear todos los archivos |
| `03-resolver-y-filtrar.js` | Resolver y filtrar |
| `04-construir-sql.js` | Construir SQL |
| `05-limpiar-cortes-viejos.sql` | Limpiar cortes viejos |

Pruebas (68, sin tocar la base):

```
node --test docs/n8n/wf-costeo/*.test.js
```

### A.7 Si algo falla

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `The resource you are requesting could not be found` (404) | Un equipo cambió de nombre en SharePoint | Actualizar la lista `EQUIPOS` en `Generar contexto ejecución` |
| `Referenced node doesn't exist` | Alguien renombró un nodo | Devolverle el nombre exacto |
| `You have an error in your SQL syntax` | Un texto se coló sin pasar a hexadecimal | Revisar `04-construir-sql.js` |
| Salen 564 items donde deberían ir 12 | Falta **Execute Once** en un MySQL de lectura | Encenderlo en Settings |
| `TextEncoder is not defined` | Se usó una API que el sandbox no tiene | Escribirlo en JS puro |

### A.8 Límite conocido

n8n no hace transacciones entre nodos. Si la corrida muere entre los `DELETE`
y los `INSERT`, las personas afectadas quedan con menos horas **ese día**,
hasta la corrida siguiente o hasta re-ejecutar a mano. No se pierde nada de
días anteriores.

---

## B. Alertas sin corregir

### B.1 El reparto, y por qué

```
   LA APP                                  N8N (WF1)
   ─────────────────────────────           ─────────────────────────────
   decide a quién, cuándo y qué      ───▶  mp_alerta_email_cola  ───▶  lo manda
   dice el correo                          (correo ya armado)          y lo marca
```

Las 22 reglas de alertas, el conteo de días y el armado del HTML ya viven en
la app y están probados. Repetirlos dentro de nodos Code habría significado
mantener dos versiones de la misma lógica, y la de n8n sin pruebas.

**n8n recibe el correo ya escrito y solo lo envía.**

El HTML viaja completo dentro de una columna, y no una URL ni un id que n8n
resuelva, por dos motivos: n8n no puede alcanzar la app por HTTP hoy, y una
alerta es la foto de un momento — si n8n reconstruyera el correo horas después
podría mandar números distintos a los que se decidió mandar. **Lo que se
encola es exactamente lo que se envía.**

### B.2 Cadena de nodos

```
Trigger 6 AM alertas
 → Leer correos pendientes ... MySQL   Execute Once
 → Enviar alertas ............ Send Email (SMTP Office365)
      ├── salida ok ────────→ Marcar enviado ... MySQL   Execute Once APAGADO
      └── salida error ─────→ Marcar fallido ... MySQL   Execute Once APAGADO
```

**Leer correos pendientes**

```sql
SELECT cola_id, destinatario, asunto, html, texto FROM mp_alerta_email_cola WHERE estado = 'pendiente' AND fecha = CURDATE() ORDER BY cola_id
```

`fecha = CURDATE()` a propósito: una alerta es de un día. Un pendiente que se
quedó de ayer no se manda tarde — el servicio lo marca `vencido`.

**Enviar alertas** (nodo *Send Email*, credencial SMTP de Office365):

| Campo | Valor | Modo |
|---|---|---|
| From Email | `<correo_remitente>` #colocar credenciales | Fixed |
| To Email | `{{ $json.destinatario }}` | **Expression** |
| Subject | `{{ $json.asunto }}` | **Expression** |
| Email Format | HTML | — |
| HTML | `{{ $json.html }}` | **Expression** |

En **Settings**, `On Error` = **Continue (using error output)**. Eso le da la
segunda salida. Con el `Continue` a secas, un correo que rebota seguía de
largo y quedaba marcado como enviado.

**Marcar enviado**

```
UPDATE mp_alerta_email_cola SET estado = 'enviado', enviado_at = NOW() WHERE cola_id = {{ $('Leer correos pendientes').item.json.cola_id }}
```

**Marcar fallido**

```
UPDATE mp_alerta_email_cola SET estado = 'fallido', error = '{{ String(($json.error && $json.error.message) || $json.error || "sin detalle").replace(/'/g, "''").slice(0, 400) }}' WHERE cola_id = {{ $('Leer correos pendientes').item.json.cola_id }}
```

El `.replace(/'/g, "''")` escapa las comillas simples del mensaje de error
para que no rompan la consulta.

> **No cambiar el nombre de `Leer correos pendientes`**: los dos nodos de
> marcar lo buscan por ese nombre exacto.

### B.3 La tabla `mp_alerta_email_cola`

Definida en `sql/43_alerta_email_cola.sql`.

| Columna | Tipo | Para qué |
|---|---|---|
| `cola_id` | INT PK | |
| `job` | VARCHAR(120) | `ceo` o `pm:correo@...` — cruza con el turno |
| `fecha` | DATE | El día al que pertenece |
| `destinatario` | VARCHAR(255) | |
| `asunto` | VARCHAR(255) | |
| `html` | MEDIUMTEXT | El correo completo. MEDIUMTEXT porque pasa de los 64 KB que aguanta TEXT |
| `texto` | MEDIUMTEXT | Versión plana |
| `alertas` | INT | Cuántas viajan |
| `estado` | ENUM | `pendiente` / `enviado` / `fallido` / `vencido` |
| `error` | VARCHAR(500) | El motivo, cuando falló |
| `creado_at`, `enviado_at` | DATETIME | |

Estados:

| Estado | Significa |
|---|---|
| `pendiente` | Encolado, n8n todavía no lo tomó |
| `enviado` | n8n lo mandó |
| `fallido` | El SMTP lo rechazó — el motivo está en `error` |
| `vencido` | Se encoló y nunca salió ese día |

La migración incluye además un `ALTER` que ensancha
`mp_alerta_email_envio.job` de VARCHAR(40) a 120: con 40 no cabe un job como
`pm:nombre_apellido_largo@empresa.com`, y un job cortado haría que dos
PMs distintos colisionaran y uno dejara de recibir su correo en silencio.

### B.4 Quién recibe qué

El escalamiento es por **días sin corregir**:

| Días abierta | Quién la ve |
|---|---|
| 0–2 | Nadie por correo (solo en el panel) |
| 3–4 | Recordatorio al PM del centro |
| 5 | Último aviso al PM — *"si no se corrige, mañana la ve el CEO"* |
| 6+ | Se le muestra también al CEO |

Es **la misma alerta**, que se vuelve más visible mientras más tiempo lleve
sin corregirse. No hay avisos que se manden aparte.

Los dos correos del día son complementarios y nunca se solapan:

- **CEO** (`ALERTAS_EMAIL_TO`): las de 6+ días.
- **Cada PM activo de `mp_project_owners`**: las de 3 a 5 días, solo de sus
  proyectos.

La lista de PMs sale de la base, no del `.env`: **dar de alta un PM en Accesos
basta para que empiece a recibir el suyo**, sin tocar código.

Al 22 sep 2026 son 5: César Arbeláez (14 proyectos), Mónica Bastidas (7),
Diego Chamorro, Jonathan Anaya y Jonathan Ariza (1 cada uno).

**Si alguien no tiene ninguna alerta sin corregir, no se le encola correo.** Un
"no hay nada" diario se deja de abrir, y entonces tampoco se abre el día que sí
trae algo.

### B.5 Por qué nadie recibe dos veces

El turno del día se reserva en `mp_alerta_email_envio` (`UNIQUE (job, fecha)`,
ver `sql/40`) **antes** de encolar nada, con las mismas funciones que usa el
envío por SMTP de la app. Los dos caminos comparten ese candado: el que llegue
primero se queda con el turno y el otro no hace nada.

El orden importa y no es casual:

1. Se reserva el turno. Si la base lo rechaza por duplicado, hoy ya salió.
2. Se arma y se encola.
3. Si encolar falla, se **borra** el turno para que la pasada siguiente
   reintente.

Al revés — encolar y después registrar — un fallo al registrar dejaría el
correo encolado y sin rastro, y la pasada siguiente lo encolaría de nuevo.

La cola **no** lleva llave única a propósito: la garantía es de la otra tabla,
y una llave aquí impediría reencolar un correo puntual a mano.

### B.6 Los correos van sin logo

A diferencia de los que manda la app, que lo llevan como adjunto `cid:`.

Por la cola no pasa nodemailer, así que no hay adjunto al que apuntar. El
reemplazo obvio —incrustarlo como data URI dentro del HTML— **se probó el 22
sep 2026 y no sirve**: Outlook bloquea las imágenes en base64 y en su lugar
pinta un cuadro roto con el texto alternativo. Y en Outlook es justo donde lo
leen los PMs y el CEO.

La otra salida era servirlo por URL, pero eso obliga a que el dashboard sea
alcanzable desde el computador de cada quien, y Outlook igual pide "descargar
imágenes" la primera vez. Se prefirió un correo que se vea bien siempre antes
que uno con logo a veces.

### B.7 Encenderlo

Está **apagado por defecto**. Encenderlo empieza a escribirle a PMs reales, y
eso lo decide una persona, no el arranque del contenedor.

1. Aplicar `sql/43_alerta_email_cola.sql`.
2. Poner `ALERTAS_COLA=1` en el `.env`. Si se quiere que el CEO también reciba
   el suyo, llenar `ALERTAS_EMAIL_TO` (hoy está vacío).
3. Reconstruir:
   ```
   docker compose build dashboard && docker compose up -d dashboard
   ```
4. En el log debe aparecer `[alertas-email-cola] activo`.

El servicio (`src/services/alertas-email-cola.js`) revisa cada hora a partir
de las 6, igual que el programador del correo por SMTP y por los mismos
motivos: un fallo puntual —la base remota sin conexiones libres— no se puede
comer el aviso del día, pero el reintento tampoco puede volverse una ráfaga.

### B.8 Probar sin escribirle a nadie

Encolar a mano un correo dirigido a uno mismo y ejecutar la rama:

```sql
INSERT INTO mp_alerta_email_cola (job, fecha, destinatario, asunto, html, texto, alertas)
VALUES ('prueba', CURDATE(), 'tu_correo@empresa.com', 'Prueba de la cola', '<p>Si ves esto, el envio por n8n funciona.</p>', 'prueba', 0)
```

Y revisar cómo quedó:

```sql
SELECT cola_id, job, destinatario, estado, alertas, enviado_at, error
  FROM mp_alerta_email_cola ORDER BY cola_id DESC LIMIT 10
```

Para probar con el HTML real, el correo lo tiene que armar la app — n8n no
puede generarlo.

> **Al probar nodos sueltos a mano, correrlos en orden.** Si se ejecuta
> `Marcar enviado` directamente, n8n reutiliza los datos guardados de la
> última vez que corrió `Leer correos pendientes` en vez de consultar la base,
> y manda lo viejo. En la corrida automática no pasa: arranca desde el trigger
> con datos frescos.

### B.9 Si algo falla

| Síntoma | Qué mirar |
|---|---|
| Sale "0 items" | Normal. No hay nada pendiente hoy |
| `estado = 'fallido'` | El motivo está en la columna `error` |
| `pendiente` viejo | El flujo no llegó hasta los nodos de correo |
| Llega el correo sin diseño | *Email Format* quedó en Text en vez de HTML |
| Llega a la dirección equivocada | *To Email* quedó en modo **Fixed** en vez de Expression |
| Nunca se encola nada | Falta `ALERTAS_COLA=1`, o el contenedor no se reconstruyó |

Los tres campos con expresión (**To Email**, **Subject**, **HTML**) tienen que
mostrar el cuadrito `fx` a la izquierda. *From Email* es el único que va sin
él. El toggle `Fixed | Expression` solo aparece mientras el mouse está encima
del campo, y es fácil voltear otro sin querer al moverse entre ellos.

### B.10 Archivos del repo

| Archivo | Qué es |
|---|---|
| `sql/43_alerta_email_cola.sql` | La tabla + el ALTER del job |
| `src/services/alertas-email-cola.js` | Llena la cola |
| `test/unit/alertas-email-cola.test.js` | 13 pruebas |
| `docs/n8n/alertas/README.md` | Guía de los nodos |
| `src/services/alertas-email.js` | Arma el correo (compartido con el envío por SMTP) |
| `sql/40_alerta_email_envio.sql` | El candado de "un correo por día" |

---

## C. Pendientes conocidos

**El sistema de correos propio de WF1 está roto.** Es la rama de la
planeación: `Construir correos líderes` → `Enviar correo líder`. SharePoint se
reorganizó de "una carpeta por proyecto" a "una carpeta por Equipo", así que
su `projectFolder` ya no identifica un proyecto y el enrutamiento por PM manda
información equivocada. **No activar esos correos hasta corregirlo.** El
arreglo es el mismo que ya tiene la carga de horas: leer el proyecto de la
columna "Proyecto" dentro del Excel, fila por fila, no de la carpeta (ver
`centroParaProyecto` en `03-resolver-y-filtrar.js`).

Esto **no** afecta a los nodos de alertas: no usan `projectFolder` ni nada de
SharePoint, solo la tabla.

**Cuatro personas quedaron en "Management" por suposición** (Diana Ximena
Duque Arévalo, Jhon David Caicedo, Johnny Díaz, José Armando Martínez
Villamizar), sin señal real de a qué proyecto pertenecen. Falta confirmarlo.

**Tarifas faltantes en Equipo del Proyecto.** Mientras no estén, esas horas
entran pero cuestan $0 y la barra muestra muchas horas y poca plata.

**El contador de días de las alertas arrancó de cero el 22 sep 2026**, cuando
se limpió la base para la entrega. Las primeras alertas por correo saldrían el
25 de septiembre (PMs) y el 28 (CEO).
