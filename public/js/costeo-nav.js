'use strict';

/**
 * Navegacion entre paneles y arranque de la pantalla.
 *
 * Va SIEMPRE de ultimo: aqui esta el unico codigo que se ejecuta al
 * cargar (el listener de DOMContentLoaded), y para entonces todos los
 * demas archivos ya tienen que haberse cargado.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Navegación =====================

// subtabActivo y panelActivo viven en costeo-indicadores.js (junto con
// aplicarVisibilidadFiltros, que los lee) para que las pruebas de
// componente puedan cargarlos sin arrastrar el arranque completo de este
// archivo (DOMContentLoaded).

function marcarNavActivo(target, subtab) {
  document.querySelectorAll('.cst-nav-item[data-panel]').forEach((n) => {
    const mismoPanel = n.dataset.panel === target;
    // Un botón sin data-subtab (o sin hermanos que compartan su data-panel)
    // se activa solo con el panel. Si tiene data-subtab, además debe
    // coincidir con la sub-pestaña activa.
    const necesitaSubtab = !!n.dataset.subtab;
    const coincideSubtab = !necesitaSubtab || n.dataset.subtab === subtab;
    n.classList.toggle('is-active', mismoPanel && coincideSubtab);
  });
}

// aplicarVisibilidadFiltros() y su matriz de reglas viven en
// costeo-indicadores.js (junto con filtrosQuery/PANELES_CON_FILTRO, el
// resto de la lógica de "qué filtro aplica dónde") para que las pruebas de
// componente puedan cargarlas sin arrastrar el arranque completo de este
// archivo (DOMContentLoaded).

function showPanel(target) {
  panelActivo = target;
  document.querySelectorAll('.cst-panel').forEach((panel) => {
    panel.hidden = panel.id !== `cst-panel-${target}`;
  });
  marcarNavActivo(target, subtabActivo);
  // Barra de pestañas global (#cst-tabbar): las 4 de panel se marcan acá.
  // Las 7 de Equipo y Gastos NO — de esas se encarga switchEgSubtab(), que
  // corre justo después y sabe cuál sub-pestaña quedó activa; marcarlas acá
  // también haría que el panel entero se viera activo un instante antes.
  if (target !== 'equipo-gastos') {
    document.querySelectorAll('#cst-tabbar .cst-tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.panel === target);
    });
  }
  aplicarVisibilidadFiltros(target);
  renderAvisoFiltro();
  // Actualizar header cada vez que cambias de pestaña (5.10 — barra de KPIs en todas partes)
  renderHeader();
}

function initNav() {
  document.querySelectorAll('.cst-nav-item[data-panel]').forEach((item) => {
    item.addEventListener('click', () => {
      subtabActivo = item.dataset.panel === 'equipo-gastos' ? (item.dataset.subtab || defaultEgSubtab()) : null;
      showPanel(item.dataset.panel);
      if (item.dataset.panel === 'equipo-gastos') switchEgSubtab(subtabActivo);
    });
  });

  const params = new URLSearchParams(location.search);
  const requested = params.get('panel');
  const validPanels = ['indicadores', 'alertas', 'centro-costos', 'comercial', 'equipo-gastos'];
  const target = validPanels.includes(requested) ? requested : 'indicadores';
  subtabActivo = target === 'equipo-gastos' ? (params.get('subtab') || defaultEgSubtab()) : null;
  showPanel(target);
  if (target === 'equipo-gastos') switchEgSubtab(subtabActivo);
}

function initTabs() {
  // #cst-ind-tabs (Catálogo/Panel Comparativo/Gráficos de Indicadores)
  // queda afuera: ya tiene su propio manejador scopeado en
  // initIndicadoresTabs() (costeo-indicadores.js), que además muestra/oculta
  // la vista correspondiente — este genérico solo marca is-active y no sabía
  // nada de vistas, por eso esas tres pestañas no hacían nada al hacer clic.
  //
  // #cst-tabbar queda afuera por lo mismo: initEgSubtabs() (costeo-accesos.js)
  // ya la engancha, y quien marca su botón activo son switchEgSubtab() y
  // showPanel(). Además, el barrido de abajo se limita ahora a las pestañas
  // HERMANAS (mismo .cst-tabs) en vez de a todas las de la página: con la
  // barra global viviendo fuera de los paneles, un clic en un filtro del
  // Historial le apagaba el resaltado a la pestaña de la pantalla en la que
  // estabas.
  document.querySelectorAll('.cst-tab').forEach((tab) => {
    if (tab.closest('#cst-ind-tabs') || tab.closest('#cst-tabbar')) return;
    tab.addEventListener('click', () => {
      const grupo = tab.closest('.cst-tabs') || document;
      grupo.querySelectorAll('.cst-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
    });
  });
}

async function loadUser() {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!res.ok) { window.location.href = '/login'; return; }
  state.user = (await res.json()).user;
}

// Placeholders de "Cargando X…" — se pintan de una vez, antes de pedir
// sesión o datos, para que quien entre a cualquier panel (aunque el
// portafolio todavía esté cargando) vea de inmediato qué se está cargando
// específicamente, en vez de un hueco vacío.
function pintarLoadersIniciales() {
  document.getElementById('cst-indicators-grid').innerHTML = loaderGrid('Cargando indicadores…');
  document.getElementById('cst-alertas-grid').innerHTML = loaderGrid('Cargando alertas…');
  document.getElementById('cst-cc-grid').innerHTML = loaderGrid('Cargando centros de costos…');
  document.getElementById('cst-com-tbody').innerHTML = loaderRow(7, 'Cargando comercial…');
  document.getElementById('cst-accesos-tbody').innerHTML = loaderRow(7, 'Cargando accesos…');
  document.getElementById('cst-equipo-tbody').innerHTML = loaderRow(6, 'Cargando equipo del proyecto…');
  document.getElementById('cst-tarifas-cargo-tbody').innerHTML = loaderRow(5, 'Cargando tarifas por cargo…');
  document.getElementById('cst-gastos-tbody').innerHTML = loaderRow(5, 'Cargando gastos…');
  document.getElementById('cst-overtime-tbody').innerHTML = loaderRow(9, 'Cargando horas extra…');
  document.getElementById('cst-historial-tbody').innerHTML = loaderRow(6, 'Cargando historial…');
  document.getElementById('cst-config-grid').innerHTML = loaderGrid('Cargando configuración…');
}

document.addEventListener('DOMContentLoaded', async () => {
  // Primero los iconos: el HTML estatico solo deja el hueco
  // (<span class="cst-ico" data-ico="...">) y esta funcion mete el SVG (ver
  // ICONOS en costeo-core.js). Va antes que nada para que la barra de
  // pestanas y las bandas de encabezado no se vean un instante sin icono.
  pintarIconos();
  pintarLoadersIniciales();
  await loadUser();
  initNav();
  initTabs();
  initIndicadoresTabs();
  // Antes que los init de cada formulario: es el que abre y cierra todos los
  // modales de alta (ver initModales en costeo-core.js), los demás solo
  // enganchan lo suyo encima.
  initModales();
  initCentroForm();
  initEquipoGastoForms();
  initOvertimeAddForm();
  initOvertimeTableAcciones();
  initOvertimeSesion();
  initAlertasFiltros();
  initAlertasAcciones();
  initEgSubtabs();
  initTarifasCargo();
  initHistorialFiltros();
  initMilesFormatEstaticos();
  await initFiltrosPeriodoRecurso();
  applyEgRoleView();
  initAccesoForm();
  initConfigForm();
  initExportButtons();
  initSnapshotButton();
  initSnapshotBulkbar();
  initAyudaToggle();
  initComercial();
  initSimulador();
  document.getElementById('cst-f-centro').addEventListener('change', () => {
    actualizarLogoProyecto();
    renderIndicadoresPanel();
    loadSnapshots();
    renderSimulador();
    renderAvisoFiltro();
    refiltrarTablasEquipoGastos();
    refiltrarPantallasGlobales();
    // Comercial se repinta desde state.comercial, que ya trae TODOS los
    // proyectos — recortarlo es filtrar en memoria, no hace falta volver a
    // pedirlo al servidor. Entró aquí el 10 sep 2026, cuando este selector
    // pasó a ser el de Comercial también (antes ese panel tenía el suyo).
    // El guard es por si el filtro se toca antes de que llegue la primera
    // carga: renderComercial() lee state.comercial.proyectos sin comprobar.
    if (state.comercial) renderComercial();
  });

  // Guardar snapshot escribe en la base de datos — mismo criterio que el
  // resto de acciones de escritura de Costeo (solo admin/ceo).
  if (!(state.user && (state.user.role === 'admin' || state.user.role === 'ceo'))) {
    document.getElementById('cst-snapshot-save').hidden = true;
  }

  // Antes esto era una cadena de ~14 await secuenciales: cada petición
  // esperaba a que terminara la anterior aunque no dependieran entre sí, así
  // que la carga inicial completa podía tardar varios segundos. Cada panel
  // ya arrancó con su propio "Cargando X…" (pintarLoadersIniciales, arriba)
  // así que no hace falta bloquear nada mientras esto corre.
  //
  // loadIndicadores() y loadAlertas() son las dos peticiones caras de la
  // pantalla (~2,4s cada una: recorren los 17 indicadores de todos los
  // centros contra la base remota). Iban una DESPUÉS de la otra, así que
  // abrir Costeo costaba la suma de ambas — medido el 9 sep 2026 contra
  // producción: 1657ms + 2708ms ≈ 4,4s, y se pagaban enteros cada vez que se
  // volvía de Planeación (es otra página: el navegador recarga todo).
  //
  // Ahora salen juntas. Lo que las mantenía en fila era el ORDEN de lo que
  // viene después, y eso se respeta igual esperando a las dos:
  //   - populateEquipoGastoCentroSelect() necesita state.centros (loadIndicadores).
  //   - renderCentroCostosPanel() lee state.alertas.length para la tarjeta
  //     "Alertas" del resumen; si arrancara antes de loadAlertas() mostraría
  //     0 y nada la volvería a pintar.
  // Del lado del servidor las dos piden el mismo cálculo de indicadores y la
  // segunda se cuelga del que ya está corriendo, sin repetirlo
  // (src/lib/shared-cache.js).
  {
    await Promise.all([loadIndicadores(), loadAlertas()]);
    populateEquipoGastoCentroSelect();

    const tareas = [
      loadSnapshots(),
      renderCentroCostosPanel(),
      loadEmployeesOptions(),
      loadEquipoYGastos(),
      loadTarifasCargo(),
      loadOvertime(),
      loadHistorial(),
      loadComercial(),
    ];
    if (state.user && (state.user.role === 'admin' || state.user.role === 'ceo')) {
      tareas.push(populateAccesoCentroSelect(), loadAccesos(), loadConfig());
    }
    await Promise.all(tareas);
  }
});

