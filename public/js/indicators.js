/* Renderers de los 8 indicadores DIARIOS (Bloque 2).
 * Cada renderer expone .render() (al cambiar filtros) y opcionalmente .drill(...).
 * Se conectan via el evento 'filters:change' emitido por filters.js.
 */
(function () {
  'use strict';

  const PAL = {
    navy: '#10164E', teal: '#39D4CC', yellow: '#FFC107', red: '#E53935',
    blueMid: '#25007A', blueLight: '#9B8AC2', purple: '#6D54A6',
  };

  const STATE = { charts: new Map(), inflight: 0 };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(n, d = 1) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toFixed(d);
  }
  function card(n) { return document.querySelector(`.card[data-ind="${n}"]`); }
  function chartEl(n) {
    const c = card(n); if (!c) return null;
    const ch = c.querySelector('.chart'); ch.classList.remove('placeholder'); return ch;
  }
  function ensureChart(n) {
    const el = chartEl(n); if (!el) return null;
    if (el.firstChild && el.firstChild.tagName !== 'CANVAS' && el.firstChild.tagName !== 'DIV') el.innerHTML = '';
    if (STATE.charts.has(n)) { STATE.charts.get(n).resize(); return STATE.charts.get(n); }
    el.innerHTML = '';
    const inst = echarts.init(el);
    STATE.charts.set(n, inst);
    // ECharts cachea el tamaño del contenedor al hacer init. Si el layout cambia despues
    // (porque cargan datos en otras tarjetas y el grid recalcula alturas), el canvas no se
    // entera. ResizeObserver dispara resize() automaticamente. Throttle minimo via rAF.
    if (typeof ResizeObserver !== 'undefined') {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { try { inst.resize(); } catch (e) {} });
      });
      ro.observe(el);
    }
    return inst;
  }
  function setHtml(n, html) {
    if (STATE.charts.has(n)) { try { STATE.charts.get(n).dispose(); } catch (e) {} STATE.charts.delete(n); }
    const el = chartEl(n); if (!el) return; el.innerHTML = html;
  }
  function setError(n, msg) {
    setHtml(n, `<p class="err">${esc(msg || 'No se pudo cargar')}</p>`);
  }

  async function fetchJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login'; return null; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function withFilters(extra) {
    const q = window.GTC_FILTERS.toQuery();
    if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    return q.toString();
  }
  const get  = (n, extra) => fetchJSON('/api/indicator/' + n + '?' + withFilters(extra));
  const dgo  = (n, extra) => fetchJSON('/api/indicator/' + n + '/drilldown?' + withFilters(extra));

  function table(headers, rows, cellFn, headerTooltips) {
    if (!rows.length) return '<p>Sin filas.</p>';
    const ths = headers.map((h, i) => {
      const tip = headerTooltips && headerTooltips[i];
      return tip
        ? `<th title="${esc(tip)}"><span class="th-with-tip">${esc(h)}<span class="th-tip-mark" aria-hidden="true">?</span></span></th>`
        : '<th>' + esc(h) + '</th>';
    }).join('');
    return '<table class="dt"><thead><tr>' + ths + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + cellFn(r).map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  // ============================================================
  //  Indicador 3 — Vencidas sin cerrar (KPI rojo/verde + drilldown)
  // ============================================================
  async function render3() {
    const res = await get(3); if (!res) return;
    const total = res.data.total;
    setHtml(3, `
      <div class="kpi ${total > 0 ? 'kpi-bad' : 'kpi-good'}">
        <div class="kpi-value">${total}</div>
        <div class="kpi-label">tareas vencidas sin cerrar</div>
        <button class="kpi-drill" data-drill="3">Ver detalle</button>
      </div>`);
  }
  async function drill3() {
    const res = await dgo(3);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Fecha estimada', 'Días vencida', 'Estado'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.estimated_delivery_date), r.days_overdue, esc(r.task_status)]
    );
    window.GTC_MODAL.open('Indicador 3 · Actividades vencidas sin cerrar', html);
  }

  // ============================================================
  //  Indicador 5 — % Terminadas (dona)
  // ============================================================
  async function render5() {
    const res = await get(5); if (!res) return;
    const b = res.data.buckets;
    const items = [
      { value: b.Terminado, name: 'Terminado' },
      { value: b['En Progreso'], name: 'En Progreso' },
      { value: b.Pendiente, name: 'Pendiente' },
      { value: b.Bloqueado, name: 'Bloqueado' },
      { value: b.Otro, name: 'Otro' },
    ].filter((d) => d.value > 0);
    const inst = ensureChart(5);

    function centerPct(selected) {
      const visible = items.filter((it) => !selected || selected[it.name] !== false);
      const total = visible.reduce((a, x) => a + x.value, 0);
      const term = visible.find((x) => x.name === 'Terminado');
      return total > 0 && term ? Math.round((term.value / total) * 100) : 0;
    }

    function buildOption(selected) {
      const pct = centerPct(selected);
      return {
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { bottom: 4, left: 'center', textStyle: { fontSize: 11 }, itemGap: 12, itemHeight: 10 },
        color: [PAL.teal, PAL.blueMid, PAL.blueLight, PAL.red, '#bdbdbd'],
        series: [{
          type: 'pie', radius: ['48%', '70%'], avoidLabelOverlap: true,
          center: ['50%', '42%'],
          label: {
            show: true, position: 'center', fontSize: 26, fontWeight: 700, color: PAL.navy,
            formatter: () => pct + '%\n{small|terminadas}',
            rich: { small: { fontSize: 10, color: '#666', fontWeight: 400, padding: [4, 0, 0, 0] } },
          },
          labelLine: { show: false },
          data: items,
        }],
      };
    }

    inst.setOption(buildOption(), true);
    inst.off('legendselectchanged').on('legendselectchanged', (e) => {
      inst.setOption(buildOption(e.selected));
    });
    inst.off('click').on('click', (p) => { if (p.componentType === 'series') drill5(p.name); });
  }
  async function drill5(status) {
    const res = await dgo(5, status ? { status } : undefined);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Estado', 'Presup.', 'Ejec.'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.task_status), fmt(r.budgeted_hours), fmt(r.total_executed_hours)]
    );
    window.GTC_MODAL.open('Indicador 5 · Tareas' + (status ? ' — ' + status : ''), html);
  }

  // ============================================================
  //  Indicador 6 — % Bloqueadas
  // ============================================================
  async function render6() {
    const res = await get(6); if (!res) return;
    const { pct, blocked, total } = res.data;
    setHtml(6, `
      <div class="kpi ${blocked > 0 ? 'kpi-bad' : 'kpi-good'}">
        <div class="kpi-value">${pct.toFixed(1)}%</div>
        <div class="kpi-label">${blocked} de ${total} tareas bloqueadas</div>
        ${blocked > 0 ? '<button class="kpi-drill" data-drill="6">Ver detalle</button>' : ''}
      </div>`);
  }
  async function drill6() {
    const res = await dgo(6);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Observaciones', 'Fecha estimada'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.observations), esc(r.estimated_delivery_date)]
    );
    window.GTC_MODAL.open('Indicador 6 · Tareas bloqueadas', html);
  }

  // ============================================================
  //  Indicador 7 — Horas ejecutadas vs presupuestadas (barras dobles)
  // ============================================================
  async function render7() {
    const res = await get(7); if (!res) return;
    if (!res.data.series.length) { setHtml(7, '<p>Sin datos.</p>'); return; }

    // Estructura: chart arriba + lista de top proyectos abajo (rellena la altura
    // y da una segunda lectura por proyecto sin agregar otra card).
    setHtml(7, `
      <div id="ch7-main" style="min-height: 200px; flex: 1;"></div>
      <div class="top-projects" id="ch7-top"></div>
    `);

    const mainDiv = document.getElementById('ch7-main');
    const inst = echarts.init(mainDiv);
    STATE.charts.set(7, inst);
    const labels = res.data.series.map((s) => s.label);
    inst.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 14, top: 14, bottom: 34, containLabel: true },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', name: 'horas' },
      series: [
        { name: 'Presupuestado', type: 'bar', data: res.data.series.map((s) => s.budgeted), itemStyle: { color: PAL.navy } },
        { name: 'Ejecutado',     type: 'bar', data: res.data.series.map((s) => s.executed), itemStyle: { color: PAL.teal } },
      ],
    }, true);
    inst.off('click').on('click', () => drill7());

    // Lista de proyectos con ratio ejec/presup
    const byProject = res.data.byProject || [];
    if (byProject.length > 0) {
      const html = `
        <div class="top-projects-title">RATIO EJEC / PRESUP POR PROYECTO</div>
        <ul class="top-projects-list">
          ${byProject.map((p) => {
            const pct = p.ratio_pct;
            const cls = pct >= 100 ? 'over' : pct >= 80 ? 'ok' : 'under';
            const w = Math.min(100, pct);
            return `<li class="${cls}">
              <span class="tp-name" title="${esc(p.project)}">${esc(p.project)}</span>
              <span class="tp-bar"><span class="tp-bar-fill" style="width:${w}%"></span></span>
              <span class="tp-pct">${pct}%</span>
            </li>`;
          }).join('')}
        </ul>`;
      document.getElementById('ch7-top').innerHTML = html;
    }
  }
  async function drill7() {
    const res = await dgo(7);
    const html = table(
      ['Sem', 'Proyecto', 'Actividad', 'Recurso', 'Presup.', 'Ejec.', 'Estado'],
      res.data.rows,
      (r) => [r.week_number, esc(r.project_folder), esc(r.activity), esc(r.assigned_to), fmt(r.budgeted_hours), fmt(r.total_executed_hours), esc(r.task_status)]
    );
    window.GTC_MODAL.open('Indicador 7 · Horas por tarea', html);
  }

  // ============================================================
  //  Indicador 8 — Indicador general por recurso (tabla)
  // ============================================================
  async function render8() {
    const res = await get(8); if (!res) return;
    const rows = res.data.rows;
    if (!rows.length) { setHtml(8, '<p>Sin recursos en el periodo.</p>'); return; }
    const semHtml = (sem) => `<span class="sem-dot sem-${sem}"></span>`;
    const html = table(
      ['Recurso', 'Cumpl.', 'Presup.', 'Ejec.', '% Term.', 'Bloq.', '% A tiempo', 'Sem.'],
      rows,
      (r) => [
        `<a href="#" data-emp="${r.employee_id}" data-name="${esc(r.canonical_name)}">${esc(r.canonical_name)}</a>${r.contract_type === 'prestacion_servicios' ? ' <span class="emp-pill-ps" title="Prestación de servicios — los KPIs pueden mostrar criticidades esperadas por la modalidad de contrato">PS</span>' : ''}`,
        r.compliance_pct === null ? '—' : r.compliance_pct.toFixed(1) + '%',
        r.budgeted.toFixed(1),
        r.executed.toFixed(1),
        r.completed_pct.toFixed(1) + '%',
        r.blocked_tasks,
        r.on_time_pct === null ? '—' : r.on_time_pct + '%',
        semHtml(r.semaphore),
      ],
      [
        'Empleado. Clic en el nombre para ver el detalle completo de sus tareas del mes.',
        '% Cumplimiento = (horas ejecutadas / horas presupuestadas) × 100, agregando todas sus tareas del mes.',
        'Horas presupuestadas: suma de budgeted_hours de todas las tareas del mes para este recurso.',
        'Horas ejecutadas: suma de total_executed_hours (= lunes + martes + ... + sábado) del mes.',
        '% Tareas terminadas: (tareas con estado "Terminado") / (total de tareas del recurso) × 100.',
        'Cantidad de tareas en estado "Bloqueado". Si es > 0, el semáforo del recurso pasa automáticamente a ROJO.',
        '% A tiempo: de las tareas terminadas con fecha real, qué porcentaje se entregó en o antes de la fecha estimada.',
        'Semáforo del recurso: ROJO si tiene ≥1 bloqueada o cumplimiento < 80%; AMARILLO si cumplimiento 80–99%; VERDE si ≥100%.',
      ]
    );
    setHtml(8, html);
    card(8).querySelectorAll('a[data-emp]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); drillResource(Number(a.dataset.emp), a.dataset.name); });
    });
  }

  async function drillResource(employeeId, name) {
    const month = window.GTC_FILTERS.state().month;
    if (!month) return;
    const r = await fetch('/api/resource/' + employeeId + '?month=' + encodeURIComponent(month), { credentials: 'same-origin' });
    if (!r.ok) return;
    const json = await r.json();
    const html = table(
      ['Sem', 'Proyecto', 'Actividad', 'Tipo', 'Presup.', 'Ejec.', 'Estado', 'Estimada', 'Real'],
      json.tasks,
      (t) => [t.week_number, esc(t.project_folder), esc(t.activity), esc(t.planned_type), fmt(t.budgeted_hours), fmt(t.total_executed_hours), esc(t.task_status), esc(t.estimated_delivery_date), esc(t.actual_delivery_date)]
    );
    window.GTC_MODAL.open('Detalle del recurso · ' + name, html);
  }

  // ============================================================
  //  Indicador 9 — Semaforo de gestion (3 niveles)
  // ============================================================
  async function render9() {
    const res = await get(9); if (!res) return;
    const g = res.data.global;
    const all = res.data.byResource || [];
    // Orden de top 6 visibles: peor primero (rojos arriba, amarillos, verdes, grises) y dentro de cada grupo por % cumplimiento asc.
    const semOrder = { red: 0, amber: 1, green: 2, grey: 3 };
    const sorted = all.slice().sort((a, b) => {
      const dx = (semOrder[a.semaphore] ?? 9) - (semOrder[b.semaphore] ?? 9);
      if (dx !== 0) return dx;
      return (a.compliance_pct ?? 0) - (b.compliance_pct ?? 0);
    });
    const top = sorted.slice(0, 6);
    const hidden = sorted.length - top.length;
    const t = res.data.byTask;
    const lbl = (s) => ({ green: 'VERDE', amber: 'AMARILLO', red: 'ROJO', grey: 'SIN DATO' }[s] || '—');
    const html = `
      <div class="sem-block">
        <div class="sem-row sem-row-main">
          <div class="sem-bigdot sem-${g.semaphore}"></div>
          <div>
            <div class="sem-title">Global del mes</div>
            <div class="sem-sub">Cumpl. ${g.compliance_pct === null ? '—' : g.compliance_pct + '%'} · ${g.blocked} bloqueadas</div>
            <div class="sem-label sem-label-${g.semaphore}">${lbl(g.semaphore)}</div>
          </div>
        </div>
        <div class="sem-block-title">
          Por recurso (top 6)
          ${hidden > 0 ? `<button type="button" class="sem-see-all" data-sem-see-all>Ver todos (${sorted.length})</button>` : ''}
        </div>
        <ul class="sem-list">
          ${top.map((r) => `<li><span class="sem-dot sem-${r.semaphore}"></span>${esc(r.canonical_name)} <span class="sem-muted">${r.compliance_pct === null ? '' : r.compliance_pct + '%'}</span></li>`).join('') || '<li class="sem-muted">Sin recursos</li>'}
        </ul>
        <div class="sem-block-title">Por tarea</div>
        <div class="sem-tasks">
          <span><span class="sem-dot sem-green"></span>${t.green} verdes</span>
          <span><span class="sem-dot sem-amber"></span>${t.amber} amarillas</span>
          <span><span class="sem-dot sem-red"></span>${t.red} rojas</span>
          <span><span class="sem-dot" style="background:#bbb"></span>${t.grey} s/dato</span>
        </div>
      </div>`;
    setHtml(9, html);
    const btn = card(9).querySelector('[data-sem-see-all]');
    if (btn) btn.addEventListener('click', () => openSemaforoFull(sorted));
  }

  function openSemaforoFull(sorted) {
    const lbl = (s) => ({ green: 'VERDE', amber: 'AMARILLO', red: 'ROJO', grey: 'SIN DATO' }[s] || '—');
    const html = `
      <table class="dt">
        <thead><tr><th>Semáforo</th><th>Recurso</th><th>Cumpl.</th><th>Bloq.</th></tr></thead>
        <tbody>
          ${sorted.map((r) => `
            <tr>
              <td><span class="sem-dot sem-${r.semaphore}"></span> <span class="sem-label sem-label-${r.semaphore}" style="font-size:10px">${lbl(r.semaphore)}</span></td>
              <td>${esc(r.canonical_name)}</td>
              <td>${r.compliance_pct === null ? '—' : r.compliance_pct + '%'}</td>
              <td>${r.blocked}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    window.GTC_MODAL.open('Semáforo · todos los recursos', html);
  }

  // ============================================================
  //  Indicador 10 — Recursos compartidos entre proyectos
  // ============================================================
  async function render10() {
    const res = await get(10); if (!res) return;
    if (!res.data.rows.length) {
      setHtml(10, `
        <div class="empty-state">
          <div class="empty-state-icon" aria-hidden="true">${icono('ok')}</div>
          <div class="empty-state-title">Sin recursos compartidos</div>
          <div class="empty-state-sub">Ningún recurso aparece en más de un proyecto este mes.<br/>Buena especialización del equipo.</div>
        </div>
      `);
      return;
    }
    const html = table(
      ['Recurso', 'Proyectos', '# Proy.', 'Horas ejec.'],
      res.data.rows,
      (r) => [
        `<a href="#" data-emp="${r.employee_id}" data-name="${esc(r.canonical_name)}">${esc(r.canonical_name)}</a>`,
        esc(r.projects_list),
        `<span class="${r.project_count > 2 ? 'pill-warn' : ''}">${r.project_count}</span>`,
        r.total_hours.toFixed(1),
      ]
    );
    setHtml(10, html);
    card(10).querySelectorAll('a[data-emp]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); drill10(Number(a.dataset.emp), a.dataset.name); });
    });
  }
  async function drill10(employeeId, name) {
    const res = await dgo(10, { employee_id: employeeId });
    const html = table(
      ['Proyecto', 'Presup.', 'Ejec.', '# Tareas'],
      res.data.rows,
      (r) => [esc(r.project_folder), fmt(r.budgeted), fmt(r.executed), r.tasks]
    );
    window.GTC_MODAL.open('Recurso compartido · ' + name, html);
  }

  // ============================================================
  //  Indicador 14 — Carga vs capacidad (44h + festivos)
  // ============================================================
  async function render14() {
    const res = await get(14); if (!res) return;
    if (!res.data.employees.length) { setHtml(14, '<p>Sin datos de carga.</p>'); return; }
    const inst = ensureChart(14);
    const yAxisData = res.data.employees.map((e) => e.canonical_name);
    const series = res.data.weeks.map((w, wIdx) => ({
      name: 'Sem ' + w,
      type: 'bar',
      stack: 'carga',
      emphasis: { focus: 'series' },
      data: res.data.employees.map((e, eIdx) => {
        const cell = res.data.matrix[eIdx][wIdx];
        return {
          value: cell.budgeted,
          itemStyle: { color: cell.overload ? PAL.red : (wIdx % 2 ? PAL.blueMid : PAL.navy) },
          employee_id: e.employee_id,
          canonical_name: e.canonical_name,
          week: cell.week,
          capacity: cell.capacity,
        };
      }),
    }));
    const caps = Object.values(res.data.capacities).filter((c) => c > 0);
    const avgCap = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : 0;
    inst.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const d = p.data || {};
          return `<b>${esc(d.canonical_name || '')}</b><br/>${esc(p.seriesName)}: ${fmt(p.value)}h<br/>Capacidad: ${fmt(d.capacity)}h`;
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 40, top: 32, bottom: 36, containLabel: true },
      xAxis: { type: 'value', name: 'horas presupuestadas', nameLocation: 'middle', nameGap: 22, nameTextStyle: { fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: yAxisData,
        axisLabel: {
          fontSize: 10,
          width: 140,
          overflow: 'truncate',
          formatter: (v) => (v && v.length > 22 ? v.slice(0, 20) + '…' : v),
        },
      },
      series: series.concat([{
        name: 'Capacidad',
        type: 'bar',
        data: [],
        markLine: {
          symbol: 'none',
          lineStyle: { type: 'dashed', color: PAL.yellow, width: 2 },
          label: {
            show: true,
            position: 'end',
            distance: 6,
            rotate: 0,
            color: '#5a4500',
            backgroundColor: 'rgba(255,255,255,0.9)',
            padding: [2, 5],
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            formatter: 'Cap. ~' + avgCap.toFixed(1) + 'h',
          },
          data: [{ xAxis: avgCap }],
        },
      }]),
    }, true);
    inst.off('click').on('click', (p) => {
      if (p.componentType !== 'series' || !p.data || !p.data.employee_id) return;
      drill14(p.data.employee_id, p.data.canonical_name, p.data.week);
    });
  }
  async function drill14(employeeId, name, week) {
    const res = await dgo(14, { employee_id: employeeId, week });
    const html = table(
      ['Proyecto', 'Actividad', 'Presup.', 'Ejec.', 'Estado'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), fmt(r.budgeted_hours), fmt(r.total_executed_hours), esc(r.task_status)]
    );
    window.GTC_MODAL.open('Carga · ' + name + ' · Semana ' + week, html);
  }

  // ============================================================
  //  Indicador 1 — % Cumplimiento semanal (barras por semana + meta 100%)
  //  🔧 v2: agrega título explícito según filtro de semana.
  //    - Sin filtro (Todas): "Vista comparativa por semana · Cumpl. del mes: X%"
  //    - Con filtro: "Semana N · Cumpl.: Y%"
  // ============================================================
  async function render1() {
    const res = await get(1); if (!res) return;
    if (!res.data.series.length) { setHtml(1, '<p>Sin semanas con datos.</p>'); return; }
    const inst = ensureChart(1);
    const labels = res.data.series.map((s) => 'Sem ' + s.week);
    const values = res.data.series.map((s) => s.compliance_pct);

    // Calcular cumplimiento consolidado (todas las semanas visibles).
    const totalBudgeted = res.data.series.reduce((s, w) => s + (w.budgeted || 0), 0);
    const totalExecuted = res.data.series.reduce((s, w) => s + (w.executed || 0), 0);
    const consolidatedPct = totalBudgeted > 0
      ? Number(((totalExecuted / totalBudgeted) * 100).toFixed(1))
      : null;

    // Determinar título según filtro activo.
    const filterState = window.GTC_FILTERS ? window.GTC_FILTERS.state() : {};
    const selectedWeek = filterState.week ? Number(filterState.week) : null;
    let titleText, subText;
    if (selectedWeek) {
      const pct = consolidatedPct === null ? '—' : consolidatedPct + '%';
      titleText = `Semana ${selectedWeek} · Cumpl.: ${pct}`;
      subText = 'Cumplimiento de la semana seleccionada (Ejec. / Presup.).';
    } else {
      const pct = consolidatedPct === null ? '—' : consolidatedPct + '%';
      titleText = `Vista comparativa por semana · Cumpl. del mes: ${pct}`;
      subText = `Cada barra es una semana del mes. La línea punteada marca la meta (100%). El % del título es consolidado (suma de ejecutadas / suma de presupuestadas).`;
    }

    inst.setOption({
      title: {
        text: titleText,
        subtext: subText,
        left: 'left',
        top: 0,
        textStyle: { fontSize: 13, fontWeight: 600, color: '#222' },
        subtextStyle: { fontSize: 11, color: '#666' },
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const p = params[0]; const s = res.data.series[p.dataIndex];
          return `<b>${esc(p.name)}</b><br/>Cumpl.: ${s.compliance_pct === null ? '—' : s.compliance_pct + '%'}<br/>Ejec.: ${fmt(s.executed)}h<br/>Presup.: ${fmt(s.budgeted)}h`;
        },
      },
      grid: { left: 8, right: 14, top: 64, bottom: 22, containLabel: true },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value', name: '%', max: 120 },
      series: [{
        type: 'bar', barMaxWidth: 50,
        data: values.map((v) => ({
          value: v,
          itemStyle: { color: v === null ? '#bbb' : v >= 100 ? PAL.teal : v >= 80 ? PAL.yellow : PAL.red },
        })),
        markLine: {
          symbol: 'none',
          lineStyle: { color: PAL.navy, type: 'dashed', width: 2 },
          data: [{ yAxis: res.data.target_pct, label: { formatter: 'Meta 100%', color: PAL.navy } }],
        },
        label: { show: true, position: 'top', formatter: (p) => p.value === null ? '—' : p.value + '%', fontSize: 10 },
      }],
    }, true);
    inst.off('click').on('click', (p) => { if (p.componentType === 'series') drill1(); });
  }
  async function drill1() {
    const res = await dgo(1);
    const html = table(
      ['Sem', 'Proyecto', 'Actividad', 'Recurso', 'Presup.', 'Ejec.', 'Cumpl.', 'Estado'],
      res.data.rows,
      (r) => [r.week_number, esc(r.project_folder), esc(r.activity), esc(r.assigned_to), fmt(r.budgeted_hours), fmt(r.total_executed_hours), r.compliance_pct === null ? '—' : r.compliance_pct + '%', esc(r.task_status)]
    );
    window.GTC_MODAL.open('Indicador 1 · Cumplimiento por tarea', html);
  }

  // ============================================================
  //  Indicador 2 — % Entrega a tiempo (KPI con semaforo)
  // ============================================================
  async function render2() {
    const res = await get(2); if (!res) return;
    const { pct, on_time, finished } = res.data;
    if (pct === null) {
      setHtml(2, '<div class="kpi"><div class="kpi-value">—</div><div class="kpi-label">aún no hay tareas terminadas en el periodo</div></div>');
      return;
    }
    const cls = pct >= 100 ? 'kpi-good' : pct >= 80 ? 'kpi-amber' : 'kpi-bad';
    setHtml(2, `
      <div class="kpi ${cls}">
        <div class="kpi-value">${pct}%</div>
        <div class="kpi-label">${on_time} de ${finished} terminadas entregadas a tiempo</div>
        <button class="kpi-drill" data-drill="2">Ver detalle</button>
      </div>`);
  }
  async function drill2() {
    const res = await dgo(2);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Estimada', 'Real', 'Días', 'Resultado'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.estimated_delivery_date), esc(r.actual_delivery_date), r.days_diff, `<span class="${r.resultado === 'A tiempo' ? 'pill-ok' : 'pill-warn'}">${esc(r.resultado)}</span>`]
    );
    window.GTC_MODAL.open('Indicador 2 · Entregas a tiempo vs tarde', html);
  }

  // ============================================================
  //  Indicador 4 — Días de desfase promedio (KPI con dirección)
  // ============================================================
  async function render4() {
    const res = await get(4); if (!res) return;
    const { avg_days, finished, on_time, late } = res.data;
    if (avg_days === null) {
      setHtml(4, '<div class="kpi"><div class="kpi-value">—</div><div class="kpi-label">sin tareas terminadas con fecha real</div></div>');
      return;
    }
    const sign = avg_days > 0 ? '+' : '';
    const cls = avg_days <= 0 ? 'kpi-good' : avg_days <= 2 ? 'kpi-amber' : 'kpi-bad';
    const direction = avg_days > 0 ? '↑ promedio entrega TARDE' : avg_days < 0 ? '↓ promedio entrega ANTES' : 'justo a tiempo';
    setHtml(4, `
      <div class="kpi ${cls}">
        <div class="kpi-value">${sign}${avg_days} d</div>
        <div class="kpi-label">${direction}<br/>${on_time} a tiempo · ${late} tarde · ${finished} terminadas</div>
        <button class="kpi-drill" data-drill="4">Ver detalle</button>
      </div>`);
  }
  async function drill4() {
    const res = await dgo(4);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Estimada', 'Real', 'Días desfase'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.estimated_delivery_date), esc(r.actual_delivery_date), `<span class="${r.days_diff > 0 ? 'pill-warn' : 'pill-ok'}">${r.days_diff > 0 ? '+' : ''}${r.days_diff}</span>`]
    );
    window.GTC_MODAL.open('Indicador 4 · Desfase por tarea', html);
  }

  // ============================================================
  //  Indicador 11 — % Tareas no planeadas (dona)
  // ============================================================
  async function render11() {
    const res = await get(11); if (!res) return;
    const { planned, unplanned, total } = res.data;
    if (total === 0) { setHtml(11, '<p>Sin datos de planeación.</p>'); return; }
    const items = [
      { value: planned, name: 'Planeadas' },
      { value: unplanned, name: 'No planeadas' },
    ];
    const inst = ensureChart(11);

    function centerPct(selected) {
      const visible = items.filter((it) => !selected || selected[it.name] !== false);
      const visTotal = visible.reduce((a, x) => a + x.value, 0);
      const np = visible.find((x) => x.name === 'No planeadas');
      return visTotal > 0 && np ? Math.round((np.value / visTotal) * 1000) / 10 : 0;
    }

    const pct = centerPct();  // valor original sobre todos los datos
    inst.setOption({
      tooltip: { trigger: 'item' },
      // 2 segmentos => el toggle de leyenda no aporta (ocultar uno deja solo el otro)
      // y rompe la coherencia entre la dona y el % del centro.
      legend: { bottom: 10, left: 'center', textStyle: { fontSize: 11 }, itemGap: 14, itemHeight: 10, selectedMode: false, padding: [12, 5, 5, 5] },
      color: [PAL.navy, PAL.yellow],
      series: [{
        type: 'pie', radius: [55, 85], avoidLabelOverlap: true,
        center: ['50%', '52%'],
        label: {
          show: true, position: 'center', fontSize: 22, fontWeight: 700, color: PAL.navy,
          formatter: () => pct + '%\n{small|no plan.}',
          rich: { small: { fontSize: 11, color: '#666', fontWeight: 400, padding: [4, 0, 0, 0] } },
        },
        labelLine: { show: false },
        data: items,
      }],
    }, true);
    inst.off('click').on('click', (p) => { if (p.componentType === 'series') drill11(); });
  }
  async function drill11() {
    const res = await dgo(11);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Estado', 'Tarea no planeada'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.task_status),
              esc([r.unplanned_task_1, r.unplanned_task_2, r.unplanned_task_3].filter(Boolean).join(' · '))]
    );
    window.GTC_MODAL.open('Indicador 11 · Tareas no planeadas', html);
  }

  // ============================================================
  //  Indicador 12 — Tasa de reestimación (KPI + top motivos)
  // ============================================================
  async function render12() {
    const res = await get(12); if (!res) return;
    const { pct, reestimated, total, top_reasons } = res.data;
    const cls = pct === 0 ? 'kpi-good' : pct <= 10 ? 'kpi-amber' : 'kpi-bad';
    const reasonsHtml = top_reasons.length ? `
      <div class="reasons-list">
        <div class="reasons-title">Motivos más frecuentes</div>
        <ul>${top_reasons.slice(0, 5).map((r) => `<li><span class="reason-bar" style="width:${Math.min(100, (r.count / top_reasons[0].count) * 100)}%"></span><span class="reason-txt">${esc(r.motivo)}</span><span class="reason-count">${r.count}</span></li>`).join('')}</ul>
      </div>` : '';
    setHtml(12, `
      <div class="kpi-compact ${cls}">
        <div><div class="kpi-value-sm">${pct}%</div><div class="kpi-label-sm">${reestimated} de ${total} reestimadas</div></div>
        <button class="kpi-drill" data-drill="12">Ver tareas</button>
      </div>
      ${reasonsHtml}`);
  }
  async function drill12() {
    const res = await dgo(12);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Motivo 1', 'Tipo 1', 'Motivo 2', 'Motivo 3'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.adjustment_reason_1), esc(r.adjustment_type_1), esc(r.adjustment_reason_2), esc(r.adjustment_reason_3)]
    );
    window.GTC_MODAL.open('Indicador 12 · Tareas reestimadas', html);
  }

  // ============================================================
  //  Indicador 13 — % Imprevistos internos vs externos (dona)
  // ============================================================
  async function render13() {
    const res = await get(13); if (!res) return;
    const { interno, externo, otro, total } = res.data;
    if (total === 0) { setHtml(13, '<p>Sin imprevistos en el periodo.</p>'); return; }
    const items = [
      { value: interno, name: 'Interno' },
      { value: externo, name: 'Externo' },
      ...(otro > 0 ? [{ value: otro, name: 'Otro' }] : []),
    ];
    const inst = ensureChart(13);

    function centerPcts(selected) {
      const visible = items.filter((it) => !selected || selected[it.name] !== false);
      const visTotal = visible.reduce((a, x) => a + x.value, 0);
      const get = (n) => {
        const it = visible.find((x) => x.name === n);
        return it && visTotal > 0 ? Math.round((it.value / visTotal) * 100) : 0;
      };
      return { i: get('Interno'), e: get('Externo') };
    }

    const { i, e } = centerPcts();  // valores originales sobre todos los datos
    inst.setOption({
      tooltip: { trigger: 'item' },
      // 2 segmentos => el toggle de leyenda no aporta y rompe la coherencia con el centro.
      legend: { bottom: 10, left: 'center', textStyle: { fontSize: 11 }, itemGap: 14, itemHeight: 10, selectedMode: false, padding: [12, 5, 5, 5] },
      color: [PAL.blueMid, PAL.teal, '#bdbdbd'],
      series: [{
        type: 'pie', radius: [55, 85], avoidLabelOverlap: true,
        center: ['50%', '52%'],
        label: {
          show: true, position: 'center', fontSize: 22, fontWeight: 700, color: PAL.navy,
          formatter: () => 'Int ' + i + '%\n{small|Ext ' + e + '%}',
          rich: { small: { fontSize: 11, color: PAL.teal, fontWeight: 600, padding: [4, 0, 0, 0] } },
        },
        labelLine: { show: false },
        data: items,
      }],
    }, true);
    inst.off('click').on('click', (p) => { if (p.componentType === 'series') drill13(p.name); });
  }
  async function drill13(tipo) {
    const res = await dgo(13, tipo ? { tipo } : undefined);
    const html = table(
      ['Proyecto', 'Actividad', 'Recurso', 'Tipo 1', 'Motivo 1', 'Tipo 2', 'Motivo 2'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.assigned_to), esc(r.adjustment_type_1), esc(r.adjustment_reason_1), esc(r.adjustment_type_2), esc(r.adjustment_reason_2)]
    );
    window.GTC_MODAL.open('Indicador 13 · Imprevistos' + (tipo ? ' — ' + tipo : ''), html);
  }

  // ============================================================
  //  Indicador 15 — Velocidad de cierre (barras apiladas por rango de dias)
  // ============================================================
  async function render15() {
    const res = await get(15); if (!res) return;
    if (!res.data.rows.length) { setHtml(15, '<p>Sin tareas terminadas con fecha real.</p>'); return; }
    const inst = ensureChart(15);
    // Ordenar de "mejor velocidad" a "peor": mas tarde 4+ al final, luego 1-3, luego on_time, etc.
    const rows = res.data.rows.slice().sort((a, b) => {
      // peor primero (mas late_4plus arriba, segun yAxis invertido de echarts horizontal)
      if (a.late_4plus !== b.late_4plus) return a.late_4plus - b.late_4plus;
      if (a.late_1_3 !== b.late_1_3) return a.late_1_3 - b.late_1_3;
      return b.early - a.early;
    });
    const names = rows.map((r) => r.canonical_name);
    const buckets = [
      { key: 'early',      label: 'Antes de tiempo', color: PAL.teal    },
      { key: 'on_time',    label: 'A tiempo',        color: PAL.blueMid },
      { key: 'late_1_3',   label: '1-3 días tarde',  color: PAL.yellow  },
      { key: 'late_4plus', label: '4+ días tarde',   color: PAL.red     },
    ];
    inst.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const idx = params[0].dataIndex;
          const r = rows[idx];
          const lines = params
            .filter((p) => p.value > 0)
            .map((p) => `${p.marker} ${esc(p.seriesName)}: <b>${p.value}</b>`);
          const avg = r.avg_days === null
            ? ''
            : `<br/><span style="color:#666">Desfase promedio: ${r.avg_days > 0 ? '+' : ''}${r.avg_days} d</span>`;
          return `<b>${esc(r.canonical_name)}</b><br/>${lines.join('<br/>')}<br/><span style="color:#666">Total: ${r.finished_count}</span>${avg}`;
        },
      },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      grid: { left: 12, right: 24, top: 16, bottom: 40, containLabel: true },
      xAxis: {
        type: 'value',
        name: '# tareas terminadas',
        nameLocation: 'middle', nameGap: 26, nameTextStyle: { fontSize: 11 },
        splitLine: { lineStyle: { color: '#EDEEF7' } },
        minInterval: 1,
      },
      yAxis: {
        type: 'category', data: names,
        axisLabel: {
          fontSize: 11, width: 200, overflow: 'truncate',
          formatter: (v) => (v && v.length > 30 ? v.slice(0, 28) + '…' : v),
        },
      },
      series: buckets.map((b) => ({
        name: b.label,
        type: 'bar',
        stack: 'cierre',
        barMaxWidth: 22,
        itemStyle: { color: b.color },
        label: {
          show: true,
          // Solo mostrar etiqueta si el segmento tiene >= 5 tareas (evita amontonamiento en barras chicas)
          formatter: (p) => (p.value >= 5 ? p.value : ''),
          fontSize: 10,
          color: '#fff',
          fontWeight: 600,
        },
        data: rows.map((r) => r[b.key]),
      })),
    }, true);
    inst.off('click').on('click', (p) => {
      if (p.componentType !== 'series') return;
      const r = rows[p.dataIndex];
      drill15(r.employee_id, r.canonical_name);
    });
  }
  async function drill15(employeeId, name) {
    const res = await dgo(15, { employee_id: employeeId });
    const html = table(
      ['Proyecto', 'Actividad', 'Estimada', 'Real', 'Días'],
      res.data.rows,
      (r) => [esc(r.project_folder), esc(r.activity), esc(r.estimated_delivery_date), esc(r.actual_delivery_date), `<span class="${r.days_diff > 0 ? 'pill-warn' : 'pill-ok'}">${r.days_diff > 0 ? '+' : ''}${r.days_diff}</span>`]
    );
    window.GTC_MODAL.open('Velocidad de cierre · ' + name, html);
  }

  // ============================================================
  //  Indicador 16 — Actividad diaria por recurso (heatmap)
  // ============================================================
  async function render16() {
    const res = await get(16); if (!res) return;
    const { days, day_capacities: caps, employees } = res.data;
    if (!employees || !employees.length) { setHtml(16, '<p>Sin recursos en el periodo.</p>'); return; }

    // Construir matriz [iEmp][iDay] = hours
    const matrix = [];
    let maxH = 0;
    employees.forEach((e, i) => {
      e.days.forEach((d, j) => {
        const v = d.hours;
        if (v > maxH) maxH = v;
        matrix.push([j, i, v, d]);
      });
    });
    // Heatmap necesita un piso para el visualMap; si todo es 0, usa 1 para no crashear.
    const maxDomain = Math.max(maxH, ...caps, 1);

    const yLabels = employees.map((e) => {
      const ps = e.contract_type === 'prestacion_servicios' ? ' ' + icono('estrella') : '';
      return e.canonical_name + ps;
    });

    const inst = ensureChart(16);
    inst.setOption({
      tooltip: {
        position: 'top',
        formatter: (p) => {
          const emp = employees[p.value[1]];
          const dayInfo = emp.days[p.value[0]];
          const ps = emp.contract_type === 'prestacion_servicios' ? '<br/><i>Prestación de servicios</i>' : '';
          const flag = dayInfo.overload ? '<br/>' + icono('advertencia') + ' Sobre capacidad (cap ref: ' + dayInfo.capacity_ref + 'h)' : '';
          const empty = dayInfo.empty ? '<br/>(sin actividad)' : '';
          return `<b>${esc(emp.canonical_name)}</b>${ps}<br/>${days[p.value[0]]}: <b>${dayInfo.hours}h</b>${flag}${empty}`;
        },
      },
      grid: { left: 190, right: 30, top: 30, bottom: 50, containLabel: false },
      xAxis: {
        type: 'category', data: days, splitArea: { show: true },
        axisLabel: { color: PAL.navy, fontWeight: 600, fontSize: 12, margin: 10 },
      },
      yAxis: {
        type: 'category', data: yLabels, splitArea: { show: true },
        axisLabel: { fontSize: 11, width: 175, overflow: 'truncate', color: PAL.navy, margin: 8 },
      },
      visualMap: {
        min: 0, max: maxDomain,
        calculable: false, orient: 'horizontal', left: 'center', bottom: 4,
        inRange: { color: ['#f7fbff', '#bcd9f0', '#5fa4d1', '#1b6ea8', '#0d3b66'] },
        text: ['más horas', '0h'],
        textStyle: { fontSize: 12, color: PAL.navy },
        itemWidth: 22, itemHeight: 14,
        textGap: 8,
      },
      series: [{
        type: 'heatmap',
        data: matrix.map((m) => [m[0], m[1], m[2]]),
        label: {
          show: true, fontSize: 10, color: '#222',
          formatter: (p) => p.value[2] > 0 ? p.value[2] : '',
        },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,.3)' } },
        itemStyle: { borderColor: '#fff', borderWidth: 1 },
      }],
    }, true);

    inst.off('click').on('click', (p) => {
      if (p.componentType !== 'series') return;
      const emp = employees[p.value[1]];
      drill16(emp.employee_id, emp.canonical_name);
    });
  }
  async function drill16(employeeId, name) {
    const res = await dgo(16, { employee_id: employeeId });
    const html = table(
      ['Sem', 'Proyecto', 'Actividad', 'Estado', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Total'],
      res.data.rows,
      (r) => [r.week_number, esc(r.project_folder), esc(r.activity), esc(r.task_status),
              fmt(r.h_mon), fmt(r.h_tue), fmt(r.h_wed), fmt(r.h_thu), fmt(r.h_fri), fmt(r.h_sat), fmt(r.total)]
    );
    window.GTC_MODAL.open('Actividad diaria · ' + name, html);
  }

  // ============================================================
  //  Indicador 17 — Auditoría cambios fecha estimada
  //  v2: la tabla ahora muestra TAREAS individuales con observación
  //  y fechas (original vs actual). El resumen agregado va arriba como KPIs.
  // ============================================================
  async function render17() {
    const res = await get(17); if (!res) return;
    const { tasks, totals } = res.data;
    if (!tasks || !tasks.length) {
      setHtml(17, `<p class="kpi-good-msg">${icono('ok')} Ningún recurso modificó fechas estimadas en el periodo.</p>`);
      return;
    }
    const summary = `<div class="aud-summary">
      <span><b>${totals.employees_affected}</b> recursos</span>
      <span><b>${totals.total_tasks_modified}</b> tareas modificadas</span>
      <span><b>+${totals.total_days_pushed}</b> días postergados</span>
    </div>`;
    const fmtDate = (d) => d ? String(d).slice(0, 10) : '—';
    const html = summary + table(
      ['Recurso', 'Sem', 'Proyecto', 'Actividad', 'Estado', 'F. original', 'F. actual', 'Días', 'Observación'],
      tasks,
      (r) => [
        `${esc(r.canonical_name)}${r.contract_type === 'prestacion_servicios' ? ' <span class="emp-pill-ps" title="Prestación de servicios">PS</span>' : ''}`,
        r.week_number ?? '—',
        esc(r.project_folder),
        esc(r.activity),
        esc(r.task_status || ''),
        esc(fmtDate(r.first_estimated_date)),
        esc(fmtDate(r.last_estimated_date)),
        `<span class="${r.days_moved > 0 ? 'pill-warn' : r.days_moved < 0 ? 'pill-ok' : ''}">${r.days_moved > 0 ? '+' : ''}${r.days_moved}</span>`,
        esc(r.observations || ''),
      ],
      [
        'Recurso dueño de la tarea.',
        'Semana de la tarea en su Excel.',
        'Carpeta de SharePoint donde vive el archivo.',
        'Texto de la actividad tal como aparece en el Excel.',
        'Estado actual (último snapshot).',
        'Fecha estimada en el PRIMER snapshot del mes — la fecha original que se prometió.',
        'Fecha estimada en el ÚLTIMO snapshot — la fecha vigente hoy.',
        'Diferencia en días entre la fecha original y la actual. Positivo = postergada, negativo = adelantada.',
        'Texto de la columna Observaciones en el snapshot más reciente. Suele explicar por qué se movió la fecha.',
      ]
    );
    setHtml(17, html);
  }
  // drill17 ya no se usa — la tabla principal incluye todo el detalle.

  // ============================================================
  //  Indicador 18 — Reconocimientos del mes
  // ============================================================
  async function render18() {
    const res = await get(18); if (!res) return;
    const { podium, mentions, total_eligible } = res.data;
    if (!podium || !podium.length) {
      setHtml(18, '<p class="reco-empty">Aún no hay suficientes datos para reconocimientos este mes.</p>');
      return;
    }
    // Un icono no puede distinguir oro/plata/bronce como hacian los emojis:
  // el primero lleva trofeo y los demas su posicion en numero.
    const podHtml = `<div class="reco-podium">
      ${podium.map((p, i) => `
        <div class="reco-card reco-pos-${p.position}">
          <div class="reco-medal">${i === 0 ? icono('trofeo') : i + 1}</div>
          <div class="reco-name">${esc(p.canonical_name)}${p.contract_type === 'prestacion_servicios' ? ' <span class="emp-pill-ps" title="Prestación de servicios">PS</span>' : ''}</div>
          <div class="reco-score" title="Score compuesto sobre 100">${p.score} pts</div>
          <div class="reco-stats">
            <span><b>${p.compliance_pct}%</b> cumpl.</span>
            <span><b>${p.on_time_pct}%</b> a tiempo</span>
            <span><b>${p.total_tasks}</b> tareas</span>
          </div>
          <div class="reco-badges">${p.badges.map((b) => `<span class="reco-badge" title="${esc(b.label)}">${esc(b.label)}</span>`).join('')}</div>
          <button type="button" class="reco-drill" data-reco-emp="${p.employee_id}" data-name="${esc(p.canonical_name)}">Ver detalle</button>
        </div>`).join('')}
    </div>`;

    const mentionsHtml = mentions.length
      ? `<div class="reco-mentions">
           <h4>Menciones honoríficas (≥3 logros)</h4>
           <ul>
             ${mentions.map((m) => `
               <li>
                 <strong>${esc(m.canonical_name)}</strong>
                 ${m.contract_type === 'prestacion_servicios' ? '<span class="emp-pill-ps">PS</span>' : ''}
                 <span class="reco-mention-stats">${m.compliance_pct}% cumpl · ${m.on_time_pct}% a tiempo</span>
                 <span class="reco-mention-badges">${m.badges.map((b) => esc(b.label)).join(' · ')}</span>
               </li>`).join('')}
           </ul>
         </div>`
      : '';

    const footHtml = `<div class="reco-foot">${total_eligible} recursos elegibles (mín. 3 tareas en el mes)</div>`;
    setHtml(18, podHtml + mentionsHtml + footHtml);

    card(18).querySelectorAll('[data-reco-emp]').forEach((b) => {
      b.addEventListener('click', () => drill18(Number(b.dataset.recoEmp), b.dataset.name));
    });
  }
  async function drill18(employeeId, name) {
    const res = await dgo(18, { employee_id: employeeId });
    const html = table(
      ['Sem', 'Proyecto', 'Actividad', 'Estado', 'Presup.', 'Ejec.', '% Cumpl.', 'Estimada', 'Real'],
      res.data.rows,
      (r) => [r.week_number, esc(r.project_folder), esc(r.activity), esc(r.task_status),
              fmt(r.budgeted_hours), fmt(r.total_executed_hours),
              r.compliance_pct === null ? '—' : r.compliance_pct + '%',
              esc(r.estimated_delivery_date), esc(r.actual_delivery_date)]
    );
    window.GTC_MODAL.open('Detalle · ' + name, html);
  }

  // ===== Wiring =====
  const RENDERERS = {
    1: render1, 2: render2, 3: render3, 4: render4, 5: render5,
    6: render6, 7: render7, 8: render8, 9: render9, 10: render10,
    11: render11, 12: render12, 13: render13, 14: render14, 15: render15,
    16: render16, 17: render17, 18: render18,
  };
  const DRILLS = {
    1: drill1, 2: drill2, 3: drill3, 4: drill4, 5: drill5,
    6: drill6, 7: drill7, 11: drill11, 12: drill12,
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-drill]');
    if (!b) return;
    const n = Number(b.dataset.drill);
    if (DRILLS[n]) DRILLS[n]();
  });

  async function refreshAll() {
    await Promise.allSettled(
      Object.entries(RENDERERS).map(async ([n, fn]) => {
        try { await fn(); }
        catch (err) { console.warn('[ind ' + n + ']', err); setError(n, err.message); }
      })
    );
  }

  document.addEventListener('filters:change', () => { refreshAll(); });
  window.addEventListener('resize', () => { for (const c of STATE.charts.values()) c.resize(); });

  // ============================================================
  //  Botón "expandir gráfico" en cada card
  //  - Si la card tiene un gráfico ECharts, clona sus options en un canvas grande dentro del modal
  //  - Si la card tiene contenido HTML (tabla, KPI, lista), clona el HTML al modal
  // ============================================================
  function setupExpandButtons() {
    document.querySelectorAll('article.card').forEach((card) => {
      const header = card.querySelector('header');
      if (!header || header.querySelector('.expand')) return;
      const n = Number(card.dataset.ind);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'expand';
      btn.setAttribute('aria-label', 'Expandir');
      btn.title = 'Expandir';
      btn.innerHTML = icono('expandir');
      btn.addEventListener('click', () => openExpanded(n, card));
      header.appendChild(btn);
    });
  }

  function openExpanded(n, cardEl) {
    const title = cardEl.querySelector('h2')?.textContent?.trim() || 'Detalle';
    const inst = STATE.charts.get(n);
    if (inst) {
      // Clonar las options del chart en uno nuevo dentro del modal.
      const opt = inst.getOption();
      const container = document.createElement('div');
      container.className = 'expanded-chart';
      window.GTC_MODAL.open(title, container);
      // Inicializar ECharts despues de que el modal este visible (para que tenga tamaño).
      requestAnimationFrame(() => {
        const bigInst = echarts.init(container);
        bigInst.setOption(opt);
        // Limpieza cuando se cierre el modal.
        const modal = document.getElementById('drill-modal');
        const cleanup = () => {
          try { bigInst.dispose(); } catch (e) {}
          modal.removeEventListener('click', onClose, true);
        };
        const onClose = (e) => { if (modal.hidden) cleanup(); };
        // Observador simple: cuando modal se oculta, dispose.
        const obs = new MutationObserver(() => { if (modal.hidden) { cleanup(); obs.disconnect(); } });
        obs.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
      });
    } else {
      // Card sin ECharts (KPI / tabla / HTML): clonar el contenido al modal.
      const chartEl = cardEl.querySelector('.chart');
      const wrap = document.createElement('div');
      wrap.className = 'expanded-content';
      wrap.innerHTML = chartEl ? chartEl.innerHTML : cardEl.innerHTML;
      window.GTC_MODAL.open(title, wrap);
    }
  }

  // Esperar a que las cards existan en el DOM (estan estaticas en index.html, asi que ya estan).
  setupExpandButtons();

  // ============================================================
  //  Exportar los gráficos como imágenes — para el PDF de "Gráficos" del
  //  botón "PDF envío semanal" (app.js). STATE es privado a este cierre, así
  //  que hay que exponer esta función a propósito. A propósito SOLO cubre
  //  los indicadores que de verdad son un gráfico de ECharts (STATE.charts)
  //  — 1,5,7,11,13,14,15,16. Los otros 10 se pintan como tabla/lista/KPI en
  //  HTML, no son un gráfico, así que no van en este PDF (si van en el de
  //  "Datos", que sí los cubre a los 18 en texto).
  // ============================================================
  window.GTC_INDICATORS = {
    exportarGraficos() {
      const salida = [];
      STATE.charts.forEach((inst, num) => {
        try {
          const tituloEl = document.querySelector(`.card[data-ind="${num}"] h2`);
          const dataUrl = inst.getDataURL({ type: 'png', pixelRatio: 1.5, backgroundColor: '#ffffff' });
          // Ancho/alto REALES del chart (no del PNG, que ya viene multiplicado
          // por pixelRatio — la proporción es la misma) para que el PDF pueda
          // calcular cuánto agrandarlo sin dejarlo chiquito ni deformado: un
          // gráfico ancho y corto (como #15/#16, con pocas filas) no debe
          // encogerse a la fuerza dentro de una caja alta pensada para uno
          // cuadrado.
          salida.push({
            num,
            name: tituloEl ? tituloEl.textContent.trim() : `Indicador ${num}`,
            dataUrl,
            width: inst.getWidth(),
            height: inst.getHeight(),
          });
        } catch (e) {
          // Chart sin datos todavía o ya destruido — se omite, no se
          // revienta la exportación completa por uno solo.
        }
      });
      return salida.sort((a, b) => a.num - b.num);
    },
  };
})();
