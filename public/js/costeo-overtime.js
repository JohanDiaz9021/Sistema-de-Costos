'use strict';

/**
 * Horas Extra e Historial de acciones.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Horas extra =====================

// Las columnas "Decisión PM" y "Aprobación" se quitaron el 4 sep 2026, a
// pedido explícito: no hay flujo de aprobación de horas extra. Toda hora
// extra se registra desde la plataforma y queda aprobada en el mismo acto
// (ver createManualOvertime en costo-overtime.js), así que las dos columnas
// mostraban SIEMPRE el mismo valor ("Sí paga" y una pill verde fija) — dos
// columnas de ancho gastadas en información que nunca cambiaba.

// Fecha + turno exacto (2 sep 2026, a pedido explícito) — solo lo trae el
// alta manual (única vía desde el 2 sep 2026: ver costeo-overtime.js), así
// que una fila detectada antes de ese cambio no tiene de dónde sacarlo.
function formatFechaTurnoHTML(row) {
  if (!row.fecha) return '<span class="emp-muted">—</span>';
  const fecha = formatFecha(row.fecha);
  const hi = String(row.hora_inicio || '').slice(0, 5);
  const hf = String(row.hora_fin || '').slice(0, 5);
  return `${escapeHtml(fecha)}<br><span class="cst-overtime-turno-rango">${escapeHtml(hi)} – ${escapeHtml(hf)}</span>`;
}

// Las 6 etiquetas que calcula clasificarTurno() en el servidor
// (costo-overtime.js) — puramente visual, no cambian el costo potencial
// que ya viene calculado. "Fin de semana" es informativa: la tabla de
// recargos de GTC no le da tarifa distinta al sábado, se paga igual que
// un día hábil (por eso el título del badge lo aclara al pasar el mouse).
const TIPO_HORA_CLASE = {
  Diurno: 'cat-diurno', Nocturno: 'cat-nocturno',
  'Diurno festivo': 'cat-diurno-festivo', 'Nocturno festivo': 'cat-nocturno-festivo',
  'Diurno fin de semana': 'cat-diurno-finde', 'Nocturno fin de semana': 'cat-nocturno-finde',
};
function formatTipoHoraHTML(row) {
  if (!row.desglose_turno || !row.desglose_turno.length) return '<span class="emp-muted">—</span>';
  return row.desglose_turno.map((d) => {
    const titulo = d.categoria.includes('fin de semana')
      ? 'Informativo: el sábado se paga igual que un día hábil, sin recargo adicional.'
      : '';
    return `<span class="cst-overtime-tipo-badge ${TIPO_HORA_CLASE[d.categoria] || ''}" ${titulo ? `title="${escapeHtml(titulo)}"` : ''}>${escapeHtml(d.categoria)} · ${d.horas}h</span>`;
  }).join(' ');
}

// Opciones del filtro de Talento de la tabla: salen de las horas extra que
// realmente hay (no del equipo completo) — ofrecer a alguien sin ningún
// turno registrado solo lleva a una tabla vacía. Se acotan al proyecto
// elegido arriba por la misma razón. La selección se conserva si la persona
// sigue estando entre las opciones; si desaparece, vuelve a "Todos" (si no,
// quedaría filtrando por alguien que ya no está en la lista).
function populateOvertimeTalentoFilter() {
  const select = document.getElementById('cst-overtime-filtro-talento');
  if (!select) return;
  const previo = select.value;
  const gCentro = document.getElementById('cst-f-centro')?.value || '';

  const porId = new Map();
  state.overtime
    .filter((row) => row.pm_decision === 'si')
    .filter((row) => !gCentro || String(row.cost_center_id) === String(gCentro))
    .forEach((row) => porId.set(String(row.employee_id), row.canonical_name));

  const opciones = [...porId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  select.innerHTML = '<option value="">Todos</option>' +
    opciones.map(([id, nombre]) => `<option value="${id}">${escapeHtml(nombre)}</option>`).join('');
  select.value = porId.has(previo) ? previo : '';
}

function renderOvertimeTable() {
  const tbody = document.getElementById('cst-overtime-tbody');

  // El CEO/admin ve una columna "Acciones" con un botón Eliminar por fila
  // (17 sep 2026, a pedido explícito: "el CEO o admin pueden tener la
  // opción de eliminar en caso de que se haya registrado una por error").
  // La columna NO se pinta (ni siquiera vacía) para el líder/PM, y la
  // cabecera desaparece con ella (mismo criterio que Eliminar en Tarifas
  // por Cargo — renderTarifasCargoTable en costeo-equipo.js): una columna
  // con encabezado y todas las celdas en blanco se lee como un error de la
  // pantalla, no como "esto no es para ti".
  const puedeEliminar = !!(state.user && (state.user.role === 'admin' || state.user.role === 'ceo'));
  sincronizarCabeceraAccionesOvertime(puedeEliminar);

  // El Recurso GLOBAL ya no se lee acá (11 sep 2026, a pedido explícito):
  // ese recorte por persona ahora lo hace cst-overtime-filtro-talento, que
  // vive dentro de la tarjeta, encima de la columna Talento. El de Proyecto
  // (cst-f-centro, en el encabezado) sí sigue acotando la tabla.
  const gCentro = document.getElementById('cst-f-centro')?.value || '';
  const fTalento = document.getElementById('cst-overtime-filtro-talento')?.value || '';
  const visibles = state.overtime
    .filter((row) => row.pm_decision === 'si')
    .filter((row) => !gCentro || String(row.cost_center_id) === String(gCentro))
    .filter((row) => !fTalento || String(row.employee_id) === String(fTalento));

  const pag = paginar('overtime', visibles);
  tbody.innerHTML = pag.items.map((row) => `
    <tr data-overtime-row="${row.decision_id}">
      <td>${escapeHtml(row.canonical_name)}</td>
      <td>${escapeHtml(row.project_name)}</td>
      <td>${row.week_number}</td>
      <td>${formatFechaTurnoHTML(row)}</td>
      <td>${formatTipoHoraHTML(row)}</td>
      <td>${Number(row.extra_hours).toFixed(2)}</td>
      <td>${formatCOP(row.extra_cost_potential)}</td>
      ${puedeEliminar ? `<td><button type="button" class="btn-danger" data-overtime-delete="${row.decision_id}">Eliminar</button></td>` : ''}
    </tr>`).join('') || `<tr><td colspan="${puedeEliminar ? 8 : 7}" class="emp-muted">Sin horas extra registradas.</td></tr>`;
  pintarPaginacion('overtime', pag, tbody);
}

// Agrega/quita el th "Acciones" de la cabecera según si el usuario puede
// eliminar. Se gestiona en cada pintado (no una sola vez al arrancar): el
// panel se repinta al cambiar de pestaña y state.user puede no estar listo
// en el primer pintado. El th se QUITA del DOM (no se deja hidden) para que
// las filas y la cabecera tengan siempre el mismo número de columnas y no
// descuadren la tabla.
function sincronizarCabeceraAccionesOvertime(puedeEliminar) {
  const tr = document.querySelector('#cst-overtime-table thead tr');
  if (!tr) return;
  const th = tr.querySelector('#cst-overtime-th-acciones');
  if (puedeEliminar && !th) {
    const nuevo = document.createElement('th');
    nuevo.id = 'cst-overtime-th-acciones';
    nuevo.textContent = 'Acciones';
    tr.appendChild(nuevo);
  } else if (!puedeEliminar && th) {
    th.remove();
  }
}

async function loadOvertime() {
  const { overtime } = await fetchJSON('/api/costeo/overtime');
  state.overtime = overtime || [];
  populateOvertimeTalentoFilter();
  renderOvertimeTable();
}

// Alta manual de hora extra (24 ago 2026; única vía desde el 2 sep 2026, a
// pedido explícito: la hora extra ya NO se detecta sola desde el Excel de
// Planeación — el Excel sigue existiendo solo para Costo Planeado/horas
// ejecutadas, nunca para generar horas extra por su cuenta). El endpoint
// POST /overtime/sync (costo-overtime.js) sigue existiendo y probado, por
// si algún día se necesita un disparador manual/admin, pero el front ya no
// lo llama. Talento se filtra por el Centro de Costos elegido: solo
// aparece quien ya está asignado ahí CON tarifa (si no tiene costo/hora, el
// backend no puede calcular el costo potencial y rechaza).
function refiltrarOvertimeEmployeeSelect() {
  const centroId = document.getElementById('cst-overtime-centro').value;
  const select = document.getElementById('cst-overtime-employee');
  const disponibles = state.equipo.filter((m) =>
    m.is_active && Number(m.hourly_cost) > 0 && String(m.cost_center_id) === String(centroId)
  );
  select.innerHTML = disponibles.length
    ? disponibles.map((m) => `<option value="${m.employee_id}">${escapeHtml(m.canonical_name)}</option>`).join('')
    : '<option value="">Nadie con tarifa asignada en ese centro</option>';
}

async function populateOvertimeForm() {
  const centroSelect = document.getElementById('cst-overtime-centro');
  centroSelect.innerHTML = state.centros
    .map((c) => `<option value="${c.cost_center_id}">${escapeHtml(c.project_name)}</option>`)
    .join('') || '<option value="">Sin centros de costos</option>';

  refiltrarOvertimeEmployeeSelect();
}

// Vista previa informativa del turno (cst-overtime-turno-preview). Solo
// suma horas totales y avisa si cruza a otro día calendario — NO calcula
// diurno/nocturno/festivo ni el costo: eso exige mp_holidays y los recargos
// de Configuración, que solo el backend tiene. Es una ayuda visual, la
// cifra que manda siempre es la que devuelve POST /overtime.
//
// El turno se elige con fecha + select de hora + select de minutos (NO con
// datetime-local): el spinner nativo de Chrome para horas solo muestra 1..12,
// aunque el valor final sea de 24 h — imposible registrar turnos nocturnos
// que pasan de 12 (18:00 -> 02:00, 17 sep 2026 a pedido explícito). Con los
// selects de 00..23 se ve de un vistazo la hora real. Ambas piezas se juntan
// acá en el mismo formato 'YYYY-MM-DDTHH:MM' que exigía el datetime-local,
// así el backend (parseFechaHora en costo-overtime.js) no cambia nada.
function rellenarSelectoresTurno() {
  const horas = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
  ['inicio', 'fin'].forEach((punto) => {
    const horaSel = document.getElementById(`cst-overtime-${punto}-hora`);
    const minSel = document.getElementById(`cst-overtime-${punto}-min`);
    horaSel.innerHTML = '<option value="">Hora</option>' +
      horas.map((h) => `<option value="${h}">${h}</option>`).join('');
    minSel.innerHTML = '<option value="">Min</option>' +
      mins.map((m) => `<option value="${m}">${m}</option>`).join('');
  });
}

function leerTurno(punto) {
  const parte = (campo) => document.getElementById(`cst-overtime-${punto}-${campo}`).value.trim();
  const fecha = parte('fecha');
  const hora = parte('hora');
  const min = parte('min');
  return fecha && hora && min ? `${fecha}T${hora}:${min}` : '';
}

function actualizarTurnoPreview() {
  const preview = document.getElementById('cst-overtime-turno-preview');
  const inicioVal = leerTurno('inicio');
  const finVal = leerTurno('fin');

  if (!inicioVal || !finVal) {
    preview.textContent = 'Elige inicio y fin del turno';
    preview.className = '';
    return;
  }

  const inicio = new Date(inicioVal);
  const fin = new Date(finVal);
  const horas = (fin - inicio) / 3_600_000;

  if (!(horas > 0)) {
    preview.textContent = 'El fin debe ser posterior al inicio';
    preview.className = 'is-error';
    return;
  }

  const cruzaDia = inicio.toDateString() !== fin.toDateString();
  const horasFmt = horas.toFixed(horas % 1 === 0 ? 0 : 2);
  preview.textContent = `${horasFmt} hora${horas === 1 ? '' : 's'} de turno${cruzaDia ? ' (cruza a otro día)' : ''}`;
  preview.className = 'is-listo';
}

function initOvertimeAddForm() {
  const btnNueva = document.getElementById('cst-btn-nueva-overtime');
  const form = document.getElementById('cst-form-overtime');
  const errorEl = document.getElementById('cst-overtime-error');
  const employeeSelect = document.getElementById('cst-overtime-employee');
  const centroSelect = document.getElementById('cst-overtime-centro');

  // El modal lo abre y lo cierra initModales (costeo-core.js) por los
  // data-modal-abrir/data-modal-cerrar del HTML — aquí solo queda llenar los
  // selects (incluidos los de hora/minuto 00..23) al inicializar y dejar la
  // vista previa del turno en blanco al cerrar (reset() vuelve la fecha y
  // los selects a su opción vacía pero no reescribe el texto de ayuda).
  rellenarSelectoresTurno();
  btnNueva.addEventListener('click', () => populateOvertimeForm());
  document.getElementById('cst-overtime-modal-overlay')
    .addEventListener('cst-modal-cerrado', actualizarTurnoPreview);
  document.getElementById('cst-overtime-centro').addEventListener('change', refiltrarOvertimeEmployeeSelect);

  // Filtro de Talento de la TABLA — nada que ver con el select de Talento
  // del modal de alta de arriba (cst-overtime-employee): este solo acota lo
  // que se ve, no cambia qué se registra.
  document.getElementById('cst-overtime-filtro-talento')
    .addEventListener('change', renderOvertimeTable);
  ['inicio', 'fin'].forEach((punto) => ['fecha', 'hora', 'min'].forEach((campo) => {
    document.getElementById(`cst-overtime-${punto}-${campo}`)
      .addEventListener('change', actualizarTurnoPreview);
  }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const submitBtn = form.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        const resp = await fetchJSON('/api/costeo/overtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employee_id: employeeSelect.value,
            cost_center_id: centroSelect.value,
            inicio: leerTurno('inicio'),
            fin: leerTurno('fin'),
          }),
        });

        // El modal ya NO se cierra al registrar (17 sep 2026, a pedido
        // explícito): se limpia solo el turno y se conservan Centro y
        // Talento para registrar la siguiente persona/turno sin re-elegir.
        registrarEnSesion({
          decision_id: resp.decision_id,
          talento: employeeSelect.selectedOptions[0]?.textContent.trim() || employeeSelect.value,
          centro: centroSelect.selectedOptions[0]?.textContent.trim() || centroSelect.value,
          turno: formatearTurnoSesion(leerTurno('inicio'), leerTurno('fin')),
          horas: null,
          estado: 'aprobada',
        });

        ['inicio', 'fin'].forEach((punto) => {
          document.getElementById(`cst-overtime-${punto}-fecha`).value = '';
          document.getElementById(`cst-overtime-${punto}-hora`).value = '';
          document.getElementById(`cst-overtime-${punto}-min`).value = '';
        });
        errorEl.hidden = true;
        actualizarTurnoPreview();
        document.getElementById('cst-overtime-inicio-fecha').focus();

        await completarEntradaSesion(resp.decision_id);
        cstToast('Hora extra registrada.');
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }, 'Registrando…');
  });
}

// Eliminar una hora extra es SOLO de admin/ceo (17 sep 2026, a pedido
// explícito): es la vía para quitar un registro hecho por error. El botón
// solo se pinta para ellos (renderOvertimeTable), y el backend también lo
// exige: la ruta DELETE /overtime/:id deja a un líder borrar únicamente
// mientras la fila siga Pendiente.
function initOvertimeTableAcciones() {
  document.getElementById('cst-overtime-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-overtime-delete]');
    if (!btn) return;

    if (!(await cstConfirm('¿Eliminar esta hora extra? Se quitará del costo ejecutado del proyecto. Esta acción no se puede deshacer.'))) return;
    await withBusy(btn, async () => {
      try {
        await fetchJSON(`/api/costeo/overtime/${btn.dataset.overtimeDelete}`, { method: 'DELETE' });
        cstToast('Hora extra eliminada.');
        await loadOvertime();
        await loadIndicadores();
      } catch (err) {
        cstToast(err.message || 'No se pudo eliminar la hora extra.', { tipo: 'error' });
      }
    }, 'Eliminando…');
  });
}

// ===================== Mini-historial del modal de alta =====================
// 17 sep 2026, a pedido explícito: al registrar varias horas extra seguidas,
// el modal ya no se cierra con cada alta (ver el submit en
// initOvertimeAddForm) y acá se ve lo que se lleva registrado en ESTA página.
// El array vive mientras la página no se recargue: sobrevive a abrir/cerrar
// el modal, y cada fila trae su Eliminar para corregir un error al instante.
// El backend deja que quien registró a mano borre su propia fila aunque el
// alta manual ya nazca aprobada (approved_by, ver deleteOvertimeDecision).
const overtimeRegistradosSesion = [];

function registrarEnSesion(fila) {
  overtimeRegistradosSesion.push(fila);
  renderOvertimeSesion();
}

function formatearTurnoSesion(inicioRaw, finRaw) {
  if (!inicioRaw || !finRaw) return '';
  const limpia = (raw) => String(raw).replace('T', ' ');
  return `${limpia(inicioRaw)} → ${limpia(finRaw)}`;
}

function formatearTurnoSesionFila(fila) {
  const fecha = fila.fecha ? formatFecha(String(fila.fecha).slice(0, 10)) : '';
  const ini = fila.hora_inicio ? String(fila.hora_inicio).slice(0, 5) : '';
  const fin = fila.hora_fin ? String(fila.hora_fin).slice(0, 5) : '';
  return `${fecha} · ${ini} → ${fin}`;
}

function renderOvertimeSesion() {
  const section = document.getElementById('cst-overtime-sesion');
  const lista = document.getElementById('cst-overtime-sesion-list');
  if (!section || !lista) return;
  lista.innerHTML = overtimeRegistradosSesion.map((f) => `
    <li class="cst-overtime-sesion-item">
      <div class="cst-overtime-sesion-detalle">
        <strong>${escapeHtml(f.talento)}</strong>
        <span class="cst-overtime-sesion-turno">${escapeHtml(f.centro)} · ${escapeHtml(f.turno)}</span>
      </div>
      ${f.horas !== null && f.horas !== undefined ? `<span class="cst-overtime-sesion-horas">${Number(f.horas).toFixed(2)} h</span>` : ''}
      <span class="cst-overtime-sesion-badge">${escapeHtml(f.estado)}</span>
      <button type="button" class="btn-danger cst-overtime-sesion-del" data-overtime-sesion-delete="${f.decision_id}">Eliminar</button>
    </li>`).join('');
  section.hidden = overtimeRegistradosSesion.length === 0;
}

async function completarEntradaSesion(decisionId) {
  try {
    await loadOvertime();
    await loadIndicadores();
    const fila = state.overtime.find((r) => String(r.decision_id) === String(decisionId));
    const entrada = overtimeRegistradosSesion.find((r) => String(r.decision_id) === String(decisionId));
    if (!fila || !entrada) return;
    entrada.talento = fila.canonical_name;
    entrada.centro = fila.project_name;
    entrada.turno = formatearTurnoSesionFila(fila);
    entrada.horas = Number(fila.extra_hours) || null;
    entrada.estado = fila.approval_status === 'aprobado' ? 'aprobada' : 'pendiente';
    renderOvertimeSesion();
  } catch {
    // El refresco de la tabla no debe tumbar el alta recién hecha: el
    // mini-historial ya quedó con la entrada básica.
  }
}

function initOvertimeSesion() {
  document.getElementById('cst-overtime-sesion-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-overtime-sesion-delete]');
    if (!btn) return;

    if (!(await cstConfirm('¿Eliminar esta hora extra del registro de la sesión? Ya no contará en el costo ejecutado y no se puede deshacer.'))) return;
    await withBusy(btn, async () => {
      try {
        await fetchJSON(`/api/costeo/overtime/${btn.dataset.overtimeSesionDelete}`, { method: 'DELETE' });
        const idx = overtimeRegistradosSesion.findIndex((f) => String(f.decision_id) === String(btn.dataset.overtimeSesionDelete));
        if (idx >= 0) overtimeRegistradosSesion.splice(idx, 1);
        renderOvertimeSesion();
        await loadOvertime();
        await loadIndicadores();
        cstToast('Hora extra eliminada.');
      } catch (err) {
        cstToast(err.message || 'No se pudo eliminar la hora extra.', { tipo: 'error' });
      }
    }, 'Eliminando…');
  });
}

// ===================== Historial de acciones =====================
// Bloque 4 (ago 2026) — quién hizo qué y cuándo en Centro de Costos, Equipo
// del Proyecto, Gastos no planeados y Horas Extra. Lee mp_costeo_audit_log
// vía /api/costeo/historial, ya scopeado por el backend (un PM solo ve el
// historial de sus propios centros).

// Tiene que cubrir el ENUM entero de mp_costeo_audit_log.entity_type
// (sql/18 + sql/22 + sql/27 + sql/30): si falta un tipo aquí, la columna
// "Tipo" del historial muestra el slug crudo de la base ("plan_recursos")
// en vez de texto legible ("Plan de Recursos").
const HIST_ENTITY_LABEL = {
  centro_costo: 'Centro de Costos', equipo: 'Equipo', gasto: 'Gasto', overtime: 'Horas Extra',
  tarifa_cargo: 'Catálogo de Cargos', acceso: 'Acceso', plan_recursos: 'Plan de Recursos',
  config: 'Configuración', snapshot: 'Snapshot',
};
const HIST_ACTION_LABEL = {
  crear: 'Creó', editar: 'Editó', eliminar: 'Eliminó', desactivar: 'Desactivó',
  reactivar: 'Reactivó', decidir: 'Decidió', aprobar: 'Aprobó', rechazar: 'Rechazó',
};
const HIST_ACTION_CLASS = {
  crear: 'estado-viable', editar: 'estado-riesgo', eliminar: 'estado-no_viable',
  desactivar: 'estado-no_viable', reactivar: 'estado-viable', decidir: 'estado-riesgo',
  aprobar: 'estado-viable', rechazar: 'estado-no_viable',
};

let historialFiltroTipo = '';

// Alias del helper compartido (costeo-core.js): el historial es el único
// sitio que necesita la hora además de la fecha.
function formatHistorialFecha(iso) {
  return formatFechaHora(iso);
}

function renderHistorialTable() {
  const tbody = document.getElementById('cst-historial-tbody');
  const visibles = historialFiltroTipo
    ? state.historial.filter((h) => h.entity_type === historialFiltroTipo)
    : state.historial;

  const pag = paginar('historial', visibles);
  tbody.innerHTML = pag.items.map((item) => `
    <tr>
      <td>${escapeHtml(formatHistorialFecha(item.created_at))}</td>
      <td>${escapeHtml(item.user_name || 'Sistema')}</td>
      <td>${item.project_name ? `<span class="cst-pill-centro">${escapeHtml(item.project_name)}</span>` : '—'}</td>
      <td>${escapeHtml(HIST_ENTITY_LABEL[item.entity_type] || item.entity_type)}</td>
      <td><span class="cst-estado-pill ${escapeHtml(HIST_ACTION_CLASS[item.action] || '')}">${escapeHtml(HIST_ACTION_LABEL[item.action] || item.action)}</span></td>
      <!-- formatearDescripcionHistorial (costeo-core.js): las filas
           guardadas antes del 7 sep 2026 traen el monto crudo ("por
           $500000", o "Presupuesto: 10000000 → 100000000" sin ni siquiera
           el "$") — se le ponen los puntos de miles al pintarlas, misma
           lógica que ya usa la ventana "Ver cambios" de Costo Planeado. -->
      <td>${escapeHtml(formatearDescripcionHistorial(item.description))}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="emp-muted">Sin acciones registradas todavía.</td></tr>';
  pintarPaginacion('historial', pag, tbody);
}

async function loadHistorial() {
  const { historial } = await fetchJSON('/api/costeo/historial');
  state.historial = historial || [];
  renderHistorialTable();
}

function initHistorialFiltros() {
  document.querySelectorAll('#cst-historial-filtros .cst-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cst-historial-filtros .cst-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      historialFiltroTipo = btn.dataset.tipo || '';
      // Otro tipo es otra lista: seguir en la pagina 4 de la anterior no
      // significa nada (y con menos paginas, caeria en una vacia).
      reiniciarPaginacion('historial');
      renderHistorialTable();
    });
  });
}

