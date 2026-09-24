// ============================================================
//  WF-COSTEO — Nodo "Construir SQL" (n8n, tipo Code)
// ------------------------------------------------------------
//  Convierte las filas de "Resolver y filtrar" en las sentencias que
//  guarda el nodo MySQL siguiente ("Guardar en Costeo", cuyo Query es
//  solo  {{ $json.sql }} ). Sale un item por sentencia, EN ORDEN:
//
//    1. DELETE del día de las personas leídas COMPLETAS (todos sus
//       proyectos). El DELETE por (persona, centro) queda solo como
//       respaldo si "Resolver y filtrar" no manda la lista de completos.
//    2. Los INSERT, en lotes.
//    3. Limpieza de los proyectos que las personas completas YA NO
//       reportan (cortes de días anteriores).
//
//  Regla (22 sep 2026): el Excel leído es la verdad COMPLETA de esa
//  persona. Antes el reemplazo era solo por pareja (persona, proyecto), y
//  una pareja que desaparecía del Excel no disparaba ningún borrado: el
//  usuario quitó todas sus horas de GTC Project, volvió a correr, y el
//  proyecto siguió en 5% con las filas de la corrida anterior.
//
//  Quién es "completa" lo decide "Resolver y filtrar": alguien cuyo
//  archivo se leyó sin que fallara ninguna hoja. A quien le falló una hoja
//  "Resolver y filtrar" ni siquiera le manda filas: no se le borra ni se le
//  escribe nada, y conserva lo de la corrida anterior.
//
//  Nunca se borra "todo lo de hoy" sin filtro de persona: lo de alguien
//  que esta corrida no leyó (no está en el Excel, o su archivo no abrió) no
//  se toca.
//
//  LIMITACIÓN CONOCIDA: n8n no hace transacciones entre nodos. Si la
//  corrida muere entre el DELETE y el INSERT, esa persona queda con menos
//  horas HOY hasta la corrida siguiente. No se pierde nada de días
//  anteriores: el motor toma el corte más reciente de cada persona y
//  proyecto, los cortes viejos siguen en la tabla, y el paso 3 (que sí los
//  borra) va AL FINAL — si algo falló antes, n8n se detiene y no llega.
// ============================================================

const NOMBRE_NODO_FILAS = 'Resolver y filtrar';
const NOMBRE_NODO_CONTEXTO = 'Generar contexto ejecución';
const LOTE = 100; // en hexadecimal el texto ocupa el doble

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Mismas 22 columnas, en el mismo orden, que el INSERT de la carga manual.
const COLUMNAS = [
  'snapshot_date', 'employee_id', 'project_folder', 'month_name', 'month_number', 'year_number',
  'week_number', 'project_name', 'activity', 'planned_type', 'budgeted_hours',
  'estimated_delivery_date', 'actual_delivery_date',
  'hours_monday', 'hours_tuesday', 'hours_wednesday', 'hours_thursday', 'hours_friday', 'hours_saturday',
  'total_executed_hours', 'task_status', 'observations',
];

// ---- Textos: viajan en HEXADECIMAL ----
//
// El texto viene de un Excel que llena la gente a mano (actividades,
// observaciones): trae comillas, barras, saltos de línea y punto y coma.
//
// La primera versión los escapaba como mysql.escape() ('O\'Brien'). Era
// SQL válido, pero falló de verdad (21 sep 2026, primera corrida con los
// 9 equipos): el nodo MySQL de n8n PARTE la consulta en cada ";" antes de
// mandarla, y su separador se confunde con las comillas escapadas. Una
// actividad con un apóstrofo y un ";" cortaba el INSERT a la mitad
// ("You have an error in your SQL syntax ... near 'P', 0.25, ...").
//
// En hexadecimal (X'...' convertido a utf8mb4) el valor no lleva comillas,
// ni ";", ni barras, ni llaves ni "$": no queda nada que n8n ni MariaDB
// puedan interpretar, traiga lo que traiga el Excel. De paso cierra la
// puerta a inyección SQL: el contenido nunca se lee como código.
function sqlTexto(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  if (s === '') return "''";
  return `CONVERT(X'${utf8Hex(s)}' USING utf8mb4)`;
}

// Texto -> bytes UTF-8 en hexadecimal, escrito a mano a propósito: el
// sandbox de los nodos Code de n8n NO tiene TextEncoder (falló así el 21
// sep 2026: "TextEncoder is not defined") y tampoco se puede contar con
// Buffer. Esto solo usa JavaScript puro.
function utf8Hex(s) {
  let out = '';
  for (const ch of s) { // for...of recorre por caracter real, emojis incluidos
    let cp = ch.codePointAt(0);
    // Media pareja suelta de un emoji (texto dañado): se guarda como el
    // caracter de reemplazo, igual que haría cualquier codificador UTF-8.
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
    let bytes;
    if (cp < 0x80) bytes = [cp];
    else if (cp < 0x800) bytes = [0xC0 | (cp >> 6), 0x80 | (cp & 63)];
    else if (cp < 0x10000) bytes = [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    else bytes = [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
  }
  return out;
}

// Un número que no sea finito entra como NULL, nunca como texto: así un
// valor raro del Excel no puede colarse sin comillas en la sentencia.
function sqlNumero(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

// Solo acepta YYYY-MM-DD real; cualquier otra cosa es NULL.
function sqlFecha(v) {
  if (!v) return 'NULL';
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `'${s}'` : 'NULL';
}

/**
 * Arma las sentencias. Pura (sin nada de n8n) para poder probarla.
 *
 * @param filas         salida de "Resolver y filtrar" (sin el item resumen)
 * @param snapshotDate  'YYYY-MM-DD', fecha de HOY en Colombia
 * @param centros       Map cost_center_id -> { project_name, project_folder }
 * @param opciones.empleadosCompletos  employee_id de las personas cuyo Excel
 *        se leyó entero (resumen de "Resolver y filtrar"). Sin esta lista se
 *        comporta como antes: reemplazo solo por pareja.
 */
function construirSentencias(filas, snapshotDate, centros, { empleadosCompletos = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshotDate))) {
    throw new Error(`snapshotDate inválida: ${snapshotDate}`);
  }
  const [anioCorte, mesCorte] = snapshotDate.split('-').map(Number);
  const sentencias = [];
  const fecha = sqlFecha(snapshotDate);

  // Solo ids numéricos válidos: esta lista termina dentro de un IN (...).
  const completos = [...new Set(empleadosCompletos.map(sqlNumero).filter((v) => v !== 'NULL'))];
  const esCompleto = new Set(completos);

  // ---- 1a. DELETE del día de las personas completas (todos sus proyectos) ----
  //
  // Incluye a quien ya no tiene NINGUNA fila en esta corrida (quitó todo lo
  // de proyectos con centro): también tiene que quedar en cero.
  if (completos.length) {
    sentencias.push({
      tipo: 'delete',
      sql: `DELETE FROM mp_costeo_task_facts WHERE snapshot_date = ${fecha}`
        + ` AND employee_id IN (${completos.join(', ')})`,
    });
  }

  // ---- 1b. DELETE por (persona, centro) de quien NO está en la lista ----
  //
  // Respaldo: con la lista de completos no le llega ninguna fila de otra
  // persona (las incompletas se filtran antes, en "Resolver y filtrar").
  //
  // Se borra por TODOS los nombres con que ese centro puede aparecer en
  // project_name (su nombre, su carpeta, y lo que venga escrito en el
  // Excel), igual que la carga manual borra por project_name o
  // project_folder del centro.
  const grupos = new Map();
  for (const f of filas) {
    if (esCompleto.has(sqlNumero(f.employee_id))) continue; // ya cubierta por 1a
    const clave = `${f.employee_id}|${f.cost_center_id}`;
    if (!grupos.has(clave)) {
      const c = centros.get(Number(f.cost_center_id)) || {};
      grupos.set(clave, {
        employee_id: f.employee_id,
        nombres: new Set([c.project_name, c.project_folder].filter(Boolean)),
      });
    }
    if (f.project_name) grupos.get(clave).nombres.add(f.project_name);
  }
  for (const g of grupos.values()) {
    const nombres = [...g.nombres].map(sqlTexto).join(', ');
    sentencias.push({
      tipo: 'delete',
      sql: `DELETE FROM mp_costeo_task_facts WHERE employee_id = ${sqlNumero(g.employee_id)}`
        // Sin ";" final: al separador de n8n no le queda nada que partir.
        + ` AND snapshot_date = ${fecha} AND project_name IN (${nombres})`,
    });
  }

  // ---- 2. INSERT en lotes ----
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const valores = lote.map((f) => {
      // Mismo relleno que la carga manual cuando la fila no trae fecha:
      // el mes y el año del corte.
      const mes = Number(f.month_number) || mesCorte;
      const anio = Number(f.year_number) || anioCorte;
      return `(${[
        sqlFecha(snapshotDate),
        sqlNumero(f.employee_id),
        sqlTexto(f.project_folder),
        sqlTexto(MESES[mes - 1] || null),
        sqlNumero(mes),
        sqlNumero(anio),
        sqlNumero(f.week_number),
        sqlTexto(f.project_name),
        sqlTexto(f.activity),
        sqlTexto(f.planned_type),
        sqlNumero(f.budgeted_hours),
        sqlFecha(f.estimated_delivery_date),
        sqlFecha(f.actual_delivery_date),
        sqlNumero(f.hours_monday ?? 0),
        sqlNumero(f.hours_tuesday ?? 0),
        sqlNumero(f.hours_wednesday ?? 0),
        sqlNumero(f.hours_thursday ?? 0),
        sqlNumero(f.hours_friday ?? 0),
        sqlNumero(f.hours_saturday ?? 0),
        sqlNumero(f.total_executed_hours ?? 0),
        sqlTexto(f.task_status),
        sqlTexto(f.observations),
      ].join(', ')})`;
    });
    sentencias.push({
      tipo: 'insert',
      filas: lote.length,
      sql: `INSERT INTO mp_costeo_task_facts (${COLUMNAS.join(', ')}) VALUES ${valores.join(', ')}`,
    });
  }

  // ---- 3. Proyectos que las personas completas ya no reportan ----
  //
  // El paso 1a limpia HOY, pero el motor busca el corte más reciente de
  // cada (persona, proyecto): si la persona dejó de reportar un proyecto,
  // encontraría un corte de otro día y lo seguiría cobrando. Aquí se
  // borran los cortes anteriores de las parejas que hoy ya no existen.
  //
  // Las parejas que sí existen hoy conservan su historia (la purga el nodo
  // "Limpiar cortes viejos" a los 7 días). Y esto va DESPUÉS de los INSERT:
  // si alguno falla, n8n se detiene aquí y los cortes viejos quedan como
  // respaldo.
  if (completos.length) {
    sentencias.push({
      tipo: 'limpieza',
      sql: 'DELETE t FROM mp_costeo_task_facts t'
        + ' LEFT JOIN (SELECT DISTINCT employee_id, project_name FROM mp_costeo_task_facts'
        + ` WHERE snapshot_date = ${fecha}) hoy`
        + ' ON hoy.employee_id = t.employee_id AND hoy.project_name = t.project_name'
        + ` WHERE t.snapshot_date < ${fecha} AND t.employee_id IN (${completos.join(', ')})`
        + ' AND hoy.employee_id IS NULL',
    });
  }

  return sentencias;
}

// ---- n8n ----
const snapshotDate = $(NOMBRE_NODO_CONTEXTO).first().json.snapshotDate;
const centros = new Map(
  $('Cargar centros').all().map((i) => [Number(i.json.cost_center_id), i.json])
);
const items = $(NOMBRE_NODO_FILAS).all().map((i) => i.json);
const resumen = items.find((j) => j.resumen) || {};
const filas = items.filter((j) => !j.resumen); // el último item es el resumen, no una fila

const sentencias = construirSentencias(filas, snapshotDate, centros, {
  empleadosCompletos: resumen.empleados_completos || [],
});
const cuenta = (tipo) => sentencias.filter((s) => s.tipo === tipo).length;
console.log(`🧱 ${cuenta('delete')} DELETE, ${cuenta('insert')} INSERT y ${cuenta('limpieza')} limpieza `
  + `para ${filas.length} fila(s) de ${(resumen.empleados_completos || []).length} persona(s) completas, corte ${snapshotDate}`);

return sentencias.map((s) => ({ json: s }));

// Exportado solo para la prueba local (04-construir-sql.test.js).
module.exports = { construirSentencias, sqlTexto, sqlNumero, sqlFecha };
