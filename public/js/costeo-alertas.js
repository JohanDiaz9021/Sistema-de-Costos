'use strict';

/**
 * Panel de Alertas: la grilla de hallazgos del motor de reglas y el
 * escalamiento de las que llevan dias sin corregirse.
 *
 * Extraido de public/js/costeo.js, que habia llegado a 2.752 lineas con
 * todos los paneles mezclados. El panel Comercial y el Simulador vivian
 * aqui hasta el 4 sep 2026 y se movieron a costeo-comercial.js (eran 860
 * de las 996 lineas del archivo). Siguen siendo <script> clasicos: las
 * funciones y constantes son globales y se ven entre archivos, igual que
 * antes. Lo que importa es el orden de carga en costeo.html.
 */

// ===================== Alertas =====================

let alertasFiltroActivo = 'todas';

// Alertas que llevan 3+ días sin corregirse (sql/19 + costo-alertas-eventos.js).
// El backend YA filtra por rol: un leader/PM solo recibe SUS propios
// centros (desde nivel 'pm', 3 días); admin/ceo reciben de TODOS los
// centros, pero aquí se les muestran solo las que llegaron a nivel 'ceo'
// (6+ días) — las de 3-5 días siguen siendo "problema del PM todavía", no
// hace falta que el CEO las vea una por una.
function escalamientosVisibles() {
  const lista = state.escalamientos || [];
  return lista.filter(esSinCorregir);
}

// Misma regla de rol para el listado y para el resaltado dentro de "Todas":
// si difirieran, el contador de la pestaña diría 12 y en la lista completa
// aparecerían resaltadas otras tantas.
//
// Las alertas llegan del backend ya marcadas con dias_abierta/nivel cuando
// tienen un escalamiento abierto (ver anotarDiasAbierta en
// costo-alertas-eventos.js), así que sirve igual para una alerta o para un
// escalamiento.
function esSinCorregir(a) {
  // dias_abierta es 0 el día en que se detecta y sigue contando desde ahí
  // (21 sep 2026) — comparar con undefined/null en vez de con "truthy"
  // evita que el día 0 se trate como "sin escalamiento" por ser falsy.
  if (!a || a.dias_abierta === undefined || a.dias_abierta === null) return false;
  const esAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  return esAdmin ? a.nivel === 'ceo' : true;
}

// Las que llevan días sin corregirse van primero (10 sep 2026, a pedido
// explícito) y, entre ellas, la más vieja arriba. El resto conserva el
// orden por severidad que ya trae el backend (ordenarPorSeveridad).
function ordenarSinCorregirPrimero(alertas) {
  return [...alertas].sort((a, b) => {
    const sa = esSinCorregir(a) ? 1 : 0;
    const sb = esSinCorregir(b) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return sa ? (b.dias_abierta - a.dias_abierta) : 0;
  });
}

// Cuadro rojo con los días, debajo de la pastilla de severidad.
function diasBadgeHTML(a) {
  if (!esSinCorregir(a)) return '';
  const clase = a.nivel === 'ceo' ? 'cst-alert-dias is-escalada' : 'cst-alert-dias';
  return `<span class="${clase}">${a.dias_abierta} día${a.dias_abierta === 1 ? '' : 's'} sin corregir</span>`;
}

function renderAlertasGrid() {
  const grid = document.getElementById('cst-alertas-grid');

  // Combinación de dos filtros: severidad (locales) + Centro de Costos (global).
  const gCentro = document.getElementById('cst-f-centro')?.value || '';
  const delCentro = (a) => !gCentro || a.cost_center_id === null || String(a.cost_center_id) === String(gCentro);

  // Los KPIs y el contador de la pestaña van ANTES de cualquier salida: son
  // del portafolio completo, no de lo que se esté mirando. Si se calcularan
  // después de pintar, la pestaña "sin corregir" los dejaría con el valor
  // de la vez anterior.
  const criticas = state.alertas.filter((a) => a.severidad === 'critica').length;
  document.getElementById('cst-kpi-alertas').textContent = String(state.alertas.length);
  document.getElementById('cst-nav-alertas-badge').textContent = String(state.alertas.length);
  document.getElementById('cst-kpi-riesgo').textContent = String(criticas);
  actualizarContadorSinCorregir();

  // "Alertas sin corregir" no es una severidad: es la MISMA alerta filtrada
  // por antigüedad, así que sale de state.escalamientos (que además trae los
  // días que lleva abierta) en vez de state.alertas.
  if (alertasFiltroActivo === 'sin-corregir') {
    grid.innerHTML = tarjetasSinCorregirHTML(escalamientosVisibles().filter(delCentro));
    return;
  }

  let visibles = state.alertas.filter(delCentro);
  visibles = alertasFiltroActivo === 'todas'
    ? visibles
    : visibles.filter((a) => a.severidad === alertasFiltroActivo);
  visibles = ordenarSinCorregirPrimero(visibles);

  // Sin botones de accion en la tarjeta (4 sep 2026): los de
  // "Aprobar"/"Rechazar" colgaban del tipo de alerta 'Aprobación pendiente',
  // que dejo de generarse cuando se retiro el flujo de aprobacion de horas
  // extra — toda hora extra registrada desde la plataforma queda aprobada en
  // el acto. Eran codigo inalcanzable: la condicion nunca se cumplia.
  const pag = paginar('alertas', visibles);
  grid.innerHTML = pag.items.map((a) => `
    <article class="cst-alert-card sev-${a.severidad} ${esSinCorregir(a) ? 'is-sin-corregir' : ''}">
      <div class="cst-alert-head">
        <h4>${escapeHtml(a.tipo)}</h4>
        <span class="cst-alert-sev sev-${escapeHtml(a.severidad)}">${escapeHtml(a.severidad)}</span>
      </div>
      ${diasBadgeHTML(a)}
      <span class="cst-alert-cat">${escapeHtml(a.categoria)}</span>
      <p class="cst-alert-detalle">${escapeHtml(a.detalle)}</p>
      ${a.project_name ? `<span class="cst-alert-proyecto">${escapeHtml(a.project_name)}</span>` : ''}
    </article>`).join('') || '<p class="emp-muted">Sin alertas para este filtro.</p>';
  pintarPaginacion('alertas', pag, grid);
}

// El contador vive en la pestaña porque estas alertas perdieron el bloque
// destacado que tenían arriba: sin un número a la vista, "3 alertas tuyas
// llevan días sin corregir" quedaba escondido detrás de un clic.
function actualizarContadorSinCorregir() {
  const badge = document.getElementById('cst-alertas-sin-corregir-count');
  if (!badge) return;
  const n = escalamientosVisibles().length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function tarjetasSinCorregirHTML(items) {
  if (!items.length) {
    return '<p class="emp-muted">Nada sin corregir por aquí. Las alertas aparecen en esta pestaña cuando llevan 3 días o más abiertas.</p>';
  }

  const esAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');
  // La nota explica por qué estas alertas están apartadas del resto, que es
  // lo que decía el subtítulo del bloque que existía antes. Ocupa la fila
  // completa de la grilla (son 2 columnas) para que se lea como un aviso y
  // no como una tarjeta más.
  const nota = esAdmin
    ? 'El PM ya las tuvo visibles varios días — les toca tu atención.'
    : 'Aparecen aquí desde que se detectan. El día 5 es la última oportunidad: al 6º día también las ve el CEO.';

  return `<p class="cst-alertas-nota emp-muted">${nota}</p>` + items.map((e) => `
    <article class="cst-alert-card sev-${e.severidad} is-sin-corregir">
      <div class="cst-alert-head">
        <h4>${escapeHtml(e.tipo)}</h4>
        <span class="cst-alert-sev sev-${escapeHtml(e.severidad)}">${escapeHtml(e.severidad)}</span>
      </div>
      ${diasBadgeHTML(e)}
      <p class="cst-alert-detalle">${escapeHtml(e.detalle)}</p>
      ${e.project_name ? `<span class="cst-alert-proyecto">${escapeHtml(e.project_name)}</span>` : ''}
      ${e.es_ultimo_aviso ? `<p class="cst-escalamiento-ultimo">${icono('advertencia')} Último día: si no se corrige hoy, mañana la ve el CEO.</p>` : ''}
      <!-- "Corregido" es una AFIRMACIÓN, no un cierre: esconde la alerta hoy
           y mañana lo confirman los datos. Por eso el texto de ayuda dice
           que puede volver — prometer que desaparece y que reaparezca al día
           siguiente se leería como un fallo, no como la regla. -->
      <div class="cst-alert-acciones">
        <button type="button" class="btn-ghost" data-alerta-corregida="${escapeHtml(e.clave_dedup)}">
          ${icono('check')} Corregido
        </button>
        <span class="cst-alert-ayuda">Se confirma mañana con los datos: si sigue sin corregirse, vuelve.</span>
      </div>
    </article>`).join('');
}

async function loadAlertas() {
  // Sin Recurso ni Periodo: Alertas no muestra ninguno de los dos controles
  // (ver FILTROS_POR_PANEL en costeo-indicadores.js) y una alerta abierta lo
  // está hoy, no "en Agosto" — recortarla por un valor elegido en otra
  // pantalla escondía avisos vigentes sin explicación visible.
  const q = filtrosQuery({ incluirRecurso: false, incluirPeriodo: false });
  const { alertas, escalamientos } = await fetchJSON(`/api/costeo/alertas${q}`);
  state.alertas = alertas || [];
  state.alertasListas = true;
  state.escalamientos = escalamientos || [];
  renderAlertasGrid();
  // renderHeader() lee state.alertas.length para el KPI de "Alertas" — si
  // loadIndicadores() se ejecutó antes que esta función, ese KPI había
  // quedado en 0 hasta el próximo cambio de pestaña. Se recalcula aquí
  // también para no depender del orden en que se llamen ambas.
  renderHeader();
}

// "Corregido" en las tarjetas de "sin corregir".
//
// Se engancha en el CONTENEDOR y no en cada botón porque la grilla se
// repinta entera cada vez (renderAlertasGrid): los botones de ahora no son
// los mismos objetos que los de dentro de un momento, así que un listener
// por botón se perdería en el primer repintado.
function initAlertasAcciones() {
  const grid = document.getElementById('cst-alertas-grid');
  if (!grid) return;

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-alerta-corregida]');
    if (!btn) return;

    const clave = btn.dataset.alertaCorregida;
    if (!(await cstConfirm(
      '¿Marcar esta alerta como corregida? Se oculta hoy, y mañana se confirma con los datos: si el problema sigue, la alerta vuelve con los días que lleva.',
      { aceptar: 'Marcar corregida', peligro: false }
    ))) return;

    await withBusy(btn, async () => {
      try {
        await fetchJSON('/api/costeo/alertas/corregida', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clave_dedup: clave }),
        });
        cstToast('Marcada como corregida. Mañana se confirma con los datos.');
        // Se recarga en vez de quitar la tarjeta a mano: el contador de la
        // pestaña y los KPI de arriba salen de state.alertas, y esconder
        // solo la tarjeta los dejaría diciendo un número que ya no es.
        await loadAlertas();
      } catch (err) {
        cstToast(err.message, { tipo: 'error' });
      }
    }, 'Marcando…');
  });
}

function initAlertasFiltros() {
  document.querySelectorAll('#cst-alertas-filtros .cst-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cst-alertas-filtros .cst-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      alertasFiltroActivo = btn.dataset.sev;
      reiniciarPaginacion('alertas');
      renderAlertasGrid();
    });
  });
}

