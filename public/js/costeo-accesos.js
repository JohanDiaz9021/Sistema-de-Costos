'use strict';

/**
 * Accesos (Gestion de PMs) y Configuracion de umbrales.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Accesos (Gestión de PMs) =====================
// Crea/edita cuentas reales de mp_dashboard_users (rol leader), asignadas
// a un Centro de Costos vía mp_project_owners — mismo login que el resto
// del sistema, no una simulación aparte.

const EG_SUBPANELES = ['accesos', 'equipo-proyecto', 'tarifas-cargo', 'costo-no-planeado', 'horas-extra', 'historial', 'configuracion'];

// Este panel tenía un banner de cabecera compartido por todas las
// sub-pestañas, cuyo título y descripción se reescribían aquí para que cada
// una anunciara lo suyo. Los banners de todos los paneles se quitaron el 10
// sep 2026 a pedido explícito — la pestaña activa ya dice dónde estás.

function switchEgSubtab(id) {
  // Marca la sub-pestaña activa y, de paso, apaga las 4 de panel: ninguna
  // tiene data-subtab, así que la comparación les da false. Es la misma
  // barra desde el 11 sep 2026 (#cst-tabbar, ya no #cst-eg-subtabs).
  document.querySelectorAll('#cst-tabbar .cst-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.subtab === id));
  EG_SUBPANELES.forEach((sid) => {
    document.getElementById(`cst-subpanel-${sid}`).hidden = sid !== id;
  });
  // Mantiene sincronizado el botón del sidebar cuando el cambio de
  // sub-pestaña viene de la barra de pestañas (#cst-tabbar), no del sidebar.
  subtabActivo = id;
  marcarNavActivo('equipo-gastos', id);
  // Cada sub-pestaña usa un subconjunto distinto de los filtros globales
  // (ver FILTROS_POR_SUBTAB_EQUIPO_GASTOS en costeo-nav.js) — sin esto, el
  // clic en la barra de pestañas (#cst-tabbar) no recalculaba la
  // visibilidad y quedaba la del subtab anterior hasta el próximo cambio
  // de panel desde el sidebar.
  aplicarVisibilidadFiltros('equipo-gastos');
  renderAvisoFiltro();
}

// Accesos y Configuración son exclusivas de admin/ceo — mismas dos que el
// menú lateral le esconde al PM (data-ceo-only, ver applyRoleNav en
// sidebar.js).
//
// Antes esto escondía la barra ENTERA cuando el rol no era admin/ceo: vivía
// dentro de "Equipo y Gastos" y el PM llegaba a cada sub-pestaña desde el
// menú lateral, así que sobraba. Desde el 11 sep 2026 la barra es la
// navegación de TODA la pantalla (#cst-tabbar, fuera de los paneles):
// esconderla entera dejaría al PM sin ella en las 11 pantallas, no solo en
// las dos que no le tocan. Se esconden solo esos dos botones.
//
// NO toca el banner (cst-eg-info-admin/cst-eg-info-pm ya no existen, se
// eliminaron del front; el banner completo tampoco existe desde el 10 sep
// 2026). Antes esta función pisaba los avisos sin mirar el subtab
// — en la carga inicial directo a Historial (?subtab=historial), initNav()
// ya había llamado a switchEgSubtab('historial') y escondido los dos avisos,
// pero esta función corría DESPUÉS (ver el orden en costeo-nav.js) y los
// volvía a mostrar, dejando el aviso de PM encima del banner "Historial" sin
// su descripción.
function applyEgRoleView() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  document.querySelectorAll('#cst-tabbar .cst-tab[data-ceo-only]').forEach((btn) => {
    btn.hidden = !isAdmin;
    btn.style.visibility = 'visible';
  });
}

function defaultEgSubtab() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  return isAdmin ? 'accesos' : 'equipo-proyecto';
}

// Los dos tipos de botón de la barra global: data-panel cambia de pantalla
// (y deja subtabActivo en null, como hace el menú lateral) y data-subtab
// entra a Equipo y Gastos por esa sub-pestaña. showPanel() vive en
// costeo-nav.js; si no está cargado (pruebas de componente) el clic sigue
// haciendo lo suyo con la sub-pestaña, que es lo que esas pruebas miran.
function initEgSubtabs() {
  document.querySelectorAll('#cst-tabbar .cst-tab[data-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (panelActivo !== 'equipo-gastos' && typeof showPanel === 'function') showPanel('equipo-gastos');
      switchEgSubtab(btn.dataset.subtab);
    });
  });

  document.querySelectorAll('#cst-tabbar .cst-tab[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      subtabActivo = null;
      if (typeof showPanel === 'function') showPanel(btn.dataset.panel);
    });
  });
}

async function loadProyectosDisponibles() {
  if (state.proyectosDisponibles) return state.proyectosDisponibles;
  const { proyectos } = await fetchJSON('/api/costeo/proyectos-disponibles');
  state.proyectosDisponibles = proyectos || [];
  return state.proyectosDisponibles;
}

let accesoCentroWidget = null;

async function populateAccesoCentroSelect() {
  const container = document.getElementById('cst-acceso-centro');
  const proyectos = await loadProyectosDisponibles();
  const opciones = proyectos.map((p) => ({ value: p.project_folder, label: p.project_name || p.project_folder }));
  // No hay "Ninguno" — no elegir nada YA significa "sin asignar todavía".
  accesoCentroWidget = crearMultiselect(container, opciones, []);
}

function renderAccesosTable() {
  const tbody = document.getElementById('cst-accesos-tbody');
  const pag = paginar('accesos', state.accesos);
  tbody.innerHTML = pag.items.map((a) => `
    <tr data-acceso-row="${a.user_id}">
      <td>${escapeHtml(a.full_name)}</td>
      <td>${a.username ? escapeHtml(a.username) : '<span class="emp-muted">—</span>'}</td>
      <td>••••••••</td>
      <td>${escapeHtml(a.email)}</td>
      <td>${(a.proyectos && a.proyectos.length)
        ? a.proyectos.map((p) => `<span class="cst-pill-centro">${escapeHtml(p.project_name || p.project_folder)}</span>`).join(' ')
        : '<span class="emp-muted">Sin asignar</span>'}</td>
      <td><span class="cst-estado-pill ${a.is_active ? 'estado-viable' : 'estado-no_viable'}">${a.is_active ? 'Activo' : 'Inactivo'}</span></td>
      <td><button type="button" class="btn-ghost" data-acceso-edit="${a.user_id}">Editar</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="emp-muted">Sin accesos de PM creados todavía.</td></tr>';
  pintarPaginacion('accesos', pag, tbody);
}

async function abrirEdicionAcceso(userId) {
  const a = state.accesos.find((x) => String(x.user_id) === String(userId));
  const row = document.querySelector(`tr[data-acceso-row="${userId}"]`);
  if (!a || !row) return;
  const proyectos = await loadProyectosDisponibles();
  const opciones = proyectos.map((p) => ({ value: p.project_folder, label: p.project_name || p.project_folder }));
  const asignados = (a.proyectos || []).map((p) => p.project_folder);

  row.innerHTML = `
    <td colspan="7">
      <form class="cst-cc-edit-form" data-acceso-edit-form="${userId}">
        <label><span>Nombre</span><input type="text" name="full_name" value="${escapeHtml(a.full_name)}" required /></label>
        <label><span>Usuario</span><input type="text" name="username" value="${escapeHtml(a.username || '')}" pattern="[a-z0-9._-]{3,50}" title="Letras, números, puntos, guiones y guion bajo (mínimo 3 caracteres)" /></label>
        <label><span>Correo</span><input type="email" name="email" value="${escapeHtml(a.email)}" required /></label>
        <label><span>Nueva contraseña (opcional)</span><input type="password" name="password" minlength="8" placeholder="Dejar vacío para no cambiarla" /></label>
        <label>
          <span>Centro(s) de Costos</span>
          <div class="cst-multiselect" data-acceso-centro-widget></div>
          <small class="cst-field-hint">Escribe para buscar y da clic para agregar. Vacío = sin asignar.</small>
        </label>
        <label><span>Estado</span>
          <select name="is_active">
            <option value="1" ${a.is_active ? 'selected' : ''}>Activo</option>
            <option value="0" ${!a.is_active ? 'selected' : ''}>Inactivo</option>
          </select>
        </label>
        <p class="emp-form-error" data-acceso-edit-error hidden></p>
        <div class="cst-cc-edit-actions">
          <button type="submit" class="btn-primary">Guardar</button>
          <button type="button" data-acceso-edit-cancel="${userId}">Cancelar</button>
        </div>
      </form>
    </td>`;

  // Se guarda en el propio nodo del form (no en una variable module-level
  // como accesoCentroWidget) porque puede haber varias filas en edición al
  // mismo tiempo — cada una necesita su propia instancia.
  const widgetContainer = row.querySelector('[data-acceso-centro-widget]');
  widgetContainer._multiselect = crearMultiselect(widgetContainer, opciones, asignados);
}

async function guardarEdicionAcceso(userId, form) {
  const errorEl = form.querySelector('[data-acceso-edit-error]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  const widgetContainer = form.querySelector('[data-acceso-centro-widget]');
  data.project_folders = widgetContainer._multiselect ? widgetContainer._multiselect.getValues() : [];
  if (!data.password) delete data.password;
  data.is_active = data.is_active === '1';
  await withBusy(submitBtn, async () => {
    try {
      await fetchJSON(`/api/costeo/accesos/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await loadAccesos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Guardando…');
}

async function loadAccesos() {
  const { accesos } = await fetchJSON('/api/costeo/accesos');
  state.accesos = accesos || [];
  renderAccesosTable();
}

function initAccesoForm() {
  const form = document.getElementById('cst-form-acceso');
  const errorEl = document.getElementById('cst-acceso-error');

  // El widget de Centro(s) de Costos guarda su selección aparte del
  // formulario, así que reset() lo deja con los chips del PM anterior — se
  // reconstruye vacío cada vez que se cierra el modal (por el botón, por
  // Escape o por el fondo).
  document.getElementById('cst-acceso-modal-overlay')
    .addEventListener('cst-modal-cerrado', () => { populateAccesoCentroSelect(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        await fetchJSON('/api/costeo/accesos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: document.getElementById('cst-acceso-nombre').value,
            username: document.getElementById('cst-acceso-username').value,
            email: document.getElementById('cst-acceso-email').value,
            password: document.getElementById('cst-acceso-password').value,
            project_folders: accesoCentroWidget ? accesoCentroWidget.getValues() : [],
          }),
        });
        // cerrarModal hace el reset() y dispara 'cst-modal-cerrado', que
        // reconstruye el widget de centros (ver abajo): form.reset() no lo
        // limpia porque no es un <select> nativo.
        cerrarModal('cst-acceso-modal-overlay');
        cstToast('Acceso creado.');
        await loadAccesos();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }, 'Creando…');
  });

  document.getElementById('cst-accesos-tbody').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-acceso-edit]');
    const cancelBtn = e.target.closest('[data-acceso-edit-cancel]');
    if (editBtn) abrirEdicionAcceso(editBtn.dataset.accesoEdit);
    else if (cancelBtn) renderAccesosTable();
  });

  document.getElementById('cst-accesos-tbody').addEventListener('submit', (e) => {
    const editForm = e.target.closest('[data-acceso-edit-form]');
    if (!editForm) return;
    e.preventDefault();
    guardarEdicionAcceso(editForm.dataset.accesoEditForm, editForm);
  });
}

// ===================== Configuración (umbrales) =====================
// Lee/escribe mp_costeo_config vía /api/costeo/config. Los mismos valores
// que ya usa el motor de cálculo (getConfigNumber en costo-common.js) —
// cambiar uno aquí se refleja de inmediato, sin reiniciar nada.

// Agrupación visual de los umbrales (2 sep 2026). Antes eran 8 tarjetas
// idénticas en una rejilla plana: nada distinguía un parámetro de jornada
// de uno que mueve dinero en todos los proyectos, y había que leer cada
// descripción para saber qué hacía cada campo. El grupo aporta color de
// acento e icono — que es lo que permite ubicar un umbral de un vistazo.
//
// Los colores salen de la paleta corporativa (styles.css): azul para lo
// operativo, amarillo para lo que dispara alertas de dinero, teal para los
// recargos de ley. `soft` es el mismo color al ~10% para fondos de chip.
const CONFIG_GRUPOS = [
  {
    titulo: 'Jornada y fórmula',
    descripcion: 'De dónde salen las horas y cuánto vale cada una.',
    icono: 'reloj', accent: 'var(--c-blue-mid)', soft: '#EDE9F7',
    keys: ['weekly_legal_hours', 'horas_mes_liquidacion'],
  },
  {
    titulo: 'Umbrales de alerta',
    descripcion: 'A partir de qué punto el sistema levanta la mano solo.',
    icono: 'campana', accent: 'var(--c-yellow)', soft: '#FFF4D6',
    keys: ['umbral_presupuesto', 'dias_antes_preventiva'],
  },
  {
    titulo: 'Recargos de ley',
    descripcion: 'Porcentajes que se suman sobre el valor hora. Cambiar uno recalcula la tabla de abajo.',
    icono: 'balanza', accent: 'var(--c-teal)', soft: '#E3F8F6',
    keys: [
      'recargo_extra_diurna_pct', 'recargo_extra_nocturna_pct',
      'recargo_nocturno_ordinario_pct', 'recargo_dominical_festivo_pct',
    ],
  },
];

const CONFIG_ICONOS = {
  weekly_legal_hours: 'cronometro',
  horas_mes_liquidacion: 'calculadora',
  umbral_presupuesto: 'dinero',
  dias_antes_preventiva: 'calendario',
  recargo_extra_diurna_pct: 'sol',
  recargo_extra_nocturna_pct: 'luna',
  recargo_nocturno_ordinario_pct: 'media_luna',
  recargo_dominical_festivo_pct: 'calendario',
};

// data-original guarda el valor con el que se pintó la tarjeta: es lo que
// compara initConfigForm() para saber si hay algo que guardar. Sin eso, el
// botón "Guardar" estaría siempre encendido y un clic de más escribiría en
// la base (y en el historial de auditoría) un cambio de X a X.
function configCardHTML(c) {
  return `
    <article class="cst-cfg-card" data-config-card="${escapeHtml(c.config_key)}">
      <div class="cst-cfg-card-head">
        <span class="cst-cfg-icon">${icono(CONFIG_ICONOS[c.config_key] || 'engranaje')}</span>
        <div class="cst-cfg-titles">
          <h4>${escapeHtml(c.label)}</h4>
          ${c.is_default ? '<span class="cst-cfg-badge">Valor por defecto</span>' : ''}
        </div>
      </div>
      <p class="cst-cfg-desc">${escapeHtml(c.description)}</p>
      <form class="cst-cfg-form" data-config-form="${escapeHtml(c.config_key)}">
        <label class="cst-cfg-field">
          <input type="number" step="0.01" min="${Number(c.min) || 0}" name="config_value"
                 value="${c.config_value}" data-original="${c.config_value}" required />
          <span class="cst-cfg-unit">${escapeHtml(c.unit)}</span>
        </label>
        <button type="submit" class="cst-cfg-save" disabled>Guardar</button>
      </form>
      <p class="emp-form-error" data-config-error="${escapeHtml(c.config_key)}" hidden></p>
    </article>`;
}

function renderConfigGrid() {
  const grid = document.getElementById('cst-config-grid');
  if (!grid) return;

  const porKey = new Map(state.config.map((c) => [c.config_key, c]));
  const usados = new Set();

  const secciones = CONFIG_GRUPOS.map((g) => {
    const cards = g.keys.map((k) => porKey.get(k)).filter(Boolean);
    for (const c of cards) usados.add(c.config_key);
    if (!cards.length) return '';
    return `
      <section class="cst-cfg-group" style="--cfg-accent: ${g.accent}; --cfg-soft: ${g.soft};">
        <div class="cst-cfg-group-head">
          <span class="cst-cfg-group-icon">${icono(g.icono)}</span>
          <div>
            <h4>${escapeHtml(g.titulo)}</h4>
            <p class="cst-cfg-group-desc">${escapeHtml(g.descripcion)}</p>
          </div>
        </div>
        <div class="cst-cfg-cards">${cards.map(configCardHTML).join('')}</div>
      </section>`;
  });

  // Cualquier umbral que el backend agregue a CONFIG_DEFS y todavía no esté
  // clasificado arriba sigue apareciendo, en vez de desaparecer en silencio
  // de la pantalla solo porque nadie actualizó CONFIG_GRUPOS.
  const sobrantes = state.config.filter((c) => !usados.has(c.config_key));
  if (sobrantes.length) {
    secciones.push(`
      <section class="cst-cfg-group" style="--cfg-accent: var(--c-purple); --cfg-soft: #F4F1FB;">
        <div class="cst-cfg-group-head">
          <span class="cst-cfg-group-icon">${icono('engranaje')}</span>
          <div>
            <h4>Otros umbrales</h4>
            <p class="cst-cfg-group-desc">Parámetros nuevos, todavía sin agrupar.</p>
          </div>
        </div>
        <div class="cst-cfg-cards">${sobrantes.map(configCardHTML).join('')}</div>
      </section>`);
  }

  grid.innerHTML = secciones.join('');
}

// Tabla de recargos de GTC, tal como la aplica el motor. Los 8 factores los
// calcula el backend (costo-recargos.js) a partir de los mismos porcentajes
// que se editan arriba, así que esta tabla no puede desincronizarse del
// cálculo real — que es justo el problema que tenía tenerlos escritos a
// mano en una hoja de cálculo aparte.
function renderTablaRecargos() {
  const cont = document.getElementById('cst-formula-nomina');
  if (!cont) return;
  const filas = state.tablaRecargos || [];
  if (!filas.length) { cont.innerHTML = ''; return; }

  // El factor se lee mejor como intensidad que como número suelto: la barra
  // y el color dicen "esta hora cuesta el doble" sin que haya que comparar
  // 2,65 contra 1,00 mentalmente. El máximo (2,65) fija la escala de la
  // barra, así que si mañana cambia un porcentaje la proporción sigue
  // siendo la real y no una escala inventada.
  const maxPct = Math.max(...filas.map((f) => f.pct), 100);
  const nivelDe = (factor) => (factor < 1.05 ? 0 : factor < 1.4 ? 1 : factor < 2 ? 2 : 3);
  const valorHora = Math.round(1750950 / (state.horasMes || 210));

  cont.innerHTML = `
    <div class="cst-module-card">
      <div class="cst-module-head">
        <span class="cst-module-icon">${icono('calculadora')}</span>
        <div>
          <span class="cst-module-eyebrow">Fórmula aplicada</span>
          <h3>Valor hora y recargos</h3>
        </div>
      </div>
      <div class="cst-module-body">
        <div class="cst-formula-callout">
          <div class="cst-formula-eq">
            <span class="cst-formula-term">salario mensual</span>
            <span class="cst-formula-op">÷</span>
            <span class="cst-formula-term is-param">${state.horasMes}</span>
            <span class="cst-formula-op">=</span>
            <span class="cst-formula-result">${formatCOP(valorHora)}<small>/hora</small></span>
          </div>
          <p class="cst-formula-ej">Ejemplo con el salario de referencia de GTC: 1.750.950 ÷ ${state.horasMes}. Sobre ese valor hora se aplica el factor del tipo de hora:</p>
        </div>
        <table class="emp-table cst-recargos-table">
          <thead><tr><th>Tipo de hora</th><th>Factor</th><th>% sobre la hora</th></tr></thead>
          <tbody>
            ${filas.map((f) => `
            <tr class="nivel-${nivelDe(f.factor)}">
              <td>${escapeHtml(f.etiqueta)}</td>
              <td><span class="cst-recargo-pill">${f.factor.toFixed(2).replace('.', ',')}</span></td>
              <td>
                <div class="cst-recargo-meter">
                  <span class="cst-recargo-track"><span class="cst-recargo-fill" style="width: ${Math.round((f.pct / maxPct) * 100)}%"></span></span>
                  <span class="cst-recargo-pct">${f.pct}%</span>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="emp-muted cst-field-hint">
          Jornada diurna 6:00 a.m.–7:00 p.m., nocturna 7:00 p.m.–6:00 a.m.
          Los recargos nocturnos solo se pueden aplicar en las horas extra que se
          registran a mano con hora de inicio y fin: el Excel trae un total por
          día, sin horario, así que por esa vía solo se distingue día hábil de
          festivo.
        </p>
      </div>
    </div>`;
}

async function loadConfig() {
  const { config, tabla_recargos, horas_mes } = await fetchJSON('/api/costeo/config');
  state.config = config || [];
  state.tablaRecargos = tabla_recargos || [];
  state.horasMes = horas_mes || 210;
  renderConfigGrid();
  renderTablaRecargos();
}

function initConfigForm() {
  const grid = document.getElementById('cst-config-grid');

  // El botón "Guardar" arranca apagado y solo se enciende cuando el valor
  // dejó de ser el que se cargó. Son 8 tarjetas en pantalla: con los ocho
  // botones encendidos a la vez, el panel entero pedía acción cuando en
  // realidad no había nada pendiente. Además evita escribir en el historial
  // de auditoría un "cambio" de X a X por un clic de más.
  grid.addEventListener('input', (e) => {
    const input = e.target.closest('[data-original]');
    if (!input) return;
    const form = input.closest('[data-config-form]');
    const sucio = input.value !== input.dataset.original;
    form.classList.toggle('is-dirty', sucio);
    form.querySelector('button[type="submit"]').disabled = !sucio;
  });

  grid.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-config-form]');
    if (!form) return;
    e.preventDefault();
    const key = form.dataset.configForm;
    const errorEl = document.querySelector(`[data-config-error="${key}"]`);
    errorEl.hidden = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    await withBusy(submitBtn, async () => {
      try {
        const value = Number(new FormData(form).get('config_value'));
        await fetchJSON(`/api/costeo/config/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config_value: value }),
        });
        await loadConfig();
        // loadConfig() repinta la rejilla entera, así que el "✓ Guardado"
        // se marca sobre la tarjeta NUEVA (la vieja ya no existe en el DOM).
        marcarConfigGuardada(key);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }, 'Guardando…');
  });
}

// Confirmación en la propia tarjeta en vez de un toast: el usuario está
// mirando el campo que acaba de cambiar, no la esquina de la pantalla.
function marcarConfigGuardada(key) {
  const card = document.querySelector(`[data-config-card="${key}"]`);
  if (!card) return;
  card.classList.add('is-saved');
  setTimeout(() => card.classList.remove('is-saved'), 2200);
}

