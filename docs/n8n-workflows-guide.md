# Guía de modificaciones a los workflows n8n

Esta guía consolida **TODOS** los cambios que hay que aplicar en n8n para que
el dashboard nuevo funcione end-to-end. Léela una vez completa, luego ataca
WF por WF.

> Hay 3 workflows: **WF1** (diario, parsing de Excels), **WF2** (procesamiento intermedio si existe — no se modifica salvo cambios menores), **WF3** (sábados, resumen semanal).

---

## 📋 Pre-requisitos (correr UNA vez)

Antes de tocar n8n, asegúrate de haber corrido en la BD MariaDB de stage estos 5 SQL:

```bash
# #colocar credenciales
mysql -h <DB_HOST> -u <DB_USER> -p <DB_NAME> < sql/03_ingestion_and_validation.sql
mysql -h <DB_HOST> -u <DB_USER> -p <DB_NAME> < sql/04_employee_contract_type.sql
mysql -h <DB_HOST> -u <DB_USER> -p <DB_NAME> < sql/05_daily_hours_columns.sql
```

Verifica:
```sql
SHOW TABLES LIKE 'mp_validation_errors';   -- debe existir
SHOW TABLES LIKE 'mp_ingestion_runs';      -- debe existir
SHOW COLUMNS FROM mp_employees LIKE 'contract_type';  -- debe existir
SHOW COLUMNS FROM mp_task_facts LIKE 'hours_%';       -- debe existir (hours_monday..hours_saturday)
```

---

## 🔵 WF1 — Diario (Mar a Sáb)

**Cambios:**

### 1. Schedule
- Cron: `0 0 8 * * 2-6` (lunes=1, martes=2 ... sábado=6). Corre 8:00 AM Mar-Sáb.

### 2. Nuevo primer nodo: Guard de idempotencia + festivos
Inserta como **PRIMER nodo Function** del WF (justo después del trigger):
- Pega el contenido de [`docs/n8n-idempotency-guard.js`](n8n-idempotency-guard.js).
- Antes del Function, agrega un nodo **Set** que establezca `item.json.workflowName = 'WF1'` y `item.json.triggeredBy = 'cron'`.
- Después del Function, agrega un nodo **IF** que rute según `{{ $json.shouldRun }}`:
  - `true` → sigue al flujo normal del WF
  - `false` → un nodo HTTP/Slack/Email opcional que avise el motivo (`{{ $json.skipReason }}`), y termina

### 3. Reemplazar el parser de Excel
Hoy WF1 probablemente lee 1 sola sección por hoja. **Reemplaza ese nodo Function** por:
- Pega el contenido de [`docs/n8n-wf1-parser.js`](n8n-wf1-parser.js).
- Entrada esperada por item:
  - `filename` (string)
  - `sheetName` (string, ej. "Junio")
  - `rows` (array de arrays, la matriz cruda de la hoja)
  - `snapshotDate` (opcional, default hoy)
- Salida: N items con `_kind: 'fact'` (filas para `mp_task_facts`) o `_kind: 'validation_error'`.

### 4. Switch + 2 inserts
Después del parser, un nodo **Switch** por `{{ $json._kind }}`:
- `fact` → MySQL INSERT INTO `mp_task_facts` (campos según el JSON del item)
- `validation_error` → MySQL INSERT INTO `mp_validation_errors`

### 5. Cierre del run
Como **último nodo del WF** (después de los inserts), un Function con:
```js
const stats = items.reduce((acc, it) => {
  if (it.json._kind === 'fact') acc.rows_inserted++;
  if (it.json._kind === 'validation_error') acc.files_rejected++;
  return acc;
}, { rows_inserted: 0, files_rejected: 0, files_processed: 0 });
return [{ json: { ...stats, runId: $node["idempotency_guard"].json.runId } }];
```
Después, un MySQL:
```sql
UPDATE mp_ingestion_runs
   SET status = 'completed',
       completed_at = NOW(),
       files_processed = ?,
       files_rejected  = ?,
       rows_inserted   = ?
 WHERE run_id = ?;
```

### 6. Manejo de errores
- Activa el **Error Trigger** del WF.
- En el catch, UPDATE el `mp_ingestion_runs` correspondiente con `status='failed'`.

---

## 🟢 WF3 — Semanal (Sáb)

**Cambios:**

### 1. Schedule
- Cron: `0 0 9 * * 6` (sábados 9:00 AM).

### 2. Mismo guard de idempotencia
Repite los pasos 1-2 de WF1 pero con `workflowName = 'WF3'`. El guard del Function ya distingue: para WF3 solo permite sábado (día 6) y no chequea festivos del día anterior.

### 3. Lógica de WF3
(Si WF3 es generación de reportes, resúmenes, alertas, etc. — sigue su lógica actual.)

### 4. Cierre del run
Mismo patrón que WF1.

---

## 🟡 WF2 (opcional)

Si tienes un WF2 intermedio, aplícale solo el **guard de idempotencia** con su propio `workflowName='WF2'` y su propio cron. No requiere cambios de parsing.

---

## 🧪 Pruebas posteriores a la migración

Una vez todo desplegado:

1. **Validar un archivo bien formado**: subir a SharePoint `2026_1003713754_Emily_Tench.xlsx`. Esperar trigger de WF1. Verificar:
   - `mp_ingestion_runs` tiene una fila con `status='completed'`.
   - `mp_task_facts` tiene filas para todas las semanas del archivo (no solo 1).
   - Las columnas `hours_monday..hours_saturday` están pobladas.

2. **Validar un archivo mal nombrado**: subir `mi-archivo.xlsx`. Esperar trigger. Verificar:
   - `mp_validation_errors` tiene una fila con `error_type='filename_pattern'`.
   - `mp_task_facts` no recibió filas de ese archivo.
   - El dashboard (botón "Errores ingesta" para admin) muestra el rechazo con badge incrementado.

3. **Validar doble ejecución**: dispara manualmente WF1 dos veces seguidas. Verificar:
   - La 2da corrida termina inmediatamente con `status='skipped'`, `skip_reason='WF1 ya tiene una corrida hoy...'`
   - `mp_task_facts` no se duplica.

4. **Validar tras festivo**: con `mp_holidays` que tenga el día anterior, dispara WF1 hoy. Verificar:
   - `status='skipped'`, `skip_reason='Ayer (...) fue festivo...'`.

5. **Validar permisos en cumplimiento**: ingestar un Excel con una tarea "Permiso aprobado" 8h ejecutadas. Mirar el indicador #1 (cumplimiento semanal) — esas 8h NO deben aparecer en numerador ni denominador.

6. **Validar tipo contrato**: marcar un empleado como `prestacion_servicios` desde el CRUD. En el indicador #8 (tabla recurso), su nombre debe llevar pill PS.

7. **Validar #16 (heatmap diario)**: que aparezca color cuando hay horas, gris cuando no.

8. **Validar #17 (auditoría fechas)**: si una tarea cambia su `estimated_delivery_date` entre 2 snapshots, debe salir en la tabla con días movidos.

9. **Validar #18 (reconocimientos)**: si hay al menos 1 recurso con ≥3 tareas y cumplimiento alto, aparece en podium.

---

## 🗂️ Resumen de archivos generados por el dashboard

| Archivo | Propósito |
|---|---|
| `sql/03_ingestion_and_validation.sql` | Tablas `mp_validation_errors` y `mp_ingestion_runs` |
| `sql/04_employee_contract_type.sql` | Columna `contract_type` |
| `sql/05_daily_hours_columns.sql` | Registro de decisión: `h_mon..h_sat` desistido; horas diarias en `hours_monday..hours_saturday` |
| `docs/n8n-wf1-parser.js` | Parser multi-semana + validador filename para WF1 |
| `docs/n8n-idempotency-guard.js` | Guard de idempotencia/festivos para los 3 WFs |
| `docs/n8n-workflows-guide.md` | Este documento |
