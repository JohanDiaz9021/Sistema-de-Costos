'use strict';

/**
 * Panel de Indicadores y los filtros de Periodo / Recurso.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual
 * que antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Indicadores =====================

function currentView() {
  const select = document.getElementById('cst-f-centro');
  const selectedId = select ? select.value : '';
  if (!selectedId) return state.totales;
  return state.porCentro.find((c) => String(c.cost_center_id) === selectedId) || state.totales;
}

function renderHeader() {
  const view = currentView();
  document.getElementById('cst-kpi-presupuesto').textContent = formatCOP(view?.presupuesto ?? view?.budget);
  document.getElementById('cst-kpi-ejecutado').textContent = formatCOP(view?.ejecutado_total);

  // KPIs de alertas y riesgo (cálculos directos de la BD). Mientras
  // alertasListas siga en false (loadAlertas() todavía no respondió), se
  // deja el "—" del HTML en vez de pintar "0": state.alertas arranca como
  // arreglo vacío y sin este chequeo esta tarjeta miente por unos segundos
  // (dice "0 alertas" aunque en realidad haya 14, hasta que llega la
  // respuesta real) cada vez que se recarga la página completa (entrar y
  // salir de Planeación, que sí es una navegación real y no un cambio de
  // panel dentro de Costeo).
  if (state.alertasListas) {
    document.getElementById('cst-kpi-alertas').textContent = String(state.alertas.length);
    const criticas = state.alertas.filter((a) => a.severidad === 'critica').length;
    document.getElementById('cst-kpi-riesgo').textContent = String(criticas);
  }

  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  document.getElementById('cst-btn-nuevo-centro').hidden = !isAdmin;
}

// Proyectos en riesgo: mismo criterio que el resto de esta pantalla
// (currentIndicadores17) — con un proyecto elegido en el filtro global,
// muestra el dato de ESE proyecto (0 o 1, no un conteo); con "Todos", cuenta
// sobre state.indicadores17 (las filas reales por proyecto — portafolio17 es
// un solo objeto ya sumado, no sirve para contar CUÁNTOS proyectos están en
// riesgo). Separada de renderSummary() porque esta última tiene un `return`
// temprano cuando el proyecto/portafolio no tiene presupuesto cargado (para
// el % de ejecución) — si este cálculo viviera después de ese return, un
// portafolio sin presupuesto (pasa seguido: basta con que UN centro no
// tenga budget) dejaba esta tarjeta sin actualizar aunque sí hubiera datos
// para calcularla.
//
// "Trabajo no remunerado (empresa)" vivió aquí un momento (4 sep 2026) y se
// retiró a pedido explícito — ya no está en el catálogo de abajo tampoco
// (mismo pedido), solo sigue calculándose por dentro porque la alerta
// "Trabajo no remunerado" (costo-alertas.js) todavía depende de ese dato.
function renderResumenRiesgo() {
  const riesgoEl = document.getElementById('cst-sum-riesgo');
  const riesgoSubEl = document.getElementById('cst-sum-riesgo-sub');
  const centroSeleccionado = document.getElementById('cst-f-centro')?.value;

  if (centroSeleccionado) {
    const ind17 = currentIndicadores17();
    const enRiesgo = !!ind17?.ind4_se_queda_sin_plata_antes;
    riesgoEl.textContent = enRiesgo ? '1' : '0';
    riesgoSubEl.textContent = enRiesgo
      ? 'Este proyecto se quedaría sin presupuesto antes de la fecha fin planeada.'
      : 'Este proyecto no está en riesgo, al ritmo de gasto actual.';
  } else {
    const proyectos = state.indicadores17 || [];
    const enRiesgo = proyectos.filter((i) => i.ind4_se_queda_sin_plata_antes).length;
    riesgoEl.textContent = String(enRiesgo);
    riesgoSubEl.textContent = proyectos.length
      ? `de ${proyectos.length} proyecto(s) activos`
      : 'Sin datos aún.';
  }
}

function renderSummary() {
  renderResumenRiesgo();

  const view = currentView();
  const presupuesto = view?.presupuesto ?? view?.budget ?? 0;
  const ejecutado = view?.ejecutado_total ?? 0;

  const pctEl = document.getElementById('cst-sum-ejecutado-pct');
  const subEl = document.getElementById('cst-sum-ejecutado-sub');
  pctEl.classList.remove('is-warning');

  if (presupuesto <= 0) {
    // No es "0%": es que a este proyecto todavía no le han cargado
    // presupuesto. Mostrar "0%" ahí sugeriría que no se ha gastado nada,
    // cuando puede que sí haya ejecutado y solo falte el dato de referencia.
    pctEl.textContent = 'Sin presupuesto';
    pctEl.classList.add('is-warning');
    subEl.textContent = ejecutado > 0
      ? `${formatCOP(ejecutado)} ejecutado, pero no hay presupuesto registrado para calcular el %.`
      : 'Sin presupuesto registrado.';
    return;
  }

  const pct = Math.round((ejecutado / presupuesto) * 100);
  pctEl.textContent = `${pct.toLocaleString('es-CO')}%`;
  subEl.textContent = `${formatCOP(ejecutado)} de ${formatCOP(presupuesto)}`;

  // Viendo el agregado de varios proyectos: si algunos todavía no tienen
  // presupuesto cargado, el % compara TODO lo ejecutado contra el
  // presupuesto de solo los que sí lo tienen — sale inflado sin que sea un
  // error de cálculo. Se avisa en vez de esconder el número.
  const centroSeleccionado = document.getElementById('cst-f-centro')?.value;
  if (!centroSeleccionado) {
    const sinPresupuesto = state.porCentro.filter((c) => !(Number(c.budget) > 0));
    if (sinPresupuesto.length > 0) {
      pctEl.classList.add('is-warning');
      subEl.textContent += ` — ⚠ ${sinPresupuesto.length} de ${state.porCentro.length} proyecto(s) sin presupuesto registrado todavía, así que este % no es representativo hasta que se completen.`;
    }
  }
}

function currentIndicadores17() {
  const select = document.getElementById('cst-f-centro');
  const selectedId = select ? select.value : '';
  if (selectedId) return state.indicadores17.find((i) => String(i.cost_center_id) === selectedId) || null;
  return state.portafolio17;
}

function renderIndicators() {
  const grid = document.getElementById('cst-indicators-grid');
  const select = document.getElementById('cst-f-centro');
  const ind17 = currentIndicadores17();

  if (!ind17) {
    grid.innerHTML = `<p class="emp-muted">Sin centros de costos todavía.</p>`;
    return;
  }

  grid.innerHTML = INDICATOR_DEFS.map((ind) => `
    <article class="cst-ind-card status-ok" data-ind="${ind.num}">
      <div class="cst-ind-head">
        <h4>${ind.name}</h4>
        <span class="cst-ind-help" tabindex="0" role="note" aria-label="${ind.help.replace(/"/g, '&quot;')}">
          ?
          <span class="cst-ind-tooltip">${ind.help}</span>
        </span>
        <span class="cst-ind-num">#${ind.num}</span>
      </div>
      <p class="cst-ind-desc">${ind.desc}</p>
      <div class="cst-ind-value">${ind.value(ind17)}</div>
    </article>
  `).join('');
}

// Logo por proyecto: al elegir uno en el filtro del encabezado, el logo de
// la izquierda pasa a ser el suyo; los que todavía no tienen el propio se
// quedan con el de GTC.
//
// El mapa es explícito, no derivado del nombre del archivo, por dos
// razones: los logos llegan como los entrega diseño (con espacios, tildes y
// paréntesis en el nombre) y el proyecto no siempre se llama igual que su
// logo ("SUECO CRM" usa el logo "SUECO"). Para sumar uno nuevo: dejar el
// archivo en public/img y agregar una línea aquí.
const LOGO_GTC = '/img/logo_gtc.png';
const LOGOS_POR_PROYECTO = {
  mia: '/img/LOGO MIA_SUECO_Sinfondo.png',
  suecocrm: '/img/LOGO SUECO_ÚLTIMA VERSIÓN (2).png',
  sescol: '/img/Propuestas sescol_editable-01.png',
  gtcproject: '/img/Logo editable GTC Project_Sinfondo.png',
  documentonline: '/img/Document_1.png',
};

// Misma normalización que usa el backend para cruzar nombres de proyecto
// (ver normalizarTexto en costo-task-facts-upload.js): sin ella, "SUECO CRM"
// y "Sueco CRM" serían claves distintas.
function claveProyecto(v) {
  return String(v ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function actualizarLogoProyecto() {
  const img = document.querySelector('.cst-header-left .brand-logo');
  const select = document.getElementById('cst-f-centro');
  if (!img || !select) return;

  const nombre = select.options[select.selectedIndex]?.text || '';
  const logo = LOGOS_POR_PROYECTO[claveProyecto(nombre)] || LOGO_GTC;
  // encodeURI y no la ruta cruda: los nombres traen espacios y tildes, que
  // en un src sin codificar no resuelven en todos los navegadores.
  const src = encodeURI(logo);
  if (img.getAttribute('src') === src) return;

  // Si el archivo no está (lo borraron, o el mapa quedó apuntando a un
  // nombre viejo), se cae al de GTC en vez de dejar el icono de imagen
  // rota. Se reengancha en cada cambio porque onerror se dispara una sola
  // vez por src.
  img.onerror = () => { img.onerror = null; img.src = LOGO_GTC; img.alt = 'GTC Corporation'; };
  img.src = src;
  img.alt = logo === LOGO_GTC ? 'GTC Corporation' : nombre.trim();
}

function populateCentroFilter() {
  const select = document.getElementById('cst-f-centro');
  const current = select.value;
  // "Todos los proyectos" y no "Todos": este selector vive en el encabezado
  // desde el 10 sep 2026 y su etiqueta es "Proyecto" — un "Todos" suelto
  // ahí arriba no dice de qué.
  select.innerHTML = '<option value="">Todos los proyectos</option>' + state.centros
    .map((c) => `<option value="${c.cost_center_id}">${escapeHtml(c.project_name)}</option>`)
    .join('');
  select.value = current;
  actualizarLogoProyecto();
}

function renderIndicadoresPanel() {
  renderHeader();
  renderSummary();
  renderIndicators();
  // Las otras dos vistas (Panel Comparativo / Gráficos) solo se recalculan
  // si son la que se está viendo — no hace falta recalcular lo que no se
  // está mostrando.
  if (vistaIndicadoresActiva === 'comparativo') renderComparativo();
  if (vistaIndicadoresActiva === 'graficos') renderGraficos();
}

// ===================== Subpestañas de Indicadores =====================
// Catálogo de Indicadores / Panel Comparativo / Gráficos. Antes las tres
// pestañas existían en el HTML pero no hacían nada al hacer clic (initTabs()
// en costeo-nav.js solo marcaba is-active, sin saber mostrar/ocultar nada) —
// "Otras Vistas" se quitó del todo porque no tenía contenido previsto.

let vistaIndicadoresActiva = 'catalogo';

function initIndicadoresTabs() {
  const nav = document.getElementById('cst-ind-tabs');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.cst-tab');
    if (!btn) return;
    nav.querySelectorAll('.cst-tab').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');

    vistaIndicadoresActiva = btn.dataset.view;
    document.querySelectorAll('#cst-panel-indicadores .cst-ind-view').forEach((v) => {
      v.hidden = v.id !== `cst-ind-view-${vistaIndicadoresActiva}`;
    });

    if (vistaIndicadoresActiva === 'comparativo') renderComparativo();
    if (vistaIndicadoresActiva === 'graficos') renderGraficos();
  });

  // El viewBox de los gráficos SVG se mide en píxeles reales al dibujarlos
  // (ver medidasSvg): si el ancho disponible cambia después — se colapsa el
  // sidebar, se cambia el tamaño de la ventana — hay que volver a medir y
  // regenerar el SVG, si no queda con el tamaño de cuando se dibujó la
  // primera vez. ResizeObserver (no el evento 'resize' de window) porque
  // colapsar el sidebar cambia el layout sin cambiar el tamaño de la
  // ventana.
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    const redibujar = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (vistaIndicadoresActiva === 'comparativo') renderComparativo();
        else if (vistaIndicadoresActiva === 'graficos') renderGraficos();
      });
    };
    const ro = new ResizeObserver(redibujar);
    ['cst-comp-svg-linea', 'cst-comp-svg-barras', 'cst-graf-semanal'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    });
  }
}

// ===================== Panel Comparativo =====================
// Costo laboral y horas extra semana a semana del proyecto elegido en el
// filtro global "Centro de Costos" (o del portafolio si no hay ninguno
// elegido) — mismos datos que ya usan los indicadores #5/#16/#17, pero como
// serie en vez de reducidos a un solo número (ver serie_semanal en
// src/queries/costo-indicadores-17.js).
//
// A pedido explícito se le agregaron 3 tarjetas resumen + dos gráficos SVG
// (línea de costo laboral, barras de horas extra) arriba de la tabla — antes
// era solo una tabla, muy plano para algo que se llama "Panel Comparativo".

function renderComparativo() {
  const tbody = document.getElementById('cst-comp-tbody');
  const subt = document.getElementById('cst-comp-subtitulo');
  const kpis = document.getElementById('cst-comp-kpis');
  const lineaWrap = document.getElementById('cst-comp-svg-linea');
  const barrasWrap = document.getElementById('cst-comp-svg-barras');
  if (!tbody) return;

  const ind17 = currentIndicadores17();
  const select = document.getElementById('cst-f-centro');
  const nombreVista = select && select.value ? (ind17?.project_name || '') : 'todos los proyectos activos';
  if (subt) subt.textContent = `Costo laboral y horas extra por semana — ${escapeHtml(nombreVista)}.`;

  const serie = (ind17 && ind17.serie_semanal) || [];

  if (!serie.length) {
    if (kpis) kpis.innerHTML = '';
    if (lineaWrap) lineaWrap.innerHTML = '<p class="emp-muted">Sin semanas con datos todavía.</p>';
    if (barrasWrap) barrasWrap.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="4" class="emp-muted">Sin semanas con datos todavía.</td></tr>';
    return;
  }

  // --- 3 tarjetas resumen ---
  if (kpis) {
    const costos = serie.map((s) => s.costo_laboral);
    const promedio = costos.reduce((a, b) => a + b, 0) / costos.length;
    const maxEntry = serie.reduce((m, s) => (s.costo_laboral > m.costo_laboral ? s : m), serie[0]);
    const primero = serie[0].costo_laboral;
    const ultimo = serie[serie.length - 1].costo_laboral;
    let tendenciaHtml = '<span class="cst-tc-meta">—</span>';
    if (serie.length > 1 && primero > 0) {
      const pct = ((ultimo - primero) / primero) * 100;
      const clase = pct > 0 ? 'cst-value-red' : pct < 0 ? 'cst-value-green' : '';
      const flecha = pct > 0 ? '▲' : pct < 0 ? '▼' : '→';
      tendenciaHtml = `<span class="${clase}">${flecha} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
    }
    kpis.innerHTML = `
      <div class="cst-comp-kpi">
        <span class="cst-comp-kpi-label">Promedio semanal</span>
        <span class="cst-comp-kpi-value">${formatCOP(promedio)}</span>
      </div>
      <div class="cst-comp-kpi">
        <span class="cst-comp-kpi-label">Semana con mayor costo</span>
        <span class="cst-comp-kpi-value">${formatCOP(maxEntry.costo_laboral)}</span>
        <span class="cst-comp-kpi-sub">${etiquetaSemana(maxEntry)}</span>
      </div>
      <div class="cst-comp-kpi">
        <span class="cst-comp-kpi-label">Tendencia (primera vs. última semana)</span>
        <span class="cst-comp-kpi-value">${tendenciaHtml}</span>
      </div>`;
  }

  // --- Gráfico de línea: costo laboral ---
  if (lineaWrap) {
    const { anchoPx, altoPx } = medidasSvg(lineaWrap, 600, 210);
    lineaWrap.innerHTML = svgLinea(
      serie.map((s) => ({ etiqueta: etiquetaSemanaCorta(s), valor: s.costo_laboral, titulo: `${etiquetaSemana(s)}: ${formatCOP(s.costo_laboral)}` })),
      { anchoPx, altoPx, formatearEje: formatCOPCompacto, formatearEtiqueta: formatCOP }
    );
  }

  // --- Gráfico de barras: horas extra ---
  if (barrasWrap) {
    const { anchoPx, altoPx } = medidasSvg(barrasWrap, 600, 210);
    barrasWrap.innerHTML = svgBarrasVerticales(
      serie.map((s) => ({ etiqueta: etiquetaSemanaCorta(s), valor: Number(s.horas_extra), titulo: `${etiquetaSemana(s)}: ${Number(s.horas_extra).toFixed(1)} h extra` })),
      { anchoPx, altoPx, sufijo: 'h', color: '#FFC107', formatearEje: (v) => `${v.toFixed(1)}h` }
    );
  }

  // --- Tabla de detalle ---
  tbody.innerHTML = serie.map((s, i) => {
    const anterior = i > 0 ? serie[i - 1].costo_laboral : null;
    let variacion = '<span class="cst-tc-meta">—</span>';
    if (anterior !== null && anterior > 0) {
      const pct = ((s.costo_laboral - anterior) / anterior) * 100;
      const clase = pct > 0 ? 'cst-value-red' : pct < 0 ? 'cst-value-green' : '';
      variacion = `<span class="${clase}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
    } else if (anterior === 0 && s.costo_laboral > 0) {
      variacion = '<span class="cst-value-red">nueva actividad</span>';
    }
    return `<tr>
      <td>${etiquetaSemana(s)}</td>
      <td>${formatCOP(s.costo_laboral)}</td>
      <td>${variacion}</td>
      <td>${Number(s.horas_extra).toFixed(1)} h</td>
    </tr>`;
  }).join('');
}

// "$1.2M" / "$450K" en vez de "$ 1.200.000" — para el eje de los gráficos
// SVG, donde el número completo no cabe sin encimarse con la grilla.
function formatCOPCompacto(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

// La serie semanal viene con `month` desde el 17 sep 2026 (bug de
// weekKey: la semana es DEL MES, y una clave año*100+semana mezclaba
// enero-s3 con febrero-s3). Antes el front pintaba "2026 · Semana 3",
// que era justo el dato que no alcanzaba a distinguirlos.
// MESES_CORTOS vive en costeo-core.js (lo carga costeo.html antes); aquí
// solo se agrega la variante larga, porque la etiqueta de semana es el
// único sitio donde el mes completo entra sin romper la línea.
const MESES_LARGOS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function mesLargo(n) { return MESES_LARGOS[(Number(n) || 0) - 1] || ''; }
function mesCorto(n) { return MESES_CORTOS[(Number(n) || 0) - 1] || ''; }

// "Agosto · Semana 2 · 2026". Sin `month` (datos viejos en cache o pruebas)
// cae de forma natural a "Semana 2 · 2026", igual que antes.
function etiquetaSemana(s) {
  const mes = s && s.month ? `${mesLargo(s.month)} · ` : '';
  const sem = `Semana ${s && s.week}`;
  const anio = s && s.year ? ` · ${s.year}` : '';
  return `${mes}${sem}${anio}`;
}

// Etiqueta corta para el eje de los gráficos: "Ago·S2" en vez de solo "S2".
function etiquetaSemanaCorta(s) {
  return s && s.month ? `${mesCorto(s.month)}·S${s.week}` : `S${s && s.week}`;
}

// ===================== Gráficos: helpers SVG compartidos =====================
// Sin librería externa (ECharts por CDN se quedaba en blanco sin ningún
// error cuando la red lo bloqueaba — caso real reportado): un <svg> escrito
// a mano con viewBox siempre renderiza y escala solo, sin JS de resize.

// Mide el contenedor REAL en píxeles (getBoundingClientRect, no clientWidth:
// da decimales, que es lo que necesita un viewBox para que 1 unidad = 1
// píxel exacto) para usarlo como viewBox — si el viewBox no coincide con el
// tamaño real, el navegador estira de forma NO uniforme y deforma las
// letras (se veían "raras", como estiradas; caso real reportado). Con
// fallback: en jsdom (pruebas) o con la pestaña todavía oculta el elemento
// mide 0x0, así que se usa un tamaño razonable en su lugar.
function medidasSvg(el, anchoDefault, altoDefault) {
  if (!el) return { anchoPx: anchoDefault, altoPx: altoDefault };
  const rect = el.getBoundingClientRect();
  return {
    anchoPx: rect.width > 0 ? rect.width : anchoDefault,
    altoPx: rect.height > 0 ? rect.height : altoDefault,
  };
}

// 4 líneas de referencia horizontales + su etiqueta ($ o número, según
// `formatearEje`) — sin esto un gráfico solo con la línea/barras "flota" en
// blanco y no se puede leer qué tan alto es un valor sin pasar el mouse.
function gridHorizontal({ padI, ancho, padD, padArriba, areaAlto, min, max, formatearEje }) {
  const DIVISIONES = 4;
  let lineas = '';
  let etiquetas = '';
  for (let i = 0; i <= DIVISIONES; i++) {
    const frac = i / DIVISIONES;
    const y = padArriba + areaAlto - frac * areaAlto;
    const valor = min + frac * (max - min);
    lineas += `<line x1="${padI}" y1="${y.toFixed(1)}" x2="${ancho - padD}" y2="${y.toFixed(1)}" stroke="#E3E4F2" stroke-width="1"></line>`;
    etiquetas += `<text x="${(padI - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="9" fill="#565656" text-anchor="end">${escapeHtml(formatearEje(valor))}</text>`;
  }
  return lineas + etiquetas;
}

function svgLinea(puntos, { anchoPx = 600, altoPx = 210, formatearEje = (v) => String(Math.round(v)), formatearEtiqueta } = {}) {
  if (!puntos.length) return '<p class="emp-muted">Sin datos.</p>';
  // El viewBox usa el tamaño REAL en píxeles del contenedor (medido por
  // quien llama, con getBoundingClientRect — ver renderComparativo() /
  // renderGraficos()), no un ancho inventado: así 1 unidad SVG = 1 píxel
  // en los dos ejes y el navegador no tiene que estirar de forma NO
  // uniforme para llenar el contenedor — eso era lo que deformaba las
  // letras (se veían "raras", como estiradas) en la versión anterior.
  const ancho = anchoPx, alto = altoPx;
  // padArriba más grande que el resto de márgenes a propósito: es donde
  // vive la etiqueta de valor de cada punto (se dibuja ARRIBA del punto),
  // así que necesita más aire que abajo/los lados o se encima con la
  // grilla del eje — eso fue justo lo que se vio "raro" en la captura.
  const padI = 44, padD = 44, padArriba = 34, padAbajo = 24;
  const valores = puntos.map((p) => p.valor);
  const max = Math.max(...valores, 0);
  const min = Math.min(...valores, 0);
  const rango = max - min || 1;
  const areaAlto = alto - padArriba - padAbajo;
  const areaAncho = ancho - padI - padD;
  const stepX = puntos.length > 1 ? areaAncho / (puntos.length - 1) : 0;
  const y = (v) => padArriba + areaAlto - ((v - min) / rango) * areaAlto;
  const xy = puntos.map((p, i) => [padI + i * stepX, y(p.valor)]);

  const grid = gridHorizontal({ padI, ancho, padD, padArriba, areaAlto, min, max, formatearEje });
  const path = xy.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const base = padArriba + areaAlto;
  const area = `${path} L${xy[xy.length - 1][0].toFixed(1)},${base} L${xy[0][0].toFixed(1)},${base} Z`;
  const eje = `<line x1="${padI}" y1="${base.toFixed(1)}" x2="${ancho - padD}" y2="${base.toFixed(1)}" stroke="#B9BCDC" stroke-width="1.5"></line>`;

  // Con pocos puntos (el caso normal: semanas con datos) se puede etiquetar
  // cada uno con su valor sin que se encimen; con muchos, mejor solo dejar
  // el tooltip (<title>) para no saturar.
  const conValores = puntos.length <= 8;
  const fmtVal = formatearEtiqueta || formatearEje;
  const circulos = xy.map(([px, py], i) => {
    // El primer y el último punto anclan su etiqueta hacia adentro (no
    // centrada) — si no, el texto se sale del área visible: a la izquierda
    // se encima con los números del eje, a la derecha queda cortado por el
    // borde del SVG.
    const anchor = i === 0 ? 'start' : i === xy.length - 1 ? 'end' : 'middle';
    // anchor="start" dibuja el texto hacia la DERECHA de x (alejándolo de
    // los números del eje); anchor="end" lo dibuja hacia la IZQUIERDA
    // (alejándolo del borde derecho) — el offset empuja un poco más en esa
    // misma dirección para dejar aire entre el punto y el texto.
    const offsetX = i === 0 ? 6 : i === xy.length - 1 ? -6 : 0;
    return `
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="#fff" stroke="#39D4CC" stroke-width="2.5"><title>${escapeHtml(puntos[i].titulo || String(puntos[i].valor))}</title></circle>
    ${conValores ? `<text x="${(px + offsetX).toFixed(1)}" y="${(py - 11).toFixed(1)}" font-size="9.5" font-weight="700" fill="#000000" text-anchor="${anchor}">${escapeHtml(fmtVal(puntos[i].valor))}</text>` : ''}`;
  }).join('');

  const salto = puntos.length > 10 ? Math.ceil(puntos.length / 8) : 1;
  const etiquetasX = xy.map(([px], i) => (i % salto === 0
    ? `<text x="${px.toFixed(1)}" y="${alto - 6}" font-size="9" fill="#565656" text-anchor="middle">${escapeHtml(puntos[i].etiqueta)}</text>`
    : '')).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" class="cst-graf-svg">
    ${grid}
    <path d="${area}" fill="rgba(57, 212, 204,.15)" stroke="none"></path>
    <path d="${path}" fill="none" stroke="#39D4CC" stroke-width="2.5"></path>
    ${eje}
    ${circulos}
    ${etiquetasX}
  </svg>`;
}

function svgBarrasVerticales(puntos, { anchoPx = 600, altoPx = 210, color = '#39D4CC', sufijo = '', formatearEje } = {}) {
  if (!puntos.length) return '<p class="emp-muted">Sin datos.</p>';
  const ancho = anchoPx, alto = altoPx;
  const padI = 34, padD = 12, padArriba = 30, padAbajo = 24;
  const max = Math.max(...puntos.map((p) => p.valor), 1);
  const min = 0;
  const areaAlto = alto - padArriba - padAbajo;
  const areaAncho = ancho - padI - padD;
  const anchoBarra = Math.min(40, (areaAncho / puntos.length) * 0.55);
  const paso = areaAncho / puntos.length;
  const fmtEje = formatearEje || ((v) => `${Math.round(v)}${sufijo}`);

  const grid = gridHorizontal({ padI, ancho, padD, padArriba, areaAlto, min, max, formatearEje: fmtEje });
  const base = padArriba + areaAlto;
  const eje = `<line x1="${padI}" y1="${base.toFixed(1)}" x2="${ancho - padD}" y2="${base.toFixed(1)}" stroke="#B9BCDC" stroke-width="1.5"></line>`;

  const barras = puntos.map((p, i) => {
    const h = max > 0 ? (p.valor / max) * areaAlto : 0;
    const x = padI + i * paso + (paso - anchoBarra) / 2;
    const y = padArriba + areaAlto - h;
    const etiquetaValor = p.valor > 0
      ? `<text x="${(x + anchoBarra / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="9.5" font-weight="700" fill="#000000" text-anchor="middle">${escapeHtml(fmtEje(p.valor))}</text>`
      : '';
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${anchoBarra.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}"><title>${escapeHtml(p.titulo || `${p.valor}${sufijo}`)}</title></rect>
      ${etiquetaValor}`;
  }).join('');

  const salto = puntos.length > 10 ? Math.ceil(puntos.length / 8) : 1;
  const etiquetasX = puntos.map((p, i) => (i % salto === 0
    ? `<text x="${(padI + i * paso + paso / 2).toFixed(1)}" y="${alto - 6}" font-size="9" fill="#565656" text-anchor="middle">${escapeHtml(p.etiqueta)}</text>`
    : '')).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" class="cst-graf-svg">
    ${grid}
    ${barras}
    ${eje}
    ${etiquetasX}
  </svg>`;
}

// Barra horizontal comparando el MISMO indicador entre proyectos — es lo que
// convierte a un valor sin escala natural (dinero, conteo) en un gráfico de
// verdad: no dice "62%" de la nada, dice "más que estos, menos que aquellos".
// Resalta con un borde el proyecto actualmente elegido en el filtro global.
function svgBarrasHorizontalesProyectos(filas, { formatear, colorDestacado = '#39D4CC', colorNormal = '#B9BCDC' } = {}) {
  if (!filas.length) return '<p class="emp-muted">Sin proyectos con datos.</p>';
  const max = Math.max(...filas.map((f) => f.valor), 1);
  return filas.map((f) => `
    <div class="cst-graf-barra-fila${f.destacado ? ' is-destacado' : ''}">
      <span class="cst-graf-barra-nombre" title="${escapeHtml(f.nombre)}">${escapeHtml(f.nombre)}</span>
      <div class="cst-graf-barra-track">
        <div class="cst-graf-barra-fill" style="width:${Math.max(2, (f.valor / max) * 100).toFixed(1)}%; background:${f.destacado ? colorDestacado : colorNormal};"></div>
      </div>
      <span class="cst-graf-barra-valor">${formatear(f.valor)}</span>
    </div>`).join('');
}

// ===================== Gráficos: un gráfico por indicador =====================
// Los que son porcentaje se pintan como velocímetro CSS (número grande al
// centro, sin ejes que leer). Los que no tienen 0-100% natural (dinero,
// conteos: #5,#6,#7) se comparan contra los DEMÁS proyectos en una
// barra horizontal — sigue siendo un gráfico real, no un número suelto.
// #4 (fecha) no es comparable entre proyectos de forma legible en una
// barra, así que queda como tarjeta destacada con ícono.
//
// No se colorea "verde=bueno / rojo=malo" por indicador: cuál dirección es
// buena cambia según el indicador y acertar mal el color sería peor que no
// colorear — se deja un solo color neutro consistente en los velocímetros
// y en las barras comparativas.

// num -> { min, max } para el velocímetro. El signado (#3) usa un rango
// angosto centrado en 0 porque en la práctica rara vez pasa de ±50
// puntos — un rango de -100..100 dejaría el arco casi sin moverse.
const GAUGE_INDICADORES = {
  1: { min: 0, max: 100 },
  2: { min: 0, max: 100 },
  3: { min: -50, max: 50 },
  8: { min: 0, max: 100 },
};

// num -> campo en el objeto de indicadores, para las barras comparativas
// entre proyectos (money/conteo).
const BARRA_PROYECTOS_INDICADORES = {
  5: { campo: 'ind5_ritmo_gasto_semanal', formatear: (v) => formatCOP(v) },
  6: { campo: 'ind7_personas_trabajando', formatear: (v) => `${v}` },
  7: { campo: 'ind8_costo_real_por_hora', formatear: (v) => formatCOP(v) },
};

function valorNumericoIndicador(num, ind17) {
  const CAMPOS = {
    1: 'ind1_presupuesto_ejecutado_pct', 2: 'ind2_tiempo_transcurrido_pct',
    3: 'ind3_ritmo_gasto_vs_tiempo',
    8: 'ind9_proporcion_horas_extra_pct',
  };
  const campo = CAMPOS[num];
  return campo ? ind17[campo] : null;
}

// Velocímetro con conic-gradient (CSS puro): el % se pasa como variable
// custom (--pct, 0-100) y el color como --color; ver .cst-gauge-donut en
// costeo.css. clamp() adentro del propio valor por si un indicador se sale
// del rango declarado.
function gaugeHtml(valor, { min, max }) {
  const sinDatos = valor === null || valor === undefined || !Number.isFinite(Number(valor));
  const v = sinDatos ? min : Math.max(min, Math.min(max, Number(valor)));
  const pct = ((v - min) / (max - min)) * 100;
  const texto = sinDatos ? 'Sin datos' : `${v >= 0 && min < 0 ? '+' : ''}${v.toFixed(1)}%`;
  return `<div class="cst-gauge-donut${sinDatos ? ' is-sin-datos' : ''}" style="--pct:${pct.toFixed(1)};">
    <span>${texto}</span>
  </div>`;
}

function renderGraficos() {
  const grid = document.getElementById('cst-graf-grid');
  const subt = document.getElementById('cst-graf-subtitulo');
  if (!grid) return;

  const ind17 = currentIndicadores17();
  const select = document.getElementById('cst-f-centro');
  const centroSeleccionado = select ? select.value : '';
  if (subt) {
    subt.textContent = centroSeleccionado
      ? `Detalle de "${ind17?.project_name || ''}". Las barras comparativas siguen mostrando TODOS los proyectos, con el tuyo resaltado.`
      : 'Agregado de todos los proyectos activos.';
  }
  if (!ind17) {
    grid.innerHTML = '<p class="emp-muted">Sin centros de costos todavía.</p>';
    return;
  }

  const proyectos = state.indicadores17 || [];

  // El grid se reconstruye completo cada vez (cambia de proyecto/mes con el
  // filtro global) — es más simple que llevar el registro de qué tarjeta ya
  // existe, y 17 tarjetas no pesan nada de recrear (son CSS/SVG, no
  // instancias de una librería que haya que destruir primero).
  grid.innerHTML = INDICATOR_DEFS.map((def) => {
    let cuerpo;
    if (Object.prototype.hasOwnProperty.call(GAUGE_INDICADORES, def.num)) {
      cuerpo = gaugeHtml(valorNumericoIndicador(def.num, ind17), GAUGE_INDICADORES[def.num]);
    } else if (Object.prototype.hasOwnProperty.call(BARRA_PROYECTOS_INDICADORES, def.num)) {
      const { campo, formatear } = BARRA_PROYECTOS_INDICADORES[def.num];
      const filas = proyectos
        .map((p) => ({ nombre: p.project_name, valor: Number(p[campo]) || 0, destacado: centroSeleccionado ? String(p.cost_center_id) === centroSeleccionado : false }))
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 6);
      cuerpo = `<div class="cst-graf-barras-proyectos">${svgBarrasHorizontalesProyectos(filas, { formatear })}</div>`;
    } else {
      // #4 (fecha de quiebre) y #15 (gasto más grande): no son comparables
      // entre proyectos en una barra legible, quedan como dato destacado.
      cuerpo = `<div class="cst-graf-ind-stat">${def.value(ind17)}</div>`;
    }
    return `
      <div class="cst-graf-ind-card${Object.prototype.hasOwnProperty.call(BARRA_PROYECTOS_INDICADORES, def.num) ? ' cst-graf-ind-card-ancha' : ''}">
        <div class="cst-graf-ind-head">
          <span class="cst-graf-ind-num">#${def.num}</span>
          <h4>${escapeHtml(def.name)}</h4>
        </div>
        ${cuerpo}
        <p class="cst-graf-ind-desc">${escapeHtml(def.desc)}</p>
      </div>`;
  }).join('');

  const semanalWrap = document.getElementById('cst-graf-semanal');
  if (semanalWrap) {
    const serie = ind17.serie_semanal || [];
    const { anchoPx, altoPx } = medidasSvg(semanalWrap, 900, 240);
    semanalWrap.innerHTML = svgLinea(
      serie.map((s) => ({ etiqueta: etiquetaSemanaCorta(s), valor: s.costo_laboral, titulo: `${etiquetaSemana(s)}: ${formatCOP(s.costo_laboral)}` })),
      { anchoPx, altoPx, formatearEje: formatCOPCompacto, formatearEtiqueta: formatCOP }
    );
  }
}

// ===================== Filtros de Periodo y Recurso =====================
// Periodo (mes o semana) y Recurso (talento) recortan el GASTO: horas, costo
// laboral y horas extra. El presupuesto y el valor de contrato NO se filtran
// —son propiedades del proyecto, no del recorte— así que al filtrar se avisa
// para que nadie lea el "% ejecutado" como si fuera del periodo completo.

// Devuelve "?month=Agosto&week=2&employee_id=7" según lo que esté elegido.
//
// { incluirRecurso: false } lo usa Comercial (loadComercial): esa pantalla
// lista PROYECTOS, no personas — filtrar por Recurso ahí no responde
// ninguna pregunta de negocio real ("¿es viable ESTE proyecto?" no cambia
// de sentido mirando solo la hora de una persona). Antes el mismo Recurso
// que alguien dejaba puesto en Indicadores se colaba en cada carga de
// Comercial sin que la pantalla mostrara ese control en ningún lado — el
// número salía recortado por una razón invisible.
// { incluirPeriodo: false } lo usa Alertas (loadAlertas): ese panel ya no
// muestra el control de Periodo, y sin esto el mes que alguien dejara puesto
// en Indicadores se colaría igual en la siguiente carga de Alertas —
// recargarPorFiltros() las recarga todas juntas — escondiendo avisos
// vigentes por un recorte que la pantalla no muestra en ningún lado.
function filtrosQuery({ incluirRecurso = true, incluirPeriodo = true } = {}) {
  const params = new URLSearchParams();
  const periodo = document.getElementById('cst-f-periodo');
  const recurso = document.getElementById('cst-f-recurso');

  // El valor es directo el nombre del mes ("Agosto") — el filtro es por mes
  // completo, sin semanas (8 sep 2026, a pedido explícito: se quitó el
  // segundo nivel de semana por mes que había antes).
  if (incluirPeriodo && periodo && periodo.value) params.set('month', periodo.value);
  if (incluirRecurso && recurso && recurso.value) params.set('employee_id', recurso.value);

  const s = params.toString();
  return s ? `?${s}` : '';
}

// Solo Recurso dispara el aviso (8 sep 2026, a pedido explícito: el de
// Periodo se quitó). Cuando Periodo filtraba por SEMANA sí tenía sentido
// avisar "estás viendo una parte, no el proyecto completo" — pero ahora que
// Periodo es por MES completo (sin semanas, ver initFiltrosPeriodoRecurso),
// ese aviso ya no aporta nada: un mes no es "una parte recortada" del
// mismo modo que lo era una semana suelta.
function hayFiltroActivo() {
  const recurso = document.getElementById('cst-f-recurso');
  return !!(recurso && recurso.value);
}

// Solo estos paneles usan Periodo/Recurso de verdad (computeIndicadores17,
// generarAlertasParaCentro, computeComercial). Centro de Costos, Equipo del
// Proyecto, Costo No Planeado, etc. son listados CRUD que el filtro nunca
// tocó — mostrarles el aviso decía "recortado" sobre una tabla donde nada se
// había recortado, lo cual confundía más de lo que ayudaba.
const PANELES_CON_FILTRO = ['indicadores', 'alertas'];

// El sidebar tiene varios botones que comparten data-panel="equipo-gastos"
// (uno por sub-pestaña: Costo No Planeado, Equipo del Proyecto, Catálogo de
// Cargos...). Si "activo" se decidiera solo por data-panel, los tres se
// iluminarían juntos apenas se entra a cualquiera de ellos. subtabActivo
// (costeo-nav.js la escribe) guarda cuál se pulsó de verdad, para
// desempatar entre los que comparten panel — y aplicarVisibilidadFiltros()
// de aquí abajo la usa para saber qué sub-pestaña de Equipo y Gastos está
// activa.
let subtabActivo = null;
// Qué panel se ve ahora mismo (costeo-nav.js la escribe) — renderAvisoFiltro
// y aplicarVisibilidadFiltros la usan para no aplicar Periodo/Recurso en
// pantallas que ese filtro no toca.
let panelActivo = 'indicadores';

// Qué filtro global tiene sentido en cada panel — depende de qué datos
// consume esa pantalla, NO del rol de quien la mira (28 ago 2026, a pedido
// explícito — antes solo se ocultaban para admin/ceo; un PM veía Recurso y
// Periodo en TODAS partes, incluido Comercial, que lista proyectos, no
// personas: filtrar por una sola persona ahí no responde ninguna pregunta
// de negocio real).
//
// 'equipo-gastos' tiene 7 sub-pestañas con necesidades distintas entre sí
// (Equipo del Proyecto sí usa Recurso, Costo No Planeado no) y se resuelve
// aparte, por subtabActivo — ver FILTROS_POR_SUBTAB_EQUIPO_GASTOS abajo.
// `centro` ya no aparece aquí: desde el 10 sep 2026 el selector de
// Proyecto vive en el encabezado y se ve en TODAS las pantallas, a pedido
// explícito. Antes se ocultaba en Comercial y en varias sub-pestañas de
// Equipo y Gastos; el efecto secundario es que en Comercial reemplazó al
// selector propio que tenía ese panel (cst-com-f-proyecto), que era otro
// control con la misma etiqueta y las mismas opciones.
const FILTROS_POR_PANEL = {
  // Recurso queda fuera de Indicadores a propósito (28 ago 2026, a pedido
  // explícito): la mayoría de los indicadores dejan de tener sentido
  // recortados a una sola persona (p.ej. "Personas Trabajando" siempre
  // daría 1). loadIndicadores() ya no manda employee_id — ocultarlo aquí
  // es solo la mitad visual.
  indicadores:     { recurso: false, periodo: true },
  // Recurso salió de Alertas (8 sep 2026, a pedido explícito) — mismo
  // criterio que ya se le aplicó a Indicadores el 28 ago 2026. Periodo salió
  // después (11 sep 2026, también a pedido explícito): una alerta abierta lo
  // está hoy, no "en Agosto" — recortarla por mes escondía avisos vigentes.
  alertas:         { recurso: false, periodo: false },
  'centro-costos': { recurso: false, periodo: false },
  // Recurso queda fuera a propósito: computeComercial() reutiliza el mismo
  // motor que Indicadores y SÍ acepta employee_id, pero "¿es viable este
  // proyecto?" no cambia de sentido mirando solo la hora de una persona.
  // Periodo también sale (7 sep 2026, a pedido explícito): con el selector
  // de Proyecto ya alcanza para mirar un proyecto puntual — dejar Periodo
  // encima solo sumaba una segunda forma de recortar el mismo número sin
  // agregar nada.
  comercial:       { recurso: false, periodo: false },
};

// Cada sub-pestaña de "Equipo y Gastos" consume un subconjunto distinto de
// los 3 filtros globales — ver qué lee cada render*() antes de tocar esto:
// ni renderEquipoTable() ni renderOvertimeTable() filtran ya por el Recurso
// global (11 sep 2026, a pedido explícito): las dos tablas traen su propio
// filtro "Talento" adentro, encima de la columna que acotan, así que el
// control de arriba era un segundo recorte para lo mismo, lejos de su tabla;
// renderGastosTable() deliberadamente no (un gasto es del proyecto, no de
// una persona); Catálogo de Cargos/Accesos/Historial/Configuración no usan
// ninguno de los 3 (son catálogos de empresa o traen su propio filtro).
const FILTROS_POR_SUBTAB_EQUIPO_GASTOS = {
  accesos:             { recurso: false, periodo: false },
  'equipo-proyecto':   { recurso: false, periodo: false },
  'tarifas-cargo':     { recurso: false, periodo: false },
  'costo-no-planeado': { recurso: false, periodo: false },
  // Horas Extra: el Recurso global salió el 11 sep 2026 (a pedido
  // explícito) — ese recorte por persona ahora lo hace el filtro de
  // Talento que vive dentro de la tarjeta, encima de la columna Talento
  // (cst-overtime-filtro-talento, ver populateOvertimeTalentoFilter).
  'horas-extra':       { recurso: false, periodo: false },
  historial:           { recurso: false, periodo: false },
  configuracion:       { recurso: false, periodo: false },
};
const SIN_FILTROS = { recurso: false, periodo: false };

// No se desconectan los <select> del DOM (solo se ocultan/limpian):
// filtrosQuery() y el resto de lecturas de su .value siguen funcionando
// igual en los paneles donde sí aplican.
//
// Recurso y Periodo se LIMPIAN al ocultarse (Centro no): antes quedaban con
// su valor aunque el control estuviera invisible, y como recargarPorFiltros()
// (más abajo) recarga Indicadores/Alertas/Comercial juntos ante cualquier
// cambio, un Recurso elegido en Indicadores se colaba en la siguiente carga
// de Comercial sin que esa pantalla mostrara ese control en ningún lado —
// el número salía recortado por una razón invisible. Centro sí se conserva
// a propósito: es el selector de "qué proyecto estoy mirando" que persiste
// a través de toda la app, no un recorte puntual.
function aplicarVisibilidadFiltros(target) {
  const reglas = target === 'equipo-gastos'
    ? (FILTROS_POR_SUBTAB_EQUIPO_GASTOS[subtabActivo] || SIN_FILTROS)
    : (FILTROS_POR_PANEL[target] || SIN_FILTROS);

  // El selector de Proyecto (cst-filter-centro-wrap) ya no se oculta en
  // ninguna pantalla — vive en el encabezado y se ve siempre.
  const recursoWrap = document.getElementById('cst-filter-recurso-wrap');
  recursoWrap.hidden = !reglas.recurso;
  if (!reglas.recurso) document.getElementById('cst-f-recurso').value = '';

  // Periodo ya NO vive en la barra global: desde el 11 sep 2026 está dentro
  // del panel de Indicadores, la única pantalla que lo consume (a pedido
  // explícito). Su .hidden lo decide el panel que lo contiene, no esta
  // función — pero el valor SÍ hay que seguir limpiándolo al salir: sin eso,
  // el mes elegido en Indicadores se colaría en la siguiente carga de
  // Comercial, que llama a filtrosQuery() sin excluirlo y no muestra ese
  // control en ningun lado (Alertas ya se protege con incluirPeriodo:false).
  const periodoWrap = document.getElementById('cst-filter-periodo-wrap');
  if (periodoWrap) periodoWrap.hidden = !reglas.periodo;
  if (!reglas.periodo) document.getElementById('cst-f-periodo').value = '';

  // La barra global quedo con un solo control (Recurso), oculto hoy en todas
  // las pantallas: sin esto se vería como una franja blanca vacía debajo del
  // encabezado. Ya no depende de Periodo, que vive fuera de ella.
  const barra = document.querySelector('.cst-filters');
  if (barra) barra.hidden = !reglas.recurso;
}

// Aviso permanente mientras haya filtro Y se esté viendo un panel al que le
// aplica: sin esto, un "% ejecutado" de un solo mes contra el presupuesto
// anual se lee como si el proyecto fuera barato.
function renderAvisoFiltro() {
  let aviso = document.getElementById('cst-filtro-aviso');
  if (!aviso) {
    aviso = document.createElement('div');
    aviso.id = 'cst-filtro-aviso';
    // OJO: no reutilizar la clase .cst-info-note aquí. Es display:flex, y en
    // flexbox cada nodo de texto suelto entre <b>...</b> se vuelve su propio
    // ítem flex — con gap y align-items la frase se parte en cajas separadas
    // en vez de fluir como un párrafo. .cst-filtro-aviso (ver costeo.css) no
    // usa flex por esto mismo.
    aviso.className = 'cst-filtro-aviso';
    const filtros = document.querySelector('.cst-filters');
    filtros.parentNode.insertBefore(aviso, filtros.nextSibling);
  }

  if (!hayFiltroActivo() || !PANELES_CON_FILTRO.includes(panelActivo)) {
    aviso.hidden = true;
    return;
  }

  // Solo Recurso llega hasta aquí (hayFiltroActivo ya lo garantiza) — el
  // aviso de Periodo se quitó.
  const recurso = document.getElementById('cst-f-recurso');
  const nombreRecurso = recurso.options[recurso.selectedIndex].text.trim();

  const texto = `${icono('advertencia')} Viendo solo <b>${escapeHtml(nombreRecurso)}</b>. El gasto, las horas y las horas extra están recortados a esa selección, `
    + 'pero el <b>presupuesto y el valor de contrato siguen completos</b>: los porcentajes comparan una parte contra el total del proyecto. '
    + 'Al filtrar por recurso, los <b>gastos no planeados quedan fuera</b> — son del proyecto, no de una persona.';
  aviso.innerHTML = texto;
  aviso.hidden = false;
}

// Equipo/Gastos/Horas Extra ya tienen todos sus datos en state.*: filtrar
// por Centro de Costos o Recurso es solo volver a pintar la tabla, sin
// pedirle nada al servidor.
function refiltrarTablasEquipoGastos() {
  reiniciarPaginacion('equipo', 'gastos', 'overtime');
  renderEquipoTable();
  renderGastosTable();
  // El filtro de Talento de Horas Extra solo lista a quien tiene turnos EN
  // el proyecto elegido, así que al cambiar de proyecto hay que rehacer sus
  // opciones antes de pintar — si no, queda ofreciendo gente de otro.
  populateOvertimeTalentoFilter();
  renderOvertimeTable();
}

// Centro de Costos y Alertas también se filtran sin ir al servidor —
// los datos ya están cargados.
function refiltrarPantallasGlobales() {
  reiniciarPaginacion('centros', 'alertas');
  renderCentrosGrid();
  renderAlertasGrid();
}

// Recarga los paneles que dependen de los filtros globales.
async function recargarPorFiltros() {
  renderAvisoFiltro();
  refiltrarTablasEquipoGastos();
  await Promise.all([loadIndicadores(), loadAlertas(), loadComercial()]);
}

async function initFiltrosPeriodoRecurso() {
  const periodo = document.getElementById('cst-f-periodo');
  const recurso = document.getElementById('cst-f-recurso');
  if (!periodo || !recurso) return;

  try {
    const base = await fetchJSON('/api/filters');

    // Recurso: talentos con horas registradas.
    recurso.innerHTML = '<option value="">Todos</option>' +
      (base.employees || [])
        .map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`)
        .join('');

    // Periodo: solo por mes completo (8 sep 2026, a pedido explícito — antes
    // había un segundo nivel de semanas dentro de cada mes, que se quitó).
    // El value es directo el nombre del mes ("Agosto", sin ":semana");
    // filtrosQuery() sigue funcionando igual (mes = "Agosto", semana =
    // undefined al no haber ":" — nunca manda `week`), y el backend agrega
    // TODO el mes cuando no llega `week` (ver baseWhere/buildFilterClause en
    // src/queries/_common.js), así que no hizo falta tocar el motor.
    //
    // /api/costeo/meses, NO /api/filters (8 sep 2026, reportado por el
    // usuario): /api/filters lee mp_task_facts, la tabla de PLANEACIÓN — ese
    // desplegable ofrecía meses como "Junio" que Costeo nunca tuvo (Costeo
    // depende de que alguien suba el Excel a mano, no del RPA diario).
    // Elegir uno de esos meses vacíos daba una falsa sensación de que sí
    // había datos. /api/costeo/meses lee mp_costeo_task_facts, la tabla que
    // este motor usa de verdad — el desplegable ahora solo ofrece meses que
    // Costeo realmente tiene cargados.
    const { months } = await fetchJSON('/api/costeo/meses');
    const meses = (months || []).map((m) => m.month_name);
    periodo.innerHTML = '<option value="">Todo</option>' +
      meses.map((mes) => `<option value="${escapeHtml(mes)}">${escapeHtml(mes)}</option>`).join('');
  } catch (err) {
    console.error('No se pudieron cargar las opciones de filtro:', err);
  }

  periodo.addEventListener('change', recargarPorFiltros);
  recurso.addEventListener('change', recargarPorFiltros);
}

async function loadIndicadores() {
  // Sin Recurso: la mayoría de los 13 indicadores pierde el sentido
  // recortado a una sola persona (ver FILTROS_POR_PANEL) — igual que
  // Comercial, si alguien dejó un Recurso puesto en Alertas (que sí lo usa)
  // no debe colarse aquí en silencio.
  const q = filtrosQuery({ incluirRecurso: false });
  const [centrosRes, indicadoresRes, ind17Res] = await Promise.all([
    fetchJSON('/api/costeo/centros'),
    fetchJSON('/api/costeo/indicadores'),
    fetchJSON(`/api/costeo/indicadores-17${q}`),
  ]);
  state.centros = centrosRes.centros || [];
  state.porCentro = indicadoresRes.centros || [];
  state.totales = indicadoresRes.totales || null;
  state.indicadores17 = ind17Res.centros || [];
  state.portafolio17 = ind17Res.portafolio || null;
  populateCentroFilter();
  renderIndicadoresPanel();
}

