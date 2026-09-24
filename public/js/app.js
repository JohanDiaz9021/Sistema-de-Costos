/* Bootstrap del dashboard. Verifica sesion, carga filtros, y deja gancho para indicadores. */
(function () {
  'use strict';

  async function checkSession() {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!r.ok) { window.location.href = '/login'; return null; }
    return (await r.json()).user;
  }

  // "Cerrar sesión" vive solo en el sidebar (sidebar.js) — antes también
  // estaba en la topbar y salía duplicado en Planeación.

  // Bloque 4 (ago 2026) — PDF de los 18 indicadores para el envío semanal,
  // con los mismos filtros activos en pantalla. Mismo patrón de descarga que
  // costeo.js (downloadFile): no se puede reusar esa función porque
  // costeo.js no se carga en esta página.
  async function downloadPdf(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Error ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'reporte-planeacion.pdf';

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  // Igual que downloadPdf() pero mandando un POST con body JSON (el PDF de
  // gráficos manda las imágenes capturadas, no le caben en una URL de GET).
  async function downloadPdfPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const cuerpo = await res.json().catch(() => ({}));
      throw new Error(cuerpo.error || `Error ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'reporte-planeacion.pdf';

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  const exportBtn = document.getElementById('export-planeacion-pdf');
  const exportMenu = document.getElementById('export-planeacion-menu');
  if (exportBtn && exportMenu) {
    // El texto del botón refleja el filtro de Proyecto activo, para que
    // quede claro ANTES de descargar si el PDF va a salir general o de un
    // solo proyecto — a pedido explícito: el reporte debe poder pedirse por
    // proyecto, no solo general, y el filtro "Proyecto" ya existente es lo
    // que decide el alcance (ver /api/indicator/export/pdf).
    const actualizarLabelExport = () => {
      const s = window.GTC_FILTERS && window.GTC_FILTERS.state ? window.GTC_FILTERS.state() : {};
      // innerHTML y no textContent: el rotulo lleva el icono SVG (ver
      // icono() en iconos.js). El nombre del proyecto va escapado porque
      // entra a una plantilla de HTML, no a un nodo de texto.
      exportBtn.innerHTML = s.project
        ? `${icono('documento')} PDF envío semanal — ${escapeHtml(s.project)}`
        : `${icono('documento')} PDF envío semanal — Todos los proyectos`;
    };
    document.addEventListener('filters:change', actualizarLabelExport);
    actualizarLabelExport();

    const cerrarMenu = () => { exportMenu.hidden = true; };
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.hidden = !exportMenu.hidden;
    });
    // Clic afuera del menú lo cierra — mismo patrón que el multiselect de
    // proyectos (costeo-core.js), sin esto se queda abierto para siempre.
    document.addEventListener('click', (e) => {
      if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) cerrarMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenu(); });

    function filtrosActualesParaExport() {
      const s = window.GTC_FILTERS && window.GTC_FILTERS.state ? window.GTC_FILTERS.state() : {};
      const partes = [];
      if (s.month) partes.push(`Mes: ${s.month}`);
      if (s.week) partes.push(`Semana ${s.week}`);
      if (s.project) partes.push(`Proyecto: ${s.project}`);
      if (s.leader) partes.push(`Líder: ${s.leader}`);
      return { s, filtrosLabel: partes.length ? partes.join(' · ') : 'Todos los proyectos — snapshot más reciente' };
    }

    exportMenu.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-export]');
      if (!btn) return;
      cerrarMenu();

      if (btn.dataset.export === 'datos') {
        await withBusy(exportBtn, async () => {
          try {
            const { s } = filtrosActualesParaExport();
            const params = new URLSearchParams();
            if (s.month) params.set('month', s.month);
            if (s.week) params.set('week', s.week);
            if (s.project) params.set('project', s.project);
            if (s.employee) params.set('employee_id', s.employee);
            if (s.leader) params.set('leader', s.leader);
            await downloadPdf('/api/indicator/export/pdf?' + params.toString());
          } catch (err) {
            alert(err.message);
          }
        }, 'Generando…');
        return;
      }

      if (btn.dataset.export === 'graficos') {
        await withBusy(exportBtn, async () => {
          try {
            if (!window.GTC_INDICATORS || !window.GTC_INDICATORS.exportarGraficos) {
              throw new Error('Los gráficos todavía no están listos — espera a que termine de cargar el dashboard.');
            }
            const imagenes = window.GTC_INDICATORS.exportarGraficos();
            if (!imagenes.length) {
              throw new Error('No hay gráficos visibles para exportar en este momento.');
            }
            const { s, filtrosLabel } = filtrosActualesParaExport();
            await downloadPdfPost('/api/indicator/export/pdf-graficos', {
              imagenes, filtrosLabel, project: s.project || '',
            });
          } catch (err) {
            alert(err.message);
          }
        }, 'Generando…');
      }
    });
  }

  // Modal de drilldown (helpers para Bloques 2-3)
  const modal = document.getElementById('drill-modal');
  const drillTitle = document.getElementById('drill-title');
  const drillBody  = document.getElementById('drill-body');
  document.getElementById('drill-close').addEventListener('click', () => modal.hidden = true);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  window.GTC_MODAL = {
    open: (title, htmlOrNode) => {
      drillTitle.textContent = title || 'Detalle';
      drillBody.innerHTML = '';
      if (typeof htmlOrNode === 'string') drillBody.innerHTML = htmlOrNode;
      else if (htmlOrNode instanceof Node) drillBody.appendChild(htmlOrNode);
      modal.hidden = false;
    },
    close: () => modal.hidden = true,
  };

  // Bloques 2 y 3 escucharan este evento para refrescar sus visuales.
  document.addEventListener('filters:change', (e) => {
    console.debug('[filters:change]', e.detail);
  });

  // Auto-refresh periódico. Los datos de la BD solo cambian cuando el WF1
  // ingiere un snapshot nuevo, pero el dashboard puede estar abierto durante
  // toda la jornada — recargar cada 5 min mantiene la vista al día sin que
  // el usuario tenga que apretar F5. Si algún modal está abierto no
  // refrescamos para no perder el contexto del drilldown.
  const REFRESH_MS = 5 * 60 * 1000;
  setInterval(() => {
    const modalOpen = document.getElementById('drill-modal') && !document.getElementById('drill-modal').hidden;
    if (modalOpen) return;
    if (document.visibilityState !== 'visible') return;
    if (window.GTC_FILTERS && window.GTC_FILTERS.refresh) {
      window.GTC_FILTERS.refresh();
    } else {
      // Fallback: dispara el evento manualmente con el state actual.
      const state = window.GTC_FILTERS && window.GTC_FILTERS.state ? window.GTC_FILTERS.state() : {};
      document.dispatchEvent(new CustomEvent('filters:change', { detail: { ...state, _autoRefresh: true } }));
    }
  }, REFRESH_MS);

  (async function start() {
    const user = await checkSession();
    if (!user) return;
    if (window.GTC_EMPLOYEES_ADMIN && window.GTC_EMPLOYEES_ADMIN.init) {
      window.GTC_EMPLOYEES_ADMIN.init(user);
    }
    if (window.GTC_VALIDATION_ADMIN && window.GTC_VALIDATION_ADMIN.init) {
      window.GTC_VALIDATION_ADMIN.init(user);
    }
    await window.GTC_FILTERS.init();
  })();
})();
