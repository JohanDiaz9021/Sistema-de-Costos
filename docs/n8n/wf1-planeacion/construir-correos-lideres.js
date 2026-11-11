/* global $, $getWorkflowStaticData -- globales del nodo Code de n8n */
// =============================================================
// CONSTRUIR CORREOS DE RESUMEN PARA LÍDERES — v12 PRODUCCIÓN
//
// 🔧 v12 (2026-10-22): Se agrega Mónica Bastidas al CC universal. Ahora
//   todos los correos de Equipo van a sus PMs + Emily + César + Mónica
//   (deduplicando donde Mónica ya es PM: Equipos 3, 5, 8 y 9).
//
// 🔧 (2026-10-14): Angela Lucia Trujillo pasa a líder del Equipo 6 (QA) en
//   lugar de Jonathan Ariza, que pasó a Backup.
//
// 🔧 v11 (2026-10-02): UN CORREO POR EQUIPO de SharePoint, dirigido a los
//   PMs de ese Equipo (tabla PMS_POR_EQUIPO) + Emily y César en copia. Cada
//   persona aparece una sola vez, en el correo de su Equipo, con todas sus
//   tareas y hallazgos. Reemplaza el enrutamiento por proyecto de la v10
//   (por proyecto de cada tarea, QA por persona, destinatarios exclusivos),
//   que mezclaba Equipos en un mismo correo.
//
// 🔧 v10 (2026-10-01): el correo va al PM del PROYECTO de cada tarea, no al de
//   la carpeta, y el CEO recibe TODOS. SharePoint se organiza por Equipo
//   ("Equipo 4") y el desplegable "Proyecto" trae módulos ("Gestion
//   financiera (MIA)"); desde "Parsear todos los archivos" v20 cada tarea y
//   cada error ya traen su proyecto padre (MIA, SESCOL...). Aquí:
//   - Una persona con tareas en dos proyectos aparece en el correo de cada
//     PM, con las tareas de ese proyecto. Antes se armaba un grupo extra
//     "Equipo N" con la persona como IMPECABLE.
//   - Un proyecto con varios PMs (MIA: César + Juan Carlos) les llega a
//     todos. Antes projectToPMO se quedaba solo con el último.
//   - Sin archivo / sin hoja / carpeta no reconocida, y quien solo tiene
//     tareas de Management: se usa el proyecto de la ficha del empleado
//     (mp_employees.project_folder).
//   - El CEO va en copia de TODOS los correos (CEO_RECIBE_TODO).
//   - MODO_PRUEBA: ningún correo sale a una persona real (ver abajo).
//
// 🔧 v8 (2026-08-31): Se RETIRA al CEO del CC de correos diarios a líderes.
//   Los correos diarios de validación ahora van solo a: líder + Emily + César.
//   (Reactivado en v10 a pedido: el CEO debe recibir todos. Para volver a
//   retirarlo: CEO_RECIBE_TODO = false.)
//
// 🔧 v7 (2026-08-25): Se agrega César Arbeláez al CC universal.
// 🔧 v6 (2026-08-25): Se retira Johana del CC universal.
// 🔧 v5: Nuevos tipos ZERO_BUDGETED_HOURS y MISSING_WEEK_PLANNING; filtro L-V
//   deja pasar errores ESTRUCTURALES aunque sean de otra semana.
// =============================================================

// El flujo tiene DOS copias de "Generar contexto ejecución": la de la rama de
// festivo ("...ejecución1") y la que corre en un día normal ("...ejecución2").
// Se usa la que SÍ se ejecutó en esta corrida.
function nodoEjecutado(nombres) {
  for (const n of nombres) {
    try {
      if ($(n).first()) return n;
    } catch (e) { /* no existe o no se ejecutó en esta corrida */ }
  }
  throw new Error(`Ninguno de estos nodos se ejecutó en esta corrida: ${nombres.join(', ')}`);
}

const ctx = $(nodoEjecutado(['Generar contexto ejecución2', 'Generar contexto ejecución1', 'Generar contexto ejecución'])).first().json;
const staticData = $getWorkflowStaticData('global');

const catalog = $(nodoEjecutado(['Cargar catálogo empleados (early)1', 'Cargar catálogo empleados (early)'])).all().map(i => i.json);
const projectOwners = $('Cargar project owners').all().map(i => i.json);

const allValidationErrors = staticData.validationErrors || [];
const successfulEmployees = staticData.successfulEmployees || [];
const foldersWithoutFile = staticData.foldersWithoutFile || [];
const folderToProject = staticData.folderToProject || {};

// FILTRO_WEEK_LIDER_V2: martes-viernes filtra a semana actual, pero deja pasar
// siempre los errores estructurales del archivo (duplicados/consecutivos rotos/etc.)
// aunque sean de otra semana. Sábado envía consolidado completo.
const STRUCTURAL_TYPES = new Set([
  'DUPLICATE_WEEK_TASKS',
  'DUPLICATE_CONSECUTIVE',
  'NON_SEQUENTIAL_CONSECUTIVE',
  'DUPLICATE_TASK',
  'MISSING_WEEK_PLANNING'
]);
const snapshotDateObj = new Date(ctx.snapshotDate + 'T00:00:00Z');
const isSaturdayDigest = snapshotDateObj.getUTCDay() === 6; // 6 = sábado
const currentWeek = staticData.currentMonthWeek;
const validationErrors = isSaturdayDigest
  ? allValidationErrors
  : allValidationErrors.filter(e => {
      if (e.week_number === null || e.week_number === undefined) return true;
      if (STRUCTURAL_TYPES.has(e.error_type)) return true;
      return Number(e.week_number) === Number(currentWeek);
    });
console.log(`📅 Líderes: ${isSaturdayDigest ? 'SÁBADO digest (todas las semanas)' : 'L-V filtro semana ' + currentWeek}: ${allValidationErrors.length} → ${validationErrors.length}`);

// =============================================================
// QUIÉN RECIBE
// Cada correo va a: el/los PM del proyecto + estas copias universales.
// =============================================================
const MONITOREO_EMILY = 'emily@empresa.com';
const MONITOREO_CESAR = 'cesar@empresa.com';
const MONITOREO_MONICA = 'monica@empresa.com';
const MONITOREO_CEO = 'gerencia@empresa.com';
// true  → el CEO va en copia de TODOS los correos de líderes.
// false → el CEO no recibe la planeación de los demás Equipos; solo le llega
//         la del Equipo 7, donde es el PM (decisión del 2026-10-01,
//         ratificada el 2026-10-22). Debe quedar en false.
const CEO_RECIBE_TODO = false;
const COPIAS_UNIVERSALES = [MONITOREO_EMILY, MONITOREO_CESAR, MONITOREO_MONICA, ...(CEO_RECIBE_TODO ? [MONITOREO_CEO] : [])];

// =============================================================
// 🧪 MODO PRUEBA
// true  → NINGÚN correo sale a una persona real: cada destinatario se cambia
//         por su buzón de prueba (tabla de abajo) y quien no esté en la tabla
//         se DESCARTA. Si un correo se queda sin destinatarios, no se envía.
//         El cuerpo trae un recuadro "CORREO DE PRUEBA" con a quién
//         le habría llegado de verdad.
// false → producción: se envía a los destinatarios reales.
// ⚠️ PONER EN false ANTES DE ACTIVAR EL FLUJO EN PRODUCCIÓN.
// =============================================================
const MODO_PRUEBA = false;
// Solo estos 3 reciben en prueba; cualquier otro (César, Emily, Jonathan...)
// se descarta.
const REDIRECCION_PRUEBA = {
  'gerencia@empresa.com': 'prueba3@ejemplo.com',              // CEO
  'monica@empresa.com': 'prueba2@ejemplo.com',          // Mónica Bastidas
  'juancarlos@empresa.com': 'prueba1@empresa.com',       // Juan Carlos Díaz
};

// Lista de correos reales → lista que de verdad se usa (redirigida en prueba).
function destinatariosFinales(reales) {
  if (!MODO_PRUEBA) return reales;
  const salida = [];
  for (const r of reales) {
    const destino = REDIRECCION_PRUEBA[r.toLowerCase()];
    if (destino && !salida.includes(destino)) salida.push(destino);
  }
  return salida;
}

console.log(`📊 Construyendo resúmenes v10 para líderes (por PMO)${MODO_PRUEBA ? ' — 🧪 MODO PRUEBA' : ''}`);
console.log(`   - Procesados OK: ${successfulEmployees.length}`);
console.log(`   - Sin archivo: ${foldersWithoutFile.length}`);
console.log(`   - Errores totales: ${validationErrors.length}`);
console.log(`   - PMOs en catálogo: ${projectOwners.length}`);

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const SEVERITY_BY_TYPE = {
  'NO_FILE': 'critical', 'MISSING_MONTH_SHEET': 'critical', 'DUPLICATE_MONTH_SHEET': 'warning',
  'INVALID_TALENT_AND_LEADER': 'critical',
  'NON_SEQUENTIAL_CONSECUTIVE': 'warning',
  'EMPTY_SHEET': 'critical',
  'PARSE_ERROR': 'critical', 'EMPLOYEE_NOT_IN_CATALOG': 'critical',
  'MISSING_WEEK_PLANNING': 'critical',
  'NO_EMPLOYEE_NAME': 'warning', 'NAME_MISMATCH': 'warning', 'MISSING_LEADER': 'warning',
  'DUPLICATE_WEEK_TASKS': 'warning', 'DUPLICATE_CONSECUTIVE': 'warning',
  'DUPLICATE_TASK': 'warning', 'WEEK_NUMBER_MISMATCH': 'warning',
  'EXECUTED_HOURS_IN_FUTURE': 'warning', 'TASK_OVERDUE_IN_PLANNING': 'warning',
  'MISSING_PROJECT': 'warning', 'MISSING_ASSIGNEE': 'warning', 'ZERO_BUDGETED_HOURS': 'warning',
  'ESTIMATED_DATE_MISMATCH_WEEK': 'warning',
  'MISSING_CONSECUTIVE': 'info', 'MISSING_WEEK_NUMBER': 'info',
  'MISSING_ACTIVITY': 'info', 'MISSING_PLANNED_TYPE': 'info', 'MISSING_BUDGETED_HOURS': 'info',
  'MISSING_DELIVERY_DATE': 'info', 'MISSING_STATUS': 'info',
  'INVALID_STATUS': 'info', 'MISSING_OBSERVATIONS_BLOCKED': 'info'
};

const ERROR_LABELS = {
  'NO_FILE': 'Sin archivo cargado',
  'MISSING_MONTH_SHEET': 'Falta hoja del mes',
  'DUPLICATE_MONTH_SHEET': 'Múltiples pestañas del mismo mes',
  'INVALID_TALENT_AND_LEADER': 'Nombre del talento y líder sin diligenciar',
  'NON_SEQUENTIAL_CONSECUTIVE': 'Consecutivos no secuenciales en la semana',
  'EMPTY_SHEET': 'Hoja vacía',
  'PARSE_ERROR': 'Error al leer archivo',
  'EMPLOYEE_NOT_IN_CATALOG': 'Carpeta no reconocida',
  'MISSING_WEEK_PLANNING': 'Sin planeación para la semana actual',
  'NO_EMPLOYEE_NAME': 'Sin nombre del talento en B6',
  'NAME_MISMATCH': 'Nombre Excel ≠ carpeta',
  'MISSING_LEADER': 'Sin líder asignado en el archivo',
  'DUPLICATE_WEEK_TASKS': 'Bloques duplicados con la misma semana',
  'DUPLICATE_CONSECUTIVE': 'Consecutivos repetidos en la semana',
  'DUPLICATE_TASK': 'Tareas duplicadas en la misma semana',
  'WEEK_NUMBER_MISMATCH': 'Número de semana no coincide con el calendario',
  'EXECUTED_HOURS_IN_FUTURE': 'Horas ejecutadas en días futuros',
  'TASK_OVERDUE_IN_PLANNING': 'Tareas vencidas sin cerrar',
  'MISSING_PROJECT': 'Falta seleccionar proyecto en tareas',
  'MISSING_ASSIGNEE': 'Falta responsable ("A cargo de") en tareas',
  'ZERO_BUDGETED_HOURS': 'Tareas con 0 horas presupuestadas',
  'ESTIMATED_DATE_MISMATCH_WEEK': 'Fecha estimada no coincide con la semana declarada',
  'MISSING_CONSECUTIVE': 'Falta consecutivo',
  'MISSING_WEEK_NUMBER': 'Falta número de semana',
  'MISSING_ACTIVITY': 'Falta descripción de la actividad',
  'MISSING_PLANNED_TYPE': 'Falta marcar P o NP',
  'MISSING_BUDGETED_HOURS': 'Falta horas presupuestadas',
  'MISSING_DELIVERY_DATE': 'Falta fecha estimada de entrega',
  'MISSING_STATUS': 'Falta estado de la tarea',
  'INVALID_STATUS': 'Estado de tarea inválido',
  'MISSING_OBSERVATIONS_BLOCKED': 'Bloqueada sin observaciones',
  'TERMINATED_WITHOUT_DELIVERY_DATE': 'Tarea terminada sin fecha de entrega',
  'TT_INCONSISTENT': 'La columna TT no coincide con la suma de las horas del día',
  'NO_DATA_INGESTED': 'No se cargó ninguna tarea'
};

// =============================================================
// PASO 1: mapas auxiliares
// =============================================================

const folderToEmployee = {};
for (const emp of catalog) {
  const info = {
    canonical_name: emp.canonical_name,
    employee_id: emp.employee_id,
    employee_email: emp.email || null,
    fallback_leader_name: emp.leader_name || null,
    fallback_leader_email: emp.leader_email || null,
    // v10: proyecto de la ficha, para quien no tiene tareas de dónde sacarlo.
    catalog_project: emp.project_folder || null
  };

  if (emp.canonical_name) {
    folderToEmployee[normalizeName(emp.canonical_name)] = info;
  }

  let aliases = emp.aliases;
  if (typeof aliases === 'string') {
    try { aliases = JSON.parse(aliases); } catch (e) { aliases = []; }
  }
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      folderToEmployee[normalizeName(a)] = info;
    }
  }
}

// =============================================================
// v11: A QUIÉN LE LLEGA — un correo por EQUIPO de SharePoint.
// Cada persona pertenece a la carpeta de su Equipo ("Equipo 4 - Cesar
// Arbelaez"); el correo de ese Equipo va a sus PMs. El proyecto de cada
// tarea (MIA, Transversales...) ya NO decide a quién le llega: antes una
// persona con tareas de un proyecto caía en el correo de ese proyecto, y a
// Mónica le llegaban los Equipos 2, 3, 5 y 8 mezclados en un solo correo.
// Para cambiar los PMs de un Equipo: editar esta tabla.
// =============================================================
const PM = {
  juanCarlos: ['Juan Carlos Díaz', 'juancarlos@empresa.com'],
  sara:       ['Sara Piedad Lasso', 'sara@empresa.com'],
  monica:     ['Mónica Bastidas', MONITOREO_MONICA],
  cesar:      ['César Arbeláez', MONITOREO_CESAR],
  lucia:      ['Angela Lucia Trujillo', 'lucia@empresa.com'],
  chamorro:   ['Diego Chamorro', 'diego@empresa.com'],
  jair:       ['Jair Lucumi', 'gerencia@empresa.com'],
};
const PMS_POR_EQUIPO = {
  'Equipo 1': [PM.juanCarlos, PM.chamorro],
  'Equipo 2': [PM.sara],
  'Equipo 3': [PM.monica],
  'Equipo 4': [PM.cesar],
  'Equipo 5': [PM.juanCarlos, PM.monica],
  'Equipo 6': [PM.lucia],
  'Equipo 7': [PM.jair],
  'Equipo 8': [PM.monica],
  'Equipo 9': [PM.monica, PM.cesar],
};

const SIN_EQUIPO = 'Equipo sin identificar';

// Equipo de una persona: el de la carpeta donde está ("Filtrar carpetas
// válidas" lo guarda en folderToProject). Si no aparece ahí, se usa la
// etiqueta que traiga el registro, siempre que sea un Equipo ("Equipo 9").
function equipoDe(folder, etiqueta) {
  if (folder && folderToProject[folder]) return folderToProject[folder];
  if (etiqueta && /^equipo \d+$/i.test(String(etiqueta).trim())) return String(etiqueta).trim();
  return SIN_EQUIPO;
}

console.log(`🗺️  Equipos con PM: ${Object.keys(PMS_POR_EQUIPO).join(', ')}`);

// =============================================================
// PASO 2: estado consolidado por persona (una sola tarjeta por persona)
// =============================================================

const employeeState = {};

function nuevoEstado(folder, equipo, empInfo, extra) {
  return {
    folder_name: folder,
    canonical_name: empInfo.canonical_name || folder,
    equipo,
    employee_id: empInfo.employee_id || null,
    leader_name_excel: null,
    has_file: false,
    tasks_count: 0,
    errors_by_severity: { critical: 0, warning: 0, info: 0 },
    errors_by_type: {},
    rows_by_type: {},
    overdue_count: 0,
    status: 'perfect',
    ...extra
  };
}

for (const emp of successfulEmployees) {
  const folder = emp.employeeFolderName;
  const empInfo = folderToEmployee[normalizeName(folder)] || {};
  employeeState[folder] = nuevoEstado(folder, equipoDe(folder, emp.equipoFolder || emp.projectFolder), empInfo, {
    leader_name_excel: emp.leaderName,
    has_file: true,
    tasks_count: emp.tasksCount || (emp.tasks || []).length
  });
}

for (const f of foldersWithoutFile) {
  const folder = f.employeeFolderName;
  const empInfo = folderToEmployee[normalizeName(folder)] || {};
  if (!employeeState[folder]) {
    employeeState[folder] = nuevoEstado(folder, equipoDe(folder, f.projectFolder), empInfo, { status: 'no_file' });
  } else {
    employeeState[folder].has_file = false;
    employeeState[folder].status = 'no_file';
  }
}

for (const err of validationErrors) {
  const folder = err.employee_folder_name;
  if (!folder) continue;

  const empInfo = folderToEmployee[normalizeName(folder)] || {};
  if (!employeeState[folder]) {
    employeeState[folder] = nuevoEstado(folder, equipoDe(folder, err.project_folder), empInfo, { status: 'with_errors' });
  }
  const st = employeeState[folder];

  const severity = SEVERITY_BY_TYPE[err.error_type] || 'info';
  st.errors_by_severity[severity]++;
  st.errors_by_type[err.error_type] = (st.errors_by_type[err.error_type] || 0) + 1;
  // Filas del Excel donde está cada tipo de hallazgo (las trae el parser).
  if (Array.isArray(err.filas)) {
    const filas = st.rows_by_type[err.error_type] || (st.rows_by_type[err.error_type] = []);
    for (const f of err.filas) if (!filas.includes(f)) filas.push(f);
  }

  if (err.file_name && !st.file_name) {
    st.file_name = err.file_name;
  }

  if (err.error_type === 'TASK_OVERDUE_IN_PLANNING') {
    st.overdue_count++;
  }

  if (st.status === 'perfect') {
    st.status = 'with_errors';
  }
}

for (const k of Object.keys(employeeState)) {
  const e = employeeState[k];
  if (e.status !== 'with_errors') continue;

  const errorTypes = Object.keys(e.errors_by_type);
  if (errorTypes.length === 1 && errorTypes[0] === 'MISSING_MONTH_SHEET') {
    e.status = 'missing_month_sheet';
  }
}

for (const k of Object.keys(employeeState)) {
  const e = employeeState[k];
  e.total_findings = e.errors_by_severity.critical + e.errors_by_severity.warning + e.errors_by_severity.info;
}

// =============================================================
// PASO 3: agrupar por EQUIPO
// =============================================================
const byPMO = {};

for (const emp of Object.values(employeeState)) {
  const equipo = emp.equipo;
  if (!byPMO[equipo]) {
    const pms = PMS_POR_EQUIPO[equipo] || [];
    const nombres = pms.map(p => p[0]);
    byPMO[equipo] = {
      leader_name: nombres.length > 1
        ? `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`
        : (nombres[0] || 'equipo'),
      leader_email: pms.map(p => p[1]).join(', '),
      leader_source: pms.length ? 'equipo' : 'none',
      project_folder: equipo,
      employees: []
    };
  }
  byPMO[equipo].employees.push(emp);
}

console.log(`👥 Correos por Equipo: ${Object.keys(byPMO).length}`);
for (const g of Object.values(byPMO)) {
  console.log(`   • ${g.project_folder} → ${g.leader_name} <${g.leader_email || 'solo copias'}> (${g.employees.length} personas)`);
}

// =============================================================
// PASO 4: HTML del correo
// =============================================================

// "· filas 45, 52, 60" junto a cada hallazgo, para ubicarlo en el Excel. Se
// ordenan y se cortan en 15 para que el correo no crezca sin límite.
const MAX_FILAS = 15;
function textoFilas(filas) {
  if (!filas || !filas.length) return '';
  const orden = [...filas].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const visibles = orden.slice(0, MAX_FILAS).join(', ');
  const resto = orden.length > MAX_FILAS ? ` y ${orden.length - MAX_FILAS} más` : '';
  const una = orden.length === 1 && !String(orden[0]).includes('–');
  return `<span style="color:#555;font-size:12px"> · ${una ? 'fila' : 'filas'} <strong>${visibles}</strong>${resto}</span>`;
}

function renderEmployeeCard(emp, accentColor) {
  const e = emp.errors_by_severity;

  const badges = [];
  if (e.critical > 0) badges.push(`<span style="display:inline-block;background:#dc3545;color:white;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600;margin-left:8px">🔴 ${e.critical}</span>`);
  if (e.warning > 0) badges.push(`<span style="display:inline-block;background:#ffc107;color:#333;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600;margin-left:8px">🟡 ${e.warning}</span>`);
  if (e.info > 0) badges.push(`<span style="display:inline-block;background:#fd7e14;color:white;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600;margin-left:8px">🟠 ${e.info}</span>`);

  let bodyHtml = '';

  if (emp.status === 'no_file') {
    bodyHtml = `<div style="margin-top:10px;padding:10px 14px;background:#fff5f5;border-radius:4px;color:#dc3545;font-size:13px;font-weight:600">⛔ No subió archivo .xlsx — su planeación no se pudo analizar hoy</div>`;
  } else if (emp.status === 'missing_month_sheet') {
    const fileNameLabel = emp.file_name ? `"${emp.file_name}"` : 'su archivo';
    bodyHtml = `<div style="margin-top:10px;padding:10px 14px;background:#fff8ed;border-radius:4px;color:#b35900;font-size:13px;font-weight:600">📄 Subió ${fileNameLabel} pero la pestaña del Excel no se llama "${ctx.monthName}" — el sistema no pudo procesar sus tareas</div>`;
  } else {
    const typesArr = Object.entries(emp.errors_by_type)
      .map(([type, count]) => ({
        type,
        count,
        label: ERROR_LABELS[type] || type,
        rows: emp.rows_by_type[type] || [],
        severity: SEVERITY_BY_TYPE[type] || 'info'
      }))
      .sort((a, b) => b.count - a.count);

    if (typesArr.length > 0) {
      const sevDot = { critical: '🔴', warning: '🟡', info: '🟠' };
      const listItems = typesArr.map(t => `
        <li style="margin:5px 0;line-height:1.5;color:#444;font-size:13px">
          ${sevDot[t.severity]} ${t.label}
          <span style="color:#888;font-weight:500"> — ${t.count} ${t.count === 1 ? 'caso' : 'casos'}</span>${textoFilas(t.rows)}
        </li>
      `).join('');

      bodyHtml = `
        <div style="margin-top:10px;padding:10px 14px;background:#fafafa;border-radius:4px">
          <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">Hallazgos detectados</div>
          <ul style="margin:0;padding-left:18px;list-style:none">${listItems}</ul>
        </div>
      `;
    }
  }

  const statusBadge = emp.status === 'no_file'
    ? `<span style="display:inline-block;background:#dc3545;color:white;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600">SIN ARCHIVO</span>`
    : emp.status === 'missing_month_sheet'
    ? `<span style="display:inline-block;background:#fd7e14;color:white;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600">SIN HOJA DEL MES</span>`
    : emp.status === 'perfect'
    ? `<span style="display:inline-block;background:#28a745;color:white;padding:4px 11px;border-radius:11px;font-size:11px;font-weight:600">✓ IMPECABLE</span>`
    : '';

  const tasksInfo = emp.has_file && emp.tasks_count > 0
    ? ` <span style="color:#999;font-size:13px;font-weight:normal">· ${emp.tasks_count} tareas</span>`
    : '';

  const totalLabel = emp.total_findings > 0 && emp.status !== 'no_file' && emp.status !== 'missing_month_sheet'
    ? `<div style="font-size:12px;color:#666;margin-top:3px">${emp.total_findings} ${emp.total_findings === 1 ? 'hallazgo' : 'hallazgos'} en total</div>`
    : '';

  return `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff;border-left:4px solid ${accentColor};margin:12px 0;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <tr><td style="padding:14px 16px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-size:15px;font-weight:bold;color:#222;vertical-align:top">
              👤 ${emp.canonical_name || emp.folder_name}${tasksInfo}
              ${totalLabel}
            </td>
            <td align="right" style="white-space:nowrap;vertical-align:top">
              ${statusBadge}${badges.join('')}
            </td>
          </tr>
        </table>
        ${bodyHtml}
      </td></tr>
    </table>
  `;
}

// Los correos muestran el/los Equipo(s) de SharePoint de las personas del
// correo ("Equipo 4"), nunca el nombre del proyecto. El proyecto solo se usa
// por dentro para decidir a quién le llega. Si no se conoce el Equipo de
// nadie, se muestra el proyecto.
function equipoDelCorreo(leaderData) {
  const equipos = [...new Set(leaderData.employees.map(e => e.equipo).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  return equipos.length ? equipos.join(' · ') : leaderData.project_folder;
}

function buildLeaderEmail(leaderData) {
  const employees = leaderData.employees;
  const titulo = equipoDelCorreo(leaderData);

  const totalTeam = employees.length;
  const perfectCount = employees.filter(e => e.status === 'perfect').length;
  const noFileCount = employees.filter(e => e.status === 'no_file').length;
  const missingSheetCount = employees.filter(e => e.status === 'missing_month_sheet').length;
  const withFindingsCount = employees.filter(e =>
    e.status === 'with_errors' || e.status === 'no_file' || e.status === 'missing_month_sheet'
  ).length;
  const teamOverdueTotal = employees.reduce((s, e) => s + e.overdue_count, 0);

  const noFileSection = employees
    .filter(e => e.status === 'no_file')
    .sort((a, b) => (a.canonical_name || '').localeCompare(b.canonical_name || ''));

  const missingSheetSection = employees
    .filter(e => e.status === 'missing_month_sheet')
    .sort((a, b) => (a.canonical_name || '').localeCompare(b.canonical_name || ''));

  const criticalSection = employees
    .filter(e => e.status === 'with_errors' && e.errors_by_severity.critical > 0)
    .sort((a, b) => b.total_findings - a.total_findings);

  const warningSection = employees
    .filter(e => e.status === 'with_errors' && e.errors_by_severity.critical === 0 && e.errors_by_severity.warning > 0)
    .sort((a, b) => b.total_findings - a.total_findings);

  const infoSection = employees
    .filter(e => e.status === 'with_errors' && e.errors_by_severity.critical === 0 && e.errors_by_severity.warning === 0 && e.errors_by_severity.info > 0)
    .sort((a, b) => b.total_findings - a.total_findings);

  const perfectSection = employees
    .filter(e => e.status === 'perfect')
    .sort((a, b) => (a.canonical_name || '').localeCompare(b.canonical_name || ''));

  const noFileAlertHtml = noFileCount > 0 ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff5f5;border:2px solid #dc3545;border-radius:8px;margin:0 0 20px 0">
      <tr><td style="padding:14px 18px">
        <div style="font-size:14px;font-weight:bold;color:#dc3545;margin-bottom:4px">⛔ ${noFileCount} ${noFileCount === 1 ? 'persona NO subió archivo' : 'personas NO subieron archivo'}</div>
        <div style="font-size:13px;color:#7d2a2a">Su planeación no se pudo analizar. Es la situación más urgente del día y suele resolverse con un mensaje rápido.</div>
      </td></tr>
    </table>
  ` : '';

  const missingSheetAlertHtml = missingSheetCount > 0 ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff8ed;border:2px solid #fd7e14;border-radius:8px;margin:0 0 20px 0">
      <tr><td style="padding:14px 18px">
        <div style="font-size:14px;font-weight:bold;color:#b35900;margin-bottom:4px">📄 ${missingSheetCount} ${missingSheetCount === 1 ? 'persona subió archivo pero sin hoja del mes' : 'personas subieron archivo pero sin hoja del mes'}</div>
        <div style="font-size:13px;color:#7d4900">Subieron el .xlsx pero la pestaña interna no se llama "${ctx.monthName}", así que el sistema no pudo procesar sus tareas. Suele resolverse en 30 segundos pidiéndoles renombrar la pestaña.</div>
      </td></tr>
    </table>
  ` : '';

  const noFileSectionHtml = noFileSection.length > 0 ? `
    <h3 style="color:#dc3545;margin-top:24px;margin-bottom:8px;font-size:16px">⛔ Sin archivo cargado — ${noFileSection.length}</h3>
    ${noFileSection.map(e => renderEmployeeCard(e, '#dc3545')).join('')}
  ` : '';

  const missingSheetSectionHtml = missingSheetSection.length > 0 ? `
    <h3 style="color:#b35900;margin-top:24px;margin-bottom:8px;font-size:16px">📄 Sin hoja del mes "${ctx.monthName}" — ${missingSheetSection.length}</h3>
    <p style="color:#666;font-size:13px;margin:0 0 8px 0">Subieron archivo pero la pestaña interna del Excel no se llama "${ctx.monthName}". No se pudieron procesar sus tareas hasta que renombren la pestaña.</p>
    ${missingSheetSection.map(e => renderEmployeeCard(e, '#fd7e14')).join('')}
  ` : '';

  const criticalHtml = criticalSection.length > 0 ? `
    <h3 style="color:#dc3545;margin-top:24px;margin-bottom:8px;font-size:16px">🔴 Críticos — ${criticalSection.length}</h3>
    <p style="color:#666;font-size:13px;margin:0 0 8px 0">Tienen errores que impiden o degradan severamente el procesamiento.</p>
    ${criticalSection.map(e => renderEmployeeCard(e, '#dc3545')).join('')}
  ` : '';

  const warningHtml = warningSection.length > 0 ? `
    <h3 style="color:#e0a800;margin-top:24px;margin-bottom:8px;font-size:16px">🟡 Por revisar — ${warningSection.length}</h3>
    <p style="color:#666;font-size:13px;margin:0 0 8px 0">Archivos procesados con advertencias de calidad de datos.</p>
    ${warningSection.map(e => renderEmployeeCard(e, '#ffc107')).join('')}
  ` : '';

  const infoHtml = infoSection.length > 0 ? `
    <h3 style="color:#fd7e14;margin-top:24px;margin-bottom:8px;font-size:16px">🟠 Detalles menores — ${infoSection.length}</h3>
    <p style="color:#666;font-size:13px;margin:0 0 8px 0">Campos por completar en tareas individuales (no bloquean el procesamiento).</p>
    ${infoSection.map(e => renderEmployeeCard(e, '#fd7e14')).join('')}
  ` : '';

  const perfectHtml = perfectSection.length > 0 ? `
    <h3 style="color:#28a745;margin-top:24px;margin-bottom:8px;font-size:16px">🏆 Impecables — ${perfectSection.length}</h3>
    <p style="color:#666;font-size:13px;margin:0 0 8px 0">Planeación sin errores detectados. Considera reconocer su trabajo.</p>
    ${perfectSection.map(e => renderEmployeeCard(e, '#28a745')).join('')}
  ` : '';

  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:760px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <tr><td style="background:#11998e;color:white;padding:24px;text-align:center">
      <h1 style="margin:0;font-size:22px;color:white">📊 Estado diario de planeación · ${titulo}</h1>
      <p style="margin:8px 0 0 0;opacity:0.9;font-size:14px;color:white">${ctx.monthName} ${ctx.yearNumber} · ${ctx.snapshotDate}</p>
    </td></tr>

    <tr><td style="padding:24px">
      <p style="font-size:16px;margin-top:0;color:#333">Hola <strong>${leaderData.leader_name}</strong>,</p>
      <p style="color:#555;line-height:1.6">Aquí está el resumen de cómo amaneció hoy la planeación del <strong>${titulo}</strong>. Cada colaborador recibió por separado el detalle de qué corregir; este correo te da la vista consolidada para que priorices conversaciones.</p>

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8f9fa;border-radius:8px;margin:20px 0">
        <tr>
          <td align="center" width="25%" style="padding:18px 8px;border-right:1px solid #e0e0e0">
            <div style="font-size:30px;font-weight:bold;color:#333;line-height:1">${totalTeam}</div>
            <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:0.5px">${titulo.toUpperCase()}</div>
          </td>
          <td align="center" width="25%" style="padding:18px 8px;border-right:1px solid #e0e0e0">
            <div style="font-size:30px;font-weight:bold;color:${withFindingsCount > 0 ? '#e0a800' : '#28a745'};line-height:1">${withFindingsCount}</div>
            <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:0.5px">CON HALLAZGOS</div>
          </td>
          <td align="center" width="25%" style="padding:18px 8px;border-right:1px solid #e0e0e0">
            <div style="font-size:30px;font-weight:bold;color:#28a745;line-height:1">${perfectCount}</div>
            <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:0.5px">IMPECABLES</div>
          </td>
          <td align="center" width="25%" style="padding:18px 8px">
            <div style="font-size:30px;font-weight:bold;color:${teamOverdueTotal > 0 ? '#dc3545' : '#28a745'};line-height:1">${teamOverdueTotal}</div>
            <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:0.5px">TAREAS VENCIDAS</div>
          </td>
        </tr>
      </table>

      ${noFileAlertHtml}
      ${missingSheetAlertHtml}
      ${noFileSectionHtml}
      ${missingSheetSectionHtml}
      ${criticalHtml}
      ${warningHtml}
      ${infoHtml}
      ${perfectHtml}

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e8f4f8;border-radius:6px;margin-top:24px">
        <tr><td style="padding:14px;font-size:13px;color:#0c5460">
          💡 <strong>¿Cómo leer este resumen?</strong> El sistema valida cada mañana los archivos de planeación del <strong>${titulo}</strong>. Los hallazgos se agrupan por tipo y muestran cuántos casos hay de cada uno. Las "tareas vencidas" son fechas estimadas que ya pasaron sin que la tarea se marque como Terminado — es la métrica más accionable del día a día. Cada persona ya recibió su correo con el detalle.
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="background:#f8f9fa;padding:16px;text-align:center;color:#999;font-size:12px">
      Sistema RPA de Planeación · ${ctx.executionId}<br>No responder a este correo
    </td></tr>
  </table>
</body></html>`;
}

// =============================================================
// PASO 5: emitir 1 item por (PMO × proyecto)
// =============================================================
const emails = [];
let skippedNoEmail = 0;

for (const leaderData of Object.values(byPMO)) {
  if (!leaderData.leader_email) {
    console.log(`   ⚠️ ${leaderData.project_folder} no tiene PM en PMS_POR_EQUIPO — solo le llega a las copias universales`);
  }

  const totalEmps = leaderData.employees.length;
  const noFile = leaderData.employees.filter(e => e.status === 'no_file').length;
  const missingSheet = leaderData.employees.filter(e => e.status === 'missing_month_sheet').length;
  const withFindings = leaderData.employees.filter(e => e.status !== 'perfect').length;
  const overdue = leaderData.employees.reduce((s, e) => s + e.overdue_count, 0);
  const equipo = equipoDelCorreo(leaderData);

  let subject;
  if (noFile > 0 && missingSheet > 0) {
    subject = `⛔ [${equipo}] ${noFile} sin archivo + ${missingSheet} sin hoja "${ctx.monthName}"`;
  } else if (noFile > 0) {
    subject = `⛔ [${equipo}] ${noFile} ${noFile === 1 ? 'persona no subió' : 'personas no subieron'} archivo hoy`;
  } else if (missingSheet > 0) {
    subject = `📄 [${equipo}] ${missingSheet} ${missingSheet === 1 ? 'archivo sin hoja' : 'archivos sin hoja'} "${ctx.monthName}"`;
  } else if (overdue >= 10) {
    subject = `🔴 [${equipo}] ${overdue} tareas vencidas en tu equipo · ${withFindings}/${totalEmps} con hallazgos`;
  } else if (withFindings > 0) {
    subject = `📊 [${equipo}] ${withFindings}/${totalEmps} con hallazgos hoy`;
  } else {
    subject = `🏆 [${equipo}] Tu equipo está impecable hoy (${totalEmps}/${totalEmps})`;
  }

  // SUBJECT_DIGEST_V1: el sábado el correo es el consolidado semanal.
  const finalSubject = isSaturdayDigest
    ? `📊 CONSOLIDADO SEMANAL · ${subject}`
    : subject;

  // Destinatarios reales: el/los PM del Equipo + las copias universales
  // (Emily, César, Mónica). Se deduplica cuando César o Mónica ya son PM del
  // Equipo (Equipos 3, 4, 5, 8 y 9). El CEO NO va en copia: solo recibe el
  // correo del Equipo 7, porque ahí es el PM (tabla PMS_POR_EQUIPO).
  const destinatariosReales = (() => {
    const raw = [
      ...String(leaderData.leader_email || '').split(',').map(s => s.trim()).filter(Boolean),
      ...COPIAS_UNIVERSALES,
    ];
    const dedup = [];
    const seen = new Set();
    for (const e of raw) {
      const key = e.toLowerCase();
      if (!seen.has(key)) { seen.add(key); dedup.push(e); }
    }
    return dedup;
  })();

  const destinatarios = destinatariosFinales(destinatariosReales);
  if (destinatarios.length === 0) {
    skippedNoEmail += leaderData.employees.length;
    console.log(`   🧪 [PRUEBA] ${leaderData.project_folder}: nadie de ${destinatariosReales.join(', ')} tiene buzón de prueba — no se envía`);
    continue;
  }

  // En prueba, el cuerpo arranca con un recuadro que dice a quién le habría
  // llegado de verdad — así se verifica el enrutamiento sin molestar a nadie.
  const bannerPrueba = MODO_PRUEBA
    ? `<div style="max-width:760px;margin:0 auto 12px auto;padding:12px 16px;background:#fff3cd;border:2px dashed #e0a800;border-radius:8px;font-family:Arial,sans-serif;font-size:13px;color:#664d03">
        🧪 <strong>CORREO DE PRUEBA</strong> — en producción le llegaría a:<br>
        <strong>${destinatariosReales.join(', ')}</strong><br>
        Saludo: "${leaderData.leader_name}" · ${equipo}
      </div>`
    : '';

  emails.push({
    recipient_email: destinatarios.join(', '),
    recipient_email_real: destinatariosReales.join(', '),
    recipient_name: leaderData.leader_name,
    recipient_type: isSaturdayDigest ? 'leader_validation_weekly_digest' : 'leader_validation_summary',
    subject: `[PLANEACION] ${finalSubject}`,
    body_html: buildLeaderEmail(leaderData).replace('<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">',
      m => m + bannerPrueba),
    snapshot_date: ctx.snapshotDate,
    project_folder: leaderData.project_folder,
    team_size: totalEmps,
    no_file_count: noFile,
    overdue_count: overdue
  });
}

console.log(`\n📧 Correos a líderes (por PMO × proyecto): ${emails.length}`);
if (skippedNoEmail > 0) {
  console.log(`   ⚠️ ${skippedNoEmail} empleados sin reporte (líder sin email)`);
}

if (emails.length === 0) return [];
return emails.map(e => ({ json: e }));
