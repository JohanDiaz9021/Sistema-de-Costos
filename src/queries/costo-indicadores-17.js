'use strict';

/**
 * Fase 2.5 — Los 17 indicadores de Costeo, fórmula exacta según
 * "Herramienta de Costeo GTC — Especificación Técnica" sección 6/9
 * y "Monitoreo de Costos — Especificación Maestra" sección 9.
 *
 * Todos se recalculan en vivo sobre mp_task_facts (vía weeklyAggregate),
 * mp_equipo_proyecto, mp_overtime_decisions, mp_costo_no_planeado y
 * mp_centro_costo — nunca sobre un snapshot guardado.
 *
 * computeIndicadores17(centro) calcula un solo centro; computeIndicadoresPortafolio(centros)
 * agrega correctamente varios centros a la vez (sumas reales, no promedios de
 * porcentajes ya redondeados) — es lo que ve el Administrador con el filtro
 * "Todos los proyectos".
 */

const { query } = require('../db');
const { weeklyAggregate } = require('./costo-weekly-hours');
const { desgloseEjecutado, mesYAnio, rangoMes } = require('./costo-motor');
const { memo, filtersKey } = require('../lib/request-cache');
const { cacheCompartida } = require('../lib/shared-cache');
// La fecha de quiebre (#4) es una fecha de calendario colombiana, no UTC:
// ver el porqué en src/lib/fecha-negocio.js.
const { fechaNegocioISO } = require('../lib/fecha-negocio');

// Scope sin restricción: el filtrado de qué centros puede VER el usuario ya
// ocurrió en la ruta; el cálculo interno de un indicador debe ser correcto
// sin importar quién lo esté consultando.
const UNRESTRICTED_SCOPE = { role: 'admin', allowedProjects: null };

// Filtros vacíos: la vista sin nada seleccionado.
const SIN_FILTROS = { month: null, week: null, project: null, employee_id: null, leader: null };


async function getCentroRows(costCenterIds, filters = SIN_FILTROS) {
  const ids = new Set(costCenterIds);
  // weeklyAggregate ya aplica mes/semana/talento vía baseWhere y
  // buildFilterClause: basta con pasarle los filtros en vez de {}. Cada fila
  // ya trae h_ejec/h_extra y costo_legal/costo_extra_potencial calculados
  // con la tarifa real del talento — no hace falta reprocesarlos aquí.
  const rows = await weeklyAggregate(UNRESTRICTED_SCOPE, filters);
  return rows.filter((r) => ids.has(r.cost_center_id));
}

async function getOvertimeRows(costCenterIds, filters = SIN_FILTROS, periodo = null) {
  if (!costCenterIds.length) return [];
  // Se pidió un mes explícito y mesYAnio() (quien llama a esta función) no
  // lo encontró en mp_costeo_task_facts — ej. "Junio", que solo existe en
  // la tabla de Planeación, nunca en la de Costeo. Sin este corte, el
  // `if (periodo)` de abajo simplemente no agregaba la condición de mes/año
  // y la query devolvía horas extra de TODA la historia bajo el nombre de
  // un mes que en realidad no tenía nada (8 sep 2026, reportado por el
  // usuario: "Junio" mostraba horas que no eran de junio).
  if (filters.month && !periodo) return [];
  const placeholders = costCenterIds.map(() => '?').join(',');
  const cond = [];
  const params = [...costCenterIds];
  if (filters.employee_id) { cond.push('AND employee_id = ?'); params.push(filters.employee_id); }
  if (filters.week) { cond.push('AND week_number = ?'); params.push(filters.week); }
  // month_number SIN year_number no identifica un periodo: week_number es la
  // semana del MES (ver sql/21), asi que "agosto semana 1" existe en cada
  // año. Filtrar solo por mes mezclaba las horas extra de agosto de todos
  // los años en el mismo indicador.
  if (periodo) {
    cond.push('AND month_number = ?'); params.push(periodo.month);
    cond.push('AND year_number = ?'); params.push(periodo.year);
  }

  return query(
    `SELECT decision_id, employee_id, week_number, month_number, year_number, pm_decision, approval_status,
            motivo, calidad, extra_cost_potential, extra_cost_final, extra_hours, fecha
       FROM mp_overtime_decisions
      WHERE cost_center_id IN (${placeholders}) ${cond.join(' ')}`,
    params
  );
}

async function getMayorGastoNoPlaneado(costCenterIds, filters = SIN_FILTROS, periodo = null) {
  if (!costCenterIds.length) return null;
  // Un gasto no planeado es del proyecto, no de una persona: al filtrar por
  // talento no hay ningún gasto que atribuirle (ver costoNoPlaneadoTotal).
  if (filters.employee_id) return null;

  const placeholders = costCenterIds.map(() => '?').join(',');
  const params = [...costCenterIds];
  let cond = '';
  // Rango de fechas en vez de MONTH(expense_date): incluye el año y ademas
  // deja que MySQL use el indice de expense_date (ver rangoMes en costo-motor).
  const rango = rangoMes(periodo);
  if (rango) {
    cond = ' AND expense_date >= ? AND expense_date < DATE_ADD(?, INTERVAL 1 MONTH)';
    params.push(rango.desde, rango.desde);
  }

  const rows = await query(
    `SELECT description, amount, expense_date FROM mp_costo_no_planeado
      WHERE cost_center_id IN (${placeholders}) AND approval_status = 'aprobado' ${cond}
      ORDER BY amount DESC LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// BUG DE INDICADORES (17 sep 2026): la clave era year*100 + week, pero
// week_number es la SEMANA DEL MES (ver sql/21) y month_number existe en toda
// fila — sin incluir el mes, enero-semana-3 y febrero-semana-3 colisionaban en
// el mismo bucket: #5 (burn rate) subestimaba las semanas, #16/#17 mezclaban
// la racha y la variación, y serie_semanal cruzaba meses. Con mes en la clave
// el orden numérico ES el orden cronológico (año > mes > semana).
function weekKey(month_number, week_number, year_number) {
  return year_number * 10000 + month_number * 100 + week_number;
}

function descomponerWeekKey(wk) {
  return {
    year: Math.floor(wk / 10000),
    month: Math.floor(wk / 100) % 100,
    week: wk % 100,
  };
}

// #7 — Personas Trabajando en el Proyecto (3 sep 2026, a pedido explícito).
// Antes contaba talentos con horas REGISTRADAS (empleadosConHoras, sobre
// mp_task_facts/weeklyAggregate) — un PM que acababa de sumar gente a Equipo
// del Proyecto no veía el número moverse hasta que esa persona cargara horas
// de verdad, y eso se leía como "el indicador no se actualiza". Ahora cuenta
// directo el equipo activo asignado (mp_equipo_proyecto), que responde al
// instante a cualquier alta/baja en esa pantalla — igual que ya hacían los
// demás indicadores que dependen de Equipo del Proyecto (#6 bus factor, #8
// costo real por hora).
async function getPersonasAsignadas(costCenterIds, filters = SIN_FILTROS) {
  if (!costCenterIds.length) return 0;
  const placeholders = costCenterIds.map(() => '?').join(',');
  const params = [...costCenterIds];
  let cond = '';
  if (filters.employee_id) { cond = ' AND ep.employee_id = ?'; params.push(filters.employee_id); }
  // Las dos banderas de activo importan aparte: ep.is_active es la
  // asignación al centro (Editar > Activo en Equipo del Proyecto), pero
  // mp_employees.is_active es la persona misma (dado de baja del todo, ver
  // "Gestionar empleados"). Un talento de baja no debe contar como "gente
  // trabajando" solo porque nadie desactivó también su fila de equipo.
  const rows = await query(
    `SELECT COUNT(DISTINCT ep.employee_id) AS n
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
      WHERE ep.cost_center_id IN (${placeholders}) AND ep.is_active = 1 AND e.is_active = 1 ${cond}`,
    params
  );
  return Number(rows[0]?.n) || 0;
}

// Costo Planeado (mano de obra) — 3 sep 2026, a pedido explícito: "cuánto va
// a costar cada persona" según las horas que se le asignaron en Equipo del
// Proyecto (sql/35, planned_hours) — el equipo REAL y actual del proyecto,
// con su cargo y costo/hora ya ahí, así que las horas planeadas se editan en
// el mismo lugar donde ya se agrega/edita a cada persona (en vez de una
// pantalla aparte). Vive aparte de los 17 indicadores de la especificación
// original — vale la pena exponerlo igual porque es la comparación directa
// que un PM necesita: planeado (esto) vs. real (#8).
//
// Plan de Recursos (mp_plan_recursos) sigue existiendo como mecanismo
// aparte, solo para armar el presupuesto de un proyecto NUEVO desde cero
// ("+ Nuevo proyecto") — no alimenta este indicador, para no contar las
// mismas horas dos veces si algún día coinciden persona y rol en las dos
// tablas.
async function getCostoPlaneado(costCenterIds, filters = SIN_FILTROS) {
  if (!costCenterIds.length) return 0;
  const placeholders = costCenterIds.map(() => '?').join(',');
  const params = [...costCenterIds];
  let cond = '';
  if (filters.employee_id) { cond = ' AND ep.employee_id = ?'; params.push(filters.employee_id); }
  const rows = await query(
    `SELECT SUM(ep.planned_hours * ep.hourly_cost) AS total
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
      WHERE ep.cost_center_id IN (${placeholders}) AND ep.is_active = 1 AND e.is_active = 1
            AND ep.planned_hours IS NOT NULL ${cond}`,
    params
  );
  return Number(rows[0]?.total) || 0;
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// Núcleo compartido: calcula los 17 indicadores para el conjunto de
// cost_center_id dado, usando `meta` (nombre, presupuesto y fechas) como
// el "centro" — puede ser uno real o un agregado sintético de portafolio.
async function computeIndicadoresDesde(meta, costCenterIds, filters = SIN_FILTROS) {
  // El filtro de Periodo llega como nombre de mes; las tablas propias de
  // Costeo usan month_number, así que se traduce una sola vez y se reparte.
  const periodo = await mesYAnio(filters.month);

  const [rows, overtimeRows, desglosePorCentro, mayorGasto, personasAsignadas, costoPlaneado] = await Promise.all([
    getCentroRows(costCenterIds, filters),
    getOvertimeRows(costCenterIds, filters, periodo),
    Promise.all(costCenterIds.map((id) => desgloseEjecutado(id, filters))),
    getMayorGastoNoPlaneado(costCenterIds, filters, periodo),
    getPersonasAsignadas(costCenterIds, filters),
    getCostoPlaneado(costCenterIds, filters),
  ]);

  const ejecTotal = sum(desglosePorCentro.map((d) => d.total));
  const laboral = sum(desglosePorCentro.map((d) => d.laboral));
  const extraAprobado = sum(desglosePorCentro.map((d) => d.extra));
  const noPlaneadoTotal = sum(desglosePorCentro.map((d) => d.noPlaneado));
  const presupuesto = Number(meta.budget) || 0;

  // --- Totales agregados a nivel de fila (talento+semana) ---
  let sumHEjec = 0;
  let sumHExtra = 0;
  let sumHEjecCostoHora = 0; // para #8, costo real por hora (todas las horas)
  const costoPorEmpleado = new Map(); // #6 bus factor, sobre base "costo legal"
  const nombrePorEmpleado = new Map();
  const weeklyLaborCost = new Map(); // #5, #16, #17 — semana -> costo legal total
  const weeklyExtra = new Map(); // #17 — semana -> hExtra total

  // HALLAZGO (ago 2026, mientras se agregaba serie_semanal): este bucle leía
  // r.hourly_cost, un campo que weeklyAggregate() (costo-weekly-hours.js) ya
  // no expone — esa función ahora devuelve costo_legal y
  // costo_extra_potencial PRE-calculados con la tarifa real, no la tarifa
  // cruda. r.hourly_cost siempre daba undefined, así que costoHora siempre
  // era 0: #6 (Dependencia de una Sola Persona) y #8 (Costo Real por Hora)
  // llevaban tiempo mostrando 0%/$0 en producción sin que nada lo marcara
  // como error (una prueba nueva sobre serie_semanal lo destapó). h_ejec =
  // h_legal + h_extra siempre (por construcción, ver weeklyAggregate), así
  // que costo_legal + costo_extra_potencial = costo de TODAS las horas.
  for (const r of rows) {
    sumHEjec += r.h_ejec;
    sumHExtra += r.h_extra;
    sumHEjecCostoHora += r.costo_legal + r.costo_extra_potencial;

    const costoLegalFila = r.costo_legal;
    costoPorEmpleado.set(r.employee_id, (costoPorEmpleado.get(r.employee_id) || 0) + costoLegalFila);
    nombrePorEmpleado.set(r.employee_id, r.canonical_name);

    const wk = weekKey(r.month_number, r.week_number, r.year_number);
    weeklyLaborCost.set(wk, (weeklyLaborCost.get(wk) || 0) + costoLegalFila);
    weeklyExtra.set(wk, (weeklyExtra.get(wk) || 0) + r.h_extra);
  }

  // Horas extra registradas A MANO (3 sep 2026, a pedido explícito) — desde
  // el 2 sep 2026 esa es la ÚNICA vía para dar de alta horas extra (ver
  // createManualOvertime en costo-overtime.js): el Excel de Planeación ya no
  // las genera solo, así que estas filas NUNCA están en `rows`/weeklyAggregate
  // (que solo lee mp_costeo_task_facts). Sin este bloque, una hora extra
  // recién aprobada por el PM aparecía en el dinero ejecutado (#1, #5, que sí
  // leen mp_overtime_decisions directo) pero no en ningún indicador medido en
  // HORAS (#8, #9, #17) — el mismo hueco que #7 tenía con Equipo del
  // Proyecto, solo que aquí con Horas Extra.
  //
  // `fecha IS NOT NULL` es la marca de "alta manual": la vía RPA
  // (syncOvertimeDecisions, en desuso pero no borrada) nunca la llena. Se sale
  // a propósito para no sumar dos veces si algún día esa vía vuelve a usarse
  // sobre una semana que YA tiene esas horas en mp_costeo_task_facts.
  for (const ot of overtimeRows) {
    if (!ot.fecha || ot.approval_status !== 'aprobado') continue;
    const horas = Number(ot.extra_hours) || 0;
    if (!(horas > 0)) continue;
    sumHEjec += horas;
    sumHExtra += horas;
    sumHEjecCostoHora += Number(ot.extra_cost_final ?? ot.extra_cost_potential) || 0;
    const wk = weekKey(ot.month_number, ot.week_number, ot.year_number);
    weeklyExtra.set(wk, (weeklyExtra.get(wk) || 0) + horas);
  }

  const semanasConDatos = weeklyLaborCost.size || 1;

  // #1 — Presupuesto Ejecutado
  const presupuestoEjecutadoPct = presupuesto > 0 ? (ejecTotal / presupuesto) * 100 : null;

  // #2 — Tiempo Transcurrido
  let tiempoTranscurridoPct = null;
  let diasTranscurridos = null;
  let diasTotales = null;
  if (meta.start_date && meta.planned_end_date) {
    const inicio = new Date(meta.start_date).getTime();
    const fin = new Date(meta.planned_end_date).getTime();
    const hoy = Date.now();
    if (fin > inicio) {
      tiempoTranscurridoPct = Math.max(0, Math.min(100, ((hoy - inicio) / (fin - inicio)) * 100));
      const msPorDia = 24 * 60 * 60 * 1000;
      diasTotales = Math.round((fin - inicio) / msPorDia);
      diasTranscurridos = Math.max(0, Math.min(diasTotales, Math.round((hoy - inicio) / msPorDia)));
    }
  }

  // #3 — Ritmo de Gasto vs. Tiempo
  const ritmoVsTiempo = presupuestoEjecutadoPct !== null && tiempoTranscurridoPct !== null
    ? presupuestoEjecutadoPct - tiempoTranscurridoPct
    : null;

  // #5 — Ritmo de Gasto por Semana (burn rate: laboral + extra aprobado + no planeado, / semanas con datos)
  const burnRateSemanal = (laboral + extraAprobado + noPlaneadoTotal) / semanasConDatos;

  // #4 — Fecha de Quiebre Presupuestal
  let fechaQuiebre = null;
  let seQuedaSinPlataAntes = null;
  if (burnRateSemanal > 0 && presupuesto > 0) {
    const semanasRestantesParaAgotar = (presupuesto - ejecTotal) / burnRateSemanal;
    const instante = Date.now() + semanasRestantesParaAgotar * 7 * 24 * 60 * 60 * 1000;
    fechaQuiebre = fechaNegocioISO(instante);
    if (meta.planned_end_date) {
      // Se comparan las dos como fechas de CALENDARIO ('YYYY-MM-DD'), no
      // como instantes: en ISO el orden alfabético es el cronológico. Antes
      // se hacía `fecha.getTime() < new Date(planned_end_date).getTime()`,
      // que enfrentaba un instante real contra la medianoche UTC de la
      // fecha fin — el día del vencimiento, cualquier hora anterior a las
      // 7:00 p.m. de Colombia daba "se queda sin plata antes" siendo que
      // era justo el último día, no antes.
      seQuedaSinPlataAntes = fechaQuiebre < String(meta.planned_end_date).slice(0, 10);
    }
  }

  // #6 — Dependencia de una Sola Persona (bus factor). Se calcula si hay
  // personas con horas registradas, aunque su costo/hora todavía sea 0
  // (equipo sin tarifa asignada) — en ese caso el % simplemente da 0.
  let busFactorPct = 0;
  let busFactorEmployeeId = null;
  let mayorCosto = -1;
  for (const [empId, costo] of costoPorEmpleado.entries()) {
    if (costo > mayorCosto) {
      mayorCosto = costo;
      busFactorEmployeeId = empId;
    }
  }
  if (busFactorEmployeeId !== null && laboral > 0) {
    busFactorPct = (mayorCosto / laboral) * 100;
  }

  // #7 — Personas Trabajando en el Proyecto (ver getPersonasAsignadas arriba)

  // #8 — Costo Real por Hora
  const costoRealPorHora = sumHEjec > 0 ? sumHEjecCostoHora / sumHEjec : 0;

  // #9 — Proporción de Horas Extra
  const proporcionHorasExtraPct = sumHEjec > 0 ? (sumHExtra / sumHEjec) * 100 : 0;

  // #10 — Aprobación de Horas Extra
  const aprobadas = overtimeRows.filter((r) => r.approval_status === 'aprobado').length;
  const rechazadas = overtimeRows.filter((r) => r.approval_status === 'rechazado').length;
  const resueltas = aprobadas + rechazadas;
  const aprobacionHorasExtraPct = resueltas > 0 ? (aprobadas / resueltas) * 100 : null;

  // #11 — Trabajo No Remunerado (decision='no': la hora extra nunca se paga)
  const trabajoNoRemunerado = overtimeRows
    .filter((r) => r.pm_decision === 'no')
    .reduce((s, r) => s + Number(r.extra_cost_potential || 0), 0);
  const trabajoNoRemuneradoPct = presupuesto > 0 ? (trabajoNoRemunerado / presupuesto) * 100 : null;

  // #12 — Costo de los Errores (horas extra por bug/reproceso sobre el ejecutado total)
  const costoErroresValor = overtimeRows
    .filter((r) => r.calidad)
    .reduce((s, r) => s + Number(r.extra_cost_potential || 0), 0);
  const costoErroresPct = ejecTotal > 0 ? (costoErroresValor / ejecTotal) * 100 : 0;

  // #13 — Responsable del Sobrecosto (% interno vs externo, ponderado por hExtra)
  const conMotivo = overtimeRows.filter((r) => r.motivo);
  const totalHorasConMotivo = conMotivo.reduce((s, r) => s + Number(r.extra_cost_potential || 0), 0);
  const internoValor = conMotivo.filter((r) => r.motivo === 'interno').reduce((s, r) => s + Number(r.extra_cost_potential || 0), 0);
  const responsableSobrecostoInternoPct = totalHorasConMotivo > 0 ? (internoValor / totalHorasConMotivo) * 100 : null;

  // #14 — Qué Tan Predecible es el Gasto
  const gastoPredecriblePct = ejecTotal > 0 ? (noPlaneadoTotal / ejecTotal) * 100 : 0;

  // #15 — Gasto Más Grande Fuera de Plan
  const gastoMasGrande = mayorGasto ? { descripcion: mayorGasto.description, valor: Number(mayorGasto.amount) } : null;

  // #16 — Variación Semana a Semana (labor cost, últimas 2 semanas con datos)
  const semanasOrdenadas = [...weeklyLaborCost.keys()].sort((a, b) => b - a);
  let variacionSemanalPct = null;
  if (semanasOrdenadas.length >= 2) {
    const actual = weeklyLaborCost.get(semanasOrdenadas[0]);
    const anterior = weeklyLaborCost.get(semanasOrdenadas[1]);
    if (anterior > 0) variacionSemanalPct = ((actual - anterior) / anterior) * 100;
  }

  // #17 — Racha de Semanas con Horas Extra (consecutiva, desde la más reciente)
  let rachaSemanasHorasExtra = 0;
  for (const wk of semanasOrdenadas) {
    if ((weeklyExtra.get(wk) || 0) > 0) rachaSemanasHorasExtra += 1;
    else break;
  }

  // Serie semanal para el Panel Comparativo y los Gráficos (front): mismos
  // datos que ya usan #5/#16/#17, solo que expuestos como serie ordenada
  // cronológicamente en vez de reducidos a un solo número. Se limita a las
  // últimas 12 semanas con datos para no mandar el historial completo del
  // proyecto en cada respuesta.
  const serieSemanal = semanasOrdenadas
    .slice(0, 12)
    .reverse()
    .map((wk) => ({
      ...descomponerWeekKey(wk),
      costo_laboral: Number((weeklyLaborCost.get(wk) || 0).toFixed(2)),
      horas_extra: Number((weeklyExtra.get(wk) || 0).toFixed(2)),
    }));

  return {
    cost_center_id: meta.cost_center_id,
    project_name: meta.project_name,
    ejecutado_total: Number(ejecTotal.toFixed(2)),
    // presupuesto se repite aquí (además de venir en el centro) para que las
    // tarjetas de Indicadores puedan mostrar "45% ($X de $Y)" sin tener que
    // cruzar con state.centros — cada indicador queda armable solo con `i`.
    presupuesto: Number(presupuesto.toFixed(2)),
    ind1_presupuesto_ejecutado_pct: presupuestoEjecutadoPct,
    ind2_tiempo_transcurrido_pct: tiempoTranscurridoPct,
    ind2_dias_transcurridos: diasTranscurridos,
    ind2_dias_totales: diasTotales,
    ind3_ritmo_gasto_vs_tiempo: ritmoVsTiempo,
    ind4_fecha_quiebre_presupuestal: fechaQuiebre,
    ind4_se_queda_sin_plata_antes: seQuedaSinPlataAntes,
    ind5_ritmo_gasto_semanal: Number(burnRateSemanal.toFixed(2)),
    ind6_bus_factor_pct: Number(busFactorPct.toFixed(2)),
    ind6_bus_factor_employee_id: busFactorEmployeeId,
    ind6_bus_factor_employee_name: busFactorEmployeeId ? nombrePorEmpleado.get(busFactorEmployeeId) : null,
    ind7_personas_trabajando: personasAsignadas,
    ind8_costo_real_por_hora: Number(costoRealPorHora.toFixed(2)),
    ind9_proporcion_horas_extra_pct: Number(proporcionHorasExtraPct.toFixed(2)),
    ind9_horas_extra: Number(sumHExtra.toFixed(2)),
    ind9_horas_ejecutadas: Number(sumHEjec.toFixed(2)),
    ind10_aprobacion_horas_extra_pct: aprobacionHorasExtraPct,
    ind11_trabajo_no_remunerado: Number(trabajoNoRemunerado.toFixed(2)),
    ind11_trabajo_no_remunerado_pct: trabajoNoRemuneradoPct,
    ind12_costo_errores_pct: Number(costoErroresPct.toFixed(2)),
    ind12_costo_errores_valor: Number(costoErroresValor.toFixed(2)),
    ind13_responsable_sobrecosto_interno_pct: responsableSobrecostoInternoPct,
    ind13_horas_interno_valor: Number(internoValor.toFixed(2)),
    ind13_horas_con_motivo_valor: Number(totalHorasConMotivo.toFixed(2)),
    ind14_gasto_no_predecible_pct: Number(gastoPredecriblePct.toFixed(2)),
    ind15_gasto_mas_grande: gastoMasGrande,
    ind16_variacion_semanal_pct: variacionSemanalPct,
    ind17_racha_semanas_horas_extra: rachaSemanasHorasExtra,
    serie_semanal: serieSemanal,
    // Costo Planeado (mano de obra) — ver getCostoPlaneado arriba. No es uno
    // de los 17 de la especificación original; se agrega aparte para poder
    // comparar planeado (esto) vs. real (ind8_costo_real_por_hora * horas).
    costo_planeado_mano_obra: Number(costoPlaneado.toFixed(2)),
  };
}

// Memoizado en dos niveles: GET /alertas volvia a calcular, centro por centro,
// exactamente lo mismo que GET /indicadores-17 y que resolveExportContext ya
// habian calculado. El resultado es de solo lectura para todos sus
// consumidores (costo-alertas.js y costo-comercial.js solo lo leen), asi que
// compartir el mismo objeto es seguro.
//
//   memo()             -> dentro de esta peticion (una vez por centro).
//   cacheCompartida()  -> entre peticiones, con TTL corto y borrada en cada
//                         escritura; es la que evita que abrir Costeo pague
//                         dos veces el mismo calculo (ver shared-cache.js).
async function computeIndicadores17(centro, filters = SIN_FILTROS) {
  const key = `ind17:${centro.cost_center_id}:${filtersKey(filters)}`;
  return memo(key, () => cacheCompartida(key, () => computeIndicadoresDesde(
    {
      cost_center_id: centro.cost_center_id,
      project_name: centro.project_name,
      budget: centro.budget,
      start_date: centro.start_date,
      planned_end_date: centro.planned_end_date,
    },
    [centro.cost_center_id],
    filters
  )));
}

// Vista "Todos los proyectos": agrega sumas reales (no promedia porcentajes
// ya redondeados de cada centro) para que la matemática sea correcta.
async function computeIndicadoresPortafolio(centros, filters = SIN_FILTROS) {
  if (!centros.length) return null;
  const ids = centros.map((c) => c.cost_center_id);
  const budget = sum(centros.map((c) => Number(c.budget) || 0));
  const fechasInicio = centros.map((c) => c.start_date).filter(Boolean).sort();
  const fechasFin = centros.map((c) => c.planned_end_date).filter(Boolean).sort();

  // La clave lleva los ids y no el scope: el portafolio de un PM con 2
  // centros y el de otro con esos mismos 2 centros es el mismo numero. Quien
  // ve cuales centros ya se decidio en getCentrosVisibles(scope).
  const key = `portafolio:${ids.join(',')}:${filtersKey(filters)}`;
  return memo(key, () => cacheCompartida(key, () => computeIndicadoresDesde(
    {
      cost_center_id: null,
      project_name: 'Todos los proyectos',
      budget,
      start_date: fechasInicio[0] || null,
      planned_end_date: fechasFin[fechasFin.length - 1] || null,
    },
    ids,
    filters
  )));
}

module.exports = { computeIndicadores17, computeIndicadoresPortafolio, weekKey, descomponerWeekKey };
