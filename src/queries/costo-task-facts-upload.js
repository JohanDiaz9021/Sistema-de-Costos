'use strict';

/**
 * Carga manual del Excel semanal de horas — LA ÚNICA fuente de datos de
 * Sistema de Costos (31 ago 2026, a pedido explícito). Antes escribía en
 * mp_task_facts, la tabla que llena el RPA/n8n de Planeación leyendo el
 * Excel compartido de SharePoint; se pensó como un "relleno" para cuando
 * el RPA todavía no corría. Eso resultó ser un error de diseño: Planeación
 * y Sistema de Costos tienen que ser completamente independientes —
 * Costeo no tiene ningún RPA propio, así que ahora escribe en
 * mp_costeo_task_facts, una tabla propia, y arranca vacía (los datos que
 * hubiera antes en mp_task_facts nunca fueron horas "de Costeo", eran las
 * de Planeación).
 *
 * Regla de reemplazo: cada carga usa la fecha de HOY como snapshot_date, y
 * REEMPLAZA (no acumula) las filas de ESA persona en ESA fecha — así se
 * puede corregir un error subiendo de nuevo el mismo día sin duplicar
 * filas. Ya no hace falta "usar la fecha ya vigente en vez de hoy" (la
 * regla que tenía cuando compartía tabla con el RPA): sin un RPA
 * sincronizando a todo el mundo el mismo día, no hay una fecha "vigente"
 * compartida que proteger — cada persona tiene la suya (ver el baseWhere
 * de costo-common.js, que lee el snapshot más reciente DE CADA EMPLEADO,
 * no uno global).
 *
 * RIESGO CONOCIDO, NO CONTENIDO AÚN (17 sep 2026, auditoría): dos PM
 * subiendo el MISMO Excel de horas de la MISMA persona/proyecto de forma
 * casi simultánea pueden insertar filas duplicadas. El DELETE y el INSERT
 * viven dentro de una transacción, pero mp_costeo_task_facts NO tiene una
 * llave única (snapshot_date, employee_id, project_name, turno...) que
 * haga que el segundo commit falle, y DELETE+INSERT no anda sobre un
 * mismo snapshot dado — dos transacciones concurrentes pueden intercalar
 * sus DELETE (nadie borra nada) y luego insertar cada una su set. El motor
 * además lee MAX(snapshot_date) por empleado/proyecto (costo-common.js),
 * así que con la MISMA fecha de hoy no quedarían dos "snapshots" — las
 * filas duplicadas se contarían DOBLE como horas de la persona.
 *
 * Probabilidad baja (dos personas subiendo el mismo archivo a la vez) y
 * por eso se deja documentado en vez de arreglado. Si un día se contiene,
 * las dos opciones son:
 *   - UNIQUE compuesto (snapshot_date, employee_id, project_name,
 *     week_number, activity) agregado por migración, y volver el DELETE a
 *     "borrar + reinsertar SIEMPRE" (el único path con UNIQUE que hoy
 *     convive con la corrección intradía es REEMPLAZAR dentro del mismo
 *     snapshot — un UNIQUE estático no alcanza para eso).
 *   - SELECT ... FOR UPDATE sobre la fila de snapshot de la persona antes
 *     del DELETE, dentro de la misma transacción, para serializar dos
 *     cargas concurrentes de la misma persona.
 */

const ExcelJS = require('exceljs');
const { withTransaction } = require('../db');
const { fechaNegocioISO } = require('../lib/fecha-negocio');

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Compara texto de un Excel llenado a mano, donde el mismo valor aparece
// escrito de varias formas. Se quita todo lo que no sea letra o número
// (tildes incluidas, vía NFKD) y se baja a minúsculas.
//
// Nació por los encabezados: las columnas con filtro de Excel activado
// (AutoFilter/Tabla) traen el texto pegado a un ícono de desplegable (la
// celda real no es "Proyecto", es "🔽 Proyecto"), así que comparar por
// igualdad exacta nunca encontraba nada. También hace innecesarios los
// `|| col('variante con espacios/salto de línea')` que había antes: "P/NP"
// y "P / NP" ya normalizan igual.
//
// Se reusa para los nombres de proyecto (ver filtrarPorCentro) por la
// misma razón: "Sistema de costos" y "SISTEMA DE COSTOS" son el mismo.
function normalizarTexto(v) {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// Hasta dónde se busca la fila de encabezados. Eran 10 filas, apretado de
// más: el archivo real apila un bloque por semana (encabezado + subtítulos
// + filas), así que en una hoja que arranque con un bloque de resumen, o a
// la que le agreguen filas arriba, el primer "Proyecto" queda mucho más
// abajo y la carga entera fallaba con "¿es la plantilla correcta?".
//
// Subirlo no relaja nada: una fila solo entra como dato si además trae un
// número en "Semana" (ver parsearFilas), que es lo que ya descarta las
// hojas auxiliares con una columna "Proyecto" que no son de horas.
const MAX_FILA_ENCABEZADO = 200;

// Encuentra la fila de encabezados por TEXTO ("Proyecto", "Semana"...) en
// vez de por columna fija — el template agrupa secciones arriba y trae un
// subtítulo en cursiva debajo del encabezado, así que la posición exacta
// de cada columna no es estable entre archivos.
function localizarEncabezados(ws) {
  for (let r = 1; r <= MAX_FILA_ENCABEZADO; r++) {
    const fila = ws.getRow(r);
    const porColumna = {};
    fila.eachCell({ includeEmpty: false }, (cell, col) => {
      porColumna[col] = String(cell.value ?? '').trim();
    });
    const tieneProyecto = Object.values(porColumna).some((v) => normalizarTexto(v) === 'proyecto');
    if (!tieneProyecto) continue;

    const col = (nombre) => {
      const objetivo = normalizarTexto(nombre);
      const e = Object.entries(porColumna).find(([, v]) => normalizarTexto(v) === objetivo);
      return e ? Number(e[0]) : null;
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
      // L,M,X,J,V,S son 6 columnas contiguas justo después de "L" en el
      // template — más confiable que buscar "M" (choca con nombres de mes).
      lunes: colLunes,
      martes: colLunes ? colLunes + 1 : null,
      miercoles: colLunes ? colLunes + 2 : null,
      jueves: colLunes ? colLunes + 3 : null,
      viernes: colLunes ? colLunes + 4 : null,
      sabado: colLunes ? colLunes + 5 : null,
      tt: col('TT'),
      estado: col('Estado'),
      observaciones: col('Observaciones'),
    };
  }
  return null;
}

function valorCelda(fila, col) {
  if (!col) return null;
  const v = fila.getCell(col).value;
  if (v && typeof v === 'object' && v.result !== undefined) return v.result; // formula
  return v;
}

function comoFecha(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function comoNumero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Errores pensados para mostrarse tal cual al usuario (mensajes propios, en
// español, que ya explican qué corregir). Se marcan con `esUsuario` para que
// el route (centros.js) los distinga de un error inesperado de ExcelJS o de
// MySQL, que sí trae detalles internos y no debería llegar crudo al cliente.
function errorUsuario(mensaje) {
  const e = new Error(mensaje);
  e.esUsuario = true;
  return e;
}

// Pura: separada de la lectura del .xlsx para poder probarla con un
// worksheet armado a mano, sin depender de un archivo real en disco.
function parsearFilas(ws) {
  const enc = localizarEncabezados(ws);
  if (!enc) throw errorUsuario(`No se encontró la columna "Proyecto" en las primeras ${MAX_FILA_ENCABEZADO} filas — ¿es la plantilla correcta?`);

  const filas = [];
  for (let r = enc.filaEncabezado + 1; r <= ws.rowCount; r++) {
    const fila = ws.getRow(r);
    const proyecto = String(valorCelda(fila, enc.proyecto) ?? '').trim();
    const semanaRaw = valorCelda(fila, enc.semana);
    // La fila justo debajo del encabezado es el subtítulo en cursiva
    // ("Elige proyecto", "N° semana"...), no un dato — se detecta porque
    // "Semana" no es un número ahí.
    //
    // El chequeo de semanaRaw != null es a propósito, no redundante: si la
    // hoja no tiene columna "Semana" (enc.semana queda null — pasa en
    // hojas auxiliares de referencia, tipo listas de proyectos válidos,
    // que sí pueden tener una columna "Proyecto"), valorCelda() devuelve
    // null para TODA fila, y Number(null) da 0 — finito — así que sin este
    // chequeo cualquier hoja con una columna "Proyecto" (aunque no tenga
    // nada que ver con horas trabajadas) se leería como datos válidos.
    if (!proyecto || semanaRaw == null || !Number.isFinite(Number(semanaRaw))) continue;

    const fechaEstimada = comoFecha(valorCelda(fila, enc.fechaEstimada));
    const fechaEntrega = comoFecha(valorCelda(fila, enc.fechaEntrega));
    filas.push({
      week_number: comoNumero(semanaRaw),
      project_name: proyecto,
      activity: String(valorCelda(fila, enc.actividad) ?? '').trim() || null,
      planned_type: (String(valorCelda(fila, enc.pnp) ?? '').trim().toUpperCase() === 'NP') ? 'NP' : 'P',
      budgeted_hours: comoNumero(valorCelda(fila, enc.horasPresupuestadas)),
      estimated_delivery_date: fechaEstimada,
      actual_delivery_date: fechaEntrega,
      hours_monday: comoNumero(valorCelda(fila, enc.lunes)),
      hours_tuesday: comoNumero(valorCelda(fila, enc.martes)),
      hours_wednesday: comoNumero(valorCelda(fila, enc.miercoles)),
      hours_thursday: comoNumero(valorCelda(fila, enc.jueves)),
      hours_friday: comoNumero(valorCelda(fila, enc.viernes)),
      hours_saturday: comoNumero(valorCelda(fila, enc.sabado)),
      total_executed_hours: comoNumero(valorCelda(fila, enc.tt)),
      task_status: String(valorCelda(fila, enc.estado) ?? '').trim() || null,
      observations: String(valorCelda(fila, enc.observaciones) ?? '').trim() || null,
      month_number: fechaEstimada ? fechaEstimada.getMonth() + 1 : (fechaEntrega ? fechaEntrega.getMonth() + 1 : null),
      year_number: fechaEstimada ? fechaEstimada.getFullYear() : (fechaEntrega ? fechaEntrega.getFullYear() : null),
    });
  }
  if (!filas.length) throw errorUsuario('El archivo no tiene filas de datos reconocibles debajo del encabezado.');
  return filas;
}

// El archivo real de "Planeación Semanal" trae UNA HOJA POR MES (Agosto,
// Septiembre...) más hojas auxiliares (Datos, Control de Cambios) que no
// tienen datos de horas.
//
// Se leen TODAS las hojas con datos, no una sola. Es la corrección de un
// daño real (31 ago 2026): guardarHorasDesdeExcel() REEMPLAZA todas las
// filas de esa persona en la fecha de corte, así que devolver una sola
// hoja hacía que subir el Excel BORRARA los demás meses de esa persona.
// Pasó de verdad — una carga leyó solo la pestaña "Septiembre" y dejó a
// alguien con 4.7h de septiembre en vez de sus 143.5h de agosto.
//
// Leerlas todas también hace innecesario adivinar "cuál es la hoja
// vigente", que no tenía una respuesta confiable: ni la primera del libro
// (es historial viejo), ni la del mes del calendario (una semana puede
// empezar a fin de mes y ya vivir en la pestaña del mes siguiente — el
// caso que se intentó resolver antes con esa regla).
//
// Las hojas que no son de horas (Datos, Control de Cambios) y las de un
// mes ya creado pero todavía vacío se saltan solas: parsearFilas() lanza
// sobre ellas y se ignoran.
//
// Devuelve { hojas, filas } — `hojas` son los nombres de las que sí
// aportaron datos, útil para explicar qué se cargó.
function parsearHojasConDatos(wb) {
  const filas = [];
  const hojas = [];
  let primerError = null;

  for (const ws of wb.worksheets) {
    try {
      filas.push(...parsearFilas(ws));
      hojas.push(ws.name);
    } catch (err) {
      if (!primerError) primerError = err;
    }
  }
  if (filas.length) return { hojas, filas };

  // Con una sola hoja se propaga el error puntual de parsearFilas ("no se
  // encontró la columna Proyecto"), que dice exactamente qué corregir. Con
  // varias, ese error sería el de una hoja cualquiera del libro y
  // confundiría más de lo que ayuda: mejor listar las que hay.
  if (wb.worksheets.length === 1 && primerError) throw primerError;
  const nombres = wb.worksheets.map((ws) => ws.name).join(', ') || '(el archivo no tiene hojas)';
  throw errorUsuario(
    `Ninguna hoja del archivo tiene datos de horas reconocibles (columna "Proyecto" con filas debajo). Hojas disponibles: ${nombres}.`
  );
}

async function parsearWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (!wb.worksheets.length) throw errorUsuario('El archivo no tiene ninguna hoja.');
  return parsearHojasConDatos(wb).filas;
}

// El TT del Excel ("Total ejecutado (auto)") es una fórmula que suma los
// días. El costo se calcula con los DÍAS, no con el TT, así que un TT
// descuadrado no rompe ninguna cuenta — pero delata una fila con la
// fórmula pisada a mano, que es donde suele estar el error de digitación.
// Se avisa, no se corrige solo: cuál de los dos números es el bueno lo
// sabe la persona, no el sistema.
const TOLERANCIA_HORAS = 0.01;

function filasConTotalDescuadrado(filas) {
  return filas.filter((f) => {
    const dias = f.hours_monday + f.hours_tuesday + f.hours_wednesday
      + f.hours_thursday + f.hours_friday + f.hours_saturday;
    return Math.abs(dias - f.total_executed_hours) > TOLERANCIA_HORAS;
  }).length;
}

// Se queda SOLO con las filas cuyo "Proyecto" (columna C del Excel) es el
// del centro al que se está subiendo el archivo; las demás se ignoran.
//
// 10 sep 2026, a pedido explícito: el Excel de una persona trae todos sus
// proyectos de la semana, y antes se guardaban todos de una sola carga.
// Funcionaba (el motor ya atribuía cada hora por su proyecto), pero no era
// lo que la pantalla promete: uno sube el archivo DENTRO de un centro, así
// que espera que solo entren las horas de ese centro. Ahora el mismo
// archivo se sube una vez por proyecto y cada carga toca solo lo suyo.
//
// El criterio de coincidencia es el mismo del JOIN que después cobra las
// horas (costoLaboralEjecutado, costo-motor.js): vale contra project_name
// o contra project_folder del centro, porque el Excel unas veces escribe
// uno y otras el otro ("Sistema de costos" -> centro "Costos"). Si aquí se
// filtrara con un criterio distinto al de allá, se guardarían filas que
// luego no cobra nadie, o al revés.
function filtrarPorCentro(filas, centro) {
  const delCentro = new Set(
    [centro.project_name, centro.project_folder].filter(Boolean).map(normalizarTexto)
  );

  const propias = [];
  const ignoradas = [];
  for (const f of filas) {
    if (delCentro.has(normalizarTexto(f.project_name))) propias.push(f);
    else ignoradas.push(f);
  }
  return {
    propias,
    ignoradas,
    proyectosIgnorados: [...new Set(ignoradas.map((f) => f.project_name).filter(Boolean))],
  };
}

// Reemplaza (no acumula) las filas de este empleado EN ESTE CENTRO, en la
// fecha de corte vigente — ver las reglas de seguridad del comentario de
// arriba del archivo.
async function guardarHorasDesdeExcel(employeeId, projectFolder, centro, filas, exec) {
  // Fecha de corte en calendario colombiano, no UTC (ver
  // src/lib/fecha-negocio.js): esta fecha se GUARDA y es la clave con la
  // que el motor decide cuál es el corte vigente de cada persona
  // (MAX(snapshot_date) en costo-common.js). Con toISOString(), una carga
  // hecha después de las 7:00 p.m. quedaba fechada al día siguiente.
  const snapshotDate = fechaNegocioISO();

  // El borrado va acotado AL PROYECTO de este centro, no a toda la persona.
  //
  // Antes borraba `employee_id = ? AND snapshot_date = ?` a secas, lo que
  // era correcto mientras una sola carga traía todos los proyectos de la
  // persona. Ahora que cada carga es de UN centro, ese borrado amplio
  // destruiría el trabajo anterior: subir Sistema de costos y después
  // Management el mismo día dejaba a la persona solo con Management, con
  // las horas de Sistema de costos borradas y sin ningún aviso.
  //
  // Se acota por el proyecto DEL CENTRO (no por los nombres que traiga el
  // Excel) para que una corrección que quita filas también limpie: si el
  // lunes se subieron 5 filas y hoy el archivo trae 3, las otras 2 tienen
  // que desaparecer.
  await exec(
    `DELETE FROM mp_costeo_task_facts
      WHERE employee_id = ? AND snapshot_date = ?
        AND (project_name = ? OR project_name = ?)`,
    [employeeId, snapshotDate, centro.project_name, centro.project_folder]
  );

  // INSERT en lotes en vez de uno por fila: un Excel de varios meses puede
  // traer cientos de filas, y un `await exec` por fila las inserta una a la
  // vez dentro de la misma transacción — cientos de round-trips secuenciales
  // a una base remota (~100ms cada uno, ver la lentitud ya conocida de
  // Indicadores) alargan la ventana de locks sin necesidad. Agrupar el mismo
  // INSERT en lotes de tamaño fijo mantiene exactamente los mismos valores y
  // el mismo orden de columnas, solo cambia cuántas filas viajan por
  // statement. El tope de lote es para no arriesgar max_allowed_packet con
  // un archivo inusualmente grande.
  const LOTE = 200;
  const columnas = `(snapshot_date, employee_id, project_folder, month_name, month_number, year_number,
          week_number, project_name, activity, planned_type, budgeted_hours,
          estimated_delivery_date, actual_delivery_date,
          hours_monday, hours_tuesday, hours_wednesday, hours_thursday, hours_friday, hours_saturday,
          total_executed_hours, task_status, observations)`;
  const placeholdersFila = `(${Array(22).fill('?').join(', ')})`;

  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const params = [];
    for (const f of lote) {
      const monthNumber = f.month_number || new Date(snapshotDate).getMonth() + 1;
      const yearNumber = f.year_number || new Date(snapshotDate).getFullYear();
      params.push(
        snapshotDate, employeeId, projectFolder, MESES[monthNumber - 1] || null, monthNumber, yearNumber,
        f.week_number, f.project_name, f.activity, f.planned_type, f.budgeted_hours,
        f.estimated_delivery_date, f.actual_delivery_date,
        f.hours_monday, f.hours_tuesday, f.hours_wednesday, f.hours_thursday, f.hours_friday, f.hours_saturday,
        f.total_executed_hours, f.task_status, f.observations,
      );
    }
    await exec(
      `INSERT INTO mp_costeo_task_facts ${columnas}
       VALUES ${lote.map(() => placeholdersFila).join(', ')}`,
      params
    );
  }

  const proyectos = [...new Set(filas.map((f) => f.project_name))];
  const totalHoras = filas.reduce((s, f) => s + f.total_executed_hours, 0);
  return { snapshotDate, filasInsertadas: filas.length, proyectos, totalHoras: Number(totalHoras.toFixed(2)) };
}

// La columna "A Cargo De" del Excel se ignora a propósito: de quién son
// las horas lo decide el desplegable de la pantalla, no el archivo. Cada
// persona sube el suyo.
async function cargarExcelHoras(employeeId, projectFolder, costCenterId, buffer) {
  const todas = await parsearWorkbook(buffer);

  return withTransaction(async (exec) => {
    const centros = await exec(
      'SELECT project_name, project_folder FROM mp_centro_costo WHERE cost_center_id = ?',
      [costCenterId]
    );
    if (!centros.length) throw errorUsuario('Ese centro de costos ya no existe.');
    const centro = centros[0];

    const { propias, ignoradas, proyectosIgnorados } = filtrarPorCentro(todas, centro);

    // Ni una fila de este proyecto. Se rechaza en vez de seguir, porque
    // seguir significaría BORRAR lo que la persona ya tuviera cargado hoy
    // en este centro y dejarlo en cero — un "listo, 0 filas" que se lee
    // como éxito. Se listan los proyectos que sí venían: el caso típico es
    // haber subido el archivo al centro equivocado, o que el nombre del
    // proyecto en el Excel no sea el que espera este centro.
    if (!propias.length) {
      throw errorUsuario(
        `El Excel no trae ninguna fila del proyecto "${centro.project_name}". `
        + (proyectosIgnorados.length
          ? `Los proyectos que trae son: ${proyectosIgnorados.join(', ')}. ¿Lo estás subiendo al centro de costos correcto?`
          : 'El archivo no trae ningún proyecto reconocible.')
      );
    }

    const guardado = await guardarHorasDesdeExcel(employeeId, projectFolder, centro, propias, exec);
    return {
      ...guardado,
      filas_ignoradas: ignoradas.length,
      proyectos_ignorados: proyectosIgnorados,
      filas_total_descuadrado: filasConTotalDescuadrado(propias),
    };
  });
}

module.exports = {
  parsearFilas,
  parsearWorkbook,
  guardarHorasDesdeExcel,
  cargarExcelHoras,
  parsearHojasConDatos,
  filasConTotalDescuadrado,
  filtrarPorCentro,
};
