'use strict';

/**
 * Comercial — ¿el proyecto le genera utilidad a GTC, o se está comiendo el
 * margen? Solo aplica a centros con contract_value (cliente externo); los
 * centros internos (Management, Talento Humano, etc.) no tienen valor de
 * contrato, así que no se les calcula utilidad — solo se controla su gasto.
 *
 * Rediseñado 7 sep 2026, a pedido explícito del dueño de la empresa —
 * antes de esto, el Margen/Estado se calculaba con lo YA ejecutado (horas
 * reales + ritmo de gasto), lo que dejaba a cualquier proyecto sin
 * ejecución todavía en 100% "Viable" aunque su Plan de Recursos YA
 * prometiera gastar más de lo que el contrato cubre (Document Online, GTC
 * Project... tenían equipo asignado y ni así se notaba el riesgo). Ahora
 * tres cosas separadas, cada una con su propio propósito:
 *
 * 1. Presupuesto — control presupuestario puro: se compara contra el Costo
 *    Estimado (punto 2) para avisar si el plan ya se pasó del presupuesto
 *    autorizado, sin esperar a que el dinero se haya gastado de verdad.
 * 2. Costo Estimado = Recursos (mp_plan_recursos — el mismo "Subtotal
 *    equipo" que ya se ve en el panel de Plan de Recursos: personas ×
 *    horas_totales × costo_hora) + Gastos (mp_plan_recursos_gasto, los
 *    "Gastos iniciales" del mismo panel, + Costo No Planeado ya APROBADO).
 *    Es el costo total que el proyecto tiene comprometido, haya empezado a
 *    ejecutar o no.
 *
 *    OJO — no confundir con ind17.costo_planeado_mano_obra: ese lee
 *    mp_equipo_proyecto.planned_hours, un campo que solo se llena editando
 *    "Horas planeadas" a mano en Equipo del Proyecto — NO es lo que guarda
 *    este panel. guardarPlanRecursosTx() solo sincroniza mp_equipo_proyecto
 *    cuando la fila trae un salario NUEVO (sql/34); para alguien que ya
 *    tenía tarifa conocida, el plan se guarda en mp_plan_recursos pero
 *    nunca toca mp_equipo_proyecto. Usar ind17 aquí dejaba a cualquier plan
 *    armado con gente YA conocida (el caso normal) en $0 de Recursos — bug
 *    real, reportado por el usuario el 8 sep 2026 con un caso concreto.
 * 3. Margen = (Valor del Contrato − Costo Estimado) / Valor del Contrato.
 *    Se sigue calculando y mostrando como dato informativo, pero YA NO
 *    clasifica el estado del proyecto (ver más abajo).
 *
 * Estado real del proyecto (10 sep 2026, a pedido explícito de la dueña de
 * la empresa) — antes "Viable / Viable con riesgo / No viable" salía del
 * Margen, lo que dejaba a cualquier centro interno (sin contract_value) sin
 * clasificación ("no aplica"), y una empresa sí puede evaluar un proyecto
 * interno: solo no puede hacerlo por rentabilidad, porque no hay cliente de
 * por medio. Presupuesto en cambio existe en TODOS los centros, con o sin
 * contrato, así que el estado ahora es Ejecución Presupuestal puro:
 * Costo Estimado (punto 2, lo comprometido) / Presupuesto autorizado.
 *   Dentro del presupuesto -> ≤ 70%.
 *   En riesgo              -> 71%-90%.
 *   Sobre ejecutado        -> 91% o más (incluye todo lo que pasa de 100).
 *   No aplica              -> el centro no tiene presupuesto puesto (nada contra qué comparar).
 *
 * Umbrales nuevos del 11 sep 2026, a pedido explícito: antes la alarma
 * empezaba recién al pasar el techo (100% / 120%), o sea cuando el problema
 * ya estaba hecho. Con 70/90 el aviso llega mientras todavía queda margen de
 * maniobra — que es para lo que sirve un indicador de gasto comprometido.
 *
 * ejecutado_total, ritmo_gasto_semanal y semanas_restantes se siguen
 * calculando y devolviendo igual que antes: el Simulador de recursos
 * (costeo-comercial.js) los necesita para su propia proyección "¿qué pasa
 * si...?", que es un cálculo aparte del Margen/Estado de aquí.
 */

const { query } = require('../db');
const { computeIndicadores17 } = require('./costo-indicadores-17');
const { costoNoPlaneadoTotal } = require('./costo-motor');
const { getPlanRecursos, getPlanRecursosGastos } = require('./costo-plan-recursos');

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// Equipo activo del centro, persona por persona — es el punto de partida del
// Simulador de recursos ("¿qué pasa si subo/bajo gente de este rol?"). Antes
// se agrupaba por cargo (COUNT + AVG), lo que promediaba el costo/hora y
// hacía desaparecer a las personas reales de la vista — el simulador de un
// proyecto con equipo ya asignado no mostraba QUIÉN estaba ahí ni su costo
// real, solo un cargo genérico. Ahora cada fila es un integrante real, con
// su nombre y su tarifa real (no un promedio), igual que ya se veía en
// Equipo del Proyecto. Solo cuenta a quien ya tiene tarifa (hourly_cost > 0);
// los cargados sin tarifa todavía no aportan costo, así que no tendría
// sentido simularlos.
async function getEquipoReal(costCenterId) {
  return query(
    `SELECT ep.employee_id, e.canonical_name, ep.role_catalog, ep.hourly_cost, ep.planned_hours
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
      WHERE ep.cost_center_id = ? AND ep.is_active = 1 AND ep.hourly_cost > 0
      ORDER BY e.canonical_name`,
    [costCenterId]
  );
}

// Estado real = Ejecucion Presupuestal, umbrales fijos y del negocio (no
// configurables), igual para todo el portafolio, con o sin contrato: 70%
// para empezar a mirar, 90% para actuar (ver cabecera del archivo).
// Separada de computeComercial() para poder probar los limites sin base.
function estadoPresupuestal(presupuestoPct) {
  if (presupuestoPct === null || presupuestoPct === undefined) return 'no_aplica';
  if (presupuestoPct <= 70) return 'sin_riesgo';
  if (presupuestoPct <= 90) return 'en_riesgo';
  return 'perdida';
}

async function computeComercial(centro, filters) {
  const [ind17, gastosNoPlaneadosAprobados, planFilas, planGastos] = await Promise.all([
    computeIndicadores17(centro, filters),
    costoNoPlaneadoTotal(centro.cost_center_id, filters),
    getPlanRecursos(centro.cost_center_id),
    getPlanRecursosGastos(centro.cost_center_id),
  ]);
  const ejecTotal = ind17.ejecutado_total;

  let semanasRestantes = 0;
  if (centro.planned_end_date) {
    const restante = new Date(centro.planned_end_date).getTime() - Date.now();
    if (restante > 0) semanasRestantes = restante / MS_PER_WEEK;
  }

  // Costo Estimado = Recursos (mp_plan_recursos: personas × horas_totales ×
  // costo_hora — el "Subtotal equipo" del panel de Plan de Recursos) +
  // Gastos (mp_plan_recursos_gasto, los "Gastos iniciales" del mismo panel,
  // más el Costo No Planeado ya aprobado). No depende de que el proyecto
  // haya empezado a ejecutar — un centro recién creado, con un plan armado
  // pero 0 horas cargadas, YA tiene un costo estimado real.
  const costoRecursos = planFilas.reduce(
    (s, f) => s + (Number(f.personas) || 0) * (Number(f.horas_totales) || 0) * (Number(f.costo_hora) || 0), 0
  );
  const costoGastosIniciales = planGastos.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  const costoGastos = costoGastosIniciales + gastosNoPlaneadosAprobados;
  const costoEstimado = costoRecursos + costoGastos;

  const budget = Number(centro.budget) || 0;
  // Presupuesto vs Costo Estimado: base del Estado real del proyecto (ver
  // cabecera del archivo). Se calcula para TODOS los centros con
  // presupuesto > 0, tengan o no contrato.
  const presupuestoPct = budget > 0 ? Number(((costoEstimado / budget) * 100).toFixed(1)) : null;
  const presupuestoExcedidoPct = presupuestoPct !== null && presupuestoPct > 100
    ? Number((presupuestoPct - 100).toFixed(1)) : null;

  const contractValue = centro.contract_value !== null && centro.contract_value !== undefined
    ? Number(centro.contract_value) : null;

  // Margen: sigue siendo informativo (se muestra en la tabla), pero ya no
  // decide el estado del proyecto — solo aplica a centros con contrato.
  let utilidad = null;
  let margenPct = null;
  if (contractValue !== null && contractValue > 0) {
    utilidad = contractValue - costoEstimado;
    margenPct = (utilidad / contractValue) * 100;
  }

  const estado = estadoPresupuestal(presupuestoPct);

  return {
    cost_center_id: centro.cost_center_id,
    project_name: centro.project_name,
    contract_value: contractValue,
    costo_estimado: Number(costoEstimado.toFixed(2)),
    costo_recursos: Number(costoRecursos.toFixed(2)),
    costo_gastos: Number(costoGastos.toFixed(2)),
    utilidad: utilidad !== null ? Number(utilidad.toFixed(2)) : null,
    margen_pct: margenPct !== null ? Number(margenPct.toFixed(2)) : null,
    estado,
    budget,
    presupuesto_pct: presupuestoPct,
    presupuesto_excedido_pct: presupuestoExcedidoPct,
    // Insumos del Simulador de recursos: para poder recalcular la proyección
    // con otro equipo hay que partir de lo ya ejecutado (que no cambia), de
    // las semanas que faltan y del presupuesto/valor de contrato reales —
    // todo lo que el simulador deja mover parte de aquí. Es un cálculo
    // aparte del Margen/Estado de arriba (el simulador SÍ quiere partir de
    // lo realmente ejecutado, no del plan).
    ejecutado_total: Number(ejecTotal.toFixed(2)),
    semanas_restantes: Number(semanasRestantes.toFixed(1)),
    ritmo_gasto_semanal: ind17.ind5_ritmo_gasto_semanal,
    equipo_por_cargo: (await getEquipoReal(centro.cost_center_id)).map((r) => ({
      role_catalog: r.role_catalog,
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      personas: 1,
      costo_hora: Number(r.hourly_cost),
      // Horas planeadas ya guardadas en Equipo del Proyecto (sql/35) — el
      // simulador parte de ahí en vez de arrancar en blanco cada vez.
      horas_planeadas: r.planned_hours !== null ? Number(r.planned_hours) : null,
    })),
  };
}

module.exports = { computeComercial, estadoPresupuestal };
