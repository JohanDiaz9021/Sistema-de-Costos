'use strict';

/**
 * Equipo del Proyecto, Gastos no planeados y Tarifas por Cargo.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Equipo y Gastos =====================
// Vista global (5.11): admin/ceo ve equipo y gastos de TODOS los centros a
// la vez, con el Centro de Costos como columna (pill), no como filtro
// obligatorio. Los selects de centro solo viven en los formularios de alta.

// El cargo ya no es una lista fija en el código (ver sql/23): la etiqueta
// visible se busca primero en state.tarifasCargo (lo que trae GET
// /tarifas-cargo, que incluye los cargos creados por un PM) y solo cae al
// ROLE_LABEL estático (costeo-centros.js) para los 7 cargos originales,
// como último recurso si por lo que sea aún no cargó el catálogo.
function roleLabel(rol) {
  const cargo = (state.tarifasCargo || []).find((c) => c.role_catalog === rol);
  return (cargo && cargo.nombre_visible) || ROLE_LABEL[rol] || rol;
}

// Llena el <select> de Cargo del formulario de alta de Equipo con el
// catálogo real (state.tarifasCargo), en vez de la lista fija que había
// antes — así un cargo creado por un PM (POST /tarifas-cargo) aparece aquí
// sin necesitar un despliegue.
//
// El de alta (cst-equipo-role) y el de filtro (cst-equipo-filtro-cargo) son
// selects INDEPENDIENTES desde ahora — a pedido explícito: antes el mismo
// select hacía doble función (elegir el cargo del talento nuevo Y filtrar
// la tabla de abajo), y elegir un cargo para dar de alta a alguien ocultaba
// de la tabla a todo el resto del equipo que no tuviera ese cargo.
function populateEquipoRoleSelect() {
  const opciones = (state.tarifasCargo || [])
    .map((c) => `<option value="${c.role_catalog}">${escapeHtml(c.nombre_visible)}</option>`)
    .join('');

  const altaSelect = document.getElementById('cst-equipo-role');
  if (altaSelect) {
    const current = altaSelect.value;
    altaSelect.innerHTML = '<option value="">Ninguno</option>' + opciones;
    altaSelect.value = current || '';
  }
  const filtroSelect = document.getElementById('cst-equipo-filtro-cargo');
  if (filtroSelect) {
    const current = filtroSelect.value;
    filtroSelect.innerHTML = '<option value="">Todos</option>' + opciones;
    filtroSelect.value = current || '';
  }
}

async function populateEquipoGastoCentroSelect() {
  const opciones = state.centros
    .map((c) => `<option value="${c.cost_center_id}">${escapeHtml(c.project_name)}</option>`)
    .join('') || '<option value="">Crea un centro de costos primero</option>';

  // cst-gasto-centro: solo sirve para el alta de gastos, no es filtro —
  // sigue defaulteando al primer centro.
  const gastoSelect = document.getElementById('cst-gasto-centro');
  if (gastoSelect) {
    const current = gastoSelect.value;
    gastoSelect.innerHTML = opciones;
    gastoSelect.value = current || (state.centros[0] ? state.centros[0].cost_center_id : '');
  }

  // cst-equipo-centro: SOLO sirve para el alta (a qué centro se agrega el
  // talento) — ya no filtra la tabla (ver populateEquipoRoleSelect arriba).
  const equipoSelect = document.getElementById('cst-equipo-centro');
  if (equipoSelect) {
    const current = equipoSelect.value;
    equipoSelect.innerHTML = '<option value="">Ninguno</option>' + opciones;
    equipoSelect.value = current || '';
  }

  // cst-equipo-filtro-centro: SOLO filtra la tabla, independiente del select
  // de arriba.
  const filtroCentroSelect = document.getElementById('cst-equipo-filtro-centro');
  if (filtroCentroSelect) {
    const current = filtroCentroSelect.value;
    filtroCentroSelect.innerHTML = '<option value="">Todos</option>' + opciones;
    filtroCentroSelect.value = current || '';
  }
}

// Usa /api/employees (catálogo completo) y no /api/filters, que solo trae a
// quienes tienen tareas en el último snapshot de la RPA — así también
// aparecen los PM y cualquiera que aún no haya reportado horas.
async function loadEmployeesOptions() {
  const { rows } = await fetchJSON('/api/employees');
  state.employees = (rows || []).filter((e) => e.is_active);
  const opciones = state.employees
    .map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`)
    .join('');

  const altaSelect = document.getElementById('cst-equipo-employee');
  if (altaSelect) altaSelect.innerHTML = '<option value="">Ninguno</option>' + opciones;

  // cst-equipo-filtro-talento: independiente del select de alta de arriba
  // (ver comentario en populateEquipoRoleSelect) — solo filtra la tabla.
  const filtroSelect = document.getElementById('cst-equipo-filtro-talento');
  if (filtroSelect) {
    const current = filtroSelect.value;
    filtroSelect.innerHTML = '<option value="">Todos</option>' + opciones;
    filtroSelect.value = current || '';
  }
}

function renderEquipoTable() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  const tbody = document.getElementById('cst-equipo-tbody');

  // Talento, Cargo y Centro de Costos de la barra de filtro (independiente
  // del formulario de alta de arriba — ver populateEquipoRoleSelect) —
  // "Todos" (default de los 3) significa "sin filtro, mostrar todos".
  const fEmployee = document.getElementById('cst-equipo-filtro-talento').value;
  const fRole = document.getElementById('cst-equipo-filtro-cargo').value;
  const fCentro = document.getElementById('cst-equipo-filtro-centro').value;

  // El filtro GLOBAL de Centro de Costos (cst-f-centro, el selector de
  // Proyecto del encabezado) también acota esta tabla. Los dos juegos de
  // filtro se combinan (intersección): si arriba se eligió un centro Y abajo
  // otro cargo, se aplican los dos a la vez.
  //
  // El Recurso global ya NO se lee acá (11 sep 2026, a pedido explícito):
  // esta pantalla tiene su propio filtro "Talento" (cst-equipo-filtro-talento,
  // arriba) que hace exactamente lo mismo, así que eran dos controles para un
  // solo recorte. Se quedó el de la tabla y salió el global — ver
  // FILTROS_POR_SUBTAB_EQUIPO_GASTOS en costeo-indicadores.js, que además lo
  // oculta en esta sub-pestaña.
  const gCentro = document.getElementById('cst-f-centro')?.value || '';

  // Solo se ven las asignaciones activas — una persona con 2 proyectos que
  // se retira de uno NO debe seguir viéndose "Inactivo" ahí estorbando la
  // vista de su proyecto actual (a pedido explícito).
  // Los inactivos SE VEN, con su pastilla "Inactivo" (16 sep 2026, a pedido
  // explícito): inactivar no puede ser un viaje de ida, la persona tiene que
  // seguir ahí para poder reactivarla cuando vuelva. El filtro permite
  // ocultarlos si algún día estorban, pero por defecto se muestran.
  //
  // Si el <select> todavía no existe (primer pintado), se muestran igual: el
  // defecto seguro es enseñar de más, no esconder gente sin avisar.
  const filtroInactivos = document.getElementById('cst-equipo-filtro-inactivos');
  const verInactivos = !filtroInactivos || filtroInactivos.value === '1';

  const visibles = state.equipo
    .filter((m) => m.is_active || verInactivos)
    .filter((m) => !fEmployee || String(m.employee_id) === String(fEmployee))
    .filter((m) => !fRole || m.role_catalog === fRole)
    .filter((m) => !fCentro || String(m.cost_center_id) === String(fCentro))
    .filter((m) => !gCentro || String(m.cost_center_id) === String(gCentro));

  // Una misma persona puede estar en varios proyectos a la vez (una fila
  // por team_member_id) — antes cada una repetía el nombre completo, y con
  // dos filas seguidas casi idénticas se veía como un registro duplicado
  // por error. Se agrupan por employee_id: el nombre solo se imprime en la
  // primera fila del grupo (celda vacía en las siguientes, no colspan/
  // rowspan) para no tocar el mecanismo de edición por fila — cada fila
  // sigue siendo su propio <tr data-equipo-row> independiente, editable sin
  // afectar a las demás del mismo grupo.
  const gruposPorEmpleado = new Map();
  visibles.forEach((m) => {
    if (!gruposPorEmpleado.has(m.employee_id)) gruposPorEmpleado.set(m.employee_id, []);
    gruposPorEmpleado.get(m.employee_id).push(m);
  });

  // Se pagina por PERSONA, no por fila: alguien con tres proyectos ocupa tres
  // filas seguidas bajo un solo nombre (ver el agrupado de arriba), y cortar
  // por fila dejaria su nombre en una pagina y sus proyectos en la siguiente.
  const pagEquipo = paginar('equipo', [...gruposPorEmpleado.values()]);

  let zebra = false;
  const filas = [];
  pagEquipo.items.forEach((filasDelGrupo) => {
    zebra = !zebra;
    filasDelGrupo.forEach((m, i) => {
      const esPrimera = i === 0;
      const esUltima = i === filasDelGrupo.length - 1;
      filas.push(`
        <tr data-equipo-row="${m.team_member_id}"
            class="${m.is_active ? '' : 'emp-inactive'} ${zebra ? 'cst-equipo-zebra' : ''} ${filasDelGrupo.length > 1 ? 'cst-equipo-agrupada' : ''} ${!esPrimera ? 'cst-equipo-cont' : ''} ${!esUltima ? 'cst-equipo-mas-abajo' : ''}">
          <td>${esPrimera ? escapeHtml(m.canonical_name) : ''}</td>
          <td>${escapeHtml(roleLabel(m.role_catalog))}</td>
          <td><span class="cst-pill-centro">${escapeHtml(m.project_name || m.project_folder)}</span></td>
          <td${m.monthly_salary ? ` title="Salario ${formatCOP(m.monthly_salary)} ÷ ${state.horasMes || 210} horas/mes"` : ''}>
            ${Number(m.hourly_cost) > 0 ? formatCOP(m.hourly_cost) : '<span class="emp-muted">Sin definir</span>'}
            ${m.monthly_salary ? '<span class="cst-badge-salario" title="El valor hora se calcula desde el salario mensual">fórmula</span>' : ''}
          </td>
          <td>${m.planned_hours ? `${Number(m.planned_hours)} h` : '<span class="emp-muted">—</span>'}</td>
          <td>${m.planned_hours && Number(m.hourly_cost) > 0 ? formatCOP(Number(m.planned_hours) * Number(m.hourly_cost)) : '<span class="emp-muted">—</span>'}</td>
          <!-- Inactivo en ROJO (estado-no_viable), no en gris (16 sep 2026, a
               pedido explícito). Desde que los inactivos se quedan a la
               vista, el gris los volvía casi invisibles justo en la tabla
               donde hay que encontrarlos para reactivarlos. Se reusa el rojo
               que ya tiene el sistema en vez de inventar otro. -->
          <td><span class="cst-estado-pill ${m.is_active ? 'estado-viable' : 'estado-no_viable'}">${m.is_active ? 'Activo' : 'Inactivo'}</span></td>
          <td>${(isAdmin || state.user?.role === 'leader') ? `<button type="button" class="btn-ghost" data-equipo-edit="${m.team_member_id}">Editar</button>` : ''}</td>
        </tr>`);
    });
  });

  tbody.innerHTML = filas.join('') || '<tr><td colspan="8" class="emp-muted">Sin equipo asignado.</td></tr>';
  pintarPaginacion('equipo', pagEquipo, tbody);
}

function equipoEditFormHTML(m) {
  const opcionesRole = (state.tarifasCargo || [])
    .map((c) => `<option value="${c.role_catalog}" ${m.role_catalog === c.role_catalog ? 'selected' : ''}>${escapeHtml(c.nombre_visible)}</option>`)
    .join('');
  const opcionesCentro = state.centros
    .map((c) => `<option value="${c.cost_center_id}" ${String(c.cost_center_id) === String(m.cost_center_id) ? 'selected' : ''}>${escapeHtml(c.project_name)}</option>`)
    .join('');
  return `
    <td colspan="8">
      <form class="cst-cc-edit-form cst-acceso-form" data-equipo-edit-form="${m.team_member_id}">
        <label><span>Talento</span><input type="text" value="${escapeHtml(m.canonical_name)}" disabled /></label>
        <label><span>Cargo</span><select name="role_catalog">${opcionesRole}</select></label>
        <label><span>Centro de Costos</span><select name="cost_center_id">${opcionesCentro}</select></label>
        <!-- Fórmula de GTC (sql/33): con salario mensual, el costo/hora se
             calcula (salario ÷ horas/mes) y no se teclea. Vaciar el salario
             devuelve el campo de abajo al modo manual. -->
        <label><span>Salario mensual (COP)</span><input type="text" inputmode="numeric" name="monthly_salary" value="${m.monthly_salary ? Number(m.monthly_salary) : ''}" placeholder="Ej. 1.750.950" /></label>
        <!-- min 0: un integrante puede estar cargado sin tarifa todavía (0 =
             sin definir, no suma a los indicadores) y hay que poder guardar
             el resto de sus datos sin obligar a inventar una cifra. -->
        <label><span>Costo/hora (COP)</span><input type="number" name="hourly_cost" min="0" step="1" value="${Number(m.hourly_cost)}" required /></label>
        <p class="cst-valor-hora-hint" data-valor-hora hidden></p>
        <label><span>Horas planeadas <span class="cst-field-hint">(opcional)</span></span><input type="number" name="planned_hours" min="0" step="0.5" value="${m.planned_hours ? Number(m.planned_hours) : ''}" placeholder="Ej. 50" /></label>
        <!-- El estado NO se edita aquí (16 sep 2026): lo cambian los botones
             "Inactivar"/"Activar" de abajo. Tener además un desplegable
             Activo/Inactivo era el mismo cambio por dos caminos distintos, y
             encima uno que solo se aplicaba al pulsar "Guardar" mientras el
             botón actúa al instante — dos comportamientos distintos para lo
             que el usuario ve como una sola cosa. -->
        <p class="cst-tc-hint">Cambiar el Centro de Costos aquí MUEVE a ${escapeHtml(m.canonical_name)} de proyecto — no la agrega a uno nuevo. Para que quede en más de un proyecto a la vez, usa "+ Agregar persona a un proyecto" arriba de la tabla.</p>
        <p class="emp-form-error" data-equipo-edit-error hidden></p>
        <!-- Inactivar y Eliminar son DOS cosas distintas (16 sep 2026, a
             pedido explícito), y hasta hoy el único botón decía "Eliminar"
             pero por dentro solo desactivaba:
               Inactivar -> sigue en el sistema, deja de contar para alertas
                 y costos, y se puede reactivar el día que vuelva.
               Eliminar  -> desaparece. El servidor solo lo permite si no
                 dejó ningún rastro (ver DELETE /equipo/:id).
             El texto del primero cambia segun el estado actual: ofrecerle
             "Inactivar" a alguien que YA esta inactivo no significa nada. -->
        <div class="cst-cc-edit-actions">
          <button type="submit" class="btn-primary">Guardar</button>
          <button type="button" data-equipo-edit-cancel="${m.team_member_id}">Cancelar</button>
          <button type="button" data-equipo-toggle-activo="${m.team_member_id}" data-activo="${m.is_active ? '1' : '0'}">
            ${m.is_active ? 'Inactivar' : 'Activar'}
          </button>
          <button type="button" data-equipo-edit-delete="${m.team_member_id}" class="btn-danger">Eliminar</button>
        </div>
      </form>
    </td>`;
}

// Fórmula de GTC (sql/33): valor hora = salario mensual ÷ horas/mes.
//
// Se cablea sobre el par de campos salario/costo-hora de cualquiera de los
// dos formularios (alta y edición). Mientras haya salario, el costo/hora se
// calcula y se bloquea: dejar los dos escribibles permitía guardar un
// salario de 1.750.950 junto a una tarifa de 9.300 que no sale de ninguna
// cuenta, y después nadie sabía cuál de los dos era el bueno. El servidor
// recalcula igual (resolverTarifa en routes/costeo/equipo.js) — esto es
// para que se vea el número antes de guardar, no para decidirlo.
function sincronizarValorHora(salarioInput, horaInput, hintEl) {
  if (!salarioInput || !horaInput) return;
  const recalcular = () => {
    const salario = desformatearMiles(salarioInput.value);
    const horasMes = state.horasMes || 210;
    if (salario > 0) {
      const valorHora = Math.round(salario / horasMes);
      horaInput.value = valorHora;
      horaInput.readOnly = true;
      if (hintEl) {
        hintEl.innerHTML = `Valor hora = ${formatCOP(salario)} ÷ ${horasMes} h = <strong>${formatCOP(valorHora)}</strong> por hora.`;
        hintEl.hidden = false;
      }
    } else {
      horaInput.readOnly = false;
      if (hintEl) hintEl.hidden = true;
    }
  };
  salarioInput.addEventListener('input', recalcular);
  recalcular();
}

function abrirEdicionEquipo(teamMemberId) {
  const m = state.equipo.find((x) => String(x.team_member_id) === String(teamMemberId));
  const row = document.querySelector(`tr[data-equipo-row="${teamMemberId}"]`);
  if (!m || !row) return;
  row.innerHTML = equipoEditFormHTML(m);
  attachMilesFormat(row.querySelector('[name="hourly_cost"]'));
  attachMilesFormat(row.querySelector('[name="monthly_salary"]'));
  sincronizarValorHora(
    row.querySelector('[name="monthly_salary"]'),
    row.querySelector('[name="hourly_cost"]'),
    row.querySelector('[data-valor-hora]')
  );
}

async function guardarEdicionEquipo(teamMemberId, form) {
  const errorEl = form.querySelector('[data-equipo-edit-error]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  await withBusy(submitBtn, async () => {
    try {
      await fetchJSON(`/api/costeo/equipo/${teamMemberId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role_catalog: data.role_catalog,
          cost_center_id: Number(data.cost_center_id),
          // Se manda siempre, incluso vacío (null): así vaciar el salario
          // es la forma explícita de volver al costo/hora escrito a mano.
          monthly_salary: desformatearMiles(data.monthly_salary) || null,
          hourly_cost: desformatearMiles(data.hourly_cost) || 0,
          // Igual que el salario: se manda siempre, incluso vacío, para que
          // vaciarlo sea la forma explícita de volver a "sin definir".
          planned_hours: data.planned_hours || null,
          // is_active NO se manda: ya no está en el formulario (lo cambian
          // los botones Inactivar/Activar). Mandarlo derivado de un campo
          // inexistente lo volvería `false` en cada guardado, o sea que
          // editar el costo/hora desactivaría a la persona sin querer.
        }),
      });
      await loadEquipoYGastos();
      await loadTarifasCargo();
      await loadIndicadores();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Guardando…');
}

const GASTO_CATEGORY_LABEL = {
  licencia: 'Licencia', viatico: 'Viático', tercero: 'Tercero',
  capacitacion: 'Capacitación', otro: 'Otro',
};

// Estado de aprobación del gasto (sql/28). El PM registra una solicitud:
// nace 'pendiente' (amarillo) y solo suma al presupuesto ejecutado cuando
// admin/ceo la aprueba (verde). Rechazada (rojo), no cuenta nunca.
const GASTO_ESTADO_LABEL = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado' };

function gastoEstadoHTML(g) {
  const estado = g.approval_status || 'pendiente';
  const label = GASTO_ESTADO_LABEL[estado] || estado;
  // El motivo del rechazo y quién resolvió van en el title: es el dato que
  // el PM necesita para saber qué corregir, sin ensanchar la tabla.
  const detalle = estado === 'rechazado' && g.rejection_note
    ? `Motivo: ${g.rejection_note}`
    : (estado !== 'pendiente' && g.approved_by_name ? `${label} por ${g.approved_by_name}` : '');
  const titulo = detalle ? ` title="${escapeHtml(detalle)}"` : '';
  return `<span class="cst-gasto-estado estado-${estado}"${titulo}>${escapeHtml(label)}</span>`;
}

function gastoEditFormHTML(g) {
  const opcionesCategoria = Object.entries(GASTO_CATEGORY_LABEL)
    .map(([v, l]) => `<option value="${v}" ${g.category === v ? 'selected' : ''}>${l}</option>`)
    .join('');
  return `
    <td colspan="6">
      <form class="cst-cc-edit-form" data-gasto-edit-form="${g.expense_id}">
        <label><span>Centro de Costos</span><input type="text" value="${escapeHtml(g.project_name || g.project_folder)}" disabled /></label>
        <label><span>Descripción</span><input type="text" name="description" value="${escapeHtml(g.description)}" required /></label>
        <label><span>Monto (COP)</span><input type="number" name="amount" min="0" step="1" value="${Number(g.amount)}" required /></label>
        <label><span>Categoría</span><select name="category">${opcionesCategoria}</select></label>
        <p class="emp-form-error" data-gasto-edit-error hidden></p>
        <div class="cst-cc-edit-actions">
          <button type="submit" class="btn-primary">Guardar</button>
          <button type="button" data-gasto-edit-cancel="${g.expense_id}">Cancelar</button>
        </div>
      </form>
    </td>`;
}

function abrirEdicionGasto(expenseId) {
  const g = state.gastos.find((x) => String(x.expense_id) === String(expenseId));
  const row = document.querySelector(`tr[data-gasto-row="${expenseId}"]`);
  if (!g || !row) return;
  row.innerHTML = gastoEditFormHTML(g);
  attachMilesFormat(row.querySelector('[name="amount"]'));
}

function restaurarFilaGasto() {
  renderGastosTable();
}

async function guardarEdicionGasto(expenseId, form) {
  const errorEl = form.querySelector('[data-gasto-edit-error]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  await withBusy(submitBtn, async () => {
    try {
      await fetchJSON(`/api/costeo/gastos/${expenseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: data.description,
          amount: desformatearMiles(data.amount) || 0,
          category: data.category,
        }),
      });
      await loadEquipoYGastos();
      await loadIndicadores();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Guardando…');
}

function renderGastosTable() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  const tbody = document.getElementById('cst-gastos-tbody');

  // Un gasto no planeado es del proyecto, no de una persona (no tiene
  // employee_id): el filtro global de Recurso no aplica aquí, solo el de
  // Centro de Costos.
  const gCentro = document.getElementById('cst-f-centro')?.value || '';
  const visibles = state.gastos.filter((g) => !gCentro || String(g.cost_center_id) === String(gCentro));

  // Un gasto solo tiene acciones MIENTRAS esta pendiente, y son las dos que
  // lo resuelven: Aprobar o Rechazar (11 sep 2026, a pedido explicito). Una
  // vez aprobado o rechazado la fila no ofrece nada mas — la idea es que el
  // costo no planeado quede como registro: editarlo despues cambiaria un
  // numero que ya paso por aprobacion, y borrarlo haria desaparecer del
  // historial algo que si ocurrio. Si hay que corregir, se registra otro.
  //
  // Editar/Eliminar salieron de TODAS las filas, no solo de las resueltas:
  // la unica salida de una solicitud equivocada es que el aprobador la
  // rechace, que es justamente lo que deja rastro de por que no cuenta.
  const pag = paginar('gastos', visibles);
  tbody.innerHTML = pag.items.map((g) => {
    const pendiente = (g.approval_status || 'pendiente') === 'pendiente';
    const puedeResolver = isAdmin && pendiente;
    return `
    <tr data-gasto-row="${g.expense_id}">
      <td><span class="cst-pill-centro">${escapeHtml(g.project_name || g.project_folder)}</span></td>
      <td>${escapeHtml(g.description)}</td>
      <td>${formatCOP(g.amount)}</td>
      <td>${escapeHtml(formatFecha(g.expense_date))}</td>
      <td>${gastoEstadoHTML(g)}</td>
      <td>
        ${puedeResolver ? `<button type="button" class="btn-approve" data-gasto-aprobar="${g.expense_id}">Aprobar</button>` : ''}
        ${puedeResolver ? `<button type="button" class="btn-danger" data-gasto-rechazar="${g.expense_id}">Rechazar</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="emp-muted">Sin gastos registrados.</td></tr>';
  pintarPaginacion('gastos', pag, tbody);
}

async function loadEquipoYGastos() {
  const [equipoRes, gastosRes] = await Promise.all([
    fetchJSON('/api/costeo/equipo'),
    fetchJSON('/api/costeo/gastos'),
  ]);
  state.equipo = equipoRes.equipo || [];
  state.gastos = gastosRes.gastos || [];
  renderEquipoTable();
  renderGastosTable();
}

// ===================== Tarifas por Cargo =====================
// Define el costo/hora estándar de cada cargo y lo aplica en bloque a
// quienes lo tienen. No reemplaza la tarifa individual de
// mp_equipo_proyecto (que es la que el motor usa): es el punto de partida,
// para no diligenciar decenas de campos uno a uno.

async function loadTarifasCargo() {
  const { cargos } = await fetchJSON('/api/costeo/tarifas-cargo');
  state.tarifasCargo = cargos || [];
  renderTarifasCargoTable();
  populateEquipoRoleSelect();
  // loadEquipoYGastos() y esta función corren en paralelo al arrancar
  // (costeo-nav.js) — la tabla de Equipo pinta el Cargo con roleLabel(),
  // que lee state.tarifasCargo. Si /equipo respondía antes que /tarifas-
  // cargo, la tabla se pintaba con el catálogo todavía vacío: cualquier
  // cargo creado dinámicamente (no uno de los 7 originales del fallback
  // estático ROLE_LABEL) se veía con su slug crudo ("analista_de_
  // desarrollo") en vez de su nombre ("Analista de Desarrollo") hasta la
  // próxima acción que disparara un re-render. Repintar aquí también
  // cierra esa carrera sin importar qué petición llegue primero.
  renderEquipoTable();
}

// Nada de window.prompt/confirm/alert aquí: son diálogos del navegador, no
// del producto — no se pueden estilar, bloquean la pestaña y en Chrome hasta
// avisan "esta página dice". Todo se edita y se confirma en la misma fila,
// igual que ya hace Equipo del Proyecto (ver equipoEditFormHTML).

// Eliminar un cargo es SOLO de admin/ceo (15 sep 2026, a pedido explícito):
// lo saca del catálogo de TODA la empresa y deja huérfana a gente de
// proyectos que un PM ni siquiera ve.
//
// Vive aquí arriba, y no dentro de la fila, porque la decide también la
// CABECERA: al PM se le quita la columna "Acciones" entera, no solo el
// botón. Una columna con encabezado y todas las celdas en blanco se lee
// como un error de la pantalla, no como "esto no es para ti".
function puedeEliminarCargos() {
  return !!(state.user && (state.user.role === 'admin' || state.user.role === 'ceo'));
}

function renderTarifasCargoTable() {
  const tbody = document.getElementById('cst-tarifas-cargo-tbody');
  if (!tbody) return;
  const cargos = state.tarifasCargo || [];

  // La cabecera se ajusta en cada pintado, no una sola vez al arrancar: este
  // panel se repinta al cambiar de pestaña y al recargar el catálogo, y el
  // `state.user` puede no estar listo todavía en el primer pintado.
  const th = document.getElementById('cst-tc-th-acciones');
  if (th) th.hidden = !puedeEliminarCargos();

  const pag = paginar('cargos', cargos);
  tbody.innerHTML = pag.items.map((c) => tarifaCargoFilaHTML(c)).join('');
  pintarPaginacion('cargos', pag, tbody);
}

function tarifaCargoFilaHTML(c) {
  const personas = `${c.personas} persona${c.personas === 1 ? '' : 's'}`;

  // "Última edición" solo puede reflejar cuándo se creó el cargo: no hay
  // ninguna otra escritura posible sobre una fila de mp_tarifa_cargo desde
  // que se quitó la tarifa estándar (28 ago 2026, a pedido explícito — cada
  // persona ya cobra distinto, un valor "estándar" por cargo no aportaba).
  const editado = c.updated_at
    ? `${formatFecha(c.updated_at)}${c.updated_by_name ? ' · ' + c.updated_by_name : ''}`
    : '—';

  // Se puede eliminar tenga o no gente asignada — a pedido explícito: la
  // empresa puede decidir sacar un cargo del catálogo. Si hay gente con ese
  // cargo, eliminarTarifaCargo() lo advierte antes de mandar el DELETE.
  //
  // La celda se OMITE (no se pinta vacía) cuando el usuario no puede
  // eliminar, porque la cabecera también desaparece — ver
  // renderTarifasCargoTable. Si se dejara el <td>, la fila tendría una
  // columna más que el encabezado y la tabla saldría descuadrada.
  const acciones = puedeEliminarCargos()
    ? `<td><button type="button" class="btn-ghost cst-tc-peligro" data-tc-eliminar="${c.role_catalog}" data-personas="${c.personas}">Eliminar</button></td>`
    : '';

  return `<tr data-tc-row="${c.role_catalog}">
    <td><b>${escapeHtml(c.nombre_visible)}</b></td>
    <td>${personas}</td>
    <td class="cst-tc-meta">${editado}</td>
    ${acciones}
  </tr>`;
}

function mostrarErrorTarifasCargo(msg) {
  const p = document.getElementById('cst-tarifas-cargo-error');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
}

function mostrarOkTarifasCargo(msg) {
  const p = document.getElementById('cst-tarifas-cargo-ok');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
  // Se retira sola: es una confirmación de "quedó guardado", no algo que
  // deba quedarse ocupando espacio en pantalla.
  if (msg) setTimeout(() => { if (p.textContent === msg) p.hidden = true; }, 4000);
}

// Crear un cargo nuevo (a pedido explícito: cualquier PM debe poder dar de
// alta un cargo desde acá, sin depender de admin/ceo ni de un despliegue —
// ver POST /tarifas-cargo).
async function initNuevoCargoForm() {
  const form = document.getElementById('cst-form-nuevo-cargo');
  if (!form) return;
  const input = document.getElementById('cst-nuevo-cargo-nombre');
  const errorEl = document.getElementById('cst-nuevo-cargo-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        const nombre = input.value;
        await fetchJSON('/api/costeo/tarifas-cargo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombre_visible: nombre }),
        });
        form.reset();
        await loadTarifasCargo();
        mostrarOkTarifasCargo(`Cargo "${nombre}" creado.`);
      } catch (err) {
        errorEl.textContent = err.message || 'No se pudo crear el cargo.';
        errorEl.hidden = false;
      }
    }, 'Agregando…');
  });
}

async function eliminarTarifaCargo(rol, btn, personas) {
  const cargo = (state.tarifasCargo || []).find((c) => c.role_catalog === rol);
  const nombre = cargo ? cargo.nombre_visible : rol;
  // Se puede eliminar tenga o no gente asignada — si tiene, se avisa antes:
  // esas personas quedan con un cargo que ya no está en el catálogo (no se
  // les borra ni se les cambia el cargo solo).
  const mensaje = personas > 0
    ? `¿Eliminar el cargo "${nombre}"? Hay ${personas} persona(s) con este cargo — no se les quita ni se les reasigna, pero el cargo ya no aparecerá en el catálogo. Esta acción no se puede deshacer.`
    : `¿Eliminar el cargo "${nombre}"? Esta acción no se puede deshacer.`;
  if (!(await cstConfirm(mensaje))) return;
  await withBusy(btn, async () => {
    try {
      const res = await fetchJSON(`/api/costeo/tarifas-cargo/${rol}`, { method: 'DELETE' });
      mostrarErrorTarifasCargo('');
      await loadTarifasCargo();
      mostrarOkTarifasCargo(res.afectados > 0
        ? `Cargo "${nombre}" eliminado (${res.afectados} persona(s) lo conservan, pero ya no está en el catálogo).`
        : `Cargo "${nombre}" eliminado.`);
    } catch (err) {
      mostrarErrorTarifasCargo(err.message || 'No se pudo eliminar el cargo.');
    }
  }, 'Eliminando…');
}

function initTarifasCargo() {
  initNuevoCargoForm();
  const tbody = document.getElementById('cst-tarifas-cargo-tbody');
  if (!tbody) return;

  tbody.addEventListener('click', (ev) => {
    const eliminar = ev.target.closest('[data-tc-eliminar]');
    if (eliminar) return eliminarTarifaCargo(eliminar.dataset.tcEliminar, eliminar, Number(eliminar.dataset.personas) || 0);
  });
}

// Alterna el campo "Talento" del formulario de alta entre elegir a alguien
// que ya existe (select) y dar de alta a alguien nuevo (solo el nombre — no
// hace falta correo, ver POST /equipo/nueva-persona), que se crea y se
// agrega al equipo en el mismo paso. No se pisan: el submit decide cuál de
// los dos mandar mirando si el bloque de "persona nueva" está visible.
function setModoNuevaPersona(activo) {
  const wrap = document.getElementById('cst-equipo-nueva-persona');
  const toggleBtn = document.getElementById('cst-equipo-toggle-nueva');
  const employeeSelect = document.getElementById('cst-equipo-employee');
  const titulo = document.getElementById('cst-equipo-modal-titulo');
  const hint = document.getElementById('cst-equipo-modal-hint');
  if (!wrap || !toggleBtn || !employeeSelect) return;
  wrap.hidden = !activo;
  // El link "Prefiero crear una persona nueva" solo tiene sentido cuando NO
  // se está ya en ese modo — adentro del bloque de persona nueva, el que
  // deja volver es "Prefiero elegir un talento existente" (cst-equipo-
  // cancelar-nueva).
  toggleBtn.hidden = activo;
  employeeSelect.closest('label').hidden = activo;
  employeeSelect.disabled = activo;
  // El título y la ayuda del modal reflejan en cuál de los dos flujos se
  // está — los mismos textos que ya anunciaban los dos botones del
  // encabezado ("+ Agregar persona a un proyecto" / "+ Agregar persona
  // nueva"), para que quede claro incluso si se llegó acá por el escape
  // hatch en vez del botón.
  if (titulo) titulo.textContent = activo ? 'Agregar persona nueva al equipo' : 'Agregar persona a un proyecto';
  if (hint) {
    hint.textContent = activo
      ? 'Se crea el talento (solo el nombre, sin correo ni líder) y se agrega al equipo del centro elegido, en un solo paso.'
      : 'Elige un talento que ya existe — si trabaja en otro proyecto, su salario se autocompleta solo.';
  }
  if (!activo) {
    // Al salir del modo (por cancelar o por éxito) se limpia el nombre y se
    // vuelve a marcar "Activo" — pero Cargo/Costo/Centro NO se tocan, para
    // no obligar a re-escribirlos si el PM sigue agregando gente después.
    document.getElementById('cst-equipo-nueva-nombre').value = '';
    document.getElementById('cst-equipo-nueva-activo').checked = true;
  }
}

// Envoltorio sobre el modal genérico (abrirModal/cerrarModal en
// costeo-core.js). `modo` es 'existente' (default, botón "+ Agregar persona
// a un proyecto") o 'nueva' (botón "+ Agregar persona nueva") — dos botones
// con función propia en vez de uno solo con un interruptor escondido adentro
// (a pedido explícito: no quedaba claro que un solo botón cubría los dos
// casos). Se fija ANTES de abrir para que el modal ya aparezca en el modo
// correcto, sin que el PM tenga que darse cuenta de que hay que cambiarlo.
function abrirEquipoModal(modo = 'existente') {
  setModoNuevaPersona(modo === 'nueva');
  abrirModal('cst-equipo-modal-overlay');
}

function cerrarEquipoModal() {
  cerrarModal('cst-equipo-modal-overlay');
}

function initEquipoGastoForms() {
  // Barra de filtro de la tabla — independiente del formulario de alta
  // (Talento/Cargo/Centro de "Agregar al equipo" ya NO filtran, ver
  // populateEquipoRoleSelect).
  [
    'cst-equipo-filtro-talento', 'cst-equipo-filtro-cargo', 'cst-equipo-filtro-centro',
    'cst-equipo-filtro-inactivos',
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderEquipoTable);
  });

  // Los dos botones del encabezado ("+ Agregar persona a un proyecto" / "+
  // Agregar persona nueva") no usan data-modal-abrir: además de abrir el
  // overlay, cada uno tiene que dejar el modal ya en SU modo — eso lo hace
  // abrirEquipoModal(modo) antes de llamar a abrirModal (costeo-core.js).
  // Cerrar sí lo maneja initModales por los data-modal-cerrar del HTML.
  document.querySelectorAll('[data-equipo-abrir-modal]').forEach((btn) => {
    btn.addEventListener('click', () => abrirEquipoModal(btn.dataset.equipoAbrirModal));
  });

  // Lo que reset() no alcanza al cerrar: salir del modo "+ Persona nueva" y
  // devolverle al costo/hora su estado editable (sincronizarValorHora lo
  // deja readOnly mientras haya salario, y reset() vacía el campo pero no le
  // quita el readOnly).
  const equipoOverlay = document.getElementById('cst-equipo-modal-overlay');
  if (equipoOverlay) {
    equipoOverlay.addEventListener('cst-modal-cerrado', () => {
      setModoNuevaPersona(false);
      // reset() vacía el salario pero no le quita el readOnly que le puso
      // bloquearSalarioAlta(true) — sin esto, la próxima vez que se abre el
      // modal el campo queda bloqueado para CUALQUIER persona que se elija,
      // aunque no tenga salario conocido todavía.
      bloquearSalarioAlta(false);
      document.getElementById('cst-equipo-salario').dispatchEvent(new Event('input'));
      document.getElementById('cst-equipo-horas-planeadas').dispatchEvent(new Event('input'));
    });
  }

  const toggleNuevaBtn = document.getElementById('cst-equipo-toggle-nueva');
  if (toggleNuevaBtn) {
    toggleNuevaBtn.addEventListener('click', () => {
      const wrap = document.getElementById('cst-equipo-nueva-persona');
      setModoNuevaPersona(wrap.hidden);
    });
  }

  const cancelarNuevaBtn = document.getElementById('cst-equipo-cancelar-nueva');
  if (cancelarNuevaBtn) {
    cancelarNuevaBtn.addEventListener('click', () => setModoNuevaPersona(false));
  }

  const equipoForm = document.getElementById('cst-form-equipo');
  const equipoError = document.getElementById('cst-equipo-error');
  const salarioAlta = document.getElementById('cst-equipo-salario');
  attachMilesFormat(salarioAlta);
  sincronizarValorHora(
    salarioAlta,
    document.getElementById('cst-equipo-hourly-cost'),
    document.getElementById('cst-equipo-valor-hora')
  );

  // Vista previa del costo planeado (horas planeadas × costo/hora) — igual
  // que el valor hora de arriba, se recalcula solo mientras se escribe, sin
  // esperar al submit. Se reengancha en los dos campos porque cualquiera de
  // los dos puede cambiar el resultado.
  const horasPlaneadasInput = document.getElementById('cst-equipo-horas-planeadas');
  const costoHoraInput = document.getElementById('cst-equipo-hourly-cost');
  const costoPlaneadoHint = document.getElementById('cst-equipo-costo-planeado');
  const actualizarCostoPlaneado = () => {
    const horas = Number(horasPlaneadasInput.value) || 0;
    const costoHora = desformatearMiles(costoHoraInput.value) || 0;
    if (horas > 0 && costoHora > 0) {
      costoPlaneadoHint.innerHTML = `Costo planeado = ${horas}h × ${formatCOP(costoHora)} = <strong>${formatCOP(horas * costoHora)}</strong>.`;
      costoPlaneadoHint.hidden = false;
    } else {
      costoPlaneadoHint.hidden = true;
    }
  };
  horasPlaneadasInput.addEventListener('input', actualizarCostoPlaneado);
  costoHoraInput.addEventListener('input', actualizarCostoPlaneado);

  // "Si ya tengo su sueldo real, no me lo vuelvas a preguntar" (a pedido
  // explícito): al elegir un talento que YA tiene salario cargado en OTRO
  // proyecto, se autocompleta — y se BLOQUEA (14 sep 2026, también a pedido
  // explícito): antes quedaba editable igual, así que cualquiera podía
  // pisarlo sin querer y dos proyectos terminaban con dos cifras distintas
  // para la misma persona real, que no tendrían de dónde salir — es el
  // mismo sueldo. Mismo patrón que ya usan Plan de Recursos y el Simulador
  // (ver celdaCosto en costeo-centros.js / costeo-comercial.js): conocido =
  // solo lectura, desconocido = se escribe la primera vez. Solo aplica al
  // talento EXISTENTE (el de "+ Persona nueva" no tiene historial del que
  // autocompletar).
  const salarioBloqueadoHint = document.getElementById('cst-equipo-salario-bloqueado');
  function bloquearSalarioAlta(bloqueado) {
    salarioAlta.readOnly = bloqueado;
    if (salarioBloqueadoHint) salarioBloqueadoHint.hidden = !bloqueado;
  }
  const employeeSelect = document.getElementById('cst-equipo-employee');
  employeeSelect.addEventListener('change', async () => {
    if (!employeeSelect.value) {
      // Volvió a "— elegir —": no dejar el campo bloqueado ni con el sueldo
      // de la persona anterior puesto, como si fuera un borrador de esta.
      salarioAlta.value = '';
      bloquearSalarioAlta(false);
      salarioAlta.dispatchEvent(new Event('input'));
      return;
    }
    try {
      const { monthly_salary } = await fetchJSON(`/api/costeo/equipo/salario-conocido/${employeeSelect.value}`);
      salarioAlta.value = monthly_salary ? formatCOP(monthly_salary).replace(/^\$\s*/, '') : '';
      bloquearSalarioAlta(!!monthly_salary);
      salarioAlta.dispatchEvent(new Event('input'));
    } catch {
      // Sin bloquear el alta si la consulta misma falla: el campo se deja
      // editable y con lo que tuviera, el PM siempre puede escribirlo a
      // mano si el servidor no pudo confirmar el estado real.
      bloquearSalarioAlta(false);
    }
  });
  // El divisor sale de Configuración, no de un 210 quemado en el navegador:
  // si mañana GTC liquida sobre otro número, la vista previa tiene que
  // coincidir con lo que el servidor va a guardar. Si la petición falla se
  // queda con 210 (el valor por defecto) — un formulario que igual funciona
  // vale más que uno que se bloquea por no poder pintar una ayuda.
  fetchJSON('/api/costeo/parametros-nomina')
    .then(({ horas_mes }) => {
      state.horasMes = horas_mes || 210;
      salarioAlta.dispatchEvent(new Event('input'));
    })
    .catch(() => { state.horasMes = state.horasMes || 210; });
  equipoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    equipoError.hidden = true;
    const enModoNuevaPersona = !document.getElementById('cst-equipo-nueva-persona').hidden;
    // Deshabilita el botón mientras la petición está en curso: sin esto, un
    // doble clic mandaba dos POST y podía agregar al mismo talento dos veces
    // antes de que el índice único (sql/17) alcanzara a rechazar la segunda.
    const submitBtn = equipoForm.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        if (enModoNuevaPersona) {
          const nombre = document.getElementById('cst-equipo-nueva-nombre').value.trim();
          if (!nombre) throw new Error('El nombre del nuevo talento es obligatorio.');
          await fetchJSON('/api/costeo/equipo/nueva-persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              canonical_name: nombre,
              cost_center_id: document.getElementById('cst-equipo-centro').value,
              role_catalog: document.getElementById('cst-equipo-role').value,
              monthly_salary: desformatearMiles(document.getElementById('cst-equipo-salario').value) || null,
              hourly_cost: desformatearMiles(document.getElementById('cst-equipo-hourly-cost').value),
              planned_hours: document.getElementById('cst-equipo-horas-planeadas').value || null,
              is_active: document.getElementById('cst-equipo-nueva-activo').checked,
            }),
          });
          // El talento nuevo ya existe en mp_employees — recarga el selector
          // para que aparezca disponible si se quiere agregar a otro proyecto.
          await loadEmployeesOptions();
        } else {
          const employeeId = document.getElementById('cst-equipo-employee').value;
          if (!employeeId) throw new Error('Selecciona un talento.');
          await fetchJSON('/api/costeo/equipo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cost_center_id: document.getElementById('cst-equipo-centro').value,
              employee_id: employeeId,
              role_catalog: document.getElementById('cst-equipo-role').value,
              monthly_salary: desformatearMiles(document.getElementById('cst-equipo-salario').value) || null,
              hourly_cost: desformatearMiles(document.getElementById('cst-equipo-hourly-cost').value),
              planned_hours: document.getElementById('cst-equipo-horas-planeadas').value || null,
            }),
          });
        }
        // Cierra y limpia (incluido el readOnly del costo/hora, ver el
        // listener de 'cst-modal-cerrado' arriba) — la tabla de abajo queda
        // a la vista con la persona ya agregada.
        cerrarEquipoModal();
        cstToast('Persona agregada al equipo.');
        await loadEquipoYGastos();
        await loadIndicadores();
      } catch (err) {
        equipoError.textContent = err.message;
        equipoError.hidden = false;
      }
    }, 'Agregando…');
  });

  const gastoForm = document.getElementById('cst-form-gasto');
  const gastoError = document.getElementById('cst-gasto-error');
  gastoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    gastoError.hidden = true;
    // Mismo motivo que en equipoForm: mp_costo_no_planeado no tiene ninguna
    // restricción de unicidad, así que un doble clic aquí sí insertaba dos
    // gastos idénticos sin ningún aviso.
    const submitBtn = gastoForm.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        await fetchJSON('/api/costeo/gastos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cost_center_id: document.getElementById('cst-gasto-centro').value,
            description: document.getElementById('cst-gasto-desc').value,
            amount: desformatearMiles(document.getElementById('cst-gasto-amount').value),
            expense_date: document.getElementById('cst-gasto-date').value,
            category: document.getElementById('cst-gasto-category').value,
          }),
        });
        // cerrarModal ya hace el reset() del formulario.
        cerrarModal('cst-gasto-modal-overlay');
        cstToast('Gasto registrado. Queda Pendiente hasta que lo aprueben.');
        await loadEquipoYGastos();
        await loadIndicadores();
      } catch (err) {
        gastoError.textContent = err.message;
        gastoError.hidden = false;
      }
    }, 'Registrando…');
  });

  const equipoTbody = document.getElementById('cst-equipo-tbody');
  equipoTbody.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-equipo-edit]');
    const cancelBtn = e.target.closest('[data-equipo-edit-cancel]');
    const deleteBtn = e.target.closest('[data-equipo-edit-delete]');
    const toggleBtn = e.target.closest('[data-equipo-toggle-activo]');
    if (editBtn) abrirEdicionEquipo(editBtn.dataset.equipoEdit);
    else if (cancelBtn) renderEquipoTable();
    else if (toggleBtn) {
      // Inactivar NO borra: la persona se queda, deja de contar para alertas
      // y costos (el motor filtra por is_active) y se puede reactivar.
      const estaActivo = toggleBtn.dataset.activo === '1';
      const teamMemberId = toggleBtn.dataset.equipoToggleActivo;
      const pregunta = estaActivo
        ? '¿Inactivar a esta persona? Dejará de aparecer en alertas y de sumar a los costos, pero sigue en el sistema y puedes reactivarla cuando quieras.'
        : '¿Activar de nuevo a esta persona? Volverá a contar para alertas y costos.';
      if (!(await cstConfirm(pregunta))) return;
      await withBusy(toggleBtn, async () => {
        try {
          await fetchJSON(`/api/costeo/equipo/${teamMemberId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !estaActivo }),
          });
          await loadEquipoYGastos();
          await loadIndicadores();
        } catch (err) {
          cstToast(err.message, { tipo: 'error' });
        }
      }, estaActivo ? 'Inactivando…' : 'Activando…');
    }
    else if (deleteBtn) {
      // Eliminar de verdad. El servidor lo rechaza si la persona dejó algún
      // rastro (horas, horas extra, plan, otros proyectos) y explica por qué
      // — ese mensaje se muestra tal cual, porque dice qué hacer en su lugar.
      if (!(await cstConfirm('¿Eliminar a esta persona del sistema? Solo se puede si no tiene ningún movimiento registrado. Si ya reportó horas, usa "Inactivar".'))) return;
      const teamMemberId = deleteBtn.dataset.equipoEditDelete;
      await withBusy(deleteBtn, async () => {
        try {
          await fetchJSON(`/api/costeo/equipo/${teamMemberId}`, { method: 'DELETE' });
          await loadEquipoYGastos();
          await loadIndicadores();
        } catch (err) {
          // Mas tiempo del normal: el rechazo explica que historia tiene
          // la persona y que usar en su lugar, y eso no se lee en 5 segundos.
          cstToast(err.message, { tipo: 'error', duracionMs: 12000 });
        }
      }, 'Eliminando…');
    }
  });
  equipoTbody.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-equipo-edit-form]');
    if (!form) return;
    e.preventDefault();
    guardarEdicionEquipo(form.dataset.equipoEditForm, form);
  });

  const gastosTbody = document.getElementById('cst-gastos-tbody');
  gastosTbody.addEventListener('click', async (e) => {
    const editar = e.target.closest('[data-gasto-edit]');
    if (editar) return abrirEdicionGasto(editar.dataset.gastoEdit);

    const cancelar = e.target.closest('[data-gasto-edit-cancel]');
    if (cancelar) return restaurarFilaGasto();

    // Aprobación / rechazo (sql/28) — solo admin/ceo ven estos botones, y
    // el backend vuelve a exigir el rol: esto es la comodidad, no el
    // control. Se recargan los indicadores porque aprobar mueve dinero.
    const aprobar = e.target.closest('[data-gasto-aprobar]');
    if (aprobar) {
      if (!(await cstConfirm('¿Aprobar este gasto? Va a sumar al presupuesto ejecutado del proyecto.', { aceptar: 'Aprobar', peligro: false }))) return;
      return withBusy(aprobar, async () => {
        try {
          await fetchJSON(`/api/costeo/gastos/${aprobar.dataset.gastoAprobar}/aprobacion`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true }),
          });
          await loadEquipoYGastos();
          await loadIndicadores();
        } catch (err) {
          alert(err.message);
        }
      }, 'Aprobando…');
    }

    const rechazar = e.target.closest('[data-gasto-rechazar]');
    if (rechazar) {
      const decision = await cstGastoRechazoModal();
      if (!decision) return;
      return withBusy(rechazar, async () => {
        try {
          await fetchJSON(`/api/costeo/gastos/${rechazar.dataset.gastoRechazar}/aprobacion`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: false, note: decision.note }),
          });
          await loadEquipoYGastos();
          await loadIndicadores();
        } catch (err) {
          alert(err.message);
        }
      }, 'Rechazando…');
    }

    const btn = e.target.closest('[data-gasto-delete]');
    if (btn) {
      if (!(await cstConfirm('¿Eliminar este gasto?'))) return;
      await withBusy(btn, async () => {
        try {
          await fetchJSON(`/api/costeo/gastos/${btn.dataset.gastoDelete}`, { method: 'DELETE' });
          await loadEquipoYGastos();
          await loadIndicadores();
        } catch (err) {
          alert(err.message);
        }
      }, 'Eliminando…');
    }
  });
  gastosTbody.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-gasto-edit-form]');
    if (!form) return;
    e.preventDefault();
    guardarEdicionGasto(form.dataset.gastoEditForm, form);
  });
}

