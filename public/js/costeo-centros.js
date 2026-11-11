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

// La barra de Ejecución en dos tramos (20 oct 2026, a pedido explícito): las
// horas extra y el costo no planeado sí consumen presupuesto, pero no son
// "horas trabajadas" — mezclados en un solo tramo, un centro recién creado
// con un gasto aprobado se veía al 9% de ejecución sin una sola hora
// cargada. Los dos tramos miden contra el MISMO 100% (el presupuesto), así
// que siempre suman el total.
function desgloseDeCentro(costCenterId) {
  const row = state.porCentro.find((c) => String(c.cost_center_id) === String(costCenterId));
  if (!row) return { laboral: 0, otros: 0 };
  return {
    laboral: Number(row.costo_laboral_ejecutado) || 0,
    otros: (Number(row.costo_extra_aprobado) || 0) + (Number(row.costo_no_planeado_total) || 0),
  };
}

// Anchos de cada tramo en % del presupuesto, recortados para que juntos no
// pasen del 100% de la barra.
function tramosEjecucion({ laboral, otros }, presupuesto) {
  if (!(presupuesto > 0)) return { laboral: 0, otros: 0 };
  const anchoLaboral = Math.min(100, (laboral / presupuesto) * 100);
  const anchoOtros = Math.min(100 - anchoLaboral, (otros / presupuesto) * 100);
  return { laboral: anchoLaboral, otros: anchoOtros };
}

function pctTexto(valor, presupuesto) {
  return presupuesto > 0 ? `${Math.round((valor / presupuesto) * 100)}%` : '—';
}

function horasExtraDeCentro(costCenterId) {
  const row = state.indicadores17.find((c) => String(c.cost_center_id) === String(costCenterId));
  return row ? Number(row.ind9_horas_extra) || 0 : 0;
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
    const horasExtra = horasExtraDeCentro(c.cost_center_id);
    const presupuesto = Number(c.budget) || 0;
    const pct = presupuesto > 0 ? Math.min(100, Math.round((ejecutado / presupuesto) * 100)) : 0;
    const desglose = desgloseDeCentro(c.cost_center_id);
    const tramos = tramosEjecucion(desglose, presupuesto);
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
        <div class="cst-cc-exec-head${pct >= 85 ? ' is-over' : ''}"><span>Ejecución</span><strong>${pct}%</strong></div>
        <div class="cst-cc-exec-bar">
          <div class="cst-cc-exec-fill" style="width:${tramos.laboral}%" title="Horas trabajadas"></div>
          <div class="cst-cc-exec-fill is-otros" style="width:${tramos.otros}%" title="Horas extra y costo no planeado"></div>
        </div>
        <div class="cst-cc-exec-legend">
          <span><i class="cst-cc-dot"></i>Horas trabajadas <strong>${pctTexto(desglose.laboral, presupuesto)}</strong> · ${formatCOP(desglose.laboral)}</span>
          <span><i class="cst-cc-dot is-otros"></i>Horas extra y no planeado <strong>${pctTexto(desglose.otros, presupuesto)}</strong> · ${formatCOP(desglose.otros)}</span>
        </div>
        <div class="cst-cc-numbers"><span class="lbl">Presupuesto</span><span class="val">${formatCOP(presupuesto)}</span></div>
        <div class="cst-cc-numbers"><span class="lbl">Ejecutado</span><span class="val">${formatCOP(ejecutado)}</span></div>
        <div class="cst-cc-numbers"><span class="lbl">Horas trabajadas</span><span class="val">${horasTrabajadas.toFixed(1)} h${horasExtra > 0 ? ` <small class="cst-cc-extra">(incluye ${horasExtra.toFixed(1)} h extra)</small>` : ''}</span></div>
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
      ${esAdminCosteo() ? `
      <div class="cst-centro-pm-campo">
        <span class="cst-centro-pm-titulo">
          Responsables (PM)
          <button type="button" class="btn-ghost cst-centro-pm-todos" data-centro-pm-todos>Todos los PM</button>
        </span>
        <div data-centro-pm data-inicial="${escapeHtml(JSON.stringify(valoresPmDe(c)))}"><span class="emp-muted">Cargando…</span></div>
        <span class="cst-field-hint">Puedes elegir varios: todos ven el proyecto y reciben sus alertas.</span>
      </div>` : ''}
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
    </form>`;
  // La carga manual del Excel de horas se retiró (5 oct 2026): las horas
  // entran solas cada día por WF-COSTEO (n8n). El endpoint
  // POST /centros/:id/cargar-excel-horas sigue en el servidor.
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

// ---- Gastos iniciales: borrador vs. confirmado (30 sep 2026) ----
//
// A pedido explícito, con captura: cada gasto nuevo se quedaba como una fila
// de cajitas editables sin forma de decir "listo, este ya está" — quedaba
// "a la deriva". Ahora un gasto nuevo nace como BORRADOR (inputs + botón
// "+"), y al darle "+" (o Enter) se CONFIRMA: pasa a verse como una fila
// fija de texto, con lápiz para editarlo y X para quitarlo.
//
// `confirmado` es solo de pantalla: nunca viaja al servidor (ver
// guardarEdicionCentro, que manda solo description/amount). Lo que llega del
// servidor no trae el campo, y por eso "no dice false" = confirmado: un
// gasto ya guardado se muestra fijo sin tener que marcarlo al cargar.
//
// Confirmar NO guarda en la base — eso sigue pasando con el "Guardar" del
// proyecto, igual que todo el resto de este formulario. Y un borrador que
// no se confirmó pero tiene descripción se guarda igual: dejarlo afuera
// perdería en silencio algo que la persona sí escribió.
function gastoConfirmado(g) {
  return g.confirmado !== false;
}

// Devuelve el motivo por el que el gasto no se puede confirmar, o null si
// está completo. Pura, para poder probarla sin DOM.
function validarGastoPlan(description, amount) {
  if (!String(description || '').trim()) return 'Escribe una descripción';
  if (!(Number(amount) > 0)) return 'Escribe un valor mayor que 0';
  return null;
}

function confirmarGastoPlan(card, i) {
  const cont = card.querySelector('[data-plan-recursos-body]');
  const g = planRecursosEdit.gastos[i];
  if (!g) return false;

  // Se lee lo que hay escrito AHORA en los inputs, no lo último que guardó el
  // `change`: con Enter el input todavía no perdió el foco, y el `change`
  // solo corre al perderlo — confirmaría el valor anterior.
  const descInput = cont.querySelector(`[data-plan-gasto="description"][data-i="${i}"]`);
  const amountInput = cont.querySelector(`[data-plan-gasto="amount"][data-i="${i}"]`);
  if (descInput) g.description = descInput.value;
  if (amountInput) g.amount = desformatearMiles(amountInput.value) || 0;

  const error = validarGastoPlan(g.description, g.amount);
  if (error) {
    const el = cont.querySelector(`[data-plan-gasto-error="${i}"]`);
    if (el) {
      el.textContent = error;
      el.hidden = false;
    }
    (String(g.description || '').trim() ? amountInput : descInput)?.focus();
    return false;
  }

  g.description = g.description.trim();
  g.confirmado = true;
  renderPlanRecursosBody(card);
  return true;
}

// Deja el cursor en la descripción del gasto `i`, para escribir sin tener
// que hacer clic otra vez después de "+ Añadir gasto" o del lápiz.
function enfocarGastoPlan(card, i) {
  card.querySelector(`[data-plan-recursos-body] [data-plan-gasto="description"][data-i="${i}"]`)?.focus();
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

// Las PROGRAMADAS (turno que todavía no termina, 20 oct 2026) se listan y se
// suman aquí igual: el "Costo total del proyecto" es lo comprometido, como
// el Costo Estimado de Comercial. Lo que no hacen es sumar al Ejecutado.
//
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

  // Cada rol en dos renglones (10 nov 2026, a pedido explícito): en una sola
  // fila de 7 columnas, dentro de la tarjeta, la columna Rol quedaba de unos
  // pocos píxeles y no se leía qué cargo era. Arriba Rol y Persona real a lo
  // ancho; abajo los números.
  const rolSeleccionado = (f) => (state.tarifasCargo || []).find((t) => t.role_catalog === f.role_catalog)?.nombre_visible || '';
  const personaSeleccionada = (f) => (state.employees || []).find((e) => String(e.employee_id) === String(f.employee_id))?.canonical_name || '';
  cont.innerHTML = `
    <div class="cst-plan-roles">
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
      <div class="cst-plan-rol">
        <label class="cst-plan-campo cst-plan-campo-ancho"><span>Rol</span>
          <select data-plan-input="role_catalog" data-i="${i}" title="${escapeHtml(rolSeleccionado(f))}"><option value="">— elegir —</option>${opcionesRole.replace(`value="${f.role_catalog}"`, `value="${f.role_catalog}" selected`)}</select></label>
        <label class="cst-plan-campo cst-plan-campo-ancho"><span>Talento</span>
          <select data-plan-input="employee_id" data-i="${i}" title="${escapeHtml(personaSeleccionada(f))}"><option value="">— cargo genérico —</option>${opcionesPersona.replace(`value="${f.employee_id}"`, `value="${f.employee_id}" selected`)}</select></label>
        <button type="button" class="btn-ghost cst-plan-quitar" data-plan-remove="${i}" title="Quitar este rol" aria-label="Quitar este rol">${icono('cerrar')}</button>
        <div class="cst-plan-numeros">
          <label class="cst-plan-campo"><span>Horas totales</span>
            <input type="number" min="0" step="0.5" value="${f.horas_totales}" data-plan-input="horas_totales" data-i="${i}" /></label>
          <label class="cst-plan-campo cst-plan-salario-celda"><span>${sinSalarioConocido ? 'Salario mensual' : 'Costo/hora'}</span>${celdaCosto}</label>
          <div class="cst-plan-campo cst-plan-campo-subtotal"><span>Subtotal</span>
            <strong class="cst-plan-subtotal" data-plan-subtotal="${i}">${formatCOP(subtotalFilaPlan(f))}</strong></div>
        </div>
      </div>`;
        }).join('')}
    </div>
    <div class="cst-plan-footer">
      <button type="button" class="btn-ghost" data-plan-add>+ Agregar rol</button>
      <span class="cst-plan-total" data-plan-total-equipo>Subtotal equipo: <strong>${formatCOP(totalFilas)}</strong></span>
    </div>
    <p class="emp-muted cst-plan-hint">"Horas totales" es el total que ese rol va a trabajar en todo el proyecto — no por semana. Con un Talento elegido, el costo/hora sale de su salario y no se escribe a mano. Cada rol es una persona: para dos del mismo cargo, agrega el rol dos veces.</p>

    <p class="cst-sim-nuevo-seccion-label">Gastos iniciales <span class="cst-field-hint">(opcional — licencias, viáticos, hardware…)</span></p>
    <table class="emp-table cst-plan-table" ${gastos.length ? '' : 'hidden'} data-plan-gastos-table>
      <thead><tr><th>Descripción</th><th>Valor (COP)</th><th></th></tr></thead>
      <tbody>
        ${gastos.map((g, i) => (gastoConfirmado(g) ? `
        <tr class="cst-plan-gasto-fijo">
          <td>${escapeHtml(g.description)}</td>
          <td>${formatCOP(g.amount)}</td>
          <td><div class="cst-plan-gasto-acciones">
            <button type="button" class="btn-ghost" data-plan-gasto-editar="${i}" title="Editar este gasto" aria-label="Editar este gasto">${icono('lapiz')}</button>
            <button type="button" class="btn-ghost" data-plan-gasto-remove="${i}" title="Quitar este gasto" aria-label="Quitar este gasto">${icono('cerrar')}</button>
          </div></td>
        </tr>` : `
        <tr>
          <td>
            <input type="text" placeholder="Ej. Licencia Azure, viáticos de arranque…" value="${escapeHtml(g.description)}" data-plan-gasto="description" data-i="${i}" />
            <small class="cst-plan-gasto-error" data-plan-gasto-error="${i}" hidden></small>
          </td>
          <td><input type="text" inputmode="numeric" value="${g.amount}" data-plan-gasto="amount" data-i="${i}" /></td>
          <td><div class="cst-plan-gasto-acciones">
            <button type="button" class="btn-ghost cst-plan-gasto-confirmar" data-plan-gasto-confirmar="${i}" title="Agregar este gasto" aria-label="Agregar este gasto">${icono('mas')}</button>
            <button type="button" class="btn-ghost" data-plan-gasto-remove="${i}" title="Quitar este gasto" aria-label="Quitar este gasto">${icono('cerrar')}</button>
          </div></td>
        </tr>`)).join('')}
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
          <td>${o.fecha ? escapeHtml(formatFecha(o.fecha)) : `Semana ${escapeHtml(String(o.week_number))}/${escapeHtml(String(o.month_number))}/${escapeHtml(String(o.year_number))}`}${o.programada ? ' <span class="cst-overtime-programada" title="Todavía no suma al ejecutado: cuenta en el costo total como comprometida">Programada</span>' : ''}</td>
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
      // Si ya había algo guardado, quitar todas las filas tiene que borrarlo
      // al Guardar (ver guardarEdicionCentro).
      teniaPlanGuardado: filas.length > 0 || (gastos || []).length > 0,
    };
    renderPlanRecursosBody(card);
  };

  // El plan se carga siempre, sin importar la casilla (3 sep 2026): antes
  // solo se pedía si toggle.checked, así que un proyecto presupuestado a
  // mano nunca mostraba sus horas planeadas por persona, aunque ya tuviera
  // algunas guardadas de una edición previa.
  await Promise.all([cargarPlan(), llenarSelectPmEdicion(card, c)]);

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
      // Nace como borrador (ver gastoConfirmado): con inputs y botón "+".
      planRecursosEdit.gastos.push({ description: '', amount: 0, confirmado: false });
      renderPlanRecursosBody(card);
      enfocarGastoPlan(card, planRecursosEdit.gastos.length - 1);
    }
    const confirmarGastoBtn = e.target.closest('[data-plan-gasto-confirmar]');
    if (confirmarGastoBtn) {
      confirmarGastoPlan(card, Number(confirmarGastoBtn.dataset.planGastoConfirmar));
    }
    const editarGastoBtn = e.target.closest('[data-plan-gasto-editar]');
    if (editarGastoBtn) {
      const i = Number(editarGastoBtn.dataset.planGastoEditar);
      planRecursosEdit.gastos[i].confirmado = false;
      renderPlanRecursosBody(card);
      enfocarGastoPlan(card, i);
    }
    const removeGastoBtn = e.target.closest('[data-plan-gasto-remove]');
    if (removeGastoBtn) {
      planRecursosEdit.gastos.splice(Number(removeGastoBtn.dataset.planGastoRemove), 1);
      renderPlanRecursosBody(card);
    }
  });

  // Enter en un gasto borrador = darle "+". Sin esto, Enter dentro de estos
  // inputs MANDA EL FORMULARIO ENTERO del proyecto (envío implícito del
  // <form>): se guardaba todo con el gasto a medio escribir.
  body.addEventListener('keydown', (e) => {
    const gastoInput = e.target.closest('[data-plan-gasto]');
    if (!gastoInput || e.key !== 'Enter') return;
    e.preventDefault();
    confirmarGastoPlan(card, Number(gastoInput.dataset.i));
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
      // El nombre completo del cargo al pasar el mouse, por si no cabe.
      if (campo === 'role_catalog') input.title = input.value ? input.selectedOptions[0]?.textContent || '' : '';
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
  // Los responsables solo viajan si de verdad se cambiaron: así una edición
  // cualquiera (fechas, presupuesto) no reescribe los dueños del proyecto.
  // Cuando viajan, va la lista COMPLETA: quien no esté, deja de ser dueño.
  const pmCampo = form.querySelector('[data-centro-pm]');
  if (pmCampo && pmCampo._multiselect) {
    const ahora = pmCampo._multiselect.getValues();
    const antes = JSON.parse(pmCampo.dataset.inicial || '[]');
    if (!mismosValores(ahora, antes)) data.pm_user_ids = ahora;
  }

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
          // Siempre 1 (10 nov 2026, a pedido explícito): el campo "Personas"
          // se quitó; para dos personas del mismo cargo se agregan dos roles.
          role_catalog: f.role_catalog, employee_id: f.employee_id || null,
          personas: 1, horas_totales: f.horas_totales, costo_hora: f.costo_hora,
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
      // Sin roles el plan se borra entero, gastos incluidos: el servidor no
      // guarda un plan "solo gastos". Se avisa en vez de perderlos callado.
      if (!filas.length && gastos.length) {
        throw new Error('Los gastos iniciales necesitan al menos un rol en el Plan de Recursos. Agrega un rol o quita también los gastos.');
      }

      if (filas.length) {
        const { equipo_creado } = await fetchJSON(`/api/costeo/centros/${costCenterId}/plan-recursos`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filas, gastos, actualizar_presupuesto: planActivo }),
        });
        // Guardar el plan puede tocar Equipo del Proyecto aunque nadie traiga
        // salario nuevo (alta de personas con salario conocido, horas
        // planeadas, alguien que estaba "Sin proyecto"): se refresca siempre
        // para que no haya que recargar la página para verlo.
        void equipo_creado;
        await loadEquipoYGastos();
        // El presupuesto YA lo fijó el servidor desde el plan — mandarlo
        // también en el PUT normal de abajo chocaría con su guard (409:
        // "el presupuesto se calcula desde su plan").
        if (planActivo) delete data.budget;
      } else if (c?.budget_from_plan || planRecursosEdit?.teniaPlanGuardado) {
        // Se vació el plan: hay que borrarlo explícitamente. Antes solo se
        // hacía si el presupuesto estaba atado al plan (budget_from_plan); en
        // un proyecto con presupuesto a mano, quitar la única fila no mandaba
        // nada y la persona seguía ahí al volver a Editar (10 nov 2026,
        // reportado con Auditoria).
        await fetchJSON(`/api/costeo/centros/${costCenterId}/plan-recursos`, { method: 'DELETE' });
        // Quien se quitó del plan sin horas sale también del Equipo.
        await loadEquipoYGastos();
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
  if (!(await cstConfirm('¿Eliminar este centro de costos PERMANENTEMENTE? Se borrarán sus gastos y horas extra — esto no se puede deshacer. Su equipo no se pierde: quien no esté en otro proyecto queda "Sin proyecto" en Equipo del Proyecto. El historial se conserva.'))) return;
  await withBusy(btn, async () => {
    try {
      await fetchJSON(`/api/costeo/centros/${costCenterId}`, { method: 'DELETE' });
      await loadIndicadores();
      await loadAlertas();
      renderCentroCostosPanel();
      await populateEquipoGastoCentroSelect();
      // Eliminar el proyecto también cambia otras pantallas que ya estaban
      // cargadas: su gente pasa a "Sin proyecto" en Equipo del Proyecto, y
      // sus gastos y horas extra desaparecen. Sin esto se seguían viendo
      // como antes hasta recargar la página (16 oct 2026, reportado).
      await Promise.all([loadEquipoYGastos(), loadOvertime(), loadHistorial()]);
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
  // carpetas, no projects: desde el 6 nov 2026 `projects` son los propios
  // centros de Costeo (el filtro de Planeación), que aquí ya estarían todos
  // "usados" y el autocompletado quedaría vacío.
  const { carpetas } = await fetchJSON('/api/filters?carpetas=1');
  const usados = new Set(state.centros.map((c) => c.project_folder));
  const disponibles = (carpetas || []).filter((p) => !usados.has(p));
  datalist.innerHTML = disponibles.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('');
}

// "Responsable (PM)" de un centro: solo admin/ceo lo eligen, al crear y al
// editar (20 oct 2026, a pedido explícito: los PM renuncian y el proyecto
// pasa a otro). Un PM no lo ve: el proyecto que crea queda a su nombre (lo
// resuelve el backend) y no puede reasignarlo.
function esAdminCosteo() {
  return !!(state.user && (state.user.role === 'admin' || state.user.role === 'ceo'));
}

async function pmsActivosCosteo() {
  const { accesos } = await fetchJSON('/api/costeo/accesos');
  return (accesos || []).filter((a) => a.is_active);
}

// Valor con que se identifica a cada responsable en el selector múltiple:
// su user_id, o "email:<correo>" si no tiene usuario en el sistema (solo su
// nombre en mp_project_owners). Así se puede conservar tal cual sin
// inventarle un usuario.
function valorPm(p) {
  return p.user_id ? String(p.user_id) : `email:${p.email}`;
}

// Los responsables actuales de un centro, como valores del selector.
function valoresPmDe(c) {
  if (Array.isArray(c.pms) && c.pms.length) return c.pms.map(valorPm);
  return c.pm_user_id ? [String(c.pm_user_id)] : [];
}

function mismosValores(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b.map(String));
  return a.every((v) => sb.has(String(v)));
}

// Opciones del selector: "Yo mismo", los PM activos y, además, los
// responsables actuales que ya no están en esa lista (renunciaron y los
// desactivaron en Accesos, o no tienen usuario) — marcados, para que se
// vean y no se le quiten al proyecto en silencio al guardar otra cosa.
function opcionesPm(pmsActivos, c) {
  const yo = state.user || {};
  const opciones = [{ value: String(yo.user_id), label: `Yo mismo (${yo.full_name || ''})` }];
  pmsActivos
    .filter((p) => String(p.user_id) !== String(yo.user_id))
    .forEach((p) => opciones.push({ value: String(p.user_id), label: p.full_name }));
  const yaEsta = new Set(opciones.map((o) => o.value));
  ((c && c.pms) || []).forEach((p) => {
    const v = valorPm(p);
    if (yaEsta.has(v)) return;
    opciones.push({ value: v, label: `${p.nombre} (${p.user_id ? 'inactivo' : 'sin usuario'})` });
    yaEsta.add(v);
  });
  return opciones;
}

// Valores de "Todos los PM": los PM activos (no incluye a quien guarda ni a
// los inactivos).
function valoresTodosLosPm(pmsActivos) {
  const yo = state.user || {};
  return pmsActivos.filter((p) => String(p.user_id) !== String(yo.user_id)).map((p) => String(p.user_id));
}

async function llenarSelectPmEdicion(card, c) {
  const campo = card.querySelector('[data-centro-pm]');
  if (!campo) return;
  const pmsActivos = await pmsActivosCosteo();
  const iniciales = JSON.parse(campo.dataset.inicial || '[]');
  campo._multiselect = crearMultiselect(campo, opcionesPm(pmsActivos, c), iniciales, { placeholder: 'Buscar PM…' });
  const todos = card.querySelector('[data-centro-pm-todos]');
  if (todos) {
    todos.onclick = () => {
      const actuales = campo._multiselect.getValues();
      campo._multiselect.setValues([...new Set([...actuales, ...valoresTodosLosPm(pmsActivos)])]);
    };
  }
}

let centroPmWidget = null;

async function populateCentroPmSelect() {
  const wrap = document.getElementById('cst-centro-pm-wrap');
  const campo = document.getElementById('cst-centro-pm');
  wrap.hidden = !esAdminCosteo();
  centroPmWidget = null;
  if (!esAdminCosteo()) return;
  const pmsActivos = await pmsActivosCosteo();
  centroPmWidget = crearMultiselect(campo, opcionesPm(pmsActivos, null), [], { placeholder: 'Buscar PM…' });
  document.getElementById('cst-centro-pm-todos').onclick = () => {
    const actuales = centroPmWidget.getValues();
    centroPmWidget.setValues([...new Set([...actuales, ...valoresTodosLosPm(pmsActivos)])]);
  };
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
    await Promise.all([populateCentroProjectSelect(), populateCentroPmSelect()]);
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
            // Vacío = queda quien lo crea (lo resuelve el servidor).
            pm_user_ids: document.getElementById('cst-centro-pm-wrap').hidden || !centroPmWidget
              ? undefined : centroPmWidget.getValues(),
          }),
        });
        // cerrarModal ya hace el reset() del formulario.
        cerrarModal('cst-centro-modal-overlay');
        cstToast('Centro de costos creado.');
        await loadIndicadores();
        await loadAlertas();
        renderCentroCostosPanel();
        await populateEquipoGastoCentroSelect();
        // Un centro creado con plan puede dar de alta gente en el equipo.
        await loadEquipoYGastos();
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
    if (editForm) {
      e.preventDefault();
      guardarEdicionCentro(editForm.dataset.centroEditForm, editForm);
    }
  });
}

