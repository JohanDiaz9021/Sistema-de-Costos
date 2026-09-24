/* CRUD de empleados — Nivel 1 (solo BD).
 * Solo visible para admin / ceo. La auth se valida tambien en el backend.
 */
(function () {
  'use strict';

  const STATE = { user: null, employees: [], editingId: null };
  const PROJECTS = ['CRM', 'Document Online', 'Infraestructura', 'MIA', 'QA', 'SESCOL', 'Transversales'];
  const CONTRACT_LABELS = { planta: 'Planta', prestacion_servicios: 'Prestación de servicios' };

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

  async function loadEmployees() {
    const r = await fetchJSON('/api/employees');
    STATE.employees = r.rows || [];
  }

  function renderList(filter) {
    const q = (filter || '').toLowerCase();
    const list = STATE.employees.filter((e) => {
      if (!q) return true;
      const haystack = [
        e.canonical_name, e.email, e.leader_name, e.leader_email,
        ...(Array.isArray(e.aliases) ? e.aliases : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
    const rows = list.map((e) => {
      const contractBadge = e.contract_type === 'prestacion_servicios'
        ? ' <span class="emp-pill-ps" title="Prestación de servicios">PS</span>'
        : '';
      return `
      <tr data-emp="${e.employee_id}" class="${e.is_active ? '' : 'emp-inactive'}">
        <td><strong>${esc(e.canonical_name)}</strong>${contractBadge}${e.is_active ? '' : ' <span class="pill-warn">inactivo</span>'}</td>
        <td>${esc(e.email)}</td>
        <td>${esc(e.leader_name || '—')}</td>
        <td>${esc(e.project_folder || '—')}</td>
        <td>${Array.isArray(e.aliases) && e.aliases.length ? esc(e.aliases.join(', ')) : '<span class="emp-muted">—</span>'}</td>
        <td class="emp-actions">
          <button type="button" data-emp-edit="${e.employee_id}">Editar</button>
          <button type="button" data-emp-sp="${e.employee_id}" title="Crear carpeta y plantilla en SharePoint">SharePoint</button>
          ${e.is_active
            ? `<button type="button" data-emp-deact="${e.employee_id}" class="emp-danger">Desactivar</button>`
            : `<button type="button" data-emp-react="${e.employee_id}">Reactivar</button>`}
        </td>
      </tr>`;
    }).join('');
    return `
      <table class="emp-table">
        <thead><tr><th>Nombre canónico</th><th>Email</th><th>Líder</th><th>Proyecto</th><th>Aliases</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="emp-muted">Sin resultados</td></tr>'}</tbody>
      </table>`;
  }

  function renderForm(emp) {
    const e = emp || { canonical_name: '', email: '', leader_name: '', leader_email: '', project_folder: '', aliases: [], is_active: 1, receive_alerts: 1, contract_type: 'planta' };
    const aliasesStr = Array.isArray(e.aliases) ? e.aliases.join(', ') : '';
    const projectOpts = ['<option value="">— Sin proyecto —</option>']
      .concat(PROJECTS.map((p) => `<option value="${esc(p)}" ${e.project_folder === p ? 'selected' : ''}>${esc(p)}</option>`))
      .join('');
    const contractOpts = Object.entries(CONTRACT_LABELS)
      .map(([k, v]) => `<option value="${esc(k)}" ${e.contract_type === k ? 'selected' : ''}>${esc(v)}</option>`)
      .join('');
    return `
      <form class="emp-form" id="emp-form">
        <h4>${emp ? 'Editar empleado' : 'Nuevo empleado'}</h4>
        <label>Nombre canónico * <input type="text" name="canonical_name" value="${esc(e.canonical_name)}" required></label>
        <label>Email * <input type="email" name="email" value="${esc(e.email)}" required></label>
        <label>Proyecto (carpeta en SharePoint) <select name="project_folder">${projectOpts}</select></label>
        <label>Tipo de contrato * <select name="contract_type">${contractOpts}</select>
          <small class="emp-hint">Los de prestación de servicios se analizan igual, pero el dashboard les pone un badge informativo.</small>
        </label>
        <label>Líder (nombre) <input type="text" name="leader_name" value="${esc(e.leader_name || '')}"></label>
        <label>Líder (email) <input type="email" name="leader_email" value="${esc(e.leader_email || '')}"></label>
        <label>Aliases (separados por coma) <input type="text" name="aliases" value="${esc(aliasesStr)}" placeholder="Ej: Juan G., J. Guzmán"></label>
        <label class="emp-check"><input type="checkbox" name="is_active" ${e.is_active ? 'checked' : ''}> Activo</label>
        <label class="emp-check"><input type="checkbox" name="receive_alerts" ${e.receive_alerts ? 'checked' : ''}> Recibir alertas</label>
        <div class="emp-form-actions">
          <button type="submit" class="btn-primary">${emp ? 'Guardar cambios' : 'Crear'}</button>
          <button type="button" id="emp-cancel">Cancelar</button>
        </div>
        <div class="emp-form-error" id="emp-form-error" hidden></div>
      </form>`;
  }

  async function openManager() {
    try {
      await loadEmployees();
    } catch (err) {
      window.GTC_MODAL.open('Empleados', `<div class="emp-error">No se pudo cargar la lista: ${esc(err.message)}</div>`);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'emp-manager';
    wrap.innerHTML = `
      <div class="emp-toolbar">
        <input type="search" id="emp-search" placeholder="Buscar por nombre, email, líder…" />
        <button type="button" id="emp-new" class="btn-primary">+ Nuevo empleado</button>
      </div>
      <div id="emp-list-wrap">${renderList()}</div>
      <div id="emp-form-wrap"></div>`;
    window.GTC_MODAL.open('Gestionar empleados', wrap);

    wrap.querySelector('#emp-search').addEventListener('input', (e) => {
      wrap.querySelector('#emp-list-wrap').innerHTML = renderList(e.target.value);
    });
    wrap.querySelector('#emp-new').addEventListener('click', () => openForm(null, wrap));
    wrap.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-emp-edit]');
      if (editBtn) {
        const id = Number(editBtn.dataset.empEdit);
        const emp = STATE.employees.find((x) => x.employee_id === id);
        openForm(emp, wrap);
        return;
      }
      const deactBtn = e.target.closest('[data-emp-deact]');
      if (deactBtn) {
        const id = Number(deactBtn.dataset.empDeact);
        const emp = STATE.employees.find((x) => x.employee_id === id);
        if (!confirm(`¿Desactivar a "${emp.canonical_name}"? No se borra de la BD; quedará como inactivo y dejará de aparecer en los indicadores.`)) return;
        await withBusy(deactBtn, async () => {
          try {
            await fetchJSON('/api/employees/' + id, { method: 'DELETE' });
            await loadEmployees();
            wrap.querySelector('#emp-list-wrap').innerHTML = renderList(wrap.querySelector('#emp-search').value);
          } catch (err) { alert('Error: ' + err.message); }
        }, 'Desactivando…');
        return;
      }
      const reactBtn = e.target.closest('[data-emp-react]');
      if (reactBtn) {
        const id = Number(reactBtn.dataset.empReact);
        await withBusy(reactBtn, async () => {
          try {
            await fetchJSON('/api/employees/' + id, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
            await loadEmployees();
            wrap.querySelector('#emp-list-wrap').innerHTML = renderList(wrap.querySelector('#emp-search').value);
          } catch (err) { alert('Error: ' + err.message); }
        }, 'Reactivando…');
        return;
      }
      const spBtn = e.target.closest('[data-emp-sp]');
      if (spBtn) {
        const id = Number(spBtn.dataset.empSp);
        const emp = STATE.employees.find((x) => x.employee_id === id);
        await withBusy(spBtn, () => createSharePointStructure(emp), 'Creando en SharePoint…');
      }
    });
  }

  async function createSharePointStructure(emp) {
    if (!emp.project_folder) {
      alert('El empleado no tiene proyecto asignado. Edítalo primero y selecciona un proyecto.');
      return;
    }
    if (!confirm(`¿Crear carpeta y plantilla en SharePoint para "${emp.canonical_name}" dentro del proyecto "${emp.project_folder}"?\n\nRuta: Planeación 2026/${emp.project_folder}/${emp.canonical_name}/${emp.canonical_name}.xlsx`)) return;
    try {
      const r = await fetchJSON('/api/employees/' + emp.employee_id + '/sharepoint', { method: 'POST', body: '{}' });
      const folderMsg = r.folder.alreadyExisted ? 'Carpeta ya existía' : 'Carpeta creada';
      let fileMsg;
      if (r.file && r.file.error) fileMsg = 'Plantilla: ERROR — ' + r.file.error;
      else if (r.file && r.file.pending) fileMsg = 'Plantilla en copia (puede tardar unos segundos)';
      else if (r.file && r.file.alreadyExisted) fileMsg = 'Plantilla ya existía';
      else fileMsg = 'Plantilla copiada';
      let openLinks = '';
      if (r.folder.webUrl) openLinks += '\n• Carpeta: ' + r.folder.webUrl;
      if (r.file && r.file.webUrl) openLinks += '\n• Archivo: ' + r.file.webUrl;
      alert(`${folderMsg}\n${fileMsg}${openLinks}`);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function openForm(emp, wrap) {
    const formWrap = wrap.querySelector('#emp-form-wrap');
    formWrap.innerHTML = renderForm(emp);
    formWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const form = formWrap.querySelector('#emp-form');
    const errBox = formWrap.querySelector('#emp-form-error');
    formWrap.querySelector('#emp-cancel').addEventListener('click', () => { formWrap.innerHTML = ''; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const fd = new FormData(form);
      const payload = {
        canonical_name: String(fd.get('canonical_name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        leader_name: String(fd.get('leader_name') || '').trim() || null,
        leader_email: String(fd.get('leader_email') || '').trim() || null,
        project_folder: String(fd.get('project_folder') || '').trim() || null,
        contract_type: String(fd.get('contract_type') || 'planta').trim(),
        aliases: String(fd.get('aliases') || '').trim(),
        is_active: form.querySelector('[name="is_active"]').checked,
        receive_alerts: form.querySelector('[name="receive_alerts"]').checked,
      };
      const submitBtn = form.querySelector('button[type="submit"]');
      await withBusy(submitBtn, async () => {
        try {
          if (emp) {
            await fetchJSON('/api/employees/' + emp.employee_id, { method: 'PUT', body: JSON.stringify(payload) });
          } else {
            await fetchJSON('/api/employees', { method: 'POST', body: JSON.stringify(payload) });
          }
          await loadEmployees();
          wrap.querySelector('#emp-list-wrap').innerHTML = renderList(wrap.querySelector('#emp-search').value);
          formWrap.innerHTML = '';
        } catch (err) {
          errBox.textContent = err.message;
          errBox.hidden = false;
        }
      }, 'Guardando…');
    });
  }

  function init(user) {
    STATE.user = user;
    const btn = document.getElementById('admin-employees-btn');
    if (!btn) return;
    if (user && (user.role === 'admin' || user.role === 'ceo')) {
      btn.hidden = false;
      btn.addEventListener('click', openManager);
    }
  }

  window.GTC_EMPLOYEES_ADMIN = { init };
})();
