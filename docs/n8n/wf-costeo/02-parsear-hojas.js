// ============================================================
//  WF-COSTEO — Nodo "Parsear hojas" (n8n, tipo Code)
// ------------------------------------------------------------
//  Portado de src/queries/costo-task-facts-upload.js (parsearFilas),
//  que es el parser que ya se usa en la carga manual y esta probado en
//  test/unit/costo-task-facts-upload-puro.test.js. Mismas reglas, para
//  que el automatico y el manual den EXACTAMENTE los mismos numeros.
//
//  ENTRADA: un item por hoja, con la forma que deja el nodo de Graph
//  "usedRange":
//    {
//      equipo:  'Equipo 1 - Juan Carlos Diaz',
//      persona: 'Cristina DeWolfe',        <- nombre de la CARPETA
//      archivo: '2026_1143963601_CRISTINA_DEWOLFE.xlsx',
//      hoja:    'Septiembre',
//      values:  [[fila1...], [fila2...], ...]   <- usedRange.values
//    }
//
//  SALIDA: un item por fila de datos, lista para resolver empleado.
//  Las hojas sin encabezado "Proyecto" (Datos, Control de Cambios) se
//  saltan solas, igual que en la carga manual.
// ============================================================

// Compara texto de un Excel llenado a mano: quita todo lo que no sea letra
// o numero (tildes incluidas via NFKD) y baja a minusculas. Nacio por los
// encabezados con filtro de Excel activado, que traen el texto pegado a un
// icono ("[v] Proyecto" en vez de "Proyecto").
function normalizarTexto(v) {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// El archivo real apila un bloque por semana, asi que el encabezado puede
// quedar bastante abajo. Mismo tope que la carga manual.
const MAX_FILA_ENCABEZADO = 200;

// Graph devuelve las fechas como numero de serie de Excel. El origen es
// 1899-12-30 por el bug del año bisiesto de 1900 que Excel arrastra.
function comoFecha(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v <= 0) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Para MySQL: 'YYYY-MM-DD' o null.
function comoFechaSQL(v) {
  const d = comoFecha(v);
  return d ? d.toISOString().slice(0, 10) : null;
}

function comoNumero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Encuentra la fila de encabezados por TEXTO, no por posicion: el template
// agrupa secciones arriba y trae un subtitulo en cursiva debajo, asi que la
// columna exacta de cada campo no es estable entre archivos.
function localizarEncabezados(values) {
  const tope = Math.min(values.length, MAX_FILA_ENCABEZADO);
  for (let r = 0; r < tope; r++) {
    const fila = values[r] || [];
    const tieneProyecto = fila.some((v) => normalizarTexto(v) === 'proyecto');
    if (!tieneProyecto) continue;

    const col = (nombre) => {
      const objetivo = normalizarTexto(nombre);
      const i = fila.findIndex((v) => normalizarTexto(v) === objetivo);
      return i === -1 ? null : i;
    };
    const colLunes = col('L');
    return {
      filaEncabezado: r,
      semana: col('Semana'),
      proyecto: col('Proyecto'),
      actividad: col('Actividad'),
      pnp: col('P/NP'),
      horasPresupuestadas: col('Horas Presupuestadas'),
      fechaEstimada: col('Fecha Estimada de Entrega'),
      fechaEntrega: col('Fecha Entrega'),
      // L,M,X,J,V,S son 6 columnas contiguas despues de "L" — mas confiable
      // que buscar "M", que choca con nombres de mes.
      lunes: colLunes,
      martes: colLunes === null ? null : colLunes + 1,
      miercoles: colLunes === null ? null : colLunes + 2,
      jueves: colLunes === null ? null : colLunes + 3,
      viernes: colLunes === null ? null : colLunes + 4,
      sabado: colLunes === null ? null : colLunes + 5,
      tt: col('TT'),
      estado: col('Estado'),
      observaciones: col('Observaciones'),
    };
  }
  return null;
}

function celda(fila, col) {
  if (col === null || col === undefined) return null;
  const v = fila[col];
  return v === undefined ? null : v;
}

function parsearHoja(values) {
  const enc = localizarEncabezados(values);
  if (!enc) return []; // hoja auxiliar (Datos, Control de Cambios) o vacia

  const filas = [];
  for (let r = enc.filaEncabezado + 1; r < values.length; r++) {
    const fila = values[r] || [];
    const proyecto = String(celda(fila, enc.proyecto) ?? '').trim();
    const semanaRaw = celda(fila, enc.semana);

    // La fila justo debajo del encabezado es el subtitulo en cursiva
    // ("Elige proyecto", "N° semana"), no un dato: se detecta porque
    // "Semana" no es un numero ahi.
    //
    // El chequeo de enc.semana != null NO es redundante: si la hoja no
    // tiene columna "Semana" (hojas de referencia que si tienen una
    // columna "Proyecto"), celda() devuelve null para toda fila y
    // Number(null) da 0 — finito — asi que sin esto esas hojas se
    // leerian como datos validos.
    if (!proyecto || enc.semana === null || semanaRaw === null || semanaRaw === ''
        || !Number.isFinite(Number(semanaRaw))) continue;

    const fEstimada = comoFecha(celda(fila, enc.fechaEstimada));
    const fEntrega = comoFecha(celda(fila, enc.fechaEntrega));

    filas.push({
      week_number: comoNumero(semanaRaw),
      project_name: proyecto,
      activity: String(celda(fila, enc.actividad) ?? '').trim() || null,
      planned_type: (String(celda(fila, enc.pnp) ?? '').trim().toUpperCase() === 'NP') ? 'NP' : 'P',
      budgeted_hours: comoNumero(celda(fila, enc.horasPresupuestadas)),
      estimated_delivery_date: comoFechaSQL(celda(fila, enc.fechaEstimada)),
      actual_delivery_date: comoFechaSQL(celda(fila, enc.fechaEntrega)),
      hours_monday: comoNumero(celda(fila, enc.lunes)),
      hours_tuesday: comoNumero(celda(fila, enc.martes)),
      hours_wednesday: comoNumero(celda(fila, enc.miercoles)),
      hours_thursday: comoNumero(celda(fila, enc.jueves)),
      hours_friday: comoNumero(celda(fila, enc.viernes)),
      hours_saturday: comoNumero(celda(fila, enc.sabado)),
      total_executed_hours: comoNumero(celda(fila, enc.tt)),
      task_status: String(celda(fila, enc.estado) ?? '').trim() || null,
      observations: String(celda(fila, enc.observaciones) ?? '').trim() || null,
      // Igual que la carga manual: el mes sale de la fecha de la FILA, no
      // del nombre de la hoja — una semana puede arrancar a fin de mes y
      // vivir en la pestaña del mes siguiente.
      month_number: fEstimada ? fEstimada.getUTCMonth() + 1 : (fEntrega ? fEntrega.getUTCMonth() + 1 : null),
      year_number: fEstimada ? fEstimada.getUTCFullYear() : (fEntrega ? fEntrega.getUTCFullYear() : null),
    });
  }
  return filas;
}

// ---- n8n: recorre los items (una hoja cada uno) ----
//
// Mismo contrato que "Parsear todos los archivos" del WF1 (v18): cada item
// que llega es la RESPUESTA de Graph para una hoja ({ values: [[...]] } o
// { error: {...} }), y los datos del archivo (carpeta, nombre, hoja) NO
// vienen ahi sino en el item emparejado del nodo "Resolver hoja del mes".
// Por eso ese nodo conserva su nombre aunque ahora deje pasar todas las
// pestañas de meses: si se renombra, itemMatching() deja de encontrarlo.
const NODO_HOJAS = 'Resolver hoja del mes';

const salida = [];
const errores = [];
const entrada = $input.all();

for (let i = 0; i < entrada.length; i++) {
  const resp = entrada[i].json || {};

  let ctxArchivo = null;
  try {
    ctxArchivo = $(NODO_HOJAS).itemMatching(i).json;
  } catch (e) {
    ctxArchivo = null;
  }
  if (!ctxArchivo) continue;

  const base = {
    persona: ctxArchivo.employeeFolderName || null,
    archivo: ctxArchivo.fileName || null,
    hoja: ctxArchivo.targetSheetName || null,
    carpeta_proyecto: ctxArchivo.projectFolder || null,
  };

  // Graph puede rechazar una hoja puntual (archivo abierto, throttling). Se
  // anota y se sigue con las demas: una hoja mala no frena la corrida.
  // Una respuesta SIN `values` tampoco es una hoja vacía: es una descarga
  // que no llegó (22 sep 2026: la hoja de Agosto de una persona no trajo
  // nada a las 11:22 y siete minutos después llegó completa, mientras el
  // archivo se estaba editando en el navegador). Una hoja de verdad vacía
  // igual trae `values` (aunque sea con la fila de encabezados).
  if (resp.error || !Array.isArray(resp.values)) {
    const detalle = resp.error ? (resp.error.message || resp.error.code || 'error de Graph') : 'respuesta sin datos';
    errores.push({ ...base, error: detalle });
    continue;
  }

  const values = resp.values;
  for (const fila of parsearHoja(values)) {
    salida.push({ json: { ...base, ...fila } });
  }
}

if (errores.length) {
  console.log(`⚠️ ${errores.length} hoja(s) no se pudieron leer:`, JSON.stringify(errores));
}
console.log(`📄 ${salida.length} fila(s) parseadas de ${entrada.length} hoja(s)`);

// Último item: qué archivos quedaron INCOMPLETOS (alguna hoja falló). "Resolver
// y filtrar" lo usa para no tratar a esa persona como leída entera: a quien
// se leyó completo se le reemplaza TODO lo del día (ver 04-construir-sql.js),
// y hacer eso con un archivo al que le faltó una hoja le borraría ese mes.
salida.push({
  json: {
    resumen_parseo: true,
    archivos_con_error: [...new Set(errores.map((e) => e.archivo).filter(Boolean))],
  },
});

return salida;

// Exportado solo para la prueba local (docs/n8n/wf-costeo/02-parsear-hojas.test.js).
// n8n ignora esta linea porque nunca llega: el `return` de arriba corta.
module.exports = { parsearHoja, localizarEncabezados, normalizarTexto, comoFecha };
