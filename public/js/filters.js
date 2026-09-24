/* Filtros globales del dashboard. Estado compartido + evento 'filters:change'.
 * Cualquier cambio en un filtro pivote (mes, proyecto, lider) refresca los dropdowns
 * dependientes y dispara un banner de advertencia si la combinacion es inconsistente.
 */
(function () {
  'use strict';

  const els = {
    month:    document.getElementById('f-month'),
    week:     document.getElementById('f-week'),
    project:  document.getElementById('f-project'),
    employee: document.getElementById('f-employee'),
    leader:   document.getElementById('f-leader'),
    leaderWrap: document.getElementById('filter-leader-wrap'),
    reset:    document.getElementById('reset-filters'),
    snapshot: document.getElementById('snapshot-pill'),
    userPill: document.getElementById('user-pill'),
    warn:     document.getElementById('scope-warn'),
    warnMsg:  document.getElementById('scope-warn-msg'),
    warnClear: document.getElementById('scope-warn-clear'),
  };

  const state = { month: '', week: '', project: '', employee: '', leader: '' };
  let scopeInfo = null;
  let lastData = null; // ultima respuesta de /api/filters

  function fillSelect(sel, items, getValue, getLabel, placeholder) {
    const current = sel.value;
    sel.innerHTML = '';
    if (placeholder !== undefined) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = placeholder;
      sel.appendChild(opt);
    }
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = getValue(it);
      opt.textContent = getLabel(it);
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  }

  function showWarn(msg) {
    if (!els.warn) return;
    els.warnMsg.textContent = msg;
    els.warn.hidden = false;
  }
  function hideWarn() {
    if (!els.warn) return;
    els.warn.hidden = true;
    els.warnMsg.textContent = '';
  }

  function buildQuery() {
    const q = new URLSearchParams();
    if (state.month)    q.set('month', state.month);
    if (state.week)     q.set('week', state.week);
    if (state.project)  q.set('project', state.project);
    if (state.employee) q.set('employee_id', state.employee);
    if (state.leader)   q.set('leader', state.leader);
    return q;
  }

  function buildFilterFetchQuery() {
    // Solo enviamos las dimensiones de las que dependen los dropdowns siguientes.
    const q = new URLSearchParams();
    if (state.month)   q.set('month', state.month);
    if (state.project) q.set('project', state.project);
    if (state.leader)  q.set('leader', state.leader);
    return q;
  }

  async function loadFilters() {
    const r = await fetch('/api/filters?' + buildFilterFetchQuery().toString(), { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login'; return; }
    if (!r.ok) throw new Error('No se pudieron cargar los filtros');
    const data = await r.json();
    lastData = data;
    scopeInfo = data.scope;

    els.snapshot.textContent = data.snapshot ? `snapshot: ${data.snapshot}` : 'sin datos';
    if (data.user) els.userPill.textContent = `${data.user.full_name || data.user.email} · ${data.user.role.toUpperCase()}`;

    fillSelect(
      els.month, data.months,
      (m) => m.month_name,
      (m) => `${m.month_name} ${m.year_number}`,
      data.months.length ? undefined : '— sin meses —'
    );
    if (!state.month && data.months.length) {
      state.month = els.month.value = data.months[data.months.length - 1].month_name;
    }

    fillSelect(els.week, data.weeks, (w) => w, (w) => `Semana ${w}`, 'Todas');
    if (state.week) els.week.value = state.week;

    fillSelect(els.project, data.projects, (p) => p, (p) => p, 'Todos');
    if (state.project) els.project.value = state.project;

    fillSelect(els.employee, data.employees,
      (e) => e.employee_id, (e) => e.canonical_name, 'Todos');
    if (state.employee) els.employee.value = state.employee;

    const isCeo = scopeInfo && (scopeInfo.role === 'ceo' || scopeInfo.role === 'admin');
    els.leaderWrap.hidden = !isCeo || !data.leaders.length;
    if (isCeo) {
      fillSelect(els.leader, data.leaders,
        (l) => l.pmo_email, (l) => l.pmo_canonical_name, 'Todos');
      if (state.leader) els.leader.value = state.leader;
    }
  }

  /**
   * Despues de recargar filtros, valida que las selecciones actuales sigan siendo
   * coherentes con el alcance disponible. Devuelve un mensaje de advertencia o null.
   * Si detecta inconsistencia, limpia el filtro problematico para evitar queries vacias.
   */
  function reconcileAfterLoad() {
    if (!lastData) return null;
    const warnings = [];

    const monthLabel = state.month || 'el mes seleccionado';
    const leaderName = state.leader
      ? (lastData.leaders.find((l) => l.pmo_email === state.leader)?.pmo_canonical_name || null)
      : null;

    // 1. Proyecto seleccionado ya no esta disponible.
    if (state.project && !lastData.projects.includes(state.project)) {
      const wasProject = state.project;
      state.project = '';
      els.project.value = '';
      if (leaderName) {
        warnings.push(`El proyecto "${wasProject}" no es liderado por ${leaderName} o no tiene tareas en ${monthLabel}; se quitó del filtro.`);
      } else {
        warnings.push(`El proyecto "${wasProject}" no tiene tareas registradas en ${monthLabel}; se quitó del filtro.`);
      }
    }

    // 2. Recurso seleccionado ya no tiene tareas en el alcance/filtros actuales.
    if (state.employee) {
      const empIdNum = Number(state.employee);
      const found = lastData.employees.find((e) => Number(e.employee_id) === empIdNum);
      if (!found) {
        state.employee = '';
        els.employee.value = '';
        const why = state.project
          ? `en el proyecto "${state.project}"`
          : (leaderName ? `entre los proyectos de ${leaderName}` : `con los filtros actuales`);
        warnings.push(`El recurso seleccionado no tiene tareas ${why} en ${monthLabel}; se quitó del filtro.`);
      }
    }

    // 3. Semana seleccionada ya no existe para el mes elegido.
    if (state.week && !lastData.weeks.includes(Number(state.week))) {
      const wasWeek = state.week;
      state.week = '';
      els.week.value = '';
      warnings.push(`La Semana ${wasWeek} no tiene datos en ${monthLabel}; se quitó del filtro.`);
    }

    return warnings.length ? warnings.join(' ') : null;
  }

  function readState() {
    state.month    = els.month.value;
    state.week     = els.week.value;
    state.project  = els.project.value;
    state.employee = els.employee.value;
    state.leader   = els.leader.value;
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('filters:change', { detail: { ...state, scope: scopeInfo } }));
  }

  async function onPivotChange() {
    readState();
    await loadFilters();
    const warn = reconcileAfterLoad();
    if (warn) showWarn(warn); else hideWarn();
    emit();
  }

  async function onLeafChange() {
    readState();
    // Si cambian Recurso/Semana solo emite. No hace falta recargar dropdowns
    // (esos no son pivotes para otros).
    hideWarn();
    emit();
  }

  els.month.addEventListener('change', onPivotChange);
  els.project.addEventListener('change', onPivotChange);
  if (els.leader) els.leader.addEventListener('change', onPivotChange);
  els.week.addEventListener('change', onLeafChange);
  els.employee.addEventListener('change', onLeafChange);

  els.reset.addEventListener('click', () => withBusy(els.reset, async () => {
    state.week = state.project = state.employee = state.leader = '';
    els.week.value = els.project.value = els.employee.value = '';
    if (els.leader) els.leader.value = '';
    hideWarn();
    await loadFilters();
    emit();
  }));

  if (els.warnClear) {
    els.warnClear.addEventListener('click', () => withBusy(els.warnClear, async () => {
      // Limpia todo excepto el mes; suele ser el camino mas rapido a un estado coherente.
      state.week = state.project = state.employee = state.leader = '';
      els.week.value = els.project.value = els.employee.value = '';
      if (els.leader) els.leader.value = '';
      hideWarn();
      await loadFilters();
      emit();
    }));
  }

  window.GTC_FILTERS = {
    init: async () => { await loadFilters(); emit(); },
    state: () => ({ ...state }),
    scope: () => scopeInfo,
    toQuery: () => buildQuery(),
    // Refresh: re-emite el evento filters:change para que los indicadores
    // vuelvan a llamar al backend con el state actual. Usado por el
    // auto-refresh periódico cada 5 min.
    refresh: () => { emit(); },
  };
})();
