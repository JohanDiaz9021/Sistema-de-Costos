// =============================================================
// WF-COSTEO — Nodo "Resolver hoja del mes" (n8n, tipo Code)
// -------------------------------------------------------------
// Reemplaza al del WF1. El original elegía UNA sola pestaña por archivo
// (la del mes actual). Para Planeación está bien; para Costeo es un error
// grave: el motor toma el corte más reciente de cada persona y proyecto,
// así que si el corte de hoy trae solo septiembre, las horas de los meses
// anteriores DESAPARECEN de la barra de ejecución (ya pasó el 31 ago 2026:
// alguien quedó con 4.7 h en vez de 143.5 h).
//
// Este nodo deja pasar las pestañas de meses desde MES_MINIMO/ANIO_MINIMO
// hasta el mes actual, y emite un item por pestaña. Los meses futuros se
// saltan: suelen estar creados pero vacíos, y pedirlos solo gasta llamadas
// a Graph.
//
// El NOMBRE del nodo no se cambia: "Parsear todos los archivos" lo busca
// como 'Resolver hoja del mes' para saber de quién es cada hoja.
//
// Cada item de salida conserva los campos del original ({...fileCtx,
// targetSheetName}), que es lo que "Descargar hoja vía Graph" usa en su URL.
//
// PISO EN AGOSTO 2026 (decisión explícita del usuario, 23 sep 2026):
// es UNIVERSAL, aplica a TODOS los proyectos por igual, no solo a los que
// exigen módulo. Mayo/junio/julio 2026 ya no se leen para nadie —
// Management, Sistema de Costos, GTC Project, MIA, todos. (Hubo un intento
// de escribirlo distinto el mismo día —piso solo para los proyectos con
// módulo— y se corrigió tras confirmar con el usuario: "tanto management y
// sistema de costo tambien se lee desde agosto". Lo que SÍ es exclusivo de
// 4 proyectos es la otra regla, la del formato con módulo — ver
// REQUIERE_MODULO en 03-resolver-y-filtrar.js, una regla SEPARADA de esta.)
// Para años posteriores a ANIO_MINIMO el piso no aplica: se lee desde enero,
// porque cada año vive en su propia carpeta ("Planeación <año>") y no
// arrastra el problema del desplegable viejo.
// =============================================================

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const ANIO_MINIMO = 2026;
const MES_MINIMO = 8; // agosto

// Sin tildes, sin espacios de más, en minúsculas: "Septiembre ", "SEPTIEMBRE"
// y "septiembre" son la misma pestaña.
function normalizarHoja(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * De la lista de pestañas de un archivo, devuelve las que hay que leer: una
 * por mes, entre el piso (ANIO_MINIMO/MES_MINIMO) y `mesActual` de
 * `anioActual` (1-12), en orden de mes. El piso es el mismo para
 * CUALQUIER proyecto: aplica antes de saber siquiera qué hay en la hoja.
 *
 * El piso solo aplica dentro de ANIO_MINIMO: para cualquier año posterior
 * se lee desde enero, como antes del 23 sep 2026.
 *
 * Si dos pestañas son el mismo mes ("Agosto" y "agosto "), se queda con la
 * PRIMERA y reporta la otra en `duplicadas`. Leer las dos contaría esas
 * horas dos veces.
 */
function elegirHojas(nombres, mesActual, anioActual) {
  const mesInicial = anioActual === ANIO_MINIMO ? MES_MINIMO : 1;
  const porMes = new Map(); // numero de mes -> primer nombre real encontrado
  const duplicadas = [];

  for (const nombre of nombres || []) {
    const idx = MESES.indexOf(normalizarHoja(nombre));
    if (idx === -1) continue; // Datos, Control de Cambios, etc.
    const mes = idx + 1;
    if (mes > mesActual) continue; // mes futuro: todavía vacío
    if (mes < mesInicial) continue; // antes del piso: ya no se cuenta, para NINGUN proyecto
    if (porMes.has(mes)) {
      duplicadas.push({ mes, elegida: porMes.get(mes), descartada: nombre });
      continue;
    }
    porMes.set(mes, nombre);
  }

  const hojas = [...porMes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, nombre]) => nombre);
  return { hojas, duplicadas };
}

// ---- n8n: un item de entrada por archivo -> un item de salida por pestaña ----
const contextoEjecucion = $('Generar contexto ejecución').first().json;
const mesActual = Number(contextoEjecucion.monthNumber);
const anioActual = Number(contextoEjecucion.yearNumber);
const responses = $input.all();
const out = [];
const sinHojas = [];
const todasDuplicadas = [];

for (let i = 0; i < responses.length; i++) {
  const resp = responses[i].json || {};

  let fileCtx;
  try {
    fileCtx = $('Filtrar carpetas con archivo').itemMatching(i).json;
  } catch (e) {
    fileCtx = {};
  }

  // Graph no pudo listar las pestañas (archivo abierto, throttling). Se anota
  // y se sigue: un archivo malo no frena la carga de los demás.
  if (resp.error || !resp.value) {
    sinHojas.push({ archivo: fileCtx.fileName || '?', motivo: resp.error?.message || 'sin pestañas' });
    continue;
  }

  const nombres = resp.value.map((s) => s.name).filter(Boolean);
  const { hojas, duplicadas } = elegirHojas(nombres, mesActual, anioActual);

  for (const d of duplicadas) todasDuplicadas.push({ archivo: fileCtx.fileName, ...d });
  if (!hojas.length) {
    sinHojas.push({ archivo: fileCtx.fileName || '?', motivo: `ninguna pestaña de mes. Tiene: ${nombres.join(', ')}` });
    continue;
  }

  for (const targetSheetName of hojas) {
    // pairedItem explícito: cada pestaña queda amarrada a SU archivo, así
    // "Parsear todos los archivos" puede saber de quién es cada hoja aunque
    // un archivo haya generado varias.
    out.push({ json: { ...fileCtx, targetSheetName }, pairedItem: { item: i } });
  }
}

const mesInicialLog = anioActual === ANIO_MINIMO ? MES_MINIMO : 1;
console.log(`📑 ${out.length} pestaña(s) a leer de ${responses.length} archivo(s), meses ${mesInicialLog} a ${mesActual} de ${anioActual}`);
if (sinHojas.length) console.log('⚠️ Archivos sin pestañas de mes:', JSON.stringify(sinHojas));
if (todasDuplicadas.length) console.log('⚠️ Pestañas duplicadas (se usó la primera):', JSON.stringify(todasDuplicadas));

return out;

// Exportado solo para la prueba local (01b-resolver-hojas-meses.test.js).
module.exports = { elegirHojas, normalizarHoja, ANIO_MINIMO, MES_MINIMO };
