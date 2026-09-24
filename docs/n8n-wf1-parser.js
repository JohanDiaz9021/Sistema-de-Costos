/* ============================================================
 *  WF1 — Parser para el NUEVO formato de planeación (multi-semana)
 *  ------------------------------------------------------------
 *  Pegar este código en un nodo "Function" de n8n DESPUÉS de la
 *  lectura del archivo Excel (XLSX -> sheet -> rows).
 *
 *  ENTRADA esperada por item:
 *    item.json.filename = "2026_1003713754_Emily_Tench (1).xlsx"
 *    item.json.sheetName = "Junio"
 *    item.json.rows = [[celda, celda, ...], ...]   // matriz cruda de la hoja
 *
 *  SALIDA por item:
 *    Un nuevo item por CADA fila de tarea encontrada, listo para
 *    insertar en mp_task_facts. Y si hay errores, también un item
 *    con $node["validation_errors"] listo para mp_validation_errors.
 * ============================================================ */

// ---------- 1) Validación del nombre del archivo ----------

const FILENAME_RE = /^(\d{4})_(\d{6,12})_([^_]+)_([^_.]+?)(?:\s*\(\d+\))?\.xlsx$/i;

function parseFilename(filename) {
  const m = FILENAME_RE.exec(filename || '');
  if (!m) {
    return { ok: false, reason: `Nombre no cumple patrón YYYY_CEDULA_Nombre_Apellido.xlsx. Recibido: "${filename}"` };
  }
  return {
    ok: true,
    year: Number(m[1]),
    cedula: m[2],
    firstName: m[3].trim(),
    lastName: m[4].trim(),
  };
}

// ---------- 2) Detección de "secciones" (semanas) dentro de la hoja ----------
// Cada sección sigue el patrón:
//   [encabezado de bloque] IDENTIFICACIÓN | TIEMPOS Y EJECUCIÓN | RESULTADO
//   [encabezado de columnas] # Consec. | Semana | Proyecto | Actividad | ...
//   [descripción de columnas]
//   [filas de datos]
//   [fila Cumplimiento]
//   [fila vacía]  -> fin de sección

const HEADER_MARKER_A = /IDENTIFICACI[ÓO]N/i;
const HEADER_MARKER_B = /TIEMPOS Y EJECUCI[ÓO]N/i;
const HEADER_MARKER_C = /RESULTADO/i;
const CUMPLIMIENTO_RE = /^cumplimiento$/i;
const CONSEC_RE = /^#\s*consec/i;

function isHeaderBlockRow(row) {
  // Una fila tipo R7: tiene IDENTIFICACIÓN en col A, TIEMPOS... y RESULTADO repartidos
  if (!Array.isArray(row)) return false;
  const joined = row.map((c) => String(c || '')).join(' ');
  return HEADER_MARKER_A.test(joined) && HEADER_MARKER_B.test(joined) && HEADER_MARKER_C.test(joined);
}
function isColumnHeaderRow(row) {
  if (!Array.isArray(row) || row.length < 1) return false;
  return CONSEC_RE.test(String(row[0] || ''));
}
function isCumplimientoRow(row) {
  if (!Array.isArray(row) || row.length < 1) return false;
  return CUMPLIMIENTO_RE.test(String(row[0] || '').trim());
}
function isBlankRow(row) {
  if (!Array.isArray(row)) return true;
  return row.every((c) => c === null || c === undefined || String(c).trim() === '');
}

/**
 * Devuelve una lista de secciones detectadas:
 *   [{ headerBlockIdx, columnHeaderIdx, dataStartIdx, dataEndIdx, cumplimientoIdx }]
 *
 * Si NO encuentra ninguna sección válida, retorna [] y arroja errores en `errors`.
 */
function detectSections(rows, errors) {
  const sections = [];
  let i = 0;
  while (i < rows.length) {
    if (isHeaderBlockRow(rows[i])) {
      const headerBlockIdx = i;
      // siguiente fila esperada: column header
      let columnHeaderIdx = -1;
      for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
        if (isColumnHeaderRow(rows[j])) { columnHeaderIdx = j; break; }
      }
      if (columnHeaderIdx === -1) {
        errors.push({
          type: 'header_mismatch',
          message: `Bloque en fila ${i + 1} no tiene encabezado de columnas '# Consec.' a continuación.`,
          rawContext: JSON.stringify(rows[i]).slice(0, 200),
        });
        i++; continue;
      }
      // descripción está en columnHeaderIdx + 1 (suele ser R9)
      const dataStartIdx = columnHeaderIdx + 2;
      // buscar fila de cumplimiento
      let cumplimientoIdx = -1;
      for (let k = dataStartIdx; k < rows.length; k++) {
        if (isCumplimientoRow(rows[k])) { cumplimientoIdx = k; break; }
        if (isHeaderBlockRow(rows[k])) break;
      }
      if (cumplimientoIdx === -1) {
        errors.push({
          type: 'no_cumplimiento_row',
          message: `Sección que arranca en fila ${headerBlockIdx + 1} no tiene fila 'Cumplimiento'.`,
          rawContext: JSON.stringify(rows[headerBlockIdx]).slice(0, 200),
        });
        i++; continue;
      }
      sections.push({
        headerBlockIdx,
        columnHeaderIdx,
        dataStartIdx,
        dataEndIdx: cumplimientoIdx - 1,
        cumplimientoIdx,
      });
      i = cumplimientoIdx + 1;
    } else {
      i++;
    }
  }
  return sections;
}

// ---------- 3) Parsear cada fila de datos ----------
// Mapeo de columnas (0-indexed) según el Excel observado:
const COL = {
  CONSEC: 0, SEMANA: 1, PROYECTO: 2, ACTIVIDAD: 3, P_NP: 4,
  HORAS_PRESUP: 5, FECHA_ESTIMADA: 6, FECHA_ENTREGA: 7,
  L: 8, M: 9, X: 10, J: 11, V: 12, S: 13, TT: 14,
  ESTADO: 15, CUMPLIMIENTO: 16, DESFASE: 17, ESFUERZO: 18, A_CARGO: 19,
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(',', '.').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function parseDateCell(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // dd/mm/yyyy
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function parseDataRow(row, ctx) {
  const consec = num(row[COL.CONSEC]);
  const semana = num(row[COL.SEMANA]);
  const proyecto = txt(row[COL.PROYECTO]);
  const actividad = txt(row[COL.ACTIVIDAD]);
  if (consec === null && !proyecto && !actividad) return null; // fila vacía

  return {
    snapshot_date: ctx.snapshotDate,
    cedula: ctx.cedula,
    employee_name: ctx.employeeName,
    month_name: ctx.sheetName,
    week_number: semana,
    consec_number: consec,
    project_folder: proyecto,
    activity: actividad,
    task_kind: txt(row[COL.P_NP]),       // P / NP
    hours_budgeted: num(row[COL.HORAS_PRESUP]),
    estimated_date: parseDateCell(row[COL.FECHA_ESTIMADA]),
    delivery_date:  parseDateCell(row[COL.FECHA_ENTREGA]),
    hours_monday: num(row[COL.L]),
    hours_tuesday: num(row[COL.M]),
    hours_wednesday: num(row[COL.X]),
    hours_thursday: num(row[COL.J]),
    hours_friday: num(row[COL.V]),
    hours_saturday: num(row[COL.S]),
    total_executed: num(row[COL.TT]),
    task_status: txt(row[COL.ESTADO]),
    compliance_pct: num(row[COL.CUMPLIMIENTO]),
    desfase: num(row[COL.DESFASE]),
    effort_pct: num(row[COL.ESFUERZO]),
    assigned_to: txt(row[COL.A_CARGO]),
  };
}

// ---------- 4) Función principal expuesta a n8n ----------

function processWorkbookSheet({ filename, sheetName, rows, snapshotDate }) {
  const errors = [];
  const fn = parseFilename(filename);
  if (!fn.ok) {
    errors.push({ type: 'filename_pattern', message: fn.reason, rawContext: filename });
    return { facts: [], errors };
  }
  const sections = detectSections(rows || [], errors);
  if (!sections.length) {
    errors.push({
      type: 'multi_week_parse',
      message: `No se detectaron secciones válidas en hoja "${sheetName}".`,
      rawContext: `rows=${rows ? rows.length : 0}`,
    });
    return { facts: [], errors };
  }

  // Nombre de talento puede estar en celda B6 (índice [5][1]) si el formato lo respeta.
  let employeeNameFromCell = null;
  if (rows[5] && rows[5][1]) employeeNameFromCell = txt(rows[5][1]);

  const ctx = {
    snapshotDate: snapshotDate || new Date().toISOString().slice(0, 10),
    cedula: fn.cedula,
    employeeName: employeeNameFromCell || `${fn.firstName} ${fn.lastName}`,
    sheetName,
  };

  const facts = [];
  for (const sec of sections) {
    for (let r = sec.dataStartIdx; r <= sec.dataEndIdx; r++) {
      const parsed = parseDataRow(rows[r] || [], ctx);
      if (parsed) facts.push(parsed);
    }
  }
  return { facts, errors };
}

// ---------- 5) Entry point para n8n ----------
// n8n ejecuta este script por cada item. Esperamos:
//   item.json.filename, item.json.sheetName, item.json.rows
// y devolvemos N items (uno por fila parseada) + 1 item por error.

const out = [];
for (const item of items) {
  const { filename, sheetName, rows, snapshotDate } = item.json;
  const { facts, errors } = processWorkbookSheet({ filename, sheetName, rows, snapshotDate });

  for (const f of facts) out.push({ json: { _kind: 'fact', ...f } });
  for (const e of errors) {
    out.push({
      json: {
        _kind: 'validation_error',
        workflow_name: 'WF1',
        source_filename: filename,
        cedula_guess: (parseFilename(filename).ok ? parseFilename(filename).cedula : null),
        employee_name_guess: (parseFilename(filename).ok
          ? `${parseFilename(filename).firstName} ${parseFilename(filename).lastName}` : null),
        error_type: e.type,
        error_message: e.message,
        raw_context: e.rawContext,
      },
    });
  }
}
return out;

// ============================================================
// Cómo conectar en n8n:
//   [Trigger] -> [Get File from SharePoint] -> [XLSX a JSON rows]
//   -> [Function: este código]
//   -> [Switch por _kind]
//        case 'fact'              -> [MySQL INSERT mp_task_facts]
//        case 'validation_error'  -> [MySQL INSERT mp_validation_errors]
// ============================================================
