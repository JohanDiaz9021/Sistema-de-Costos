'use strict';

/**
 * Panel Comercial: viabilidad por proyecto y el Simulador de recursos.
 *
 * Separado de costeo-alertas.js el 4 sep 2026: ese archivo habia llegado a
 * 996 lineas de las cuales 860 eran Comercial/Simulador y solo 136 eran
 * Alertas — el nombre del archivo describia el 14% de su contenido. Es el
 * mismo corte que ya se le habia hecho a costeo.js (2.752 lineas) y por la
 * misma razon.
 *
 * Siguen siendo <script> clasicos: las funciones y constantes son globales
 * y se ven entre archivos. Lo unico que importa es que costeo.html cargue
 * este archivo DESPUES de costeo-alertas.js, porque crearProyectoDesdeSimulador()
 * llama a loadAlertas() (se resuelve en tiempo de ejecucion, no de carga,
 * pero el orden se mantiene por claridad).
 */

// ===================== Comercial =====================
// Utilidad y viabilidad por proyecto (contract_value vs. costo proyectado
// de cierre). El Análisis con IA sigue siendo solo interfaz por ahora.

// Estado real del proyecto = Ejecución Presupuestal (Costo Estimado vs
// Presupuesto autorizado), no margen — ver cabecera de src/queries/costo-comercial.js.
// Aplica a todos los centros con presupuesto, con o sin contrato.
const ESTADO_LABEL = {
  sin_riesgo: 'Dentro de presupuesto',
  en_riesgo: 'En riesgo',
  perdida: 'Sobre ejecutado',
  no_aplica: 'Sin presupuesto',
};

// ---- Simulador de recursos ----
// Escenario "¿qué pasa si...?": vive solo en memoria. Sobre un proyecto
// EXISTENTE nunca se guarda nada (mueve personas, tarifa, horas y semanas
// restantes para ver el efecto al instante). Eligiendo "+ Nuevo proyecto"
// cambia de modo: ahí sí hay un botón para crear el proyecto de verdad,
// con el Plan de Recursos armado en la tabla ya guardado (ago 2026).
let simulador = null;

// El proyecto a simular tiene su PROPIO selector (cst-sim-proyecto), aparte
// del filtro global de arriba (cst-f-centro) — ese filtro también maneja
// Indicadores y las demás pestañas, y no tiene noción de "proyecto nuevo".
function simuladorSelectValor() {
  return document.getElementById('cst-sim-proyecto')?.value || '';
}

function simuladorProyectoActual() {
  const val = simuladorSelectValor();
  if (!val || val === '__nuevo__' || !state.comercial) return null;
  return state.comercial.proyectos.find((p) => String(p.cost_center_id) === String(val)) || null;
}

// Al recargar Comercial, mantiene la selección si el proyecto sigue
// existiendo; si no, arranca sincronizado con el filtro global (punto de
// partida cómodo) sin que cambiarlo después mueva ese filtro de vuelta.
function populateSimuladorProyectoSelect() {
  const sel = document.getElementById('cst-sim-proyecto');
  if (!sel) return;
  const anterior = sel.value;
  const opciones = state.comercial.proyectos
    .map((p) => `<option value="${p.cost_center_id}">${escapeHtml(p.project_name)}</option>`).join('');
  sel.innerHTML = `<option value="">Selecciona un centro de costos…</option>${opciones}<option value="__nuevo__">+ Nuevo proyecto</option>`;
  const gCentro = document.getElementById('cst-f-centro')?.value || '';
  const candidatos = [anterior, gCentro];
  const valido = candidatos.find((v) => v && (v === '__nuevo__' || state.comercial.proyectos.some((p) => String(p.cost_center_id) === String(v))));
  sel.value = valido || '';
}

// Estado inicial de "+ Nuevo proyecto": ni el equipo ni los metadatos
// existen todavía en ningún lado, así que arranca vacío/con defaults
// razonables (mismos defaults que "+ Nuevo centro" del panel Centro de Costos).
function nuevoProyectoDefaults() {
  return {
    esNuevo: true,
    revelado: false,
    meta: {
      project_name: '', client_name: '', tipo: 'Desarrollo', status: 'vigente',
      start_date: '', planned_end_date: '', actual_end_date: '', contract_value: 0,
    },
    filas: [{ role_catalog: '', employee_id: null, personas: 1, horas_totales: 0, costo_hora: 0 }],
    // Gastos iniciales (sql/29) — partidas sueltas con nombre y valor
    // (licencias, viáticos de arranque...) que no son mano de obra pero sí
    // presupuesto conocido de antemano. Arranca vacío: a diferencia del
    // equipo, no es obligatorio tener ninguno.
    gastos: [],
  };
}

function calcularSimulacionNueva() {
  const presupuestoEquipo = simulador.filas.reduce(
    (s, f) => s + (Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0), 0
  );
  const presupuestoGastos = simulador.gastos.reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const presupuesto = presupuestoEquipo + presupuestoGastos;
  const contractValue = Number(simulador.meta.contract_value) || 0;
  const utilidad = contractValue > 0 ? contractValue - presupuesto : null;
  const margen = utilidad !== null ? (utilidad / contractValue) * 100 : null;
  return { presupuesto, presupuestoEquipo, presupuestoGastos, utilidad, margen };
}

function resetSimulador() {
  const p = simuladorProyectoActual();
  simulador = p
    ? {
        cost_center_id: p.cost_center_id,
        // Copia superficial: agregar/quitar roles en el simulador no debe
        // tocar p.equipo_por_cargo (el equipo REAL del centro).
        filas: p.equipo_por_cargo.map((r) => ({ ...r })),
        // El tiempo se mide en horas, no en semanas (28 ago 2026, a pedido
        // explícito) — mismo criterio que "horas_totales" en el Plan de
        // Recursos. Se parte de las semanas reales que quedan convertidas a
        // horas con la jornada legal, como punto de partida razonable; de
        // ahí se puede mover libremente.
        horas: Math.round(p.semanas_restantes * (state.comercial.horas_semana_legal || 46)),
        presupuesto: p.budget,
        // null (centro interno, sin contrato) parte en 0: así se puede
        // simular "¿y si este centro sí facturara a un cliente?" sin que el
        // campo empiece deshabilitado o vacío.
        contractValue: p.contract_value ?? 0,
      }
    : null;
}

function calcularSimulacion(p) {
  // Costo por hora si TODO el equipo simulado trabajara simultáneamente esa
  // hora — se multiplica por las horas restantes (no por semanas × horas/
  // semana): el tiempo ya no se mide en semanas.
  const burnPorHora = simulador.filas.reduce((s, f) => s + f.costo_hora, 0);
  const costoProyectado = p.ejecutado_total + burnPorHora * simulador.horas;
  const utilidad = simulador.contractValue > 0 ? simulador.contractValue - costoProyectado : null;
  const margen = utilidad !== null ? (utilidad / simulador.contractValue) * 100 : null;
  const presupuestoEjecutadoPct = simulador.presupuesto > 0 ? (costoProyectado / simulador.presupuesto) * 100 : null;
  return { burnPorHora, costoProyectado, utilidad, margen, presupuestoEjecutadoPct };
}

function renderSimulador() {
  const cont = document.getElementById('cst-com-simulador-body');
  const val = simuladorSelectValor();

  if (val === '__nuevo__') {
    if (!simulador || !simulador.esNuevo) simulador = nuevoProyectoDefaults();
    renderSimuladorNuevo(cont);
    return;
  }

  const p = simuladorProyectoActual();

  if (!p) {
    simulador = null;
    cont.innerHTML = '<p class="emp-muted cst-com-sim-vacio">Selecciona un Centro de Costos arriba, o elige "+ Nuevo proyecto" para armar uno desde cero.</p>';
    return;
  }
  if (!simulador || simulador.esNuevo || simulador.cost_center_id !== p.cost_center_id) resetSimulador();

  // Antes, un centro sin equipo con tarifa bloqueaba el simulador entero
  // (mensaje y nada más). Con "+ Agregar rol" eso ya no aplica: un centro
  // vacío es justo el punto de partida de "¿y si contrato a alguien de la
  // nada?" — la tabla arranca vacía en vez de trabada.
  const opcionesRoleSim = (state.tarifasCargo || [])
    .map((t) => `<option value="${t.role_catalog}">${escapeHtml(t.nombre_visible)}</option>`).join('');
  // Persona real, ya no opcional (a pedido explícito, 3 sep 2026): cada fila
  // ES una persona — no tiene sentido un "cargo genérico" con cantidad de
  // gente y una tarifa tecleada a mano, cuando ya se puede elegir a alguien
  // real de la lista y su costo/hora sale solo de su salario. Sin persona
  // elegida todavía, el costo/hora simplemente no existe (no hay de dónde
  // sacarlo) — la fila queda en $0 hasta que se elige a alguien.
  const opcionesPersonaSim = (state.employees || [])
    .map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`).join('');

  const { burnPorHora, costoProyectado, utilidad, margen, presupuestoEjecutadoPct } = calcularSimulacion(p);
  const filasHTML = simulador.filas.map((f, i) => {
    const esPersona = !!f.employee_id;
    let celdaCosto;
    if (!esPersona) {
      celdaCosto = '<span class="emp-muted cst-sim-sin-persona">Elige una persona →</span>';
    } else if (f.sinSalarioConocido) {
      celdaCosto = `<input type="text" inputmode="numeric" placeholder="Salario mensual" value="${f.monthly_salary ? formatearValorInicial(f.monthly_salary) : ''}" data-sim-input="monthly_salary" data-i="${i}" />
           <small class="cst-plan-salario-hint">${f.monthly_salary ? `≈ ${formatCOP(f.costo_hora)}/h` : 'sin salario conocido — escríbelo aquí'}</small>`;
    } else {
      celdaCosto = `<input type="text" class="cst-sim-input" value="${f.costo_hora}" readonly title="Sale de su salario real" />`;
    }
    const costoPlaneado = f.horas_planeadas ? f.horas_planeadas * f.costo_hora : null;
    return `
    <tr>
      <td><select data-sim-input="role_catalog" data-i="${i}"><option value="">— elegir —</option>${f.role_catalog ? opcionesRoleSim.replace(`value="${f.role_catalog}"`, `value="${f.role_catalog}" selected`) : opcionesRoleSim}</select></td>
      <td><select data-sim-input="employee_id" data-i="${i}"><option value="">— elegir persona —</option>${f.employee_id ? opcionesPersonaSim.replace(`value="${f.employee_id}"`, `value="${f.employee_id}" selected`) : opcionesPersonaSim}</select></td>
      <td>${celdaCosto}</td>
      <td><input type="number" class="cst-sim-input" min="0" step="0.5" placeholder="Ej. 50" value="${f.horas_planeadas ?? ''}" data-sim-input="horas_planeadas" data-i="${i}" /></td>
      <td class="cst-sim-subtotal">${costoPlaneado !== null ? formatCOP(costoPlaneado) : '<span class="emp-muted">—</span>'}</td>
      <td class="cst-sim-acciones-fila">
        ${f.nuevo ? `<button type="button" class="btn-ghost cst-sim-btn-contratar" data-sim="rol-contratar" data-i="${i}">+ Agregar al equipo</button>` : ''}
        <button type="button" class="btn-ghost" data-sim="rol-remove" data-i="${i}">${icono('cerrar')}</button>
      </td>
    </tr>`;
  }).join('');
  const costoPlaneadoTotal = simulador.filas.reduce((s, f) => s + (f.horas_planeadas ? f.horas_planeadas * f.costo_hora : 0), 0);

  const margenReal = p.margen_pct;
  let comparacion = '';
  if (margen !== null && margenReal !== null) {
    const delta = margen - margenReal;
    const signo = delta >= 0 ? 'mejora' : 'empeora';
    const clase = delta >= 0 ? 'cst-value-green' : 'cst-value-red';
    comparacion = `<p class="cst-sim-comparacion es-${signo}">Comparado con el escenario real (margen ${margenReal}%), este ajuste <strong class="${clase}">${signo} el margen en ${Math.abs(delta).toFixed(1)} puntos</strong>.</p>`;
  }

  cont.innerHTML = `
    ${simulador.filas.length ? '' : '<p class="emp-muted cst-com-sim-vacio-nota">Este centro no tiene equipo con costo/hora todavía — agrega un rol para empezar a simular (ej. "¿y si contrato un Analista de Datos?").</p>'}
    <table class="emp-table cst-sim-table">
      <thead><tr><th>Cargo</th><th>Persona real</th><th>Costo/hora</th><th>Horas planeadas <span class="cst-field-hint">(opcional)</span></th><th class="cst-sim-subtotal">Costo planeado</th><th></th></tr></thead>
      <tbody>${filasHTML}</tbody>
    </table>
    <div class="cst-plan-footer">
      <button type="button" class="btn-ghost cst-sim-btn-add" data-sim="rol-add">+ Agregar rol</button>
      ${costoPlaneadoTotal > 0 ? `<span class="cst-plan-total">Costo planeado total: <strong>${formatCOP(costoPlaneadoTotal)}</strong></span>` : ''}
    </div>

    <div class="cst-sim-controles-head">
      <p class="cst-sim-nuevo-seccion-label">Presupuesto y contrato <span class="cst-field-hint">— también se pueden mover, igual que el equipo</span></p>
      <button type="button" class="btn-ghost" data-sim="reset">↺ Reiniciar al valor real</button>
    </div>
    <div class="cst-summary-grid cst-sim-controles">
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <span class="cst-sim-label">Presupuesto</span>
        <div class="cst-sim-stepper">
          <button type="button" data-sim="presupuesto-">−</button>
          <input type="text" class="cst-sim-input cst-sim-input-money" data-sim-input="presupuesto" value="${simulador.presupuesto}" inputmode="numeric" autocomplete="off" />
          <button type="button" data-sim="presupuesto+">+</button>
        </div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <span class="cst-sim-label">Valor del contrato</span>
        <div class="cst-sim-stepper">
          <button type="button" data-sim="contrato-">−</button>
          <input type="text" class="cst-sim-input cst-sim-input-money" data-sim-input="contrato" value="${simulador.contractValue}" inputmode="numeric" autocomplete="off" />
          <button type="button" data-sim="contrato+">+</button>
        </div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <span class="cst-sim-label">Horas restantes <span class="cst-field-hint">— mueve el tiempo</span></span>
        <div class="cst-sim-stepper">
          <button type="button" data-sim="horas-">−</button>
          <input type="number" class="cst-sim-input" data-sim-input="horas" value="${simulador.horas}" min="0" step="10" />
          <button type="button" data-sim="horas+">+</button>
        </div>
      </div>
    </div>

    <div class="cst-summary-grid cst-sim-resultados">
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Ritmo de gasto / hora (escenario)</p>
        <div class="cst-summary-value">${formatCOP(burnPorHora)}</div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Costo proyectado (escenario)</p>
        <div class="cst-summary-value">${formatCOP(costoProyectado)}</div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">% Presupuesto ejecutado (escenario)</p>
        <div class="cst-summary-value ${presupuestoEjecutadoPct !== null && presupuestoEjecutadoPct > 100 ? 'cst-value-red' : ''}">${presupuestoEjecutadoPct !== null ? presupuestoEjecutadoPct.toFixed(0) + '%' : '—'}</div>
        <p class="cst-summary-sub">${simulador.presupuesto > 0 ? 'sobre el presupuesto simulado' : 'define un presupuesto para verlo'}</p>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Utilidad (escenario)</p>
        <div class="cst-summary-value ${utilidad >= 0 ? 'cst-value-green' : 'cst-value-red'}">${utilidad !== null ? formatCOP(utilidad) : '—'}</div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Margen (escenario)</p>
        <div class="cst-summary-value">${margen !== null ? margen.toFixed(0) + '%' : '—'}</div>
        <p class="cst-summary-sub">${margen === null ? 'Sin valor de contrato en este escenario' : (margen >= 25 ? 'Margen alto' : margen >= 10 ? 'Margen moderado' : 'Margen bajo')}</p>
      </div>
    </div>
    ${comparacion}`;

  // Puntos de miles en vivo mientras se escribe (igual que Presupuesto,
  // Valor de contrato, etc.) — se reengancha en cada render porque el
  // simulador reconstruye todo el HTML en cada cambio (los nodos de antes
  // ya no existen).
  cont.querySelectorAll('[data-sim-input="monthly_salary"], .cst-sim-input-money').forEach(attachMilesFormat);
  cont.querySelectorAll('[data-sim-input="horas_planeadas"]').forEach(attachSelectOnFocus);
}

// "+ Nuevo proyecto": arma un centro desde cero (metadatos + equipo por rol)
// y calcula la proyección en vivo. "Simular" solo revela ese resultado;
// "Agregar proyecto" lo persiste de verdad (POST /centros con plan_recursos).
function renderSimuladorNuevo(cont) {
  // "Agregar proyecto" ya terminó y el centro quedó creado — se queda en
  // esta pantalla de confirmación en vez de limpiar el formulario en
  // silencio (eso se veía igual que si el clic no hubiera hecho nada).
  if (simulador.exito) {
    const ex = simulador.exito;
    cont.innerHTML = `
      <div class="cst-sim-exito">
        <span class="cst-sim-exito-icono">${icono('ok')}</span>
        <div>
          <p class="cst-sim-exito-titulo">Proyecto creado: "${escapeHtml(ex.project_name)}" (${escapeHtml(ex.codigo)})</p>
          <p class="cst-sim-exito-detalle">Presupuesto ${formatCOP(ex.budget)}, calculado desde el Plan de Recursos. Ya aparece en Centro de Costos y en la tabla de arriba.</p>
        </div>
        <button type="button" class="btn-primary" data-simn-cerrar>+ Crear otro proyecto</button>
      </div>`;
    return;
  }

  const m = simulador.meta;
  const opcionesRole = (state.tarifasCargo || [])
    .map((t) => `<option value="${t.role_catalog}">${escapeHtml(t.nombre_visible)}</option>`).join('');
  const opcionesPersona = (state.employees || [])
    .map((e) => `<option value="${e.employee_id}">${escapeHtml(e.canonical_name)}</option>`).join('');

  const filasHTML = simulador.filas.map((f, i) => {
    const esPersona = !!f.employee_id;
    // "Persona real" sin salario conocido en NINGÚN proyecto (2 sep 2026,
    // hallazgo reportado por un PM real): antes esto se bloqueaba con un
    // toast y no había forma de seguir sin ir primero a Equipo del Proyecto
    // — que exige un centro YA existente. Un proyecto nuevo con una persona
    // nueva quedaba en un ciclo imposible. Ahora, en vez del costo/hora
    // (readonly, no hay de dónde sacarlo todavía), esta celda deja escribir
    // el salario mensual ahí mismo — el servidor lo usa para calcular el
    // costo/hora real Y de paso da de alta a la persona en Equipo del
    // Proyecto del centro que se está por crear (ver costo-plan-recursos.js).
    const sinSalarioConocido = esPersona && f.sinSalarioConocido;
    const celdaCosto = sinSalarioConocido
      ? `<input type="text" inputmode="numeric" placeholder="Salario mensual" value="${f.monthly_salary ? formatearValorInicial(f.monthly_salary) : ''}" data-simn-input="monthly_salary" data-i="${i}" />
         <small class="cst-plan-salario-hint" data-simn-salario-hint="${i}">${f.monthly_salary ? `≈ ${formatCOP(f.costo_hora)}/h` : 'sin salario conocido — escríbelo aquí'}</small>`
      : `<input type="text" inputmode="numeric" value="${f.costo_hora}" data-simn-input="costo_hora" data-i="${i}" ${esPersona ? 'readonly title="Sale de su salario real"' : ''} />`;
    return `
    <tr>
      <td><select data-simn-input="role_catalog" data-i="${i}"><option value="">— elegir —</option>${f.role_catalog ? opcionesRole.replace(`value="${f.role_catalog}"`, `value="${f.role_catalog}" selected`) : opcionesRole}</select></td>
      <td><select data-simn-input="employee_id" data-i="${i}"><option value="">— cargo genérico —</option>${f.employee_id ? opcionesPersona.replace(`value="${f.employee_id}"`, `value="${f.employee_id}" selected`) : opcionesPersona}</select></td>
      <td><input type="number" min="1" step="1" value="${f.personas}" data-simn-input="personas" data-i="${i}" ${esPersona ? 'readonly title="Es una persona real: siempre 1"' : ''} /></td>
      <td><input type="number" min="0" step="0.5" value="${f.horas_totales}" data-simn-input="horas_totales" data-i="${i}" /></td>
      <td class="cst-plan-salario-celda">${celdaCosto}</td>
      <td class="cst-plan-subtotal" data-simn-subtotal="${i}">${formatCOP((Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0))}</td>
      <td><button type="button" class="btn-ghost" data-simn-remove="${i}">${icono('cerrar')}</button></td>
    </tr>`;
  }).join('');

  // Gastos iniciales (sql/29): partidas sueltas con nombre y valor —
  // licencias, viáticos de arranque, hardware... — que se suman al
  // presupuesto junto con la mano de obra, sin ocupar una fila de "Equipo
  // por rol" (no tienen role_catalog ni se cobran por hora).
  const gastosHTML = simulador.gastos.map((g, i) => `
    <tr>
      <td><input type="text" placeholder="Ej. Licencia Azure, viáticos de arranque…" value="${escapeHtml(g.descripcion)}" data-simn-gasto="descripcion" data-i="${i}" /></td>
      <td><input type="text" inputmode="numeric" value="${g.monto}" data-simn-gasto="monto" data-i="${i}" /></td>
      <td><button type="button" class="btn-ghost" data-simn-gasto-remove="${i}">${icono('cerrar')}</button></td>
    </tr>`).join('');

  const { presupuesto, presupuestoEquipo, presupuestoGastos } = calcularSimulacionNueva();

  cont.innerHTML = `
    <p class="emp-muted cst-com-sim-vacio-nota">Arma un proyecto desde cero: define sus datos, arma el equipo por rol y mira la proyección antes de decidir si lo creas de verdad.</p>
    <div class="cst-sim-nuevo">
      <p class="cst-sim-nuevo-seccion-label">Datos del proyecto</p>
      <div class="cst-sim-nuevo-meta">
        <label><span>Nombre comercial</span><input type="text" data-simn-meta="project_name" value="${escapeHtml(m.project_name)}" required /></label>
        <label><span>Cliente</span><input type="text" data-simn-meta="client_name" value="${escapeHtml(m.client_name)}" /></label>
        <label><span>Tipo</span>
          <select data-simn-meta="tipo">
            ${Object.entries(TIPO_LABEL).map(([v, l]) => `<option value="${v}" ${m.tipo === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label><span>Estado</span>
          <select data-simn-meta="status">
            <option value="vigente" ${m.status === 'vigente' ? 'selected' : ''}>Vigente</option>
            <option value="por_vencer" ${m.status === 'por_vencer' ? 'selected' : ''}>Por vencer</option>
            <option value="vencido" ${m.status === 'vencido' ? 'selected' : ''}>Vencido</option>
            <option value="cerrado" ${m.status === 'cerrado' ? 'selected' : ''}>Cerrado</option>
            <option value="inactivo" ${m.status === 'inactivo' ? 'selected' : ''}>Inactivo</option>
          </select>
        </label>
        <label><span>Fecha de inicio</span><input type="date" data-simn-meta="start_date" value="${m.start_date}" required /></label>
        <label><span>Fecha fin planeada</span><input type="date" data-simn-meta="planned_end_date" value="${m.planned_end_date}" required /></label>
        <label><span>Fecha de entrega</span><input type="date" data-simn-meta="actual_end_date" value="${m.actual_end_date}" /></label>
        <label><span>Valor del contrato (COP)</span><input type="text" inputmode="numeric" data-simn-meta="contract_value" value="${m.contract_value}" /></label>
      </div>

      <p class="cst-sim-nuevo-seccion-label">Equipo por rol</p>
      <table class="emp-table cst-plan-table">
        <thead><tr><th>Rol</th><th>Persona real <span class="cst-field-hint">(opcional)</span></th><th>Personas</th><th>Horas totales del proyecto</th><th>Costo/hora</th><th>Subtotal</th><th></th></tr></thead>
        <tbody>${filasHTML}</tbody>
      </table>
      <div class="cst-plan-footer">
        <button type="button" class="btn-ghost" data-simn-add>+ Agregar rol</button>
        <span class="cst-plan-total" data-simn-total-equipo>Subtotal equipo: <strong>${formatCOP(presupuestoEquipo)}</strong></span>
      </div>

      <p class="cst-sim-nuevo-seccion-label">Gastos iniciales <span class="cst-field-hint">(opcional — licencias, viáticos, hardware…)</span></p>
      <table class="emp-table cst-plan-table" ${simulador.gastos.length ? '' : 'hidden'} data-simn-gastos-table>
        <thead><tr><th>Descripción</th><th>Valor (COP)</th><th></th></tr></thead>
        <tbody data-simn-gastos-tbody>${gastosHTML}</tbody>
      </table>
      <div class="cst-plan-footer">
        <button type="button" class="btn-ghost" data-simn-gasto-add>+ Añadir gasto</button>
        <span class="cst-plan-total" data-simn-total-gastos>Subtotal gastos: <strong>${formatCOP(presupuestoGastos)}</strong></span>
      </div>

      <div class="cst-plan-footer cst-plan-footer-total">
        <span class="cst-plan-total">Presupuesto calculado (equipo + gastos): <strong data-simn-total>${formatCOP(presupuesto)}</strong></span>
      </div>

      <p class="emp-form-error" data-simn-error hidden></p>
      <div class="cst-sim-nuevo-acciones">
        <button type="button" class="btn-ghost" data-simn-accion="simular">${icono('matraz')} Simular</button>
        <button type="button" class="btn-primary" data-simn-accion="agregar">${icono('ok')} Agregar proyecto</button>
      </div>
    </div>
    <div data-simn-resultados>${resultadosNuevoHTML()}</div>`;

  cont.querySelectorAll('[data-simn-input="costo_hora"], [data-simn-input="monthly_salary"]').forEach(attachMilesFormat);
  attachMilesFormat(cont.querySelector('[data-simn-meta="contract_value"]'));
  cont.querySelectorAll('[data-simn-input="personas"], [data-simn-input="horas_totales"]').forEach(attachSelectOnFocus);
  cont.querySelectorAll('[data-simn-gasto="monto"]').forEach(attachMilesFormat);
}

function resultadosNuevoHTML() {
  if (!simulador.revelado) return '';
  const { presupuesto, utilidad, margen } = calcularSimulacionNueva();
  return `
    <div class="cst-summary-grid cst-sim-resultados">
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Presupuesto calculado (Plan de Recursos)</p>
        <div class="cst-summary-value">${formatCOP(presupuesto)}</div>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Utilidad proyectada</p>
        <div class="cst-summary-value ${utilidad === null ? '' : (utilidad >= 0 ? 'cst-value-green' : 'cst-value-red')}">${utilidad !== null ? formatCOP(utilidad) : '—'}</div>
        <p class="cst-summary-sub">${utilidad === null ? 'Agrega un valor de contrato para verla' : ''}</p>
      </div>
      <div class="cst-summary-card">
        <span class="cst-sim-pill">${icono('matraz')} simulado</span>
        <p class="cst-summary-label">Margen</p>
        <div class="cst-summary-value">${margen !== null ? margen.toFixed(0) + '%' : '—'}</div>
        <p class="cst-summary-sub">${margen === null ? 'Sin valor de contrato en este escenario' : (margen >= 25 ? 'Margen alto' : margen >= 10 ? 'Margen moderado' : 'Margen bajo')}</p>
      </div>
    </div>`;
}

// Actualiza SOLO los números derivados (subtotales, total, tarjetas de
// resultado) sin tocar los inputs. Antes cada 'change' reconstruía todo el
// HTML del simulador: el nodo sobre el que ibas a hacer clic desaparecía a
// mitad del clic, así que el primer clic se perdía y tocaba dar dos.
function refrescarCalculosNuevo(cont) {
  simulador.filas.forEach((f, i) => {
    const celda = cont.querySelector(`[data-simn-subtotal="${i}"]`);
    if (celda) celda.textContent = formatCOP((Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0));
  });
  const { presupuesto, presupuestoEquipo, presupuestoGastos } = calcularSimulacionNueva();
  const totalEquipoEl = cont.querySelector('[data-simn-total-equipo] strong');
  if (totalEquipoEl) totalEquipoEl.textContent = formatCOP(presupuestoEquipo);
  const totalGastosEl = cont.querySelector('[data-simn-total-gastos] strong');
  if (totalGastosEl) totalGastosEl.textContent = formatCOP(presupuestoGastos);
  const totalEl = cont.querySelector('[data-simn-total]');
  if (totalEl) totalEl.textContent = formatCOP(presupuesto);
  const resultadosEl = cont.querySelector('[data-simn-resultados]');
  if (resultadosEl) resultadosEl.innerHTML = resultadosNuevoHTML();
}

async function crearProyectoDesdeSimulador(cont) {
  const errorEl = cont.querySelector('[data-simn-error]');
  errorEl.hidden = true;
  const m = simulador.meta;
  const filas = simulador.filas.filter((f) => f.role_catalog);
  // Gastos con descripción vacía se descartan en vez de rechazar el envío:
  // una fila que alguien agregó y no llegó a llenar no debería bloquear
  // crear el proyecto (misma tolerancia que "+ Agregar rol" con role_catalog).
  const gastos = simulador.gastos.filter((g) => g.descripcion.trim() && Number(g.monto) > 0);

  if (!m.project_name.trim()) {
    errorEl.textContent = 'Escribe el nombre comercial del proyecto.';
    errorEl.hidden = false;
    return;
  }
  if (!m.start_date || !m.planned_end_date) {
    errorEl.textContent = 'La fecha de inicio y la fecha fin planeada son obligatorias.';
    errorEl.hidden = false;
    return;
  }
  if (!filas.length) {
    errorEl.textContent = 'Agrega al menos un rol al equipo para calcular el presupuesto.';
    errorEl.hidden = false;
    return;
  }

  const accionBtn = cont.querySelector('[data-simn-accion="agregar"]');
  await withBusy(accionBtn, async () => {
    try {
      const data = await fetchJSON('/api/costeo/centros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: m.project_name,
          client_name: m.client_name || undefined,
          tipo: m.tipo,
          status: m.status,
          start_date: m.start_date,
          planned_end_date: m.planned_end_date,
          actual_end_date: m.actual_end_date || undefined,
          contract_value: m.contract_value || undefined,
          plan_recursos: filas.map((f) => ({
            role_catalog: f.role_catalog, employee_id: f.employee_id || null,
            personas: f.personas, horas_totales: f.horas_totales, costo_hora: f.costo_hora,
            // Solo importa cuando la persona no tenía salario conocido
            // (ver el manejador de "monthly_salary" arriba); el servidor lo
            // ignora si ya conoce el salario real de esa persona.
            monthly_salary: f.monthly_salary || undefined,
          })),
          plan_recursos_gastos: gastos.map((g) => ({ description: g.descripcion, amount: g.monto })),
        }),
      });
      // Proyecto creado de verdad: refresca todo lo que depende de
      // mp_centro_costo, igual que crear desde "+ Nuevo centro"
      // (initCentroForm en costeo-centros.js), y deja una confirmación
      // visible (ver renderSimuladorNuevo) — antes el formulario se
      // limpiaba en silencio y parecía que el clic no había hecho nada.
      await loadIndicadores();
      await loadAlertas();
      renderCentroCostosPanel();
      await populateEquipoGastoCentroSelect();
      await loadComercial();
      // Si alguna fila "por Persona" traía salario nuevo, el servidor la
      // dio de alta en Equipo del Proyecto (data.equipo_creado) — se
      // refresca esa pantalla para que no haya que salir y volver a entrar
      // a verlo.
      if (data.equipo_creado) await loadEquipoYGastos();
      simulador.exito = { project_name: m.project_name, codigo: data.codigo, budget: data.budget };
      renderSimulador();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }, 'Creando…');
}

// "+ Agregar al equipo" (28 ago 2026, a pedido explícito): un rol que se
// suma con "+ Agregar rol" en el simulador es solo un ensayo — no toca la
// base de datos. Si el PM decide que sí lo va a contratar, esto lo manda
// directo al formulario real de Equipo del Proyecto (mismo Centro de
// Costos que se está simulando) con el Cargo y el Costo/hora YA puestos —
// los mismos con los que venía probando — para que solo falte elegir o
// escribir quién. No agrega nada por sí solo: el PM todavía tiene que
// completar el Talento y darle "Agregar al equipo" allá.
function irAAgregarAlEquipoReal(f) {
  if (!f.role_catalog) {
    alert('Elige primero el cargo de esta fila para poder llevarlo a Equipo del Proyecto.');
    return;
  }
  if (!(f.costo_hora > 0)) {
    alert('Define primero el costo/hora de esta fila para poder llevarlo a Equipo del Proyecto.');
    return;
  }
  showPanel('equipo-gastos');
  switchEgSubtab('equipo-proyecto');
  abrirEquipoModal();
  document.getElementById('cst-equipo-centro').value = simulador.cost_center_id;
  document.getElementById('cst-equipo-role').value = f.role_catalog;
  document.getElementById('cst-equipo-hourly-cost').value = f.costo_hora;
  // Si la fila ya traía horas planeadas puestas en el simulador, se llevan
  // también — no hay que volver a escribirlas en el alta real.
  if (f.horas_planeadas) {
    document.getElementById('cst-equipo-horas-planeadas').value = f.horas_planeadas;
  }
  // Si la fila ya traía una persona real elegida, se lleva también — así no
  // hay que volver a buscarla en el selector de Talento.
  if (f.employee_id) {
    document.getElementById('cst-equipo-employee').value = String(f.employee_id);
    document.getElementById('cst-equipo-employee').dispatchEvent(new Event('change'));
  }
  document.getElementById('cst-equipo-employee').focus();
}

function initSimulador() {
  const cont = document.getElementById('cst-com-simulador-body');
  cont.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sim]');
    if (!btn || !simulador) return;
    // 'rol-add'/'reset' no traen data-i (no son de una fila puntual);
    // el resto sí, y f queda undefined para esos dos casos, sin problema
    // porque ninguno de los dos lo usa.
    const i = Number(btn.dataset.i);
    const f = simulador.filas[i];
    switch (btn.dataset.sim) {
      // + Agregar rol (28 ago 2026, a pedido explícito): un simulador de
      // "¿y si contrato a alguien que hoy no está en el equipo?" tiene que
      // poder sumar un rol que todavía no existe en el proyecto, no solo
      // mover a los que ya están.
      // `nuevo: true` distingue esta fila (una que el usuario agregó a
      // mano en el escenario) de las que vinieron de p.equipo_por_cargo
      // (el equipo REAL, ya contratado) — solo las nuevas ofrecen
      // "+ Agregar al equipo real" en la tabla (ver renderSimulador). Arranca
      // sin costo/hora: ya no hay forma de teclearlo a mano (3 sep 2026, a
      // pedido explícito) — sale solo al elegir la persona real.
      case 'rol-add': simulador.filas.push({ role_catalog: '', employee_id: null, costo_hora: 0, nuevo: true }); break;
      case 'rol-remove': simulador.filas.splice(i, 1); break;
      // Navega a otro panel — no hay nada que re-renderizar aquí encima.
      case 'rol-contratar': irAAgregarAlEquipoReal(f); return;
      // El tiempo se mueve en horas, no en semanas (mismo criterio que
      // horas_totales en el Plan de Recursos) — de a 10 horas por clic,
      // porque un paso de 1 hora tardaría una eternidad en un proyecto de
      // cientos de horas restantes.
      case 'horas-': simulador.horas = Math.max(0, simulador.horas - 10); break;
      case 'horas+': simulador.horas += 10; break;
      // Presupuesto y contrato se mueven de a $1.000.000: son cifras de
      // millones, un paso de $100 (como costo/hora) tardaría una eternidad
      // a punta de clics. Para el valor exacto, se escribe directo.
      case 'presupuesto-': simulador.presupuesto = Math.max(0, simulador.presupuesto - 1_000_000); break;
      case 'presupuesto+': simulador.presupuesto += 1_000_000; break;
      case 'contrato-': simulador.contractValue = Math.max(0, simulador.contractValue - 1_000_000); break;
      case 'contrato+': simulador.contractValue += 1_000_000; break;
      case 'reset': resetSimulador(); break;
      default: return;
    }
    renderSimulador();
  });

  // Los mismos valores también se pueden escribir directo en el campo, sin
  // depender de dar clic muchas veces en +/-. Se aplica en 'change' (al salir
  // del campo o Enter), no en cada tecla — si se re-renderizara en cada
  // pulsación, el input perdería el foco a media escritura.
  cont.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-sim-input]');
    if (!input || !simulador) return;
    // El rol es texto (un <select>, no un número) — se resuelve aparte,
    // antes de la conversión numérica de abajo, que lo volvería NaN/0.
    if (input.dataset.simInput === 'role_catalog') {
      const f = simulador.filas[Number(input.dataset.i)];
      f.role_catalog = input.value;
      renderSimulador();
      return;
    }
    // Persona real elegida: costo/hora sale de su salario real (mismo
    // criterio que "+ Nuevo proyecto" — ver costoHoraDeEmpleado en
    // costeo-core.js). Ya no hay forma de teclear un costo/hora a mano (3
    // sep 2026, a pedido explícito): sin persona elegida, la fila
    // simplemente no tiene costo todavía.
    if (input.dataset.simInput === 'employee_id') {
      const f = simulador.filas[Number(input.dataset.i)];
      const employeeId = input.value ? Number(input.value) : null;
      f.employee_id = employeeId;
      f.monthly_salary = null;
      f.sinSalarioConocido = false;
      f.costo_hora = 0;
      if (employeeId) {
        const costoHora = await costoHoraDeEmpleado(employeeId);
        f.costo_hora = costoHora || 0;
        f.sinSalarioConocido = !costoHora;
      }
      renderSimulador();
      return;
    }
    if (input.dataset.simInput === 'monthly_salary') {
      const f = simulador.filas[Number(input.dataset.i)];
      const monthlySalary = desformatearMiles(input.value);
      f.monthly_salary = monthlySalary || null;
      f.costo_hora = monthlySalary ? Math.round(monthlySalary / (state.horasMes || 210)) : 0;
      renderSimulador();
      return;
    }
    // Horas planeadas de ESA persona en el proyecto (3 sep 2026, a pedido
    // explícito: "yo puedo trabajar 50 horas, otra persona 35, otra 10") —
    // informativo, no toca burnPorHora/costoProyectado (que siguen midiendo
    // "todo el equipo a la vez" con las horas restantes del proyecto): esto
    // es la comparación persona por persona, "Costo planeado total" abajo de
    // la tabla.
    if (input.dataset.simInput === 'horas_planeadas') {
      const f = simulador.filas[Number(input.dataset.i)];
      const horas = Number(input.value);
      f.horas_planeadas = horas > 0 ? horas : null;
      renderSimulador();
      return;
    }
    // "presupuesto"/"contrato" vienen formateados con puntos de miles
    // ("9.800") — desformatearMiles les quita los puntos; Number(input.value)
    // directo daría NaN.
    const MONETARIOS = ['presupuesto', 'contrato'];
    const crudo = MONETARIOS.includes(input.dataset.simInput) ? desformatearMiles(input.value) : Number(input.value);
    const valor = Math.max(Number(input.min) || 0, Number(crudo) || 0);
    if (input.dataset.simInput === 'horas') {
      simulador.horas = valor;
    } else if (input.dataset.simInput === 'presupuesto') {
      simulador.presupuesto = valor;
    } else if (input.dataset.simInput === 'contrato') {
      simulador.contractValue = valor;
    }
    renderSimulador();
  });

  // ---- Modo "+ Nuevo proyecto" ----
  document.getElementById('cst-sim-proyecto').addEventListener('change', () => {
    simulador = null; // fuerza a reconstruir según el valor nuevo del select
    renderSimulador();
  });

  cont.addEventListener('click', (e) => {
    if (!simulador || !simulador.esNuevo) return;
    if (e.target.closest('[data-simn-cerrar]')) {
      simulador = nuevoProyectoDefaults();
      renderSimulador();
      return;
    }
    if (e.target.closest('[data-simn-add]')) {
      simulador.filas.push({ role_catalog: '', employee_id: null, personas: 1, horas_totales: 0, costo_hora: 0 });
      renderSimulador();
      return;
    }
    const removeBtn = e.target.closest('[data-simn-remove]');
    if (removeBtn) {
      simulador.filas.splice(Number(removeBtn.dataset.simnRemove), 1);
      renderSimulador();
      return;
    }
    if (e.target.closest('[data-simn-gasto-add]')) {
      simulador.gastos.push({ descripcion: '', monto: 0 });
      renderSimulador();
      return;
    }
    const removeGastoBtn = e.target.closest('[data-simn-gasto-remove]');
    if (removeGastoBtn) {
      simulador.gastos.splice(Number(removeGastoBtn.dataset.simnGastoRemove), 1);
      renderSimulador();
      return;
    }
    const accionBtn = e.target.closest('[data-simn-accion]');
    if (!accionBtn) return;
    if (accionBtn.dataset.simnAccion === 'simular') {
      simulador.revelado = true;
      refrescarCalculosNuevo(cont);
    } else if (accionBtn.dataset.simnAccion === 'agregar') {
      crearProyectoDesdeSimulador(cont);
    }
  });

  // Se actualizan solo los números derivados (refrescarCalculosNuevo), NO se
  // reconstruye el formulario: así el campo que estás editando no desaparece
  // bajo el cursor y basta un clic para pasar al siguiente.
  cont.addEventListener('change', async (e) => {
    if (!simulador || !simulador.esNuevo) return;
    const metaInput = e.target.closest('[data-simn-meta]');
    if (metaInput) {
      const campo = metaInput.dataset.simnMeta;
      simulador.meta[campo] = campo === 'contract_value' ? desformatearMiles(metaInput.value) : metaInput.value;
      refrescarCalculosNuevo(cont);
      return;
    }
    const filaInput = e.target.closest('[data-simn-input]');
    if (!filaInput) return;
    const i = Number(filaInput.dataset.i);
    const campo = filaInput.dataset.simnInput;
    if (campo === 'employee_id') {
      const employeeId = filaInput.value ? Number(filaInput.value) : null;
      const fila = simulador.filas[i];
      fila.employee_id = employeeId;
      fila.monthly_salary = null;
      fila.sinSalarioConocido = false;
      if (employeeId) {
        // "Por Persona": 1 persona real, el costo/hora sale de su salario
        // conocido — no se escribe a mano ni se estima con la tarifa del cargo.
        fila.personas = 1;
        const costoHora = await costoHoraDeEmpleado(employeeId);
        fila.costo_hora = costoHora || 0;
        // Sin salario conocido en ningún proyecto (2 sep 2026): en vez de
        // bloquear con un toast, la fila pasa a modo "escribe el salario
        // aquí mismo" (ver renderSimuladorNuevo) — el servidor lo usa para
        // calcular el costo/hora Y da de alta a la persona en Equipo del
        // Proyecto al crear el centro.
        fila.sinSalarioConocido = !costoHora;
      }
      renderSimulador();
      return;
    }
    if (campo === 'monthly_salary') {
      const fila = simulador.filas[i];
      const monthlySalary = desformatearMiles(filaInput.value);
      fila.monthly_salary = monthlySalary || null;
      // Vista previa en el navegador — el servidor recalcula esto mismo al
      // crear el proyecto (valorHoraDesdeSalario en costo-recargos.js), así
      // que no debería divergir salvo que alguien cambie el divisor de la
      // fórmula justo mientras se llena el formulario.
      fila.costo_hora = monthlySalary ? Math.round(monthlySalary / (state.horasMes || 210)) : 0;
      const hint = cont.querySelector(`[data-simn-salario-hint="${i}"]`);
      if (hint) hint.textContent = monthlySalary ? `≈ ${formatCOP(fila.costo_hora)}/h` : 'sin salario conocido — escríbelo aquí';
      refrescarCalculosNuevo(cont);
      return;
    }
    const valor = campo === 'costo_hora' ? desformatearMiles(filaInput.value) : (campo === 'role_catalog' ? filaInput.value : Number(filaInput.value) || 0);
    simulador.filas[i][campo] = valor;
    refrescarCalculosNuevo(cont);
  });

  cont.addEventListener('change', (e) => {
    if (!simulador || !simulador.esNuevo) return;
    const gastoInput = e.target.closest('[data-simn-gasto]');
    if (!gastoInput) return;
    const i = Number(gastoInput.dataset.i);
    const campo = gastoInput.dataset.simnGasto;
    simulador.gastos[i][campo] = campo === 'monto' ? (desformatearMiles(gastoInput.value) || 0) : gastoInput.value;
    refrescarCalculosNuevo(cont);
  });
}

// Comercial tenía su propio selector de proyecto (cst-com-f-proyecto),
// porque el filtro global estaba OCULTO en este panel desde el 28 ago 2026
// — nunca recortaba la tabla, así que tener dos controles distintos era la
// única forma de que uno de verdad filtrara.
//
// Desde el 10 sep 2026 el selector global vive en el encabezado y se ve en
// todas las pantallas, incluida esta: dejar el de Comercial habría puesto
// dos desplegables idénticos ("Proyecto / Todos los proyectos") a dos
// centímetros uno del otro. Se eliminó el local y renderComercial() pasó a
// leer el global, que ahora SÍ recorta esta tabla.

// Control presupuestario (7 sep 2026, a pedido explícito): Presupuesto vs.
// Costo Estimado (Plan de Recursos + Gastos) es una pregunta APARTE de si el
// proyecto es "Viable" — un centro interno sin contrato también puede
// pasarse de presupuesto, y uno con contrato altísimo puede ir sobrado en
// margen y aun así estar gastando más de lo que se autorizó. Semáforo
// simple: verde si no se ha pasado, rojo si sí, gris si no tiene
// presupuesto puesto (no hay contra qué comparar).
// El % ejecutado se muestra COMPLETO, sin topar (11 sep 2026: se probo con
// tope en 100 y se volvio atras a pedido explicito). La magnitud es el dato:
// un proyecto al 416% no esta en la misma situacion que uno al 105%, y con
// el tope los dos se veian igual. El exceso sobre el techo (416,65 - 100 =
// 316,65) sale en el title y en el detalle de la fila.
// Verde / ambar / rojo segun la banda, para que el numero y la pastilla de al
// lado digan lo mismo.
const COLOR_POR_ESTADO = {
  sin_riesgo: 'cst-value-green',
  en_riesgo: 'cst-value-orange',
  perdida: 'cst-value-red',
};

function pctEjecutadoTexto(p) {
  if (p.presupuesto_pct === null) return '—';
  return `${p.presupuesto_pct}%`;
}

function pctEjecutadoTitle(p) {
  if (p.presupuesto_pct === null) return 'Sin presupuesto registrado: no hay contra que comparar';
  if (p.presupuesto_excedido_pct === null) return `Ejecutado ${p.presupuesto_pct}% del presupuesto`;
  return `Ejecutado ${p.presupuesto_pct}% del presupuesto: excedido en ${p.presupuesto_excedido_pct}%`;
}

// El detalle de la fila habla en las MISMAS bandas que la pastilla (70 / 90,
// ver costo-comercial.js): antes decia "dentro de lo autorizado" para
// cualquier cosa que no pasara de 100, asi que un proyecto al 95% salia con
// la pastilla roja y el detalle tranquilizandolo.
function presupuestoLineaHTML(p) {
  if (p.presupuesto_pct === null) {
    return '<span class="emp-muted">Este centro no tiene presupuesto puesto — no se puede comparar.</span>';
  }
  const usado = `usado ${p.presupuesto_pct}% de ${formatCOP(p.budget)}`;
  if (p.presupuesto_excedido_pct !== null) {
    return `<span class="cst-value-red">Presupuesto: excedido en ${p.presupuesto_excedido_pct}% (${usado})</span>`;
  }
  if (p.presupuesto_pct > 90) {
    return `<span class="cst-value-red">Presupuesto: casi agotado, queda ${(100 - p.presupuesto_pct).toFixed(1)}% (${usado})</span>`;
  }
  if (p.presupuesto_pct > 70) {
    return `<span class="cst-value-orange">Presupuesto: en riesgo, queda ${(100 - p.presupuesto_pct).toFixed(1)}% (${usado})</span>`;
  }
  return `<span class="cst-value-green">Presupuesto: dentro de lo previsto (${usado})</span>`;
}

function renderComercial() {
  const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'ceo');

  const fProyecto = document.getElementById('cst-f-centro')?.value || '';
  const proyectos = state.comercial.proyectos.filter((p) => !fProyecto || String(p.cost_center_id) === String(fProyecto));
  // Esta pantalla compara COSTO ESTIMADO contra PRESUPUESTO, y nada mas (11
  // sep 2026, a pedido explicito): el valor de contrato es una funcion que
  // todavia no entra al sistema, asi que ni la utilidad ni el margen mandan
  // aqui. El backend los sigue calculando y devolviendo (ver
  // costo-comercial.js) para el dia que esa funcion exista; simplemente no
  // se pintan.
  const resumen = {
    costo_total: proyectos.reduce((s, p) => s + (Number(p.costo_estimado) || 0), 0),
    presupuesto_total: proyectos.reduce((s, p) => s + (Number(p.budget) || 0), 0),
    sin_riesgo: proyectos.filter((p) => p.estado === 'sin_riesgo').length,
    en_riesgo: proyectos.filter((p) => p.estado === 'en_riesgo').length,
    perdida: proyectos.filter((p) => p.estado === 'perdida').length,
    sin_presupuesto: proyectos.filter((p) => p.estado === 'no_aplica').length,
  };

  document.getElementById('cst-com-costo-total').textContent = formatCOP(resumen.costo_total);
  document.getElementById('cst-com-costo-sub').textContent = resumen.presupuesto_total > 0
    ? `de ${formatCOP(resumen.presupuesto_total)} presupuestados (${((resumen.costo_total / resumen.presupuesto_total) * 100).toFixed(1)}%)`
    : 'sin presupuesto registrado todavía';
  document.getElementById('cst-com-sin-presupuesto').textContent = String(resumen.sin_presupuesto);
  document.getElementById('cst-com-viables').textContent = String(resumen.sin_riesgo);
  document.getElementById('cst-com-riesgo').textContent = String(resumen.en_riesgo);
  document.getElementById('cst-com-no-viables').textContent = String(resumen.perdida);

  const tbody = document.getElementById('cst-com-tbody');
  const pag = paginar('comercial', proyectos);
  tbody.innerHTML = pag.items.map((p) => {
    // Sin presupuesto puesto no hay contra que comparar: la fila lo dice con
    // un guion en vez de inventar un 0%.
    const sinPresupuesto = p.presupuesto_pct === null;
    return `
    <tr>
      <td>${escapeHtml(p.project_name)}</td>
      <td>${p.budget > 0 ? formatCOP(p.budget) : '—'}</td>
      <td>${formatCOP(p.costo_estimado)}</td>
      <td class="${COLOR_POR_ESTADO[p.estado] || ''}" title="${escapeHtml(pctEjecutadoTitle(p))}">${pctEjecutadoTexto(p)}</td>
      <td><span class="cst-estado-pill estado-${p.estado}">${escapeHtml(ESTADO_LABEL[p.estado])}</span></td>
      <td class="cst-com-acciones">
        ${(isAdmin || state.user?.role === 'leader') ? `<button type="button" class="btn-ghost" data-com-editar="${p.cost_center_id}">Editar</button>` : ''}
        <button type="button" class="btn-ghost cst-com-info-btn" data-com-info="${p.cost_center_id}" title="Ver diagnóstico">ⓘ</button>
      </td>
    </tr>
    <tr class="cst-com-detalle" id="cst-com-detalle-${p.cost_center_id}" hidden>
      <td colspan="6">
        <div class="cst-com-detalle-body">
          <span><strong>Costo Estimado:</strong> ${formatCOP(p.costo_estimado)} <span class="emp-muted">(Recursos ${formatCOP(p.costo_recursos)} + Gastos ${formatCOP(p.costo_gastos)})</span></span>
          ${presupuestoLineaHTML(p)}
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="emp-muted">Sin centros de costos todavía.</td></tr>';
  pintarPaginacion('comercial', pag, tbody);

  renderRankingComercial();
}

// Ranking de proyectos: cuadro aparte de "Estado real de los proyectos" y de
// la tabla completa — un vistazo rápido a los 3 mejores y los 3 peores por
// margen, sin tener que leer fila por fila. Siempre usa el PORTAFOLIO
// completo (state.comercial.proyectos, no el recortado por el filtro):
// un ranking de un solo proyecto no dice nada.
function renderRankingComercial() {
  const topEl = document.getElementById('cst-com-ranking-top');
  const bottomEl = document.getElementById('cst-com-ranking-bottom');
  if (!topEl || !bottomEl || !state.comercial) return;

  // Se ordena por EJECUCION PRESUPUESTAL, no por margen (11 sep 2026, a
  // pedido explicito: el valor de contrato todavia no entra al sistema).
  // Quedan fuera los centros sin presupuesto puesto: no tienen contra que
  // compararse, y ponerlos en cero los dejaba liderando "con mas holgura"
  // por un dato que falta, no por buena ejecucion.
  const conPresupuesto = state.comercial.proyectos.filter((p) => p.presupuesto_pct !== null);
  const vacio = '<li class="emp-muted">Sin proyectos con presupuesto registrado todavía.</li>';
  if (!conPresupuesto.length) {
    topEl.innerHTML = vacio;
    bottomEl.innerHTML = vacio;
    return;
  }

  const itemHTML = (p) => `
    <li>
      <span class="cst-com-ranking-nombre">${escapeHtml(p.project_name)}</span>
      <span class="cst-estado-pill estado-${p.estado}">${escapeHtml(ESTADO_LABEL[p.estado])}</span>
      <span class="cst-com-ranking-margen" title="${escapeHtml(pctEjecutadoTitle(p))}">ejecutado <b>${pctEjecutadoTexto(p)}</b></span>
    </li>`;

  // De menor a mayor % ejecutado: el primero es el que mas holgura le queda.
  const ordenados = [...conPresupuesto].sort((a, b) => a.presupuesto_pct - b.presupuesto_pct);

  // Con 3 proyectos o menos, "los 3 mejores" y "los 3 peores" son la misma
  // lista al revés — mostrarla dos veces solo confunde. Se deja un solo
  // lado con todo, y el otro con una nota en vez de repetir.
  if (ordenados.length <= 3) {
    topEl.innerHTML = ordenados.map(itemHTML).join('');
    bottomEl.innerHTML = '<li class="emp-muted">Con 3 proyectos o menos, el ranking completo ya se ve a la izquierda.</li>';
    return;
  }

  topEl.innerHTML = ordenados.slice(0, 3).map(itemHTML).join('');
  bottomEl.innerHTML = ordenados.slice(-3).reverse().map(itemHTML).join('');
}

async function loadComercial() {
  const data = await fetchJSON(`/api/costeo/comercial${filtrosQuery({ incluirRecurso: false })}`);
  state.comercial = data;
  renderComercial();
  populateSimuladorProyectoSelect();
  renderSimulador();
}

function initComercial() {
  // El cambio del selector de Proyecto lo escucha costeo-nav.js (es el
  // filtro global del encabezado), que llama a renderComercial() entre lo
  // que repinta. No hace falta un listener propio aquí.
  document.getElementById('cst-com-tbody').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-com-editar]');
    const infoBtn = e.target.closest('[data-com-info]');
    if (editBtn) {
      showPanel('centro-costos');
      abrirEdicionCentro(editBtn.dataset.comEditar);
    } else if (infoBtn) {
      const fila = document.getElementById(`cst-com-detalle-${infoBtn.dataset.comInfo}`);
      if (fila) fila.hidden = !fila.hidden;
    }
  });

  // Análisis con IA — pausado a pedido (24 ago 2026), no se construye por
  // ahora. Bloque comentado en costeo.html; estos listeners van comentados
  // también para no romper el resto del arranque intentando enganchar
  // elementos que ya no existen en el DOM.
  // document.getElementById('cst-com-ia-analizar').addEventListener('click', () => {
  //   document.getElementById('cst-com-ia-msg').textContent = 'El análisis con IA todavía no está conectado — próximamente.';
  // });
  // document.getElementById('cst-com-ia-ajustes').addEventListener('click', () => {
  //   document.getElementById('cst-com-ia-msg').textContent = 'Los ajustes del análisis con IA todavía no están disponibles — próximamente.';
  // });
}

