# WF-COSTEO — carga automática de horas desde SharePoint

Reemplaza la subida manual del Excel (el botón dentro de cada centro de
costos). De lunes a viernes a las 7:00 a.m. lee los Excel de todas las
personas en SharePoint y escribe en `mp_costeo_task_facts`, de donde sale
la barra de ejecución de cada proyecto.

Primera corrida completa: 21 sep 2026 — 9 equipos, 24 personas, 11.260
tareas, 12.883 h, verificado en la base.

## Cadena de nodos

```
Schedule Trigger (cron 0 7 * * 1-5, zona America/Bogota)
 → Revisar festivo ............. MySQL   00-revisar-festivo.sql
 → Generar contexto ejecución .. Code    01-generar-contexto.js     (corta si es festivo)
 → Obtener Drive ID ─┐
 → Guardar Drive ID  │
 → Listar carpetas empleados     │ heredados del WF1, sin cambios:
 → Cargar catálogo empleados (early)   │ recorren SharePoint y bajan el Excel
 → Filtrar carpetas válidas      │
 → Listar archivos por carpeta   │
 → Filtrar carpetas con archivo  │
 → Listar hojas del Excel ───────┘
 → Resolver hoja del mes ....... Code    01b-resolver-hojas-meses.js
 → Descargar hoja vía Graph .... (heredado)
 → Parsear todos los archivos .. Code    02-parsear-hojas.js
 → Cargar empleados ............ MySQL   Execute Once
 → Cargar centros .............. MySQL   Execute Once
 → Cargar equipo ............... MySQL   Execute Once   (23 sep 2026)
 → Resolver y filtrar .......... Code    03-resolver-y-filtrar.js
 → Construir SQL ............... Code    04-construir-sql.js
 → Guardar en Costeo ........... MySQL   Query: {{ $json.sql }}   (SIN Execute Once)
 → Limpiar cortes viejos ....... MySQL   05-limpiar-cortes-viejos.sql  Execute Once
```

**Los nombres de los nodos importan:** el código los busca por nombre
exacto (`Resolver hoja del mes`, `Cargar empleados`, `Cargar centros`,
`Cargar equipo`, `Resolver y filtrar`, `Revisar festivo`, `Generar
contexto ejecución`).

SQL de los tres nodos de lectura:

```sql
-- Cargar empleados
SELECT employee_id, canonical_name, aliases, project_folder, is_active FROM mp_employees

-- Cargar centros
SELECT cost_center_id, project_name, project_folder FROM mp_centro_costo

-- Cargar equipo (sin filtrar por activo desde el 10 nov 2026)
SELECT employee_id, cost_center_id FROM mp_equipo_proyecto
```

> **10 nov 2026:** antes decía `WHERE is_active = 1`. Como el Excel leído
> reemplaza todo lo de la persona, inactivar a alguien hacía que la siguiente
> corrida le borrara sus horas de ese proyecto. Esas horas ya se pagaron y
> son costo del proyecto: un inactivo sigue cargando sus horas.

## Reglas que decide el flujo

- **Todas las pestañas de meses hasta el actual**, no solo la del mes. El
  motor toma el corte más reciente de cada persona y proyecto: si el de hoy
  trajera solo septiembre, los meses anteriores desaparecerían de la barra
  (pasó el 31 ago 2026: 143.5 h → 4.7 h).
- **Mismo parser que la carga manual.** Probado contra el real, y en datos
  reales las semanas presentes en los dos cortes coinciden al decimal.
- **El Excel leído es la verdad completa de esa persona.** A quien se le
  leyó el archivo entero se le reemplaza TODO lo del día, en todos los
  proyectos: si quitó las horas de un proyecto, ese proyecto le queda en
  cero (y se borran sus cortes viejos de ese proyecto, para que el motor
  no los siga usando). Hasta el 22 sep 2026 el reemplazo era solo por
  pareja (persona, proyecto), y quitar un proyecto entero del Excel no lo
  borraba: GTC Project se quedó en 5% con filas de una corrida anterior.
- **Si una hoja de su archivo no llegó** (error de SharePoint, o una
  respuesta sin datos), a esa persona **no se le toca nada** en esa
  corrida y conserva lo de la anterior. El 22 sep 2026 la hoja de Agosto
  de una persona no llegó mientras se editaba el archivo, y sí 7 minutos
  después; en ese rato esa persona perdió todo agosto en Costeo.
- Se puede correr varias veces el mismo día sin duplicar. Nunca borra lo
  de personas que la corrida no leyó.
- **Persona sin ficha o proyecto sin centro: se salta**, queda en el
  resumen de "Resolver y filtrar" y no frena a los demás.
- **`project_folder` = carpeta de la persona**, como la carga manual:
  Horas Semanales filtra por esa columna lo que ve cada PM.
- **Limpieza**: tras cada carga exitosa se borran cortes de más de 7 días,
  solo de pares (persona, proyecto) que recibieron corte nuevo hoy.

## El desplegable "Proyecto" del Excel: cada subproyecto es su propio centro

La columna "Proyecto" del Excel trae los **subproyectos** con el formato
`Nombre (Agrupador)` — `Notificaciones (Transversales)`, `Colaboradores y
terceros (Transversales)`, `Compras (MIA)`, `Basica (Sescol)`… — y algunos
sin paréntesis (`Management`, `CRM`, `Digno`).

**Desde el 6 nov 2026, cada subproyecto es su propio centro de costos**, con
su propio presupuesto. Lo que va entre paréntesis es solo una ayuda visual
para los PM en la planeación y **se ignora**: la fila va al centro que se
llama como el nombre de afuera.

```
Notificaciones (Transversales)            → centro "Notificaciones"
Colaboradores y terceros (Transversales)  → centro "Colaboradores y Terceros"
Contratación(MIA)                         → centro "Contratación"
Management                                → centro "Management"
```

`centroParaProyecto()` (en `03-resolver-y-filtrar.js`) busca en este orden:

1. El nombre **completo**, tal cual (sirve para `Management`, `CRM`, y para
   un centro cuya carpeta se llame literalmente `CRM (Transversales)`).
2. `EXCEPCIONES` (ej. `Habilitador` → `Habilitadores`).
3. El nombre de **afuera** del paréntesis.

Mayúsculas, tildes y espacios no importan (`normalizarTexto`). Si nada
cuadra, la fila se descarta como `proyecto_sin_centro` y queda en el resumen
con el nombre del Excel: **basta con crear ese centro en Costeo** para que la
siguiente corrida la cargue. Las horas se guardan siempre con el
`project_name` del centro, que es como las cruza el motor de costos.

Si algún día dos agrupadores tienen un subproyecto con el mismo nombre (ej.
`Talento Humano (MIA)` y `Talento Humano (Sescol)`), las dos irían al mismo
centro. Para separarlos, se crean los centros con el nombre completo (con
paréntesis): el paso 1 gana.

> **Antes (21 sep – 6 nov 2026) era al revés:** la fila iba al centro de lo
> de **adentro** del paréntesis (`Transversales`, `MIA`…), y `MIA`, `SESCOL`,
> `Document Online` y `Transversales` a secas se rechazaban por "requerir
> módulo" (`REQUIERE_MODULO`). Esos centros padre ya no existen, así que
> ninguna fila con paréntesis encontraba centro y Costeo quedó sin horas.
> Las dos reglas se retiraron el 6 nov 2026.

### Piso en septiembre 2026 (universal)

> **6 nov 2026:** el piso pasó de agosto a **septiembre 2026** (`MES_MINIMO = 9`): agosto y los meses anteriores ya no se leen. Lo de abajo describe cómo se decidió el piso original de agosto.


Mayo, junio y julio de 2026 **ya no se leen para nadie**. No importa el
proyecto: `Management`, `Sistema de costos`, `GTC Project`, `SUECO CRM`,
`Talento Humano`, `Habilitadores` — a todos se les
descartan esos tres meses por igual.

Se filtra por **pestaña completa** en `Resolver hoja del mes`
(`ANIO_MINIMO`/`MES_MINIMO`): la corrida ni siquiera pide esas hojas a
Graph, así que esas filas nunca llegan a "Resolver y filtrar".

> **Se corrigió una vez el mismo día.** El primer intento aplicó el piso
> solo a algunos proyectos (en `03-resolver-y-filtrar.js`, fila
> por fila) — el usuario avisó que eso dejaba a Management y Sistema de
> Costos leyendo mayo/junio/julio de más, y confirmó: *"tanto management y
> sistema de costo tambien se lee desde agosto"*. El piso es universal.

**Efecto real: ~7.160 horas de mayo+junio+julio (675 h + 2.823 h + 3.664 h)
desaparecen de la barra en la próxima corrida, en TODOS los proyectos.**

### Equipo obligatorio: solo se lee a quien está registrado (todos los proyectos)

Regla para **todos** los proyectos. Decisión explícita del usuario, con ejemplo concreto (23 sep 2026):
*"en Sistema de costos solo esta Johan Sebastian Diaz... asi Thomas Medina
tenga horas en Sistema de costos no deben ser leidas a menos que el este
registrado... en Management como tengo a 5 agregados a los 5 se les lee
las horas porque los 5 estan registrados"*.

Una fila solo se guarda si la persona está en el **Equipo del Proyecto**
(`mp_equipo_proyecto`, activo o inactivo) de ese centro específico. Si reportó horas a
un proyecto pero no está en su Equipo, esa fila se descarta —
`empleado_no_registrado_en_equipo` en el resumen— aunque el proyecto exista
y la persona tenga ficha.

Es **distinta** de la regla que ya tenía el motor de costos
(`costo-motor.js`): ahí no estar en el Equipo significaba "cuesta $0" pero
la hora igual aparecía en la barra (`LEFT JOIN`). Acá la fila directamente
no entra: ni horas ni plata, para ningún proyecto — la comparación es por
`(employee_id, cost_center_id)`, el mismo par que usa `mp_equipo_proyecto`.

Nodo nuevo: `Cargar equipo` (ver la cadena de nodos arriba). Sin este nodo,
`Resolver y filtrar` no encuentra a quién referencia y la corrida se
detiene con `Referenced node doesn't exist`.

## Cuándo se ve el cambio en Costeo

Una edición en el Excel pasa por tres esperas antes de verse en la barra:

1. **Excel en el navegador guarda solo**, pero tarda unos segundos. Si se
   corre el flujo justo después de editar, puede leer la versión anterior.
   Esperar ~1 minuto después de editar.
2. **La corrida de n8n** tarda un par de minutos con los 9 equipos. Hay que
   esperar a que termine (todo en verde) antes de mirar.
3. **La caché de la app**: n8n escribe directo en la base, sin pasar por el
   servidor. El vigía `src/services/vigia-horas-externas.js` revisa cada
   10 s si la tabla cambió y vacía la caché. Después, recargar la página.

Antes del vigía (21 sep 2026) la caché podía mostrar el valor viejo hasta
60 s, y eso se veía como "ejecuto y no sube; ejecuto otra vez y sí".

Ojo también con la escala: 10 h en un proyecto de $9.000.000 son ~1%, y la
barra redondea. Para una prueba, mirar el número **Ejecutado**, no la barra.

## La barra depende del Equipo

El costo de una hora = horas × tarifa de esa persona **en el Equipo de ese
proyecto** (`mp_equipo_proyecto`). Si la persona no está en el Equipo del
proyecto al que reporta, sus horas entran pero cuestan $0 y salta la
alerta "Talento sin costo/hora registrado". Al 21 sep 2026: Management
(1.940 de 2.212 tareas), Transversales (637 de 642) y Talento Humano
(todas) estaban en ese caso.

## Lecciones de n8n (cada una costó una corrida fallida)

- El nodo MySQL **parte la consulta en cada `;`** y su separador se
  confunde con comillas escapadas. Por eso los textos viajan en
  hexadecimal (`CONVERT(X'..' USING utf8mb4)`) y sin `;` final.
- El sandbox de los nodos Code **no tiene `TextEncoder` ni `Buffer`**.
  Las pruebas evalúan el código con ambos tapados.
- Un MySQL de solo lectura necesita **Execute Once**; si no, corre una vez
  por cada item que le llega.
- Si un equipo cambia de nombre en SharePoint, hay que actualizar la lista
  `EQUIPOS` en `01-generar-contexto.js`: un nombre inexistente da 404 y
  detiene la corrida.

## Pruebas

```
node --test docs/n8n/wf-costeo/01b-resolver-hojas-meses.test.js docs/n8n/wf-costeo/02-parsear-hojas.test.js docs/n8n/wf-costeo/03-resolver-y-filtrar.test.js docs/n8n/wf-costeo/04-construir-sql.test.js
```

## Límite conocido

n8n no hace transacciones entre nodos. Si la corrida muere entre los
DELETE y los INSERT, las personas afectadas quedan con menos horas **hoy**
hasta la corrida siguiente (o hasta re-ejecutarla a mano). No se pierde
nada de días anteriores.
