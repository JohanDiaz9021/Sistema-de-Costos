/* Panel de errores de ingestión — solo admin/ceo.
 * Lee los registros que el WF1 de n8n guarda en mp_validation_errors.
 * Los 30 tipos de error vienen del WF1 ya existente.
 */
(function () {
  'use strict';

  const STATE = { user: null, rows: [], lastSummary: null };

  // Labels legibles para los 30 tipos de error del WF1
  const ERROR_LABELS = {
    NO_FILE: 'Sin archivo .xlsx',
    NO_DATA_INGESTED: 'Sin datos ingresados (formato Excel sospechoso)',
    MISSING_MONTH_SHEET: 'Falta pestaña del mes',
    DUPLICATE_MONTH_SHEET: 'Pestañas duplicadas del mes',
    INVALID_TALENT_AND_LEADER: 'Talento + Líder vacíos',
    NON_SEQUENTIAL_CONSECUTIVE: 'Consecutivos no secuenciales',
    TEMPLATE_NOT_RENAMED: 'Plantilla no renombrada',
    SHEET_CASE_MISMATCH: 'Diferencia mayúsculas en hoja',
    EMPTY_SHEET: 'Hoja vacía',
    PARSE_ERROR: 'Error parseando',
    EMPLOYEE_NOT_IN_CATALOG: 'Empleado no en catálogo',
    NO_EMPLOYEE_NAME: 'Falta nombre del talento',
    NAME_MISMATCH: 'Nombre no coincide con carpeta',
    MISSING_LEADER: 'Falta líder (A cargo de)',
    DUPLICATE_WEEK_TASKS: 'Bloques duplicados de la misma semana',
    DUPLICATE_CONSECUTIVE: 'Consecutivo duplicado',
    DUPLICATE_TASK: 'Tarea duplicada',
    WEEK_NUMBER_MISMATCH: 'Semana distinta a la actual',
    EXECUTED_HOURS_IN_FUTURE: 'Horas en días futuros',
    TASK_OVERDUE_IN_PLANNING: 'Tarea vencida sin terminar',
    MISSING_CONSECUTIVE: 'Falta consecutivo',
    MISSING_WEEK_NUMBER: 'Falta semana',
    MISSING_PROJECT: 'Falta proyecto',
    MISSING_ACTIVITY: 'Falta actividad',
    MISSING_PLANNED_TYPE: 'Falta P/NP',
    MISSING_BUDGETED_HOURS: 'Falta horas presupuestadas',
    MISSING_DELIVERY_DATE: 'Falta fecha estimada',
    MISSING_ASSIGNEE: 'Falta responsable',
    MISSING_STATUS: 'Falta estado',
    INVALID_STATUS: 'Estado inválido',
    MISSING_OBSERVATIONS_BLOCKED: 'Bloqueada sin observaciones',
    TERMINATED_WITHOUT_DELIVERY_DATE: 'Terminado sin fecha de cierre (H)',
    EXECUTED_HOURS_WITHOUT_ESTIMATE: 'Horas ejecutadas sin fecha estimada (G)',
    TT_INCONSISTENT: 'TT inconsistente con suma de horas',
  };

  const SEVERITY_CLASSES = {
    critical: 'val-sev-critical',
    warning: 'val-sev-warning',
    info: 'val-sev-info',
  };
  const SEVERITY_LABELS = {
    critical: 'Crítico',
    warning: 'Advertencia',
    info: 'Info',
  };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function fetchJSON(url, opts) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { error: text }; }
    if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
    return body;
  }

  async function refreshBadge() {
    try {
      const s = await fetchJSON('/api/validation/errors/summary?days=7');
      STATE.lastSummary = s;
      const badge = document.getElementById('admin-validation-badge');
      if (!badge) return;
      const n = s.unacknowledged || 0;
      badge.textContent = String(n);
      badge.hidden = n === 0;
    } catch (e) { /* silenciar — no crítico */ }
  }

  function renderRow(r) {
    const who = r.employee_canonical || r.employee_folder_name || '—';
    const label = ERROR_LABELS[r.error_type] || r.error_type;
    const sevCls = SEVERITY_CLASSES[r.severity] || '';
    const sevLbl = SEVERITY_LABELS[r.severity] || r.severity;
    // Estado del override (falso positivo) si existe.
    const isReverted = !!r.override_id;
    const revertedTooltip = isReverted
      ? `Marcado como falso positivo por ${esc(r.reverted_by_email || '?')} el ${esc(new Date(r.reverted_at).toLocaleString('es-CO'))}${r.override_reason ? ` — Razón: ${esc(r.override_reason)}` : ''}`
      : '';

    const weekCell = r.week_number ? `S${r.week_number}` : '—';
    return `
      <tr class="${r.acknowledged ? 'val-row-ack' : ''} ${isReverted ? 'val-row-reverted' : ''}">
        <td>${esc(new Date(r.detected_at).toLocaleString('es-CO'))}</td>
        <td><span class="val-sev ${sevCls}">${esc(sevLbl)}</span></td>
        <td><strong>${esc(label)}</strong>${isReverted ? ` <span class="val-fp-tag" title="${revertedTooltip}">FALSO POSITIVO</span>` : ''}</td>
        <td>${esc(who)}</td>
        <td>${esc(r.project_folder || '—')}</td>
        <td class="val-week">${weekCell}</td>
        <td class="val-file">${esc(r.file_name || '—')}</td>
        <td class="val-msg" title="${esc(r.error_message || '')}">${esc((r.error_message || '').slice(0, 180))}</td>
        <td class="val-actions">
          ${r.acknowledged
            ? `<span class="val-ack-by" title="Reconocido">${icono('check')}</span>`
            : `<button type="button" data-ack="${r.error_id}">Reconocer</button>`}
          ${isReverted
            ? `<button type="button" data-unrevert="${r.error_id}" title="${revertedTooltip}">↩ Deshacer FP</button>`
            : `<button type="button" data-revert="${r.error_id}" class="val-btn-fp">⌀ Falso positivo</button>`}
        </td>
      </tr>`;
  }

  async function loadAndRender(wrap, filters) {
    const params = new URLSearchParams();
    if (filters.days) params.set('days', filters.days);
    if (filters.ack !== '') params.set('ack', filters.ack);
    if (filters.type) params.set('type', filters.type);
    if (filters.severity) params.set('severity', filters.severity);
    const data = await fetchJSON('/api/validation/errors?' + params.toString());
    STATE.rows = data.rows || [];

    const summary = STATE.lastSummary;
    const summaryHtml = summary
      ? `<div class="val-summary">
           <strong>${summary.unacknowledged}</strong> sin reconocer (${summary.days} días)
           ${(summary.by_severity || []).map((s) => `<span class="val-chip ${SEVERITY_CLASSES[s.severity] || ''}">${esc(SEVERITY_LABELS[s.severity] || s.severity)}: ${s.n}</span>`).join('')}
         </div>` : '';

    const tableHtml = STATE.rows.length
      ? `<div class="val-table-wrap"><table class="val-table">
          <thead><tr>
            <th>Detectado</th><th>Sev.</th><th>Tipo</th><th>Empleado</th>
            <th>Proyecto</th><th>Sem.</th><th>Archivo</th><th>Detalle</th><th></th>
          </tr></thead>
          <tbody>${STATE.rows.map(renderRow).join('')}</tbody>
        </table></div>`
      : `<p class="val-empty">No hay errores con esos filtros.</p>`;

    wrap.querySelector('#val-list').innerHTML = summaryHtml + tableHtml;
  }

  async function openManager() {
    const wrap = document.createElement('div');
    wrap.className = 'val-manager';
    wrap.innerHTML = `
      <div class="val-toolbar">
        <label>Últimos
          <select id="val-days">
            <option value="7" selected>Semana actual (7 días)</option>
            <option value="14">14 días</option>
            <option value="30">30 días</option>
            <option value="90">90 días</option>
          </select>
        </label>
        <label>Estado
          <select id="val-ack">
            <option value="">Todos</option>
            <option value="0" selected>Sin reconocer</option>
            <option value="1">Reconocidos</option>
          </select>
        </label>
        <label>Severidad
          <select id="val-severity">
            <option value="">Todas</option>
            <option value="critical">Crítico</option>
            <option value="warning">Advertencia</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>Tipo
          <select id="val-type"><option value="">Todos</option></select>
        </label>
        <button type="button" id="val-refresh" class="btn-primary">Refrescar</button>
      </div>
      <div id="val-list">Cargando…</div>`;

    const typeSel = wrap.querySelector('#val-type');
    Object.entries(ERROR_LABELS).forEach(([k, v]) => {
      const o = document.createElement('option'); o.value = k; o.textContent = v;
      typeSel.appendChild(o);
    });

    window.GTC_MODAL.open('Errores de ingestión', wrap);

    const reload = async () => {
      const filters = {
        days: wrap.querySelector('#val-days').value,
        ack:  wrap.querySelector('#val-ack').value,
        type: wrap.querySelector('#val-type').value,
        severity: wrap.querySelector('#val-severity').value,
      };
      try {
        await loadAndRender(wrap, filters);
      } catch (err) {
        wrap.querySelector('#val-list').innerHTML = `<p class="val-error">No se pudo cargar: ${esc(err.message)}</p>`;
      }
    };

    wrap.querySelector('#val-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, reload));
    wrap.querySelector('#val-days').addEventListener('change', reload);
    wrap.querySelector('#val-ack').addEventListener('change', reload);
    wrap.querySelector('#val-severity').addEventListener('change', reload);
    wrap.querySelector('#val-type').addEventListener('change', reload);

    wrap.addEventListener('click', async (e) => {
      // Reconocer
      const ack = e.target.closest('[data-ack]');
      if (ack) {
        const id = Number(ack.dataset.ack);
        await withBusy(ack, async () => {
          try {
            await fetchJSON('/api/validation/errors/' + id + '/ack', { method: 'POST', body: '{}' });
            await refreshBadge();
            await reload();
          } catch (err) { alert('Error: ' + err.message); }
        }, 'Guardando…');
        return;
      }

      // Marcar como falso positivo
      const fp = e.target.closest('[data-revert]');
      if (fp) {
        const id = Number(fp.dataset.revert);
        const reason = prompt('Razón (opcional) — por qué este hallazgo es un falso positivo:');
        if (reason === null) return; // cancelado
        await withBusy(fp, async () => {
          try {
            await fetchJSON('/api/validation/errors/' + id + '/revert', {
              method: 'POST',
              body: JSON.stringify({ reason: reason || null }),
            });
            await refreshBadge();
            await reload();
          } catch (err) { alert('Error: ' + err.message); }
        }, 'Guardando…');
        return;
      }

      // Deshacer falso positivo
      const undo = e.target.closest('[data-unrevert]');
      if (undo) {
        const id = Number(undo.dataset.unrevert);
        if (!confirm('¿Deshacer la marca de falso positivo? El hallazgo vuelve a contar como válido.')) return;
        await withBusy(undo, async () => {
          try {
            await fetchJSON('/api/validation/errors/' + id + '/unrevert', { method: 'POST', body: '{}' });
            await refreshBadge();
            await reload();
          } catch (err) { alert('Error: ' + err.message); }
        }, 'Deshaciendo…');
        return;
      }
    });

    reload();
  }

  function init(user) {
    STATE.user = user;
    const btn = document.getElementById('admin-validation-btn');
    if (!btn) return;
    // Exclusivo del CEO (9 sep 2026, a pedido explícito): el admin de
    // Accesos gestiona PMs y proyectos, no la ingesta técnica del RPA. El
    // backend (src/routes/validation.js) ya rechaza a un admin con 403;
    // esto solo evita ofrecerle un botón que le fallaría al hacer clic.
    if (user && user.role === 'ceo') {
      btn.hidden = false;
      btn.addEventListener('click', openManager);
      refreshBadge();
      setInterval(refreshBadge, 5 * 60 * 1000);
    }
  }

  window.GTC_VALIDATION_ADMIN = { init };
})();
