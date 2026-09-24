'use strict';

/**
 * Front de la pestaña Costeo. Consume /api/costeo/* — CRUD de Centro de
 * Costos / Equipo / Gastos, el flujo de decisión+aprobación de horas
 * extra, los 17 indicadores oficiales y las 21 alertas del motor de reglas.
 */

// ===================== Paginacion =====================
// 20 filas por pagina en todas las listas del modulo (11 sep 2026, a pedido
// explicito). El corte es en el navegador, no en el servidor: estas listas ya
// vienen enteras en state.* (el motor las necesita completas para los totales
// y los filtros, que tambien son en memoria), asi que paginar contra la API
// habria significado pedir lo mismo dos veces.
const FILAS_POR_PAGINA = 20;

// Pagina vigente de cada lista, por clave. Se conserva entre repintados: al
// aprobar un gasto de la pagina 3 la tabla se vuelve a pintar y tiene que
// quedarse en la 3, no saltar a la 1.
const paginaActual = {};

// Que volver a pintar cuando alguien cambia de pagina. Las funciones son
// globales (scripts clasicos) y se resuelven al hacer clic, no ahora: este
// archivo carga antes que los que las declaran.
const RENDER_PAGINADO = {
  accesos: () => renderAccesosTable(),
  alertas: () => renderAlertasGrid(),
  centros: () => renderCentrosGrid(),
  comercial: () => renderComercial(),
  equipo: () => renderEquipoTable(),
  gastos: () => renderGastosTable(),
  cargos: () => renderTarifasCargoTable(),
  overtime: () => renderOvertimeTable(),
  historial: () => renderHistorialTable(),
};

// Recorta `filas` a la pagina vigente y devuelve con que pintar los
// controles. Si la lista se encogio por debajo de la pagina en la que
// estabas (un filtro, un borrado), retrocede a la ultima que existe en vez
// de dejar la tabla vacia sin explicacion.
function paginar(clave, filas) {
  const total = filas.length;
  const paginas = Math.max(1, Math.ceil(total / FILAS_POR_PAGINA));
  let pagina = paginaActual[clave] || 1;
  if (pagina > paginas) { pagina = paginas; paginaActual[clave] = pagina; }
  const desde = (pagina - 1) * FILAS_POR_PAGINA;
  return { items: filas.slice(desde, desde + FILAS_POR_PAGINA), total, pagina, paginas, desde };
}

// Pinta (o actualiza) los controles justo debajo de la lista. El <nav> se
// crea solo la primera vez y se reutiliza; con una sola pagina se esconde,
// para que una tabla de tres filas no cargue con una barra que no hace nada.
function pintarPaginacion(clave, info, elementoLista) {
  const ancla = elementoLista.tagName === 'TBODY' ? elementoLista.closest('table') : elementoLista;
  if (!ancla || !ancla.parentNode) return;

  let nav = ancla.nextElementSibling;
  if (!nav || !nav.classList.contains('cst-paginacion')) {
    nav = document.createElement('nav');
    nav.className = 'cst-paginacion';
    nav.setAttribute('aria-label', 'Paginacion');
    ancla.parentNode.insertBefore(nav, ancla.nextSibling);
  }
  nav.dataset.pag = clave;

  if (info.paginas <= 1) { nav.hidden = true; nav.innerHTML = ''; return; }
  nav.hidden = false;
  const hasta = Math.min(info.desde + FILAS_POR_PAGINA, info.total);
  nav.innerHTML = `
    <button type="button" class="btn-ghost" data-pag-ir="anterior" ${info.pagina === 1 ? 'disabled' : ''}>Anterior</button>
    <span class="cst-paginacion-info">${info.desde + 1}\u2013${hasta} de ${info.total}</span>
    <button type="button" class="btn-ghost" data-pag-ir="siguiente" ${info.pagina === info.paginas ? 'disabled' : ''}>Siguiente</button>`;
}

// Un solo manejador para todas las listas: el <nav> dice a cual pertenece.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pag-ir]');
  if (!btn) return;
  const clave = btn.closest('[data-pag]')?.dataset.pag;
  const render = RENDER_PAGINADO[clave];
  if (!render) return;
  paginaActual[clave] = Math.max(1, (paginaActual[clave] || 1) + (btn.dataset.pagIr === 'siguiente' ? 1 : -1));
  render();
});

// Cualquier cambio de filtro deja la lista mostrando otra cosa: seguir en la
// pagina 4 de la lista anterior no significa nada. Se llama desde los
// refiltrados globales (ver costeo-indicadores.js).
function reiniciarPaginacion(...claves) {
  (claves.length ? claves : Object.keys(RENDER_PAGINADO)).forEach((c) => { paginaActual[c] = 1; });
}

// Los indicadores oficiales — nombre, descripción y fórmula exacta según la
// Especificación Técnica/Maestra de Costeo. value() lee del registro que
// devuelve /api/costeo/indicadores-17 (un objeto por centro).
//
// #10 (Aprobación de Horas Extra), #12-#17 y "Dependencia de una Sola
// Persona" (bus factor) se retiraron de esta lista (ago-sep 2026, sin dato
// real en los proyectos o a pedido directo). El backend los sigue
// calculando (costo-indicadores-17.js) por si se necesitan más adelante o
// porque una alerta todavía depende del cálculo (ver costo-alertas.js);
// solo se quitaron de esta pantalla. Los que quedan se renumeraron 1..8
// sin huecos — el "num" es solo la etiqueta que ve el usuario, no tiene
// por qué coincidir con el sufijo ind7_/ind8_/ind9_ de los campos, que sí
// siguen igual que siempre (son los que calcula el motor).
const INDICATOR_DEFS = [
  { num: 1, name: 'Presupuesto Ejecutado', desc: '% del presupuesto ya gastado', help: 'Cuánta plata del presupuesto autorizado ya se gastó. Si se acerca al 100%, hay que decidir si se amplía el presupuesto o se frena el gasto.', value: (i) => formatPctConMonto(i.ind1_presupuesto_ejecutado_pct, i.ejecutado_total, i.presupuesto) },
  { num: 2, name: 'Tiempo Transcurrido', desc: '% del tiempo del proyecto ya pasado', help: 'Cuánto del calendario del proyecto ya pasó. Se compara contra el Presupuesto Ejecutado para saber si el gasto va más rápido o más lento que el tiempo.', value: (i) => formatPctConDias(i.ind2_tiempo_transcurrido_pct, i.ind2_dias_transcurridos, i.ind2_dias_totales) },
  { num: 3, name: 'Ritmo de Gasto vs. Tiempo', desc: '%Ejecutado − %Tiempo', help: 'Compara los dos indicadores anteriores. Si es positivo, el proyecto está gastando más rápido de lo que avanza en el calendario — señal de alerta temprana.', value: (i) => formatPctSigned(i.ind3_ritmo_gasto_vs_tiempo) },
  { num: 4, name: 'Fecha de Quiebre Presupuestal', desc: 'Cuándo se acaba la plata al ritmo actual', help: 'Si el gasto sigue al ritmo actual, calcula la fecha exacta en la que se acabaría el presupuesto — para poder actuar antes de que pase.', value: (i) => formatFechaQuiebre(i) },
  { num: 5, name: 'Ritmo de Gasto por Semana', desc: 'Burn rate semanal', help: 'Cuánto se está gastando en promedio cada semana. Sirve para proyectar cuánto va a durar el presupuesto que queda.', value: (i) => formatCOP(i.ind5_ritmo_gasto_semanal) },
  { num: 6, name: 'Personas Trabajando en el Proyecto', desc: 'Talentos activos en Equipo del Proyecto', help: 'Cuántas personas distintas están asignadas activamente al equipo del proyecto (Equipo del Proyecto). Ayuda a detectar equipos muy pequeños o proyectos con una sola persona cargando todo.', value: (i) => String(i.ind7_personas_trabajando) },
  { num: 7, name: 'Costo Real por Hora del Equipo', desc: 'Costo/hora ponderado real', help: 'El costo/hora promedio de todo el equipo, ponderado por horas trabajadas. Sirve para comparar la eficiencia entre proyectos parecidos.', value: (i) => formatCOP(i.ind8_costo_real_por_hora) },
  { num: 8, name: 'Proporción de Horas Extra', desc: '% de horas que fueron extra', help: 'Qué porcentaje de las horas trabajadas fueron extra en vez de horario normal. Un número alto indica sobrecarga o mala planeación de capacidad.', value: (i) => formatPctConHoras(i.ind9_proporcion_horas_extra_pct, i.ind9_horas_extra, i.ind9_horas_ejecutadas) },
];

const state = {
  user: null,
  centros: [],
  porCentro: [],
  totales: null,
  indicadores17: [],
  portafolio17: null,
  employees: [],
  equipo: [],
  gastos: [],
  overtime: [],
  alertas: [],
  // No es solo "¿hay alertas?": arranca en false y renderHeader() lo usa
  // para distinguir "todavía no llegó la respuesta" de "llegó y son 0" —
  // sin esto, la tarjeta de Alertas del encabezado pinta un "0" real (falso)
  // durante los ~5s que tarda /api/costeo/alertas (motor de costeo con la
  // base remota, ver loadAlertas) antes de saltar al valor correcto.
  alertasListas: false,
  escalamientos: [],
  accesos: [],
  config: [],
  snapshots: [],
  proyectosDisponibles: null,
  tarifasCargo: [],
  historial: [],
};

function formatCOP(n) {
  const value = Number(n) || 0;
  return '$ ' + Math.round(value).toLocaleString('es-CO');
}

// Puntos de miles a las cifras que vienen DENTRO de un texto ya armado —
// hoy solo las descripciones del historial ("...por $500000"). Desde el 7
// sep 2026 el backend ya las guarda formateadas (formatMoneda en
// src/queries/costo-audit.js), pero las filas que YA estaban en la base
// conservan el número crudo y son justo las que el CEO va a abrir primero.
//
// Solo toca lo que viene pegado a un "$": un número suelto puede ser
// cualquier cosa (horas, "3 → 4 personas", un código de proyecto) y
// meterle puntos ahí sería peor que dejarlo como está.
//
// El "(?:\.\d+)?" antes del negative lookahead es necesario porque varias
// filas viejas interpolaron una columna DECIMAL de MySQL tal cual salió de
// la base ("$50000.00", con el ".00" pegado) — sin él, el punto decimal
// hacía fallar el lookahead que evita romper un número YA formateado
// ("$ 1.000.000") y ese caso quedaba SIN NINGÚN formato (7 sep 2026,
// reportado por el usuario: "$50000.00" no cambiaba).
function formatearMontosEnTexto(texto) {
  return String(texto ?? '').replace(/\$\s?(\d{4,})(?:\.\d+)?(?![\d.,])/g, (_, digitos) => formatCOP(digitos));
}

// ===== Antes/después de las descripciones del historial =====
// (7 sep 2026, a pedido explícito del dueño de la empresa). Compartido entre
// la ventana "Ver cambios" de una tarjeta (costeo-centros.js, arma cajas de
// color) y la tabla plana de la pestaña Historial (costeo-overtime.js) — las
// dos leen las mismas filas de mp_costeo_audit_log y tienen que verse
// consistentes.

// Las descripciones que guarda el backend ya vienen con el formato
// "Campo: antes → después" (describirCambios en src/queries/costo-audit.js),
// separadas por comas o por " · ". Esto las parte en pedazos para poder
// tratar el ANTES y el DESPUÉS por separado, en vez de una frase corrida.
function partirCambio(texto) {
  return String(texto ?? '').split(/,\s(?=[A-ZÁÉÍÓÚÑ])|\s·\s/).map((parte) => {
    const flecha = parte.indexOf('→');
    if (flecha === -1) return { titulo: parte.trim(), antes: null, despues: null };
    // "Valor de contrato: $10.000.000 → $100.000.000" → etiqueta + los dos lados
    const izquierda = parte.slice(0, flecha).trim();
    const despues = parte.slice(flecha + 1).trim();
    // lastIndexOf, no indexOf: en Equipo del Proyecto la descripción trae el
    // NOMBRE de la persona antes del campo ("Oscar Naranjo: Costo/hora:
    // 10952.00 → 10952" — ver PUT /equipo en src/routes/costeo/equipo.js).
    // Con indexOf, los dos puntos se cortaban después de "Oscar Naranjo" y
    // "antes" quedaba como " Costo/hora: 10952.00" (texto, no un número) —
    // nunca se formateaba (7 sep 2026, reportado por el usuario). El último
    // ":" siempre es el que separa el CAMPO de su valor, tenga o no un
    // nombre pegado adelante.
    const dosPuntos = izquierda.lastIndexOf(':');
    return dosPuntos === -1
      ? { titulo: '', antes: izquierda, despues }
      : { titulo: izquierda.slice(0, dosPuntos).trim(), antes: izquierda.slice(dosPuntos + 1).trim(), despues };
  });
}

// Campos cuyo valor es dinero. Las filas viejas del historial guardaron el
// número pelado ("Presupuesto: 10000000 → 100000000", o incluso
// "7000000.00" tal cual sale de una columna DECIMAL de MySQL) porque hasta
// el 7 sep 2026 describirCambios no tenía formateador de moneda; se les
// ponen los puntos aquí, al pintarlas, para que el rastro que ya existe
// también se pueda leer. Las filas nuevas ya llegan formateadas
// ("$ 10.000.000") y el regex las deja pasar de largo.
const CAMBIO_CAMPOS_DINERO = ['Presupuesto', 'Valor de contrato', 'Costo/hora', 'Salario mensual', 'Monto'];

// endsWith, no ===: con el nombre pegado adelante (ver partirCambio arriba)
// el "titulo" que llega aquí puede ser "Oscar Naranjo: Costo/hora", no solo
// "Costo/hora" — igual es un campo de dinero, solo que con el nombre de la
// persona como prefijo.
function valorCambioTexto(titulo, valor) {
  const esDinero = CAMBIO_CAMPOS_DINERO.some((campo) => titulo === campo || titulo.endsWith(`: ${campo}`));
  return esDinero && /^\d+(\.\d+)?$/.test(valor) ? formatCOP(valor) : valor;
}

// Versión en texto plano de lo mismo, para la tabla de Historial (no arma
// cajas de color, solo reconstruye la frase con los montos ya formateados).
function formatearDescripcionHistorial(texto) {
  return partirCambio(formatearMontosEnTexto(texto))
    .map((p) => (p.antes === null ? p.titulo : `${p.titulo ? p.titulo + ': ' : ''}${valorCambioTexto(p.titulo, p.antes)} → ${valorCambioTexto(p.titulo, p.despues)}`))
    .join(', ');
}

// Un solo formato de fecha para toda la pantalla de Costeo (4 sep 2026).
// Antes convivían tres para el MISMO tipo de dato: '2026-08-20' crudo en
// Costo Planeado y en Costo No Planeado, '20 ago 2026' en Horas Extra y
// '20 de agosto de 2026' en los snapshots. Se elige el mes abreviado como
// formato único: el ISO crudo obliga a traducir mentalmente y el mes
// completo desalinea las columnas de una tabla angosta.
//
// El 'T00:00:00' NO es decorativo. El backend manda las fechas como cadena
// 'YYYY-MM-DD' (dateStrings: true en src/db.js) y `new Date('2026-08-20')`
// la interpreta como medianoche UTC: en Colombia (UTC-5) eso se pinta como
// el 19. Con la hora explícita se construye en horario local y la fecha
// que se ve es la que guardó el usuario.
// Los meses se arman a mano en vez de con toLocaleDateString('es-CO'): esa
// vía devuelve "20 de ago de 2026" (el locale mete los "de"), demasiado
// largo para una celda de tabla, y su resultado exacto depende de la
// versión de ICU con la que se compiló Node — el mismo motivo por el que
// las pruebas de formatCOP comprueban la forma y no el texto literal.
// Armándolo aquí, lo que se ve es siempre "20 ago 2026".
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatFecha(valor) {
  if (!valor) return '—';
  const fecha = new Date(`${String(valor).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(fecha.getTime())) return '—';
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${dia} ${MESES_CORTOS[fecha.getMonth()]} ${fecha.getFullYear()}`;
}

// Variante con hora, para el historial de auditoría: ahí sí importa a qué
// hora se hizo el cambio. Recibe un DATETIME ('YYYY-MM-DD HH:MM:SS'), no
// una fecha suelta — por eso no reutiliza formatFecha().
function formatFechaHora(valor) {
  if (!valor) return '—';
  const d = new Date(String(valor).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '—';
  const dia = String(d.getDate()).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dia} ${MESES_CORTOS[d.getMonth()]} ${d.getFullYear()}, ${hora}:${min}`;
}

// escapeHtml(), h`` y raw() viven ahora en /js/safe-html.js, que costeo.html
// carga antes que este archivo. Estaban duplicados aquí y en el resto de
// pantallas, y cada copia se usaba en unos sitios sí y en otros no — que es
// exactamente cómo aparece un XSS almacenado.

// Multi-selección con chips removibles + buscador, para reemplazar los
// <select multiple> nativos (feos y poco descubribles: nadie adivina que
// hay que sostener Ctrl para elegir varios). container.innerHTML se
// construye entero acá; opciones = [{value, label}]; devuelve
// { getValues() } para leer la selección al enviar el formulario.
function crearMultiselect(container, opciones, seleccionadosIniciales = []) {
  const seleccionados = new Set(seleccionadosIniciales);

  container.classList.add('cst-multiselect');
  container.innerHTML = `
    <div class="cst-multiselect-box">
      <div class="cst-multiselect-chips"></div>
      <input type="text" class="cst-multiselect-input" placeholder="Buscar proyecto…" autocomplete="off" />
    </div>
    <div class="cst-multiselect-dropdown" hidden></div>
  `;
  const box = container.querySelector('.cst-multiselect-box');
  const chipsEl = container.querySelector('.cst-multiselect-chips');
  const input = container.querySelector('.cst-multiselect-input');
  const dropdown = container.querySelector('.cst-multiselect-dropdown');

  const labelOf = (value) => opciones.find((o) => o.value === value)?.label || value;

  function renderChips() {
    chipsEl.innerHTML = [...seleccionados].map((v) => `
      <span class="cst-multiselect-chip">
        ${escapeHtml(labelOf(v))}
        <button type="button" data-remove="${escapeHtml(v)}" aria-label="Quitar ${escapeHtml(labelOf(v))}">×</button>
      </span>`).join('');
  }

  function renderDropdown() {
    const q = input.value.trim().toLowerCase();
    const visibles = opciones.filter((o) => !q || o.label.toLowerCase().includes(q));
    dropdown.innerHTML = visibles.length
      ? visibles.map((o) => `
          <button type="button" class="cst-multiselect-option${seleccionados.has(o.value) ? ' is-selected' : ''}" data-value="${escapeHtml(o.value)}">
            <span class="cst-multiselect-check">${icono('check')}</span>${escapeHtml(o.label)}
          </button>`).join('')
      : '<p class="cst-multiselect-empty">Sin resultados</p>';
  }

  function open() { dropdown.hidden = false; renderDropdown(); }
  function close() { dropdown.hidden = true; }

  box.addEventListener('click', () => { input.focus(); open(); });
  input.addEventListener('focus', open);
  input.addEventListener('input', renderDropdown);

  dropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-value]');
    if (!opt) return;
    const v = opt.dataset.value;
    if (seleccionados.has(v)) seleccionados.delete(v); else seleccionados.add(v);
    renderChips();
    renderDropdown();
    input.value = '';
    input.focus();
  });

  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    seleccionados.delete(btn.dataset.remove);
    renderChips();
    renderDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) close();
  });

  renderChips();
  return { getValues: () => [...seleccionados] };
}

// Loader contextual (ver .cst-loader en costeo.css). loaderGrid() para
// contenedores tipo grid/div (Indicadores, Alertas, Centro de Costos,
// Configuración); loaderRow() para el interior de un <tbody>, con el
// colspan de esa tabla en particular. Cada render real (renderAlertasGrid,
// renderCentrosGrid, etc.) los reemplaza con innerHTML apenas llegan los
// datos — no hace falta ninguna lógica para "quitarlos" a mano.
function loaderGrid(texto) {
  return `<div class="cst-loader"><div class="cst-loader-spinner"></div><p>${texto}</p></div>`;
}
function loaderRow(colspan, texto) {
  return `<tr class="cst-loader-row"><td colspan="${colspan}">${loaderGrid(texto)}</td></tr>`;
}

// ===================== Separador de miles en campos de dinero =====================
// "25000" -> "25.000" mientras se escribe. Los <input type="number"> nativos
// no aceptan puntos como separador de miles (los leen como decimal, así que
// "25.000" ahí adentro vale 25), por eso estos campos pasan a texto con
// formato en vivo. desformatearMiles() deshace el punto antes de enviar —
// sin eso el backend recibiría Number("25.000") === 25 y perdería 3 ceros.

// Dos funciones de formateo, a propósito distintas, para no mezclar dos
// significados distintos de "punto":
//
// - formatearValorInicial(): se usa UNA sola vez, al enganchar el campo, con
//   lo que ya traía el HTML. Ese valor puede venir de un DECIMAL de MySQL
//   ("10000.00", con mysql2 devolviéndolo como string) donde el punto es
//   decimal de verdad. Number() lo interpreta bien.
// - formatearMiles(): corre en cada tecla mientras se escribe. A esa altura
//   el campo ya está bajo nuestro control — solo dígitos y los puntos de
//   miles que NOSOTROS pusimos — así que basta con quedarse con los dígitos.
//   Si esta función intentara ser "lista" con Number() aquí, el punto de
//   miles que acabamos de insertar se leería como decimal en la tecla
//   siguiente y "25.000" se convertiría en "2.5000" → 2.5, destruyendo el
//   valor mientras se escribe.
function formatearValorInicial(valor) {
  if (valor === '' || valor === null || valor === undefined) return '';
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('es-CO') : '';
}

function formatearMiles(valor) {
  const soloDigitos = String(valor ?? '').replace(/\D/g, '');
  return soloDigitos ? Number(soloDigitos).toLocaleString('es-CO') : '';
}

// Devuelve número (o '' si el campo quedó vacío) — listo para Number() o
// para ir directo al body del fetch.
function desformatearMiles(valor) {
  const soloDigitos = String(valor ?? '').replace(/\D/g, '');
  return soloDigitos === '' ? '' : Number(soloDigitos);
}

// Convierte el input a texto y lo formatea en cada tecla. Idempotente
// (data-miles-fmt) porque los inputs de formularios inline (Equipo, Tarifas
// por Cargo) se recrean cada vez que se abre la fila de edición.
function attachMilesFormat(input) {
  if (!input || input.dataset.milesFmt === '1') return;
  input.dataset.milesFmt = '1';
  input.type = 'text';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'off');
  input.value = formatearValorInicial(input.value);
  input.addEventListener('input', () => {
    const posAntes = input.selectionStart;
    const largoAntes = input.value.length;
    input.value = formatearMiles(input.value);
    // Aproximación simple de cursor: al escribir de corrido (el caso normal)
    // el punto nuevo empuja el cursor un carácter, esto lo compensa. Editar
    // a mitad de un número largo puede saltar el cursor al final; aceptable
    // para un campo numérico corto como estos.
    const diff = input.value.length - largoAntes;
    const posDespues = Math.max(0, posAntes + diff);
    input.setSelectionRange(posDespues, posDespues);
  });
}

// Selecciona todo el contenido al enfocar: sin esto, un campo numérico que
// arranca en "0" (Personas, Horas totales…) deja el "0" ahí parado y la
// primera tecla que se escribe se INSERTA junto a él ("0" + "1" = "01",
// "011"...) en vez de reemplazarlo — se ve bien recién al salir del campo,
// cuando el siguiente render ya normalizó el valor. Seleccionar todo al
// entrar hace que la primera tecla reemplace el "0", no se le pegue al lado.
function attachSelectOnFocus(input) {
  if (!input) return;
  input.addEventListener('focus', () => input.select());
}

// Aplica el formato a todos los campos de dinero que ya estén en el DOM
// (los estáticos del HTML). Los que se generan dinámicamente (edición
// inline de Centro, Equipo, Tarifas por Cargo) se enganchan justo después
// de insertar su HTML — ver abrirEdicionCentro/Equipo/TarifaCargo.
function initMilesFormatEstaticos() {
  ['cst-centro-budget', 'cst-centro-contract-value', 'cst-equipo-hourly-cost', 'cst-gasto-amount']
    .forEach((id) => attachMilesFormat(document.getElementById(id)));
}

function formatPctSigned(v) {
  if (v === null || v === undefined) return 'Sin datos suficientes';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} pts`;
}

// Muestran el valor crudo detrás del porcentaje ("45.0% ($12.500.000 de
// $27.000.000)") — a pedido explícito: con solo el % era fácil no entender
// de dónde salía el número.
function formatPctConMonto(pct, monto, total, suffix = '%') {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}${suffix} (${formatCOP(monto)} de ${formatCOP(total)})`;
}

function formatPctConDias(pct, dias, diasTotales) {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}% (${Math.round(dias)} de ${Math.round(diasTotales)} días)`;
}

function formatPctConHoras(pct, horas, horasTotales) {
  if (pct === null || pct === undefined) return 'Sin datos';
  return `${Number(pct).toFixed(1)}% (${Number(horas).toFixed(1)} de ${Number(horasTotales).toFixed(1)} horas)`;
}

function formatFechaQuiebre(i) {
  if (!i.ind4_fecha_quiebre_presupuestal) return 'Sin datos (sin ritmo de gasto todavía)';
  const riesgo = i.ind4_se_queda_sin_plata_antes === true ? ' ⚠ antes de la fecha fin' : '';
  return `${formatFecha(i.ind4_fecha_quiebre_presupuestal)}${riesgo}`;
}

// Notificación flotante propia — reemplaza alert() nativo del navegador
// (se ve como una alerta del sistema operativo, no como parte de la app,
// y bloquea hasta que alguien le da OK). Aparece, se queda 5s y se va sola;
// si el usuario pasa el mouse encima, se pausa el cierre para que le dé
// tiempo a leerla. Uso: cstToast('Guardado con éxito').
// "Ayuda visible" — el botón del menú lateral existía desde siempre pero
// no tenía NINGÚN código detrás: hacer clic no hacía absolutamente nada.
// Ahora apaga/enciende los textos explicativos de cada pantalla (ver la
// lista de clases en costeo.css). Para un PM que ya conoce el sistema esos
// textos son ruido en todas las pantallas; para quien recién entra siguen
// estando a un clic.
//
// La preferencia se guarda en el navegador (localStorage) y no en el
// servidor: es puramente visual y personal de cada quien, no un dato del
// negocio que haya que auditar. Si el navegador la bloquea (modo privado),
// simplemente no se recuerda entre sesiones — no se rompe nada.
const AYUDA_STORAGE_KEY = 'gtc.costeo.ayudaOculta';

function aplicarAyudaOculta(oculta) {
  document.body.classList.toggle('is-ayuda-oculta', oculta);
  const btn = document.getElementById('cst-help-btn');
  if (!btn) return;
  const etiqueta = btn.querySelector('span');
  if (etiqueta) etiqueta.textContent = oculta ? 'Mostrar ayuda' : 'Ocultar ayuda';
  btn.setAttribute('aria-pressed', String(oculta));
}

function initAyudaToggle() {
  const btn = document.getElementById('cst-help-btn');
  if (!btn) return;

  let oculta = false;
  try { oculta = localStorage.getItem(AYUDA_STORAGE_KEY) === '1'; } catch { /* sin localStorage: arranca visible */ }
  aplicarAyudaOculta(oculta);

  btn.addEventListener('click', () => {
    const nueva = !document.body.classList.contains('is-ayuda-oculta');
    aplicarAyudaOculta(nueva);
    try { localStorage.setItem(AYUDA_STORAGE_KEY, nueva ? '1' : '0'); } catch { /* no se recuerda, no pasa nada */ }
  });
}

function cstToast(message, { tipo = 'ok', duracionMs = 5000 } = {}) {
  const cont = document.getElementById('cst-toast-container');
  if (!cont) { console.warn('[toast] falta #cst-toast-container en el HTML:', message); return; }

  const toast = document.createElement('div');
  toast.className = `cst-toast cst-toast-${tipo}`;
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  cont.appendChild(toast);

  let cerrado = false;
  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    toast.classList.add('is-saliendo');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  const vence = Date.now() + duracionMs;
  let timer = setTimeout(cerrar, duracionMs);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => {
    const restante = Math.max(0, vence - Date.now());
    timer = setTimeout(cerrar, restante);
  });
}

// Modal de confirmación propio — reemplaza confirm() nativo del navegador
// (se ve como una alerta del sistema operativo, no como parte de la app).
//
// Uso:
//   if (!(await cstConfirm('¿Seguro?'))) return;                        // Eliminar (rojo)
//   if (!(await cstConfirm('¿Aprobar?', { aceptar: 'Aprobar', peligro: false }))) return;
//
// El botón de aceptar decía SIEMPRE "Eliminar" en rojo, porque el texto
// estaba fijo en el HTML y este modal nació para los borrados. Al reusarlo
// para aprobar un gasto (9 sep 2026, reportado por el usuario) quedaba un
// "¿Aprobar este gasto?" con un botón rojo que decía "Eliminar" — el texto
// contradecía la pregunta, justo en la acción que suma plata al ejecutado.
//
// El texto y el color se fijan en CADA llamada, no solo cuando se pasan
// opciones: el <button> es uno solo y se reusa, así que sin volver al
// default el "Aprobar" se quedaría pegado en el siguiente borrado.
function cstConfirm(message, { aceptar = 'Eliminar', peligro = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('cst-confirm-overlay');
    const acceptBtn = document.getElementById('cst-confirm-accept');
    const cancelBtn = document.getElementById('cst-confirm-cancel');
    document.getElementById('cst-confirm-message').textContent = message;
    acceptBtn.textContent = aceptar;
    acceptBtn.classList.toggle('is-ok', !peligro);
    overlay.hidden = false;

    const cleanup = (result) => {
      overlay.hidden = true;
      acceptBtn.removeEventListener('click', onAccept);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onAccept = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };

    acceptBtn.addEventListener('click', onAccept);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
  });
}

// Modal de rechazo de un gasto no planeado (sql/28). Devuelve { note } o
// null si se cancela. El motivo es obligatorio: sin el, el PM ve
// "Rechazado" y no tiene forma de saber que corregir.
function cstGastoRechazoModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('cst-gasto-rechazo-overlay');
    const okBtn = document.getElementById('cst-gasto-rechazo-ok');
    const cancelBtn = document.getElementById('cst-gasto-rechazo-cancel');
    const errorEl = document.getElementById('cst-gasto-rechazo-error');
    const noteInput = document.getElementById('cst-gasto-rechazo-note');

    errorEl.hidden = true;
    noteInput.value = '';
    overlay.hidden = false;
    noteInput.focus();

    const cleanup = (result) => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onOk = () => {
      const note = noteInput.value.trim();
      if (!note) {
        errorEl.textContent = 'El motivo es obligatorio para rechazar el gasto.';
        errorEl.hidden = false;
        return;
      }
      cleanup({ note });
    };
    const onCancel = () => cleanup(null);
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(null); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(null); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
  });
}

// ===================== Modales de alta (un solo patrón) =====================
// Antes cada "agregar algo" se abría distinto: Centro de Costos y Horas Extra
// revelaban un formulario oculto con un botón, mientras Equipo, Gastos y
// Accesos lo tenían SIEMPRE visible arriba de su tabla, empujando el
// contenido hacia abajo. Un PM tenía que aprenderse tres gestos distintos
// para la misma acción, y en las pantallas con formulario fijo la tabla
// —que es lo que viene a consultar— quedaba debajo del pliegue.
//
// Ahora es siempre lo mismo: botón "+ Agregar…" en el encabezado de la
// tarjeta, y un modal enfocado encima, sin mover la tabla de su lugar.
//
// El cableado es declarativo en vez de un par de listeners por formulario:
// [data-modal-abrir="<id>"] abre ese overlay y [data-modal-cerrar] dentro lo
// cierra. El fondo oscuro y la tecla Escape también cierran.
function abrirModal(overlayId) {
  const overlay = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
  if (!overlay) return;
  overlay.hidden = false;
  // Foco en el primer campo utilizable: se puede empezar a escribir sin un
  // clic más. Se saltan los de solo lectura (p. ej. un costo/hora que sale
  // de un salario) y los deshabilitados; offsetParent descarta además los
  // que están ocultos por el modo actual del formulario (p. ej. el select
  // de Talento cuando Equipo del Proyecto abre directo en "Persona nueva" —
  // ver abrirEquipoModal en costeo-equipo.js).
  const candidatos = overlay.querySelectorAll(
    'input:not([type="hidden"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
  );
  const primero = [...candidatos].find((el) => el.offsetParent !== null);
  if (primero) primero.focus();
}

// Cierra y deja el formulario limpio para la próxima vez. Un formulario con
// estado que reset() no alcanza (widgets propios, campos que se revelan solos)
// escucha 'cst-modal-cerrado' en su overlay en vez de que el core tenga que
// conocer cada caso particular.
function cerrarModal(overlayId) {
  const overlay = typeof overlayId === 'string' ? document.getElementById(overlayId) : overlayId;
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const form = overlay.querySelector('form');
  if (form) {
    form.reset();
    form.querySelectorAll('.emp-form-error').forEach((el) => { el.hidden = true; });
  }
  overlay.dispatchEvent(new CustomEvent('cst-modal-cerrado'));
}

function initModales() {
  document.addEventListener('click', (e) => {
    const abrir = e.target.closest('[data-modal-abrir]');
    if (abrir) return abrirModal(abrir.dataset.modalAbrir);
    const cerrar = e.target.closest('[data-modal-cerrar]');
    if (cerrar) return cerrarModal(cerrar.closest('[data-modal]'));
    // Clic en el fondo oscuro (el overlay mismo, no la caja de adentro).
    if (e.target.matches('[data-modal]')) cerrarModal(e.target);
  });

  // Escape cierra el que esté abierto — si por lo que sea hubiera dos, el
  // último, que es el que está encima.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const abiertos = [...document.querySelectorAll('[data-modal]')].filter((m) => !m.hidden);
    if (abiertos.length) cerrarModal(abiertos[abiertos.length - 1]);
  });
}

async function fetchJSON(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

// Costo/hora ya calculado de un talento, si tiene salario conocido en OTRO
// proyecto (sql/33/34) — compartido entre Equipo del Proyecto, Plan de
// Recursos y el Simulador de Comercial, las tres pantallas donde elegir una
// PERSONA real (en vez de un cargo hipotético) tiene que traer su tarifa
// real sola, sin volver a preguntarla. null si esa persona no tiene salario
// cargado todavía.
async function costoHoraDeEmpleado(employeeId) {
  try {
    const { costo_hora } = await fetchJSON(`/api/costeo/equipo/salario-conocido/${employeeId}`);
    return costo_hora;
  } catch {
    return null;
  }
}

// Descarga un archivo binario (PDF/Excel) — no es JSON, así que no usa
// fetchJSON. El nombre del archivo lo decide el backend vía
// Content-Disposition; se extrae de ahí en vez de inventarlo en el cliente.
async function downloadFile(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : 'reporte-costeo';

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

// ===================== Exportación (5.2 PDF / 5.3 Excel) =====================
// Respeta el filtro "Centro de Costos" activo: si hay uno seleccionado,
// exporta solo ese centro; en "Todos" exporta el portafolio agregado.

function currentExportQuery() {
  const select = document.getElementById('cst-f-centro');
  const centroId = select ? select.value : '';
  return centroId ? `?centro=${encodeURIComponent(centroId)}` : '';
}

// ===================== Snapshots históricos (5.1) =====================
// Un snapshot es una fotografía fija de los 17 indicadores — no se
// recalcula, así que sirve para comparar "entonces vs. ahora".

function currentCentroId() {
  const select = document.getElementById('cst-f-centro');
  const value = select ? select.value : '';
  return value || null;
}

// Selección múltiple para borrar varios snapshots a la vez (8 sep 2026, a
// pedido explícito: antes solo se podía eliminar uno por uno). Vive fuera
// de `state` a propósito — es UI efímera de esta pantalla, no algo que
// otros paneles necesiten leer, y así renderSnapshotList() la puede limpiar
// sin pisar nada más.
let snapshotsSeleccionados = new Set();

async function loadSnapshots() {
  const centroId = currentCentroId();
  const qs = centroId ? `?centro=${encodeURIComponent(centroId)}` : '';
  const { snapshots } = await fetchJSON(`/api/costeo/snapshots${qs}`);
  state.snapshots = snapshots || [];
  // Un snapshot que ya no está en la lista (se borró, o cambió el filtro de
  // Centro de Costos) no puede seguir "seleccionado" — si no, el contador de
  // la barra masiva mentiría sobre cuántos hay de verdad.
  const idsVigentes = new Set(state.snapshots.map((s) => String(s.snapshot_id)));
  snapshotsSeleccionados = new Set([...snapshotsSeleccionados].filter((id) => idsVigentes.has(id)));
  renderSnapshotList();
}

function formatSnapshotFecha(snap) {
  return formatFecha(snap.snapshot_date);
}

function buildCompareTable(snapshotInd17) {
  const actual = currentIndicadores17();
  if (!actual) return '<p class="cst-snapshot-empty">Sin datos actuales para comparar.</p>';

  const rows = INDICATOR_DEFS.map((ind) => `
    <tr>
      <td>#${ind.num} ${ind.name}</td>
      <td>${ind.value(snapshotInd17)}</td>
      <td>${ind.value(actual)}</td>
    </tr>
  `).join('');

  return `
    <table class="cst-snapshot-compare-table">
      <thead><tr><th>Indicador</th><th>En el snapshot</th><th>Hoy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function toggleCompareSnapshot(snapshotId, container) {
  if (container.dataset.open === '1') {
    container.innerHTML = '';
    container.dataset.open = '0';
    return;
  }
  container.innerHTML = '<p class="cst-snapshot-empty">Cargando comparación…</p>';
  try {
    const { snapshot } = await fetchJSON(`/api/costeo/snapshots/${snapshotId}`);
    container.innerHTML = buildCompareTable(snapshot.ind17);
    container.dataset.open = '1';
  } catch (err) {
    container.innerHTML = `<p class="cst-snapshot-empty">${escapeHtml(err.message)}</p>`;
  }
}

// Refleja snapshotsSeleccionados en la barra masiva (contador, casilla
// "Seleccionar todos" en indeterminate cuando hay una selección parcial, y
// visibilidad — solo se muestra si hay algo elegido, para no ocupar
// espacio de forma permanente).
function renderSnapshotBulkbar() {
  const barra = document.getElementById('cst-snapshot-bulkbar');
  const n = snapshotsSeleccionados.size;
  barra.hidden = n === 0;
  if (n === 0) return;

  document.getElementById('cst-snapshot-bulk-count').textContent =
    `${n} seleccionado${n === 1 ? '' : 's'}`;

  const selectAll = document.getElementById('cst-snapshot-select-all');
  const total = state.snapshots.length;
  selectAll.checked = n === total;
  selectAll.indeterminate = n > 0 && n < total;
}

function renderSnapshotList() {
  const list = document.getElementById('cst-snapshot-list');
  if (!state.snapshots.length) {
    list.innerHTML = '<p class="cst-snapshot-empty">Todavía no hay snapshots guardados para esta vista.</p>';
    renderSnapshotBulkbar();
    return;
  }

  list.innerHTML = state.snapshots.map((snap) => `
    <div class="cst-snapshot-card">
      <div class="cst-snapshot-card-head">
        <label class="cst-snapshot-checkbox">
          <input type="checkbox" data-snapshot-check="${snap.snapshot_id}" ${snapshotsSeleccionados.has(String(snap.snapshot_id)) ? 'checked' : ''} />
        </label>
        <div>
          <div class="cst-snapshot-date">${formatSnapshotFecha(snap)}</div>
          <p class="cst-snapshot-meta">${escapeHtml(snap.project_name)}</p>
        </div>
        <div class="cst-snapshot-card-actions">
          <button type="button" class="cst-snapshot-compare-btn" data-snapshot-compare="${snap.snapshot_id}">Comparar con hoy</button>
          <button type="button" class="cst-snapshot-delete-btn" data-snapshot-delete="${snap.snapshot_id}">${icono('basura')} Eliminar</button>
        </div>
      </div>
      <div class="cst-snapshot-compare-slot" data-snapshot-slot="${snap.snapshot_id}"></div>
    </div>
  `).join('');

  list.querySelectorAll('[data-snapshot-check]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.snapshotCheck;
      if (chk.checked) snapshotsSeleccionados.add(id);
      else snapshotsSeleccionados.delete(id);
      renderSnapshotBulkbar();
    });
  });

  list.querySelectorAll('[data-snapshot-compare]').forEach((btn) => {
    btn.addEventListener('click', () => withBusy(btn, async () => {
      const id = btn.dataset.snapshotCompare;
      const slot = list.querySelector(`[data-snapshot-slot="${id}"]`);
      await toggleCompareSnapshot(id, slot);
    }));
  });

  list.querySelectorAll('[data-snapshot-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.snapshotDelete;
      if (!(await cstConfirm('¿Eliminar este snapshot? No se puede deshacer.'))) return;
      await withBusy(btn, async () => {
        try {
          await fetchJSON(`/api/costeo/snapshots/${id}`, { method: 'DELETE' });
          await loadSnapshots();
        } catch (err) {
          alert(err.message);
        }
      }, 'Eliminando…');
    });
  });

  renderSnapshotBulkbar();
}

function initSnapshotBulkbar() {
  document.getElementById('cst-snapshot-select-all').addEventListener('change', (e) => {
    snapshotsSeleccionados = e.target.checked
      ? new Set(state.snapshots.map((s) => String(s.snapshot_id)))
      : new Set();
    renderSnapshotList();
  });

  const bulkDeleteBtn = document.getElementById('cst-snapshot-bulk-delete');
  bulkDeleteBtn.addEventListener('click', async () => {
    const n = snapshotsSeleccionados.size;
    if (!n) return;
    if (!(await cstConfirm(`¿Eliminar ${n} snapshot${n === 1 ? '' : 's'}? No se puede deshacer.`))) return;
    await withBusy(bulkDeleteBtn, async () => {
      const ids = [...snapshotsSeleccionados];
      // Promise.allSettled, no Promise.all: si UNO falla (ej. otro usuario
      // ya lo había borrado), los demás igual se eliminan en vez de que un
      // solo error tumbe todo el borrado masivo.
      const resultados = await Promise.allSettled(
        ids.map((id) => fetchJSON(`/api/costeo/snapshots/${id}`, { method: 'DELETE' }))
      );
      const fallidos = resultados.filter((r) => r.status === 'rejected').length;
      snapshotsSeleccionados = new Set();
      await loadSnapshots();
      if (fallidos) alert(`${fallidos} de ${n} snapshot(s) no se pudieron eliminar. El resto sí.`);
    }, 'Eliminando…');
  });
}

function initSnapshotButton() {
  const btn = document.getElementById('cst-snapshot-save');
  btn.addEventListener('click', () => withBusy(btn, async () => {
    try {
      const centroId = currentCentroId();
      await fetchJSON('/api/costeo/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ centro: centroId }),
      });
      await loadSnapshots();
    } catch (err) {
      alert(err.message);
    }
  }, 'Guardando…'));
}

function initExportButtons() {
  const btnPdf = document.getElementById('cst-export-pdf');
  const btnXlsx = document.getElementById('cst-export-xlsx');

  const handleClick = (btn, url, labelWhileBusy) => () => withBusy(btn, async () => {
    try {
      await downloadFile(url + currentExportQuery());
    } catch (err) {
      alert(err.message);
    }
  }, labelWhileBusy);

  btnPdf.addEventListener('click', handleClick(btnPdf, '/api/costeo/indicadores-17/export/pdf', 'Generando…'));
  btnXlsx.addEventListener('click', handleClick(btnXlsx, '/api/costeo/indicadores-17/export/xlsx', 'Generando…'));
}

