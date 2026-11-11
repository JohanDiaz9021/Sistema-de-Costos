/* global $, $getWorkflowStaticData -- globales del nodo Code de n8n */
// =============================================================
// CONSTRUIR CORREOS DE VALIDACIÓN PARA EMPLEADOS — v16 PRODUCCIÓN
// 🔧 v16 (2026-10-23): el correo "impecable" decía "Tu líder <X>" con lo que
//     la persona escribió en "Líder de equipo" del Excel (a Oscar Naranjo,
//     Equipo 2, le salió Jonathan Anaya aunque su PM es Sara). Ahora nombra
//     a los PMs de su Equipo (tabla PMS_POR_EQUIPO, que pasa a llevar nombre
//     y correo como en "Construir correos líderes"). El Excel solo se usa si
//     no se conoce el Equipo.
// 🔧 v15 (2026-10-22): Se agrega Mónica Bastidas al CC universal. Ahora
//     todos los correos individuales van a empleado + PMs del Equipo +
//     Emily + César + Mónica. El caso especial Thomas Medina → Mónica (v11)
//     se retira porque ya queda cubierto.
// 🔧 (2026-10-14): Angela Lucia Trujillo pasa a líder del Equipo 6 (QA) en
//     lugar de Jonathan Ariza, que pasó a Backup.
// 🔧 v14 (2026-10-02): el correo individual va al empleado + los PMs de SU
//     EQUIPO de SharePoint (tabla PMS_POR_EQUIPO, la misma de "Construir
//     correos líderes") + Emily y César. Ya no se copia al PM del proyecto
//     de sus tareas ni se usa la regla especial de QA (v13): Equipo 6 →
//     Jonathan Ariza y Diego Chamorro por tabla.
// 🔧 v13 (2026-10-01): QA se reporta POR PERSONA. Quien tenga 'QA' en su
//     ficha (mp_employees.project_folder) recibe su correo con copia SOLO a
//     Jonathan Ariza y Diego Chamorro: sin el PM del módulo que probó
//     (MIA, Document Online...), sin Emily, sin César y sin Mónica.
//     Se retira el caso especial Jhohan Alarcón → Mónica (v9); Thomas
//     Medina → Mónica sigue. El asunto y el encabezado muestran el EQUIPO de
//     SharePoint de la persona ("Equipo 4"), nunca el nombre del proyecto.
// 🔧 v12 (2026-08-25): Se agrega César Arbeláez al CC universal. Ahora
//     todos los correos individuales van a empleado + PMO + Emily + César
//     (deduplicando cuando César ya es PMO del proyecto — ej. SESCOL).
// 🔧 v11 (2026-08-25): Se agrega Thomas Medina Trujillo (UX) a los casos
//     especiales que copian a Mónica Bastidas. El bloque de casos especiales
//     se refactorizó a un mapa EXTRA_CC_BY_FOLDER extensible para no tener
//     que agregar constantes nuevas cada vez que aparece un caso similar.
// 🔧 v10 (2026-08-25): Se retira Johana del CC universal. Antes iba copiada
//     en TODOS los correos individuales a empleados. Ahora Emily es la única
//     en monitoreo. Johana solo aparece si es PMO del proyecto del recurso
//     (que actualmente ya no lidera QA ni UX — pasaron a Jonathan Ariza).
// 🔧 v9:
//   - CASO ESPECIAL hardcodeado: los correos de Jhohan Alarcón (QA) se copian
//     también a Monica Bastidas. Aplica SOLO a este recurso, no a todo QA.
// 🔧 v8:
//   - Nuevos tipos ZERO_BUDGETED_HOURS y MISSING_WEEK_PLANNING en errorLabels
//   - MISSING_PROJECT y MISSING_ASSIGNEE promovidos a warning
//   - Filtro por semana ahora deja pasar errores ESTRUCTURALES (duplicados,
//     consecutivos rotos, sin planeación semana actual) aunque sean de otra semana
// =============================================================
const ctx = $('Generar contexto ejecución').first().json;
const staticData = $getWorkflowStaticData('global');
const allValidationErrors = staticData.validationErrors || [];
const successfulEmployees = staticData.successfulEmployees || [];
// Carpeta de la persona → Equipo de SharePoint ("Equipo 4"). Lo llena "Filtrar
// carpetas válidas". Los correos muestran el Equipo, nunca el proyecto.
const folderToEquipo = staticData.folderToProject || {};

// FILTRO_WEEK_RECURSO_V2: el recurso ve hallazgos de la semana actual +
// errores file-level (week_number=null) + errores ESTRUCTURALES del archivo
// aunque sean de otra semana. Los duplicados/consecutivos rotos son problemas
// del archivo entero, no de una semana concreta, así que deben verse siempre.
const STRUCTURAL_TYPES = new Set([
  'DUPLICATE_WEEK_TASKS',
  'DUPLICATE_CONSECUTIVE',
  'NON_SEQUENTIAL_CONSECUTIVE',
  'DUPLICATE_TASK',
  'MISSING_WEEK_PLANNING'
]);
const currentWeek = staticData.currentMonthWeek;
const validationErrors = allValidationErrors.filter(e => {
  if (e.week_number === null || e.week_number === undefined) return true;
  if (STRUCTURAL_TYPES.has(e.error_type)) return true;
  return Number(e.week_number) === Number(currentWeek);
});
console.log(`📅 Filtro semana actual (recurso): ${allValidationErrors.length} → ${validationErrors.length} (semana=${currentWeek})`);


// 🆕 Catálogo de empleados para resolver email real
const catalog = $('Cargar catálogo empleados (early)').all().map(i => i.json);


// 🆕 Constantes de monitoreo — Emily + César (v12) + Mónica (v15) en TODOS
// los correos individuales. Johana ya no va en el CC universal (solo si es PMO).
const MONITOREO_EMILY = 'emily@empresa.com';
const MONITOREO_CESAR = 'cesar@empresa.com';
const MONITOREO_MONICA = 'monica@empresa.com';

// 🎯 CASOS ESPECIALES hardcodeados: recursos cuyos correos individuales de
// validación deben copiarse a personas extras (además del flujo normal
// empleado + PMO + monitoreo). Formato: normalizedFolderName → [array de emails].
// Los nombres del folder van SIN acentos y en minúsculas (ver normalizeName).
const EXTRA_CC_BY_FOLDER = {
  // Juan José Vera → Gustavo Palacios (arquitecto) recibe copia (2026-10-02)
  'juan jose vera valencia': ['gustavo@empresa.com'],
  'juan jose vera': ['gustavo@empresa.com'],
  'juan vera': ['gustavo@empresa.com'],
};

// v14: PMs de cada Equipo de SharePoint — la MISMA tabla que "Construir
// correos líderes". El correo individual va en copia a los PMs del Equipo de
// la persona (no al PM del proyecto de sus tareas). v16: [nombre, correo]; el
// nombre es el que sale en "Tu líder ..." del correo impecable.
const PM = {
  juanCarlos: ['Juan Carlos Díaz', 'juancarlos@empresa.com'],
  sara:       ['Sara Piedad Lasso', 'sara@empresa.com'],
  monica:     ['Mónica Bastidas', MONITOREO_MONICA],
  cesar:      ['César Arbeláez', MONITOREO_CESAR],
  lucia:      ['Angela Lucia Trujillo', 'lucia@empresa.com'],
  chamorro:   ['Diego Chamorro', 'diego@empresa.com'],
  // El CEO (Jair) NO va en el CC universal: solo recibe los correos de las
  // personas del Equipo 7, donde es el PM.
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

// "Tu líder Sara Piedad Lasso" / "Tus líderes Juan Carlos Díaz y Diego
// Chamorro". Sin Equipo conocido, se usa el "Líder de equipo" del Excel.
function textoLideres(equipo, liderExcel) {
  const nombres = (PMS_POR_EQUIPO[equipo] || []).map(p => p[0]);
  if (nombres.length > 1) {
    return `Tus líderes <strong>${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}</strong> ya tienen`;
  }
  return `Tu líder <strong>${nombres[0] || liderExcel || 'tu líder'}</strong> ya tiene`;
}

// 🆕 Mapa folderName → email real (case-insensitive, soporta aliases)
function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const folderToEmail = {};
for (const emp of catalog) {
  if (!emp.email) continue;
  let aliases = emp.aliases;
  if (typeof aliases === 'string') {
    try { aliases = JSON.parse(aliases); } catch (e) { aliases = []; }
  }
  const nombres = [emp.canonical_name, ...(Array.isArray(aliases) ? aliases : [])]
    .filter(Boolean).map(normalizeName);
  for (const n of nombres) folderToEmail[n] = emp.email;
}

// Equipo de la persona: el de su carpeta en SharePoint. Si no aparece, la
// etiqueta del registro cuando es un Equipo ("Equipo 9").
function equipoDe(folderName, etiqueta) {
  if (folderName && folderToEquipo[folderName]) return folderToEquipo[folderName];
  if (etiqueta && /^equipo \d+$/i.test(String(etiqueta).trim())) return String(etiqueta).trim();
  return null;
}

console.log(`📇 Catálogo mapeado: ${Object.keys(folderToEmail).length} carpetas → email`);

// Destinatarios: empleado + PMs de su Equipo + Emily + César + Mónica (+ casos especiales)
function buildRecipient(folderName, equipo) {
  const normFolder = normalizeName(folderName);
  const empEmail = folderToEmail[normFolder];
  const parts = [];
  if (empEmail) parts.push(empEmail);
  // v14: copia a los PMs del Equipo de la persona
  for (const [, pm] of PMS_POR_EQUIPO[equipo] || []) {
    if (!parts.includes(pm)) parts.push(pm);
  }
  // v12/v15: Emily + César + Mónica en el CC universal (dedup si ya son PM del Equipo)
  if (!parts.includes(MONITOREO_EMILY)) parts.push(MONITOREO_EMILY);
  if (!parts.includes(MONITOREO_CESAR)) parts.push(MONITOREO_CESAR);
  if (!parts.includes(MONITOREO_MONICA)) parts.push(MONITOREO_MONICA);
  // 🎯 Casos especiales hardcodeados — CCs extras por recurso específico
  const extraCCs = EXTRA_CC_BY_FOLDER[normFolder] || [];
  for (const extra of extraCCs) {
    if (!parts.includes(extra)) {
      parts.push(extra);
      console.log(`   🎯 Caso especial: agregando ${extra} para "${folderName}"`);
    }
  }
  if (!empEmail) console.log(`   ⚠️ Sin email para "${folderName}" — solo PMO + monitoreo recibirán`);
  return parts.join(', ');
}

const byEmployee = {};
for (const err of validationErrors) {
  const key = err.employee_folder_name || 'sin_carpeta';
  if (!byEmployee[key]) {
    byEmployee[key] = {
      folder: err.employee_folder_name,
      file: err.file_name,
      equipo: equipoDe(err.employee_folder_name, err.project_folder),
      errorsByType: {}
    };
  }
  if (!byEmployee[key].errorsByType[err.error_type]) {
    byEmployee[key].errorsByType[err.error_type] = [];
  }
  byEmployee[key].errorsByType[err.error_type].push(err.error_message);
}

const perfectEmployees = [];
for (const emp of successfulEmployees) {
  if (!byEmployee[emp.employeeFolderName]) {
    perfectEmployees.push({
      folder: emp.employeeFolderName,
      file: emp.fileName,
      tasksCount: emp.tasksCount,
      leaderName: emp.leaderName,
      equipo: equipoDe(emp.employeeFolderName, emp.equipoFolder || emp.projectFolder)
    });
  }
}

console.log(`📊 Empleados con errores: ${Object.keys(byEmployee).length}`);
console.log(`🏆 Empleados perfectos: ${perfectEmployees.length}`);

const errorLabels = {
  'NO_FILE': { emoji: '🔴', label: 'Sin archivo cargado', severity: 'critical' },
  'MISSING_MONTH_SHEET': { emoji: '🔴', label: 'Falta hoja del mes', severity: 'critical' },
  'DUPLICATE_MONTH_SHEET': { emoji: '🟡', label: 'Múltiples pestañas del mismo mes', severity: 'warning' },
  'INVALID_TALENT_AND_LEADER': { emoji: '🔴', label: 'Nombre del talento y líder sin diligenciar', severity: 'critical' },
  'NON_SEQUENTIAL_CONSECUTIVE': { emoji: '🟡', label: 'Consecutivos no secuenciales', severity: 'warning' },
  'EMPTY_SHEET': { emoji: '🔴', label: 'Hoja vacía', severity: 'critical' },
  'PARSE_ERROR': { emoji: '🔴', label: 'Error al leer archivo', severity: 'critical' },
  'EMPLOYEE_NOT_IN_CATALOG': { emoji: '🔴', label: 'Carpeta no reconocida', severity: 'critical' },
  'MISSING_WEEK_PLANNING': { emoji: '🔴', label: 'Sin planeación para la semana actual', severity: 'critical' },
  'NO_EMPLOYEE_NAME': { emoji: '🟡', label: 'Sin nombre del talento en B6', severity: 'warning' },
  'NAME_MISMATCH': { emoji: '🟡', label: 'Nombre del Excel no coincide con carpeta', severity: 'warning' },
  'MISSING_LEADER': { emoji: '🟡', label: 'Sin líder ("A cargo de")', severity: 'warning' },
  'DUPLICATE_WEEK_TASKS': { emoji: '🟡', label: 'Bloques de tareas con la misma semana', severity: 'warning' },
  'DUPLICATE_CONSECUTIVE': { emoji: '🟡', label: 'Números de consecutivo repetidos', severity: 'warning' },
  'DUPLICATE_TASK': { emoji: '🟡', label: 'Tareas idénticas duplicadas en la misma semana', severity: 'warning' },
  'WEEK_NUMBER_MISMATCH': { emoji: '🟡', label: 'Número de semana no coincide con la semana actual', severity: 'warning' },
  'EXECUTED_HOURS_IN_FUTURE': { emoji: '🟡', label: 'Horas ejecutadas en días que aún no han transcurrido', severity: 'warning' },
  'TASK_OVERDUE_IN_PLANNING': { emoji: '🟡', label: 'Tareas vencidas sin cerrar', severity: 'warning' },
  'MISSING_PROJECT': { emoji: '🟡', label: 'Falta seleccionar proyecto en tareas', severity: 'warning' },
  'MISSING_ASSIGNEE': { emoji: '🟡', label: 'Falta responsable ("A cargo de") en tareas', severity: 'warning' },
  'ZERO_BUDGETED_HOURS': { emoji: '🟡', label: 'Tareas con 0 horas presupuestadas', severity: 'warning' },
  'ESTIMATED_DATE_MISMATCH_WEEK': { emoji: '🟡', label: 'Fecha estimada no coincide con la semana declarada', severity: 'warning' },
  'MISSING_CONSECUTIVE': { emoji: '🟠', label: 'Falta consecutivo en columna A', severity: 'info' },
  'MISSING_WEEK_NUMBER': { emoji: '🟠', label: 'Falta número de semana', severity: 'info' },
  'MISSING_ACTIVITY': { emoji: '🟠', label: 'Falta descripción de actividad', severity: 'info' },
  'MISSING_PLANNED_TYPE': { emoji: '🟠', label: 'Falta marcar P/NP', severity: 'info' },
  'MISSING_BUDGETED_HOURS': { emoji: '🟠', label: 'Falta horas presupuestadas', severity: 'info' },
  'MISSING_DELIVERY_DATE': { emoji: '🟠', label: 'Falta fecha estimada', severity: 'info' },
  'MISSING_STATUS': { emoji: '🟠', label: 'Falta estado', severity: 'info' },
  'INVALID_STATUS': { emoji: '🟠', label: 'Estado no válido', severity: 'info' },
  'MISSING_OBSERVATIONS_BLOCKED': { emoji: '🟠', label: 'Bloqueada sin observaciones', severity: 'info' }
};

function buildErrorEmail(empData) {
  const folder = empData.folder;
  const errorsByType = empData.errorsByType;
  const totalErrors = Object.values(errorsByType).reduce((s, arr) => s + arr.length, 0);

  const critical = [], warnings = [], infos = [];
  for (const [type, messages] of Object.entries(errorsByType)) {
    const info = errorLabels[type] || { emoji: '⚠️', label: type, severity: 'info' };
    const item = { type, info, messages };
    if (info.severity === 'critical') critical.push(item);
    else if (info.severity === 'warning') warnings.push(item);
    else infos.push(item);
  }

  function renderSection(items, color) {
    return items.map(item => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff;border-left:4px solid ${color};margin:12px 0;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
        <tr><td style="padding:14px">
          <div style="font-size:14px;font-weight:bold;color:#333;margin-bottom:8px">
            ${item.info.emoji} ${item.info.label}
            <span style="color:#999;font-weight:normal">(${item.messages.length} ${item.messages.length === 1 ? 'caso' : 'casos'})</span>
          </div>
          <ul style="margin:8px 0 0 0;padding-left:20px;font-size:13px;color:#555">
            ${item.messages.slice(0, 10).map(m => `<li style="margin:4px 0;line-height:1.5">${m}</li>`).join('')}
            ${item.messages.length > 10 ? `<li style="color:#999;font-style:italic">... y ${item.messages.length - 10} más</li>` : ''}
          </ul>
        </td></tr>
      </table>
    `).join('');
  }

  const criticalHtml = critical.length > 0 ? `<h3 style="color:#dc3545;margin-top:20px;font-size:16px">🔴 CRÍTICOS — impiden el procesamiento</h3>${renderSection(critical, '#dc3545')}` : '';
  const warningsHtml = warnings.length > 0 ? `<h3 style="color:#e0a800;margin-top:20px;font-size:16px">🟡 IMPORTANTES — calidad de datos</h3>${renderSection(warnings, '#ffc107')}` : '';
  const infosHtml = infos.length > 0 ? `<h3 style="color:#fd7e14;margin-top:20px;font-size:16px">🟠 EN TUS TAREAS — completa estos campos</h3>${renderSection(infos, '#fd7e14')}` : '';

  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:680px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <tr><td style="background:#f39c12;color:white;padding:24px;text-align:center">
      <h1 style="margin:0;font-size:22px;color:white">📋 Acciones requeridas en tu planeación</h1>
      ${empData.equipo ? `<p style="margin:6px 0 0 0;opacity:0.95;font-size:13px;color:white;font-weight:600">📂 ${empData.equipo}</p>` : ''}
      <p style="margin:8px 0 0 0;opacity:0.9;font-size:14px;color:white">${ctx.monthName} ${ctx.yearNumber} · ${ctx.snapshotDate}</p>
    </td></tr>
    <tr><td style="padding:24px">
      <p style="font-size:16px;margin-top:0;color:#333">Hola <strong>${folder}</strong>,</p>
      <p style="color:#555;line-height:1.6">El sistema detectó <strong>${totalErrors} ${totalErrors === 1 ? 'problema' : 'problemas'}</strong> en tu planeación que ${totalErrors === 1 ? 'necesita' : 'necesitan'} corrección para que se procese correctamente.</p>
      ${criticalHtml}
      ${warningsHtml}
      ${infosHtml}
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#e8f4f8;border-radius:6px;margin-top:20px">
        <tr><td style="padding:14px;font-size:13px;color:#0c5460">
          💡 <strong>¿Por qué recibes esto?</strong> El sistema valida tu planeación automáticamente cada día. Una planeación bien diligenciada permite generar mejores indicadores para ti y tu equipo.
        </td></tr>
      </table>
      <p style="color:#555;margin-top:16px;font-size:14px">
        ⏰ Por favor corrige antes de la próxima ejecución automática.
      </p>
    </td></tr>
    <tr><td style="background:#f8f9fa;padding:16px;text-align:center;color:#999;font-size:12px">
      Sistema RPA de Planeación · ${ctx.executionId}<br>No responder a este correo
    </td></tr>
  </table>
</body></html>`;
}

function buildSuccessEmail(empData) {
  const folder = empData.folder;
  const tasksCount = empData.tasksCount;

  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;margin:0">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:680px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <tr><td style="background:#28a745;color:white;padding:24px;text-align:center">
      <h1 style="margin:0;font-size:22px;color:white">🏆 ¡Excelente trabajo en tu planeación!</h1>
      ${empData.equipo ? `<p style="margin:6px 0 0 0;opacity:0.95;font-size:13px;color:white;font-weight:600">📂 ${empData.equipo}</p>` : ''}
      <p style="margin:8px 0 0 0;opacity:0.9;font-size:14px;color:white">${ctx.monthName} ${ctx.yearNumber} · ${ctx.snapshotDate}</p>
    </td></tr>
    <tr><td style="padding:24px">
      <p style="font-size:16px;margin-top:0;color:#333">Hola <strong>${folder}</strong>,</p>
      <p style="color:#555;line-height:1.6;font-size:15px">
        ¡Tu planeación de <strong>${ctx.monthName} ${ctx.yearNumber}</strong> está <strong style="color:#28a745">IMPECABLE</strong>! 🎉
      </p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#d4edda;border-left:4px solid #28a745;margin:16px 0;border-radius:6px">
        <tr><td style="padding:16px">
          <div style="font-size:14px;color:#155724;line-height:1.8">
            ✅ <strong>${tasksCount} tareas</strong> correctamente diligenciadas<br>
            ✅ Todos los responsables asignados<br>
            ✅ Todos los estados completos<br>
            ✅ Sin inconsistencias detectadas<br>
            ✅ Nombre del talento coincide con tu carpeta
          </div>
        </td></tr>
      </table>
      <p style="color:#555;line-height:1.6">
        Sigue así, eres ejemplo para el equipo. 💪<br>
        ${textoLideres(empData.equipo, empData.leaderName)} visibilidad del cumplimiento de tus indicadores.
      </p>
    </td></tr>
    <tr><td style="background:#f8f9fa;padding:16px;text-align:center;color:#999;font-size:12px">
      Sistema RPA de Planeación · ${ctx.executionId}<br>No responder a este correo
    </td></tr>
  </table>
</body></html>`;
}

const emails = [];

for (const [key, empData] of Object.entries(byEmployee)) {
  const totalErrors = Object.values(empData.errorsByType).reduce((s, arr) => s + arr.length, 0);
  const folder = empData.folder || 'Sin carpeta';
  const projectTag = empData.equipo ? `[${empData.equipo}] ` : '';

emails.push({
    recipient_email: buildRecipient(folder, empData.equipo),  // empleado + PMs del Equipo + monitoreo
    recipient_real: folder,
    recipient_type: 'employee_validation_error',
    subject: `📋 ${projectTag}[${folder}] ${totalErrors} acción${totalErrors === 1 ? '' : 'es'} requerida${totalErrors === 1 ? '' : 's'} en tu planeación`,
    body_html: buildErrorEmail(empData),
    employee_folder_name: folder,
    snapshot_date: ctx.snapshotDate,
    error_count: totalErrors,
    email_kind: 'error'
  });
}

for (const emp of perfectEmployees) {
  const projectTag = emp.equipo ? `[${emp.equipo}] ` : '';
  emails.push({
    recipient_email: buildRecipient(emp.folder, emp.equipo),  // empleado + PMs del Equipo + monitoreo
    recipient_real: emp.folder,
    recipient_type: 'employee_validation_ok',
    subject: `🏆 ${projectTag}[${emp.folder}] ¡Tu planeación de ${ctx.monthName} está impecable!`,
    body_html: buildSuccessEmail(emp),
    employee_folder_name: emp.folder,
    snapshot_date: ctx.snapshotDate,
    error_count: 0,
    email_kind: 'success'
  });
}

console.log(`\n📧 Total correos: ${emails.length}`);
console.log(`   ⚠️ Errores: ${emails.filter(e => e.email_kind === 'error').length}`);
console.log(`   🏆 OK: ${emails.filter(e => e.email_kind === 'success').length}`);

return emails.map(e => ({ json: e }));
