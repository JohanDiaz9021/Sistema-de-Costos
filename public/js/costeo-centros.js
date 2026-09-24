'use strict';

/**
 * Panel de Centro de Costos.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Centro de Costos =====================

const TIPO_LABEL = { Desarrollo: 'Desarrollo', Consultoria: 'Consultoría', Soporte: 'Soporte', Overhead: 'Overhead' };

// En la BD los cargos se guardan en snake_case (ROLE_CATALOG de
// src/routes/costeo.js). Este mapa los muestra legibles en la tabla, sin
// cambiar el valor guardado.
const ROLE_LABEL = {
  desarrollador: 'Desarrollador',
  analista: 'Analista',
  lider_proyecto: 'Líder de proyecto',
  qa: 'QA',
  disenador: 'Diseñador',
  scrum_master: 'Scrum Master',
  otro: 'Otro',
};

function ejecutadoDeCentro(costCenterId) {
  const row = state.porCentro.find((c) => String(c.cost_center_id) === String(costCenterId));
  return row ? row.ejecutado_total : 0;
}

// Mismo dato que ya trae Indicadores (ind9_horas_ejecutadas = suma de
// total_executed_hours de mp_costeo_task_facts para este centro), solo que
// aquí se muestra en horas en vez de plata: "cuánto se trabajó" además de
// "cuánto costó". No hace falta pedirlo aparte al backend: computeIndicadores17
// ya lo calcula por centro.
//
// OJO: NO sale de state.porCentro (ese viene de GET /api/costeo/indicadores,
// que solo manda 6 campos de plata — cost_center_id, project_name, budget,
// costo_laboral_ejecutado, costo_extra_aprobado, costo_no_planeado_total,
// ejecutado_total — sin ningún ind9_horas_ejecutadas). El que SÍ lo trae es
// state.indicadores17, de GET /api/costeo/indicadores-17 (ver cargarDatos()
// en costeo-indicadores.js). Leerlo de porCentro daba siempre 0 h aunque
// Ejecutado ($) se viera bien, porque ese sí sale de porCentro.
function horasDeCentro(costCenterId) {
  const row = state.indicadores17.find((c) => String(c.cost_center_id) === String(costCenterId));
  return row ? Number(row.ind9_horas_ejecutadas) || 0 : 0;
}

function vigenciaBadge(c) {
  if (c.status === 'inactivo' || c.actual_end_date) return '';
  if (!c.planned_end_date) return '';
  const dias = Math.ceil((new Date(c.planned_end_date).getTime() - Date.now()) / 86400000);
  if (dias < 0) return `<span class="cst-cc-badge b-vencido">Vencido hace ${Math.abs(dias)}d</span>`;
  if (dias <= 30) return `<span class="cst-cc-badge b-riesgo">Faltan ${dias}d</span>`;
  return '';
}

function renderCentrosGrid() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  const grid = document.getElementById('cst-cc-grid');

  // Filtro global de Centro de Costos de arriba: solo mostrar el elegido
  // (o todos si no hay selección).
  const gCentro = document.getElementById('cst-f-centro')?.value || '';
  const visibles = state.centros.filter((c) => !gCentro || String(c.cost_center_id) === String(gCentro));

  const pag = paginar('centros', visibles);
  grid.innerHTML = pag.items.map((c) => {
    const ejecutado = ejecutadoDeCentro(c.cost_center_id);
    const horasTrabajadas = horasDeCentro(c.cost_center_id);
    const presupuesto = Number(c.budget) || 0;
    const pct = presupuesto > 0 ? Math.min(100, Math.round((ejecutado / presupuesto) * 100)) : 0;
    const isActivo = c.status !== 'inactivo';
    return `
    <article class="cst-cc-card st-${c.status || 'vigente'}" data-centro-id="${c.cost_center_id}">
      <div class="cst-cc-view">
        <div class="cst-cc-meta">${escapeHtml(c.codigo || '')} · ${escapeHtml(TIPO_LABEL[c.tipo] || c.tipo || 'Desarrollo')}</div>
        <h4 class="cst-cc-title">${escapeHtml(c.project_name)}</h4>
        <p class="cst-cc-sub">${escapeHtml(c.client_name || c.project_folder)}${c.pm_name ? ' · PM: ' + escapeHtml(c.pm_name) : ' · PM: —'}</p>
        <div class="cst-cc-badges">
          <span class="cst-cc-badge ${c.origin === 'manual' ? 'b-manual' : 'b-sync'}">${c.origin === 'manual' ? 'Manual' : `${icono('check')} Planeación Semanal`}</span>
          <span class="cst-cc-badge ${isActivo ? 'b-activo' : 'b-inactivo'}">${isActivo ? 'Activo' : 'Inactivo'}</span>
          ${vigenciaBadge(c)}
        </div>
        <div class="cst-cc-exec-head"><span>Ejecución</span><strong>${pct}%</strong></div>
        <div class="cst-cc-exec-bar"><div class="cst-cc-exec-fill${pct >= 85 ? ' is-over' : ''}" style="width:${pct}%"></div></div>
        <div class="cst-cc-numbers"><span class="lbl">Presupuesto</span><span class="val">${formatCOP(presupuesto)}</span></div>
        <div class="cst-cc-numbers"><span class="lbl">Ejecutado</span><span class="val">${formatCOP(ejecutado)}</span></div>
        <div class="cst-cc-numbers"><span class="lbl">Horas trabajadas</span><span class="val">${horasTrabajadas.toFixed(1)} h</span></div>
        ${c.contract_value !== null && c.contract_value !== undefined
          ? `<div class="cst-cc-numbers"><span class="lbl">Valor del contrato</span><span class="val">${formatCOP(c.contract_value)}</span></div>`
          : ''}
        <p class="cst-cc-dates">${escapeHtml(formatFecha(c.start_date))} → ${escapeHtml(formatFecha(c.planned_end_date))}</p>
        <div class="cst-cc-actions">
          <button type="button" class="btn-ghost cst-cc-btn-cambios" data-centro-cambios="${c.cost_center_id}" ${c.cambios_total ? '' : 'disabled title="Todavía no hay cambios registrados en este proyecto"'}>
            ${icono('reloj')} Ver cambios${c.cambios_total ? ` (${c.cambios_total})` : ''}
          </button>
          ${(isAdmin || state.user?.role === 'leader') ? `
          <button type="button" class="btn-ghost is-peligro" data-centro-delete="${c.cost_center_id}">Eliminar</button>
          <button type="button" class="btn-ghost" data-centro-edit="${c.cost_center_id}">Editar</button>` : ''}
        </div>
      </div>
    </article>`;
  }).join('') || '<p class="emp-muted">Sin centros de costos todavía.</p>';
  pintarPaginacion('centros', pag, grid);
}

function centroEditFormHTML(c) {
  return `
    <form class="cst-cc-edit-form" data-centro-edit-form="${c.cost_center_id}">
      <label><span>Nombre comercial</span><input type="text" name="project_name" value="${escapeHtml(c.project_name)}" required /></label>
      <label><span>Tipo</span>
        <select name="tipo">
          ${Object.entries(TIPO_LABEL).map(([v, l]) => `<option value="${v}" ${c.tipo === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label><span>Cliente</span><input type="text" name="client_name" value="${escapeHtml(c.client_name || '')}" /></label>
      <label><span>Presupuesto (COP)${c.budget_from_plan ? ' <span class="cst-field-hint">— calculado desde el Plan de Recursos, edítalo abajo</span>' : ''}</span><input type="number" name="budget" min="0" step="1" value="${c.budget}" ${c.budget_from_plan ? 'readonly' : ''} required /></label>
      <!-- El Plan de Recursos (horas planeadas por persona) ya NO depende de
           esta casilla (3 sep 2026, a pedido explícito): antes solo se podía
           ver/editar en proyectos que YA calculaban su presupuesto desde un
           plan, así que un PM no podía llevar "cuántas horas va a trabajar
           cada quien" en un proyecto con presupuesto fijado a mano sin que
           eso se lo pisara. Ahora el panel de abajo siempre está disponible
           para cualquier proyecto; la casilla solo decide si, ADEMÁS, ese
           plan pasa a ser el presupuesto oficial (ver actualizar_presupuesto
           en costo-plan-recursos.js). -->
      <label class="cst-plan-toggle">
        <input type="checkbox" data-plan-toggle ${c.budget_from_plan ? 'checked' : ''} />
        <span>Usar este plan para calcular el presupuesto (en vez de escribirlo a mano arriba)</span>
      </label>
      <p class="cst-sim-nuevo-seccion-label">Plan de Recursos <span class="cst-field-hint">— horas planeadas por persona, para comparar contra lo real en Indicadores</span></p>
      <div class="cst-plan-recursos-body" data-plan-recursos-body>
        <p class="emp-muted">Cargando plan de recursos…</p>
      </div>
      <label><span>Valor del contrato (COP)</span><input type="number" name="contract_value" min="0" step="1" value="${c.contract_value ?? ''}" /></label>
      <label><span>Fecha de inicio</span><input type="date" name="start_date" value="${c.start_date || ''}" required /></label>
      <label><span>Fecha fin planeada</span><input type="date" name="planned_end_date" value="${c.planned_end_date || ''}" required /></label>
      <label><span>Fecha real de entrega</span><input type="date" name="actual_end_date" value="${c.actual_end_date || ''}" /></label>
      <label><span>Estado</span>
        <select name="status">
          <option value="vigente" ${c.status === 'vigente' ? 'selected' : ''}>Vigente</option>
          <option value="por_vencer" ${c.status === 'por_vencer' ? 'selected' : ''}>Por vencer</option>
          <option value="vencido" ${c.status === 'vencido' ? 'selected' : ''}>Vencido</option>
          <option value="cerrado" ${c.status === 'cerrado' ? 'selected' : ''}>Cerrado</option>
          <option value="inactivo" ${c.status === 'inactivo' ? 'selected' : ''}>Inactivo</option>
        </select>
      </label>
      <p class="emp-form-error" data-centro-edit-error hidden></p>
      <div class="cst-cc-edit-actions">
        <button type="submit" class="btn-primary">Guardar</button>
        <button type="button" data-centro-edit-cancel="${c.cost_center_id}">Cancelar</button>
      </div>
    </form>
    <div class="cst-cc-excel-upload">
      <p class="cst-sim-nuevo-seccion-label">Cargar Excel de horas (manual)</p>
      <p class="emp-muted cst-field-hint">Sistema de Costos no trae horas automáticamente de ningún otro sistema — esta es la única forma en que entran. Del Excel se toman <strong>solo las filas de este proyecto</strong> (columna "Proyecto"); si esa persona tiene horas en otros proyectos, se ignoran aquí y se cargan subiendo el mismo archivo dentro de cada uno.</p>
      <form class="cst-cc-excel-form" data-excel-form="${c.cost_center_id}">
        <label><span>¿De quién es el Excel?</span>
          <select name="employee_id" required>
            <option value="">— elegir persona —</option>
            ${(state.employees || []).map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`).join('')}
          </select>
        </label>
        <label><span>Archivo (.xlsx)</span><input type="file" name="excel" accept=".xlsx" required /></label>
        <button type="submit" class="btn-ghost">${icono('subir')} Cargar Excel</button>
      </form>
      <p class="emp-form-error" data-excel-error hidden></p>
    </div>`;
}

// Plan de Recursos que se está editando ahora mismo (una sola tarjeta
// puede estar en edición a la vez, igual que el Simulador de Comercial).
// null cuando no hay ninguna fila cargada todavía (centro sin plan).
let planRecursosEdit = null;

// Subtotal de una fila = personas × horas totales del proyecto × costo/hora
// (NO por semana — es el total que ese rol va a costar en todo el proyecto).
function subtotalFilaPlan(f) {
  return (Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0);
}

// Presupuesto = mano de obra (filas) + gastos sueltos (sql/29) — mismo
// criterio que calcularSimulacionNueva() en el Simulador de Comercial.
function totalPlanEdit() {
  const totalFilas = planRecursosEdit.filas.reduce((s, f) => s + subtotalFilaPlan(f), 0);
  const totalGastos = planRecursosEdit.gastos.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  return totalFilas + totalGastos;
}

// Costo No Planeado (mp_costo_no_planeado) ya APROBADO de este proyecto — a
// pedido explícito (9 sep 2026): un gasto imprevisto aprobado es plata real
// gastada en el proyecto, así que el Plan de Recursos debe mostrarlo y
// sumarlo al costo total, no solo el "Ejecutado" de Indicadores.
//
// Es de SOLO LECTURA a propósito: se gestiona (crea/edita/aprueba/borra)
// desde el panel "Costo No Planeado" — mezclarlo con `planRecursosEdit.gastos`
// (los "gastos iniciales", que sí se guardan al enviar este formulario, sql/29)
// dejaría editar o borrar un gasto ya auditado y aprobado desde una pantalla
// que no tiene ese flujo de aprobación.
//
// `state.gastos` ya viene cargado completo (todos los centros visibles,
// loadEquipoYGastos) desde el arranque de Costeo, así que no hace falta
// pedirlo de nuevo: solo se filtra por este centro.
function noPlaneadosAprobadosDelPlan() {
  return (state.gastos || []).filter(
    (g) => String(g.cost_center_id) === String(planRecursosEdit.costCenterId) && g.approval_status === 'aprobado'
  );
}

function totalNoPlaneadoAprobado() {
  return noPlaneadosAprobadosDelPlan().reduce((s, g) => s + (Number(g.amount) || 0), 0);
}

// Horas Extra APROBADAS de este proyecto (17 sep 2026, a pedido explícito):
// mismo criterio que noPlaneadosAprobadosDelPlan de arriba — es plata real
// del proyecto (ya cuenta en el "Ejecutado" de Indicadores vía
// costoExtraAprobado, costo-motor.js), así que el Plan de Recursos debe
// mostrarla y sumarla al costo total, no solo Indicadores.
//
// Solo LECTURA: se gestiona desde "Horas Extra" (registrar/eliminar), no
// desde acá. Toda alta manual nace aprobada (createManualOvertime), así que
// approval_status = 'aprobado' es, en la práctica, "toda hora extra viva".
//
// `state.overtime` ya viene cargado completo (todos los centros visibles,
// loadOvertime) desde el arranque de Costeo — mismo patrón que state.gastos.
function overtimeAprobadaDelPlan() {
  return (state.overtime || []).filter(
    (o) => String(o.cost_center_id) === String(planRecursosEdit.costCenterId) && o.approval_status === 'aprobado'
  );
}

// extra_cost_final es el costo YA aprobado (lo que de verdad se paga); solo
// se cae a extra_cost_potential si alguna fila vieja nunca lo tuvo — mismo
// fallback que costo-indicadores-17.js usa para horas extra manuales.
function totalOvertimeAprobada() {
  return overtimeAprobadaDelPlan().reduce((s, o) => s + (Number(o.extra_cost_final ?? o.extra_cost_potential) || 0), 0);
}

function renderPlanRecursosBody(card) {
  const cont = card.querySelector('[data-plan-recursos-body]');
  const filas = planRecursosEdit.filas;
  const gastos = planRecursosEdit.gastos;
  const totalFilas = filas.reduce((s, f) => s + subtotalFilaPlan(f), 0);
  const totalGastos = gastos.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  const noPlaneados = noPlaneadosAprobadosDelPlan();
  const totalNoPlaneado = totalNoPlaneadoAprobado();
  const overtimeAprobada = overtimeAprobadaDelPlan();
  const totalOvertime = totalOvertimeAprobada();

  const opcionesRole = (state.tarifasCargo || [])
    .map((t) => `<option value="${t.role_catalog}">${escapeHtml(t.nombre_visible)}</option>`).join('');
  const opcionesPersona = (state.employees || [])
    .map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`).join('');

  cont.innerHTML = `
    <table class="emp-table cst-plan-table">
      <thead><tr><th>Rol</th><th>Persona real <span class="cst-field-hint">(opcional)</span></th><th>Personas</th><th>Horas totales del proyecto</th><th>Costo/hora</th><th>Subtotal</th><th></th></tr></thead>
      <tbody>
        ${filas.map((f, i) => {
          const esPersona = !!f.employee_id;
          // Igual que en el Simulador (costeo-alertas.js): sin salario
          // conocido en ningún proyecto, esta celda deja escribir el
          // salario mensual en vez de mostrar un costo/hora vacío que no
          // hay de dónde sacar todavía.
          const sinSalarioConocido = esPersona && f.sinSalarioConocido;
          const celdaCosto = sinSalarioConocido
            ? `<input type="text" inputmode="numeric" placeholder="Salario mensual" value="${f.monthly_salary ? formatearValorInicial(f.monthly_salary) : ''}" data-plan-input="monthly_salary" data-i="${i}" />
               <small class="cst-plan-salario-hint" data-plan-salario-hint="${i}">${f.monthly_salary ? `≈ ${formatCOP(f.costo_hora)}/h` : 'sin salario conocido — escríbelo aquí'}</small>`
            : `<input type="text" inputmode="numeric" value="${f.costo_hora}" data-plan-input="costo_hora" data-i="${i}" ${esPersona ? 'readonly title="Sale de su salario real"' : ''} />`;
          return `
        <tr>
          <td><select data-plan-input="role_catalog" data-i="${i}"><option value="">— elegir —</option>${opcionesRole.replace(`value="${f.role_catalog}"`, `value="${f.role_catalog}" selected`)}</select></td>
          <td><select data-plan-input="employee_id" data-i="${i}"><option value="">— cargo genérico —</option>${opcionesPersona.replace(`value="${f.employee_id}"`, `value="${f.employee_id}" selected`)}</select></td>
          <td><input type="number" min="1" step="1" value="${f.personas}" data-plan-input="personas" data-i="${i}" ${esPersona ? 'readonly title="Es una persona real: siempre 1"' : ''} /></td>
          <td><input type="number" min="0" step="0.5" value="${f.horas_totales}" data-plan-input="horas_totales" data-i="${i}" /></td>
          <td class="cst-plan-salario-celda">${celdaCosto}</td>
          <td class="cst-plan-subtotal" data-plan-subtotal="${i}">${formatCOP(subtotalFilaPlan(f))}</td>
          <td><button type="button" class="btn-ghost" data-plan-remove="${i}">${icono('cerrar')}</button></td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="cst-plan-footer">
      <button type="button" class="btn-ghost" data-plan-add>+ Agregar rol</button>
      <span class="cst-plan-total" data-plan-total-equipo>Subtotal equipo: <strong>${formatCOP(totalFilas)}</strong></span>
    </div>
    <p class="emp-muted cst-plan-hint">"Horas totales del proyecto" es el total que ese rol va a trabajar en todo el proyecto — no por semana. Con "Persona real" el costo/hora sale de su salario, no se escribe a mano.</p>

    <p class="cst-sim-nuevo-seccion-label">Gastos iniciales <span class="cst-field-hint">(opcional — licencias, viáticos, hardware…)</span></p>
    <table class="emp-table cst-plan-table" ${gastos.length ? '' : 'hidden'} data-plan-gastos-table>
      <thead><tr><th>Descripción</th><th>Valor (COP)</th><th></th></tr></thead>
      <tbody>
        ${gastos.map((g, i) => `
        <tr>
          <td><input type="text" placeholder="Ej. Licencia Azure, viáticos de arranque…" value="${escapeHtml(g.description)}" data-plan-gasto="description" data-i="${i}" /></td>
          <td><input type="text" inputmode="numeric" value="${g.amount}" data-plan-gasto="amount" data-i="${i}" /></td>
          <td><button type="button" class="btn-ghost" data-plan-gasto-remove="${i}">${icono('cerrar')}</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="cst-plan-footer">
      <button type="button" class="btn-ghost" data-plan-gasto-add>+ Añadir gasto</button>
      <span class="cst-plan-total" data-plan-total-gastos>Subtotal gastos: <strong>${formatCOP(totalGastos)}</strong></span>
    </div>

    <p class="cst-sim-nuevo-seccion-label">Costo No Planeado aprobado <span class="cst-field-hint">(imprevistos ya aprobados en este proyecto — se gestionan desde "Costo No Planeado"; aquí solo se muestran y se suman al total)</span></p>
    ${noPlaneados.length ? `
    <table class="emp-table cst-plan-table" data-plan-noplaneado-table>
      <thead><tr><th>Descripción</th><th>Fecha</th><th>Valor (COP)</th></tr></thead>
      <tbody>
        ${noPlaneados.map((g) => `
        <tr>
          <td>${escapeHtml(g.description)}</td>
          <td>${escapeHtml(formatFecha(g.expense_date))}</td>
          <td>${formatCOP(g.amount)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="cst-plan-footer">
      <span class="cst-plan-total" data-plan-total-noplaneado>Subtotal no planeado: <strong>${formatCOP(totalNoPlaneado)}</strong></span>
    </div>` : `
    <p class="emp-muted cst-plan-hint">Sin gastos no planeados aprobados en este proyecto todavía.</p>`}

    <p class="cst-sim-nuevo-seccion-label">Horas Extra aprobadas <span class="cst-field-hint">(se gestionan desde "Horas Extra"; aquí solo se muestran y se suman al total)</span></p>
    ${overtimeAprobada.length ? `
    <table class="emp-table cst-plan-table" data-plan-overtime-table>
      <thead><tr><th>Talento</th><th>Fecha / semana</th><th>Horas</th><th>Valor (COP)</th></tr></thead>
      <tbody>
        ${overtimeAprobada.map((o) => `
        <tr>
          <td>${escapeHtml(o.canonical_name)}</td>
          <td>${o.fecha ? escapeHtml(formatFecha(o.fecha)) : `Semana ${escapeHtml(String(o.week_number))}/${escapeHtml(String(o.month_number))}/${escapeHtml(String(o.year_number))}`}</td>
          <td>${Number(o.extra_hours).toFixed(2)}</td>
          <td>${formatCOP(o.extra_cost_final ?? o.extra_cost_potential)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="cst-plan-footer">
      <span class="cst-plan-total" data-plan-total-overtime>Subtotal horas extra: <strong>${formatCOP(totalOvertime)}</strong></span>
    </div>` : `
    <p class="emp-muted cst-plan-hint">Sin horas extra aprobadas en este proyecto todavía.</p>`}

    <div class="cst-plan-footer cst-plan-footer-total">
      <span class="cst-plan-total">${card.querySelector('[data-plan-toggle]')?.checked ? 'Presupuesto calculado (plan)' : 'Plan'} (equipo + gastos iniciales): <strong data-plan-total>${formatCOP(totalFilas + totalGastos)}</strong></span>
    </div>
    ${(totalNoPlaneado || totalOvertime) ? `
    <div class="cst-plan-footer cst-plan-footer-total">
      <span class="cst-plan-total">Costo total del proyecto (plan + no planeado aprobado + horas extra aprobadas): <strong data-plan-total-general>${formatCOP(totalFilas + totalGastos + totalNoPlaneado + totalOvertime)}</strong></span>
    </div>` : ''}`;

  cont.querySelectorAll('[data-plan-input="costo_hora"], [data-plan-input="monthly_salary"]').forEach(attachMilesFormat);
  cont.querySelectorAll('[data-plan-input="personas"], [data-plan-input="horas_totales"]').forEach(attachSelectOnFocus);
  cont.querySelectorAll('[data-plan-gasto="amount"]').forEach(attachMilesFormat);

  // El campo Presupuesto de arriba solo refleja este total cuando la
  // casilla "Usar este plan para calcular el presupuesto" está marcada (3
  // sep 2026): el panel ahora se ve siempre, aunque el proyecto siga
  // presupuestado a mano — sin este guard, editar horas planeadas en ESE
  // caso le pisaba en pantalla el presupuesto real sin que nadie lo pidiera.
  if (card.querySelector('[data-plan-toggle]')?.checked) {
    const budgetInput = card.querySelector('[name="budget"]');
    // formatearValorInicial, no toFixed(0): el campo ya pasó por
    // attachMilesFormat (input.type = 'text'), así que pisarlo con el
    // número crudo dejaba "452400" en vez de "452.400" cada vez que se
    // tocaba el Plan de Recursos (7 sep 2026, reportado por el usuario).
    if (budgetInput) budgetInput.value = formatearValorInicial(totalFilas + totalGastos);
  }
}

// Igual que refrescarCalculosNuevo() del Simulador: actualiza solo los
// números derivados, sin reconstruir los inputs — reconstruirlos hacía
// desaparecer el campo bajo el cursor y obligaba a dar dos clics.
function refrescarTotalesPlan(card) {
  const cont = card.querySelector('[data-plan-recursos-body]');
  const totalFilas = planRecursosEdit.filas.reduce((s, f) => s + subtotalFilaPlan(f), 0);
  const totalGastos = planRecursosEdit.gastos.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  planRecursosEdit.filas.forEach((f, i) => {
    const celda = cont.querySelector(`[data-plan-subtotal="${i}"]`);
    if (celda) celda.textContent = formatCOP(subtotalFilaPlan(f));
  });
  const totalEquipoEl = cont.querySelector('[data-plan-total-equipo] strong');
  if (totalEquipoEl) totalEquipoEl.textContent = formatCOP(totalFilas);
  const totalGastosEl = cont.querySelector('[data-plan-total-gastos] strong');
  if (totalGastosEl) totalGastosEl.textContent = formatCOP(totalGastos);
  const totalEl = cont.querySelector('[data-plan-total]');
  if (totalEl) totalEl.textContent = formatCOP(totalFilas + totalGastos);
  // El total general (plan + no planeado aprobado + horas extra aprobadas)
  // solo existe en el DOM si había algo no planeado u horas extra al
  // renderizar (ver renderPlanRecursosBody) — ambos son de solo lectura, así
  // que no cambian mientras se edita el plan, pero el plan sí, y este total
  // tiene que moverse con él.
  const totalGeneralEl = cont.querySelector('[data-plan-total-general]');
  if (totalGeneralEl) totalGeneralEl.textContent = formatCOP(totalFilas + totalGastos + totalNoPlaneadoAprobado() + totalOvertimeAprobada());
  // Mismo guard que en renderPlanRecursosBody: solo pisa el Presupuesto si
  // la casilla de usarlo como tal está marcada. A propósito NO incluye el no
  // planeado: el presupuesto/contrato no debe inflarse solo porque se aprobó
  // un imprevisto — eso rompería la comparación "% ejecutado sobre
  // presupuesto" (indicador #1) que depende de que el presupuesto sea estable.
  if (card.querySelector('[data-plan-toggle]')?.checked) {
    const budgetInput = card.querySelector('[name="budget"]');
    // formatearValorInicial, no toFixed(0): el campo ya pasó por
    // attachMilesFormat (input.type = 'text'), así que pisarlo con el
    // número crudo dejaba "452400" en vez de "452.400" cada vez que se
    // tocaba el Plan de Recursos (7 sep 2026, reportado por el usuario).
    if (budgetInput) budgetInput.value = formatearValorInicial(totalFilas + totalGastos);
  }
}

// ===== Historial de cambios de UN proyecto =====
// (7 sep 2026, a pedido explícito del dueño de la empresa: quiere ver qué se
// cambió, cuándo y con qué valores — "el contrato decía 10 millones y ahora
// dice 100", "eran 3 personas y metieron otra"). El rastro ya se venía
// guardando en mp_costeo_audit_log desde ago 2026; lo que faltaba era poder
// VERLO junto al proyecto, en vez de solo en la pestaña Historial general.

// Icono por tipo de cosa que cambió — para poder barrer la lista con la
// vista sin leer cada línea.
const CAMBIO_ICONO = {
  centro_costo: 'carpeta',
  equipo: 'personas',
  gasto: 'recibo',
  overtime: 'cronometro',
  plan_recursos: 'regla',
  tarifa_cargo: 'etiqueta',
  acceso: 'llave',
  config: 'engranaje',
  snapshot: 'camara',
};

// partirCambio, CAMBIO_CAMPOS_DINERO y valorCambioTexto viven en
// costeo-core.js (compartidos con formatearDescripcionHistorial, que usa la
// pestaña Historial general — ver renderHistorialTable en costeo-overtime.js).
function cambioEntradaHTML(item) {
  const piezas = partirCambio(formatearMontosEnTexto(item.description || '')).map((p) => {
    if (p.antes === null) return `<p class="cst-cambio-texto">${escapeHtml(p.titulo)}</p>`;
    return `
      <div class="cst-cambio-diff">
        ${p.titulo ? `<span class="cst-cambio-campo">${escapeHtml(p.titulo)}</span>` : ''}
        <span class="cst-cambio-antes">${escapeHtml(valorCambioTexto(p.titulo, p.antes))}</span>
        <span class="cst-cambio-flecha">→</span>
        <span class="cst-cambio-despues">${escapeHtml(valorCambioTexto(p.titulo, p.despues))}</span>
      </div>`;
  }).join('');

  return `
    <li class="cst-cambio">
      <span class="cst-cambio-icono">${CAMBIO_ICONO[item.entity_type] || '•'}</span>
      <div class="cst-cambio-cuerpo">
        <div class="cst-cambio-head">
          <span class="cst-estado-pill ${escapeHtml(HIST_ACTION_CLASS[item.action] || '')}">${escapeHtml(HIST_ACTION_LABEL[item.action] || item.action)}</span>
          <span class="cst-cambio-tipo">${escapeHtml(HIST_ENTITY_LABEL[item.entity_type] || item.entity_type)}</span>
          <span class="cst-cambio-fecha">${escapeHtml(formatFechaHora(item.created_at))} · ${escapeHtml(item.user_name || 'Sistema')}</span>
        </div>
        ${piezas}
      </div>
    </li>`;
}

async function abrirCambiosCentro(costCenterId) {
  const c = state.centros.find((x) => String(x.cost_center_id) === String(costCenterId));
  document.getElementById('cst-cambios-proyecto').textContent = c ? c.project_name : '';
  const body = document.getElementById('cst-cambios-body');
  body.innerHTML = '<p class="emp-muted">Cargando cambios…</p>';
  abrirModal('cst-cambios-modal-overlay');

  try {
    const { historial } = await fetchJSON(`/api/costeo/historial?cost_center_id=${encodeURIComponent(costCenterId)}`);
    body.innerHTML = historial && historial.length
      ? `<ol class="cst-cambios-lista">${historial.map(cambioEntradaHTML).join('')}</ol>`
      : '<p class="emp-muted">Todavía no hay cambios registrados en este proyecto.</p>';
  } catch (err) {
    body.innerHTML = `<p class="emp-form-error">No se pudo cargar el historial: ${escapeHtml(err.message)}</p>`;
  }
}

async function abrirEdicionCentro(costCenterId) {
  const card = document.querySelector(`.cst-cc-card[data-centro-id="${costCenterId}"]`);
  const c = state.centros.find((x) => String(x.cost_center_id) === String(costCenterId));
  if (!card || !c) return;
  card.innerHTML = centroEditFormHTML(c);
  ['budget', 'contract_value'].forEach((name) =>
    attachMilesFormat(card.querySelector(`[name="${name}"]`))
  );

  const toggle = card.querySelector('[data-plan-toggle]');
  const body = card.querySelector('[data-plan-recursos-body]');

  const cargarPlan = async () => {
    const { filas, gastos } = await fetchJSON(`/api/costeo/centros/${costCenterId}/plan-recursos`);
    planRecursosEdit = {
      costCenterId,
      filas: filas.length ? filas.map((f) => ({ ...f })) : [{ role_catalog: '', employee_id: null, personas: 1, horas_totales: 0, costo_hora: 0 }],
      // Se cargan tal cual (vacío si no hay), sin fila en blanco por
      // defecto: a diferencia del equipo, los gastos son opcionales.
      gastos: (gastos || []).map((g) => ({ ...g })),
    };
    renderPlanRecursosBody(card);
  };

  // El plan se carga siempre, sin importar la casilla (3 sep 2026): antes
  // solo se pedía si toggle.checked, así que un proyecto presupuestado a
  // mano nunca mostraba sus horas planeadas por persona, aunque ya tuviera
  // algunas guardadas de una edición previa.
  await cargarPlan();

  toggle.addEventListener('change', async () => {
    const budgetInput = card.querySelector('[name="budget"]');
    if (toggle.checked) {
      budgetInput.readOnly = true;
      // El total del plan reemplaza lo que hubiera en Presupuesto apenas se
      // marca la casilla — mismo criterio que ya aplicaba antes de este
      // cambio, solo que ahora el plan pudo haberse estado editando SIN
      // que esto pasara (toggle apagado), así que hay que sincronizar aquí.
      renderPlanRecursosBody(card);
    } else {
      budgetInput.readOnly = false;
    }
  });

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-plan-add]')) {
      planRecursosEdit.filas.push({ role_catalog: '', employee_id: null, personas: 1, horas_totales: 0, costo_hora: 0 });
      renderPlanRecursosBody(card);
    }
    const removeBtn = e.target.closest('[data-plan-remove]');
    if (removeBtn) {
      planRecursosEdit.filas.splice(Number(removeBtn.dataset.planRemove), 1);
      renderPlanRecursosBody(card);
    }
    if (e.target.closest('[data-plan-gasto-add]')) {
      planRecursosEdit.gastos.push({ description: '', amount: 0 });
      renderPlanRecursosBody(card);
    }
    const removeGastoBtn = e.target.closest('[data-plan-gasto-remove]');
    if (removeGastoBtn) {
      planRecursosEdit.gastos.splice(Number(removeGastoBtn.dataset.planGastoRemove), 1);
      renderPlanRecursosBody(card);
    }
  });

  body.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-plan-input]');
    if (input) {
      const i = Number(input.dataset.i);
      const campo = input.dataset.planInput;
      if (campo === 'employee_id') {
        const employeeId = input.value ? Number(input.value) : null;
        const fila = planRecursosEdit.filas[i];
        fila.employee_id = employeeId;
        fila.monthly_salary = null;
        fila.sinSalarioConocido = false;
        if (employeeId) {
          // "Por Persona": 1 persona real, el costo/hora sale de su salario
          // conocido (igual que Equipo del Proyecto) — no se escribe a mano.
          fila.personas = 1;
          const costoHora = await costoHoraDeEmpleado(employeeId);
          fila.costo_hora = costoHora || 0;
          // Sin salario conocido en ningún proyecto (2 sep 2026): la fila
          // pasa a modo "escribe el salario aquí" en vez de bloquear (ver
          // renderPlanRecursosBody) — el servidor la usa para calcular el
          // costo/hora Y da de alta a la persona en Equipo del Proyecto.
          fila.sinSalarioConocido = !costoHora;
        }
        renderPlanRecursosBody(card);
        return;
      }
      if (campo === 'monthly_salary') {
        const fila = planRecursosEdit.filas[i];
        const monthlySalary = desformatearMiles(input.value);
        fila.monthly_salary = monthlySalary || null;
        fila.costo_hora = monthlySalary ? Math.round(monthlySalary / (state.horasMes || 210)) : 0;
        const hint = card.querySelector(`[data-plan-salario-hint="${i}"]`);
        if (hint) hint.textContent = monthlySalary ? `≈ ${formatCOP(fila.costo_hora)}/h` : 'sin salario conocido — escríbelo aquí';
        refrescarTotalesPlan(card);
        return;
      }
      const valor = campo === 'costo_hora' ? desformatearMiles(input.value) : (campo === 'role_catalog' ? input.value : Number(input.value) || 0);
      planRecursosEdit.filas[i][campo] = valor;
      refrescarTotalesPlan(card);
      return;
    }
    const gastoInput = e.target.closest('[data-plan-gasto]');
    if (!gastoInput) return;
    const i = Number(gastoInput.dataset.i);
    const campo = gastoInput.dataset.planGasto;
    planRecursosEdit.gastos[i][campo] = campo === 'amount' ? (desformatearMiles(gastoInput.value) || 0) : gastoInput.value;
    refrescarTotalesPlan(card);
  });
}

async function guardarEdicionCentro(costCenterId, form) {
  const errorEl = form.querySelector('[data-centro-edit-error]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  // budget/contract_value llegan formateados ("25.000") por
  // attachMilesFormat: hay que quitarles el punto antes de mandarlos, si no
  // el backend hace Number("25.000") === 25 y se pierden los ceros.
  ['budget', 'contract_value'].forEach((k) => {
    if (data[k] !== undefined) data[k] = desformatearMiles(data[k]);
  });

  const planActivo = form.querySelector('[data-plan-toggle]')?.checked;
  const c = state.centros.find((x) => String(x.cost_center_id) === String(costCenterId));

  await withBusy(submitBtn, async () => {
    try {
      // filas/gastos se arman igual en los dos casos — lo único que cambia
      // es actualizar_presupuesto, que decide si el total del plan pisa el
      // Presupuesto del centro o si el plan queda solo como "horas
      // planeadas por persona" para comparar contra lo real en Indicadores
      // (3 sep 2026, a pedido explícito).
      const filas = (planRecursosEdit?.filas || [])
        .filter((f) => f.role_catalog)
        .map((f) => ({
          role_catalog: f.role_catalog, employee_id: f.employee_id || null,
          personas: f.personas, horas_totales: f.horas_totales, costo_hora: f.costo_hora,
          // Solo importa cuando la persona no tenía salario conocido; el
          // servidor lo ignora si ya lo tiene (ver validarFilasPlan).
          monthly_salary: f.monthly_salary || undefined,
        }));
      // Se manda tal cual esté planRecursosEdit.gastos (aunque no se haya
      // tocado nada en esta sesión de edición): el PUT reemplaza TODO el
      // plan, así que omitir gastos aquí los borraría en silencio.
      const gastos = (planRecursosEdit?.gastos || [])
        .filter((g) => g.description && g.description.trim())
        .map((g) => ({ description: g.description, amount: g.amount }));

      if (planActivo && !filas.length) {
        throw new Error('Agrega al menos un rol al Plan de Recursos, o desmarca la casilla para volver a escribir el presupuesto a mano.');
      }

      if (filas.length) {
        const { equipo_creado } = await fetchJSON(`/api/costeo/centros/${costCenterId}/plan-recursos`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filas, gastos, actualizar_presupuesto: planActivo }),
        });
        // Si alguna fila "por Persona" traía salario nuevo, el servidor la
        // dio de alta en Equipo del Proyecto — se refresca esa pantalla
        // para que no haya que salir y volver a entrar a verlo.
        if (equipo_creado) await loadEquipoYGastos();
        // El presupuesto YA lo fijó el servidor desde el plan — mandarlo
        // también en el PUT normal de abajo chocaría con su guard (409:
        // "el presupuesto se calcula desde su plan").
        if (planActivo) delete data.budget;
      } else if (c?.budget_from_plan) {
        // Se vació el plan en un centro que tenía el presupuesto atado a
        // él: hay que liberarlo explícitamente, si no el PUT normal de
        // abajo choca con el mismo guard (el backend todavía lo ve como
        // budget_from_plan=1).
        await fetchJSON(`/api/costeo/centros/${costCenterId}/plan-recursos`, { method: 'DELETE' });
      }

      await fetchJSON(`/api/costeo/centros/${costCenterId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      // Viabilidad por proyecto (Comercial) lee contract_value/budget/fechas
      // del mismo mp_centro_costo que se acaba de editar — sin recargarlo,
      // esa tabla se quedaba mostrando los valores de antes hasta refrescar
      // la página entera.
      await Promise.all([loadIndicadores(), loadAlertas(), loadComercial()]);
      renderCentroCostosPanel();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Guardando…');
}

async function handleDeleteCentro(costCenterId, btn) {
  // Borrado real y permanente (31 ago 2026, a pedido explícito): ya no se
  // desactiva "por las dudas" cuando tiene equipo/gastos/horas extra — se
  // borra todo. El historial es la única excepción: se conserva.
  if (!(await cstConfirm('¿Eliminar este centro de costos PERMANENTEMENTE? Se borrará junto con su equipo, gastos y horas extra — esto no se puede deshacer. El historial de lo que ya se hizo ahí sí se conserva.'))) return;
  await withBusy(btn, async () => {
    try {
      await fetchJSON(`/api/costeo/centros/${costCenterId}`, { method: 'DELETE' });
      await loadIndicadores();
      await loadAlertas();
      renderCentroCostosPanel();
      await populateEquipoGastoCentroSelect();
    } catch (err) {
      cstToast(err.message, { tipo: 'error' });
    }
  }, 'Eliminando…');
}

function renderCentroSummary() {
  const activos = state.centros.filter((c) => c.status !== 'inactivo');
  const presupuestoActivo = activos.reduce((sum, c) => sum + (Number(c.budget) || 0), 0);
  const ejecutadoActivo = activos.reduce((sum, c) => sum + ejecutadoDeCentro(c.cost_center_id), 0);
  const pct = presupuestoActivo > 0 ? ((ejecutadoActivo / presupuestoActivo) * 100).toFixed(1) : '0.0';

  document.getElementById('cst-cc-presupuesto').textContent = formatCOP(presupuestoActivo);
  document.getElementById('cst-cc-presupuesto-sub').textContent = `${activos.length} centro(s) de costos`;
  document.getElementById('cst-cc-ejecutado').textContent = formatCOP(ejecutadoActivo);
  document.getElementById('cst-cc-ejecutado-sub').textContent = `${pct}% del presupuesto`;
  document.getElementById('cst-cc-activos').textContent = String(activos.length);
  document.getElementById('cst-cc-activos-sub').textContent = `de ${state.centros.length} registrados`;
  document.getElementById('cst-cc-alertas').textContent = String(state.alertas.length);
  document.getElementById('cst-cc-alertas-sub').textContent = `${state.alertas.filter((a) => a.severidad === 'critica').length} críticas`;
}

function renderCentroCostosPanel() {
  renderCentroSummary();
  renderCentrosGrid();
}

// Antes era un <select> restringido a proyectos de Planeación sin centro
// todavía, y si ya estaban todos cubiertos quedaba sin nada seleccionable —
// bloqueando por completo la creación de un centro nuevo, aunque el backend
// nunca lo exigió (origin='manual' cuando el nombre no cruza con el RPA, ver
// POST /centros). Ahora es texto libre; esta lista solo llena el <datalist>
// como ayuda de autocompletado, no restringe lo que se puede escribir.
async function populateCentroProjectSelect() {
  const datalist = document.getElementById('cst-centro-project-folder-list');
  const { projects } = await fetchJSON('/api/filters');
  const usados = new Set(state.centros.map((c) => c.project_folder));
  const disponibles = (projects || []).filter((p) => !usados.has(p));
  datalist.innerHTML = disponibles.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('');
}

function initCentroForm() {
  const btnNuevo = document.getElementById('cst-btn-nuevo-centro');
  const form = document.getElementById('cst-form-centro');
  const errorEl = document.getElementById('cst-centro-error');

  // El botón "+ Nuevo centro" vivió en la cabecera global hasta el 14 sep
  // 2026 (visible desde cualquier pestaña) — showPanel() traía al usuario a
  // Costo Planeado al hacer clic, para no dejarlo mirando una pantalla sin
  // relación con lo que acababa de crear. Ahora el botón vive DENTRO de la
  // banda de su propio panel, así que solo es clickeable estando ya ahí —
  // el showPanel() de abajo quedó redundante (repite el panel actual) pero
  // inofensivo, se deja por si el botón alguna vez vuelve a moverse.
  btnNuevo.addEventListener('click', async () => {
    showPanel('centro-costos');
    await populateCentroProjectSelect();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const projectFolder = document.getElementById('cst-centro-project-folder').value.trim();
    if (!projectFolder) {
      errorEl.textContent = 'Escribe el nombre del proyecto.';
      errorEl.hidden = false;
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        await fetchJSON('/api/costeo/centros', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_folder: projectFolder,
            project_name: document.getElementById('cst-centro-project-name').value,
            tipo: document.getElementById('cst-centro-tipo').value,
            client_name: document.getElementById('cst-centro-client-name').value,
            budget: desformatearMiles(document.getElementById('cst-centro-budget').value),
            contract_value: desformatearMiles(document.getElementById('cst-centro-contract-value').value),
            start_date: document.getElementById('cst-centro-start-date').value,
            planned_end_date: document.getElementById('cst-centro-planned-end-date').value,
          }),
        });
        // cerrarModal ya hace el reset() del formulario.
        cerrarModal('cst-centro-modal-overlay');
        cstToast('Centro de costos creado.');
        await loadIndicadores();
        await loadAlertas();
        renderCentroCostosPanel();
        await populateEquipoGastoCentroSelect();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }, 'Creando…');
  });

  document.getElementById('cst-cc-grid').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-centro-delete]');
    const editBtn = e.target.closest('[data-centro-edit]');
    const cancelBtn = e.target.closest('[data-centro-edit-cancel]');
    const cambiosBtn = e.target.closest('[data-centro-cambios]');
    if (delBtn) handleDeleteCentro(delBtn.dataset.centroDelete, delBtn);
    else if (editBtn) abrirEdicionCentro(editBtn.dataset.centroEdit);
    else if (cambiosBtn) abrirCambiosCentro(cambiosBtn.dataset.centroCambios);
    else if (cancelBtn) renderCentrosGrid();
  });

  document.getElementById('cst-cc-grid').addEventListener('submit', (e) => {
    const editForm = e.target.closest('[data-centro-edit-form]');
    const excelForm = e.target.closest('[data-excel-form]');
    if (editForm) {
      e.preventDefault();
      guardarEdicionCentro(editForm.dataset.centroEditForm, editForm);
    } else if (excelForm) {
      e.preventDefault();
      cargarExcelHorasCentro(excelForm.dataset.excelForm, excelForm);
    }
  });
}

// Avisos de "se cargó, pero revisa esto". Van en un toast aparte del de
// éxito y duran más.
//
// Se dejan solo estos dos a propósito. Un tercer aviso que se disparara
// seguido por diferencias de forma (ej. comparar el nombre del
// responsable) entrenaría a cerrar este toast sin leerlo, y con él se
// perderían los dos que sí importan.
function avisarRevisionExcel(data) {
  const avisos = [];

  if (data.filas_ignoradas > 0) {
    avisos.push(
      `${data.filas_ignoradas} fila(s) NO se cargaron porque son de otros proyectos`
      + `${data.proyectos_ignorados?.length ? ` (${data.proyectos_ignorados.join(', ')})` : ''}. `
      + `Para cargarlas, sube este mismo Excel dentro de ese otro centro de costos.`
    );
  }
  if (data.filas_total_descuadrado > 0) {
    avisos.push(
      `${data.filas_total_descuadrado} fila(s) tienen el "Total ejecutado" distinto a la suma de los días. `
      + `El costo se calcula con los días, así que revisa si a esa fórmula la pisaron a mano.`
    );
  }

  if (avisos.length) cstToast(`${avisos.join(' ')}`, { tipo: 'warn', duracionMs: 15000 });
}

async function cargarExcelHorasCentro(costCenterId, form) {
  const errorEl = form.parentElement.querySelector('[data-excel-error]');
  errorEl.hidden = true;

  const submitBtn = form.querySelector('button[type="submit"]');
  await withBusy(submitBtn, async () => {
    try {
      const res = await fetch(`/api/costeo/centros/${costCenterId}/cargar-excel-horas`, {
        method: 'POST',
        credentials: 'same-origin',
        body: new FormData(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

      // cstToast() en vez de alert(): antes se quedaba mostrando "cargado
      // con éxito" con la tarjeta congelada en modo edición — el usuario
      // tenía que saber que debía cancelar a mano para ver el % actualizado.
      // Se avisa (sin bloquear con un diálogo nativo del navegador) y se
      // sale del modo edición de una vez, mostrando ya la tarjeta fresca.
      cstToast(`${data.filas_insertadas} fila(s) de ${data.empleado} cargadas (${data.total_horas}h, snapshot ${data.snapshot_date}) — proyectos: ${data.proyectos.join(', ')}.`);
      avisarRevisionExcel(data);
      // El Excel puede traer horas de proyectos distintos al que se estaba
      // editando (es el Excel de la persona, no de este centro) — se
      // refresca todo lo que depende de mp_task_facts, no solo este centro.
      await loadIndicadores();
      await loadAlertas();
      await loadComercial();
      // renderCentroCostosPanel() y no solo renderCentrosGrid(): las
      // tarjetas de % de ejecución se refrescan con cualquiera de las dos,
      // pero las cifras del resumen de arriba (Presupuesto/Ejecutado
      // totales) solo las pinta renderCentroSummary(), que renderCentrosGrid()
      // no llama — se quedaban con el total de antes de la carga.
      renderCentroCostosPanel();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Cargando…');
}

