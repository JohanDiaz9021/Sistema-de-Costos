'use strict';

/**
 * Fase 2.6 — Las 21 alertas de Costeo, condición y severidad exacta según
 * "Herramienta de Costeo GTC — Especificación Técnica" sección 8 y
 * "Monitoreo de Costos — Especificación Maestra" sección 10.
 *
 * generarAlertasParaCentro() evalúa las alertas propias de un centro
 * (usa sus 17 indicadores ya calculados). generarAlertasGlobales()
 * evalúa las 2 alertas que cruzan datos de TODA la empresa (sobrecarga
 * cross-proyecto, costo/hora por encima del promedio).
 */

const { query } = require('../db');
const { getConfigNumber } = require('./costo-common');
const { formatCOP } = require('./costo-export-format');

function diasEntre(fechaFutura) {
  const ms = new Date(fechaFutura).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

async function getPMActivo(project_folder) {
  const rows = await query(
    "SELECT 1 FROM mp_project_owners WHERE project_folder = ? AND is_active = 1 LIMIT 1",
    [project_folder]
  );
  return rows.length > 0;
}

// Excluye solo los RECHAZADOS (14 sep 2026, corregido tras revisión de
// código) — no "solo aprobados": las dos alertas que usan esto no miden lo
// mismo. La 9 (Dato desactualizado) es un proxy de actividad, no de dinero
// — si solo contara aprobados, un centro con gastos legítimos ESPERANDO
// aprobación dispararía "nadie registra nada aquí", un falso positivo peor
// que el que se corrige. La 16 (Gasto atípico) sí quiere ver los pendientes
// —es una alerta temprana antes de aprobar—, pero un RECHAZADO es dinero
// que la empresa denegó y nunca se va a gastar; como nunca se borra (queda
// como registro permanente) y las alertas se recalculan solas en cada
// carga sin forma de descartarlas, antes de este cambio un gasto rechazado
// hace meses seguía disparando "representa X% del presupuesto" para
// siempre. Índice ya existente (cost_center_id, approval_status) de
// sql/28, así que el filtro no cuesta nada extra.
async function getGastosDeCentro(cost_center_id) {
  return query(
    `SELECT expense_id, description, amount FROM mp_costo_no_planeado
      WHERE cost_center_id = ? AND approval_status <> 'rechazado'`,
    [cost_center_id]
  );
}

// Alerta 4 — talento cuyas horas se están costeando a $0 en este centro.
//
// Es el punto ciego que el motor no puede reportar solo: weeklyAggregate()
// entra a mp_equipo_proyecto por LEFT JOIN, así que una tarifa ausente llega
// como NULL, se convierte en 0, y las horas se suman al proyecto costando
// nada. El presupuesto ejecutado sale más bajo de lo real y el margen sale
// inflado, sin ningún error visible.
//
// Dos formas de caer en el mismo hueco, ambas se reportan igual:
//   'sin_asignacion' — registra horas en el proyecto pero no está en el equipo.
//   'tarifa_cero'    — está en el equipo, pero su costo/hora quedó en 0.
// `centro` (no solo project_folder) — corregido 14 sep 2026 tras revisión
// de código. Dos bugs encadenados, ambos por quedarse con el criterio viejo
// de cuando la carga del Excel era una sola por persona (antes del 10 sep
// 2026):
//
// 1. Filtraba por t.project_folder, pero esa columna de
//    mp_costeo_task_facts NO es el proyecto de la fila — es la carpeta de
//    SharePoint de la PERSONA que subió el archivo (ver
//    guardarHorasDesdeExcel en costo-task-facts-upload.js: guarda
//    empleado.project_folder, el mismo valor en TODAS sus filas, sin
//    importar a qué proyecto pertenezca cada una). Con eso, esta consulta
//    solo podía encontrar horas de alguien en SU proyecto "de origen" —
//    cualquier otro proyecto en el que también trabajara quedaba invisible
//    para la alerta "Talento sin costo/hora registrado", por más horas que
//    le costeara en $0. El resto del sistema (baseWhere en
//    costo-common.js, el JOIN de atribución en costo-motor.js,
//    filtrarPorCentro en la carga del Excel) usa t.project_name contra
//    project_name/project_folder DEL CENTRO — el mismo criterio que ya
//    corrigió sql/37 con sus índices.
//
// 2. El "snapshot vigente" correlacionaba solo por employee_id, sin
//    project_name — correcto cuando una persona tenía un único corte
//    vigente (antes del 10 sep 2026), roto desde que cada proyecto se
//    sube por separado y cada uno queda vigente por su cuenta (ver el
//    comentario de sql/36: "puede tener Sistema de costos cargado el
//    lunes y Management el miércoles, y las dos cargas siguen vigentes").
//    Con el MAX() sin correlacionar por proyecto, bastaba con que la
//    persona tuviera una carga MÁS RECIENTE en OTRO proyecto para que el
//    proyecto que sí se estaba evaluando devolviera cero filas — la
//    alerta se apagaba sola. Mismo patrón que baseWhere() ya usa.
async function getTalentosSinTarifa(cost_center_id, centro) {
  const [sinAsignacion, tarifaCero] = await Promise.all([
    query(
      `SELECT e.employee_id, e.canonical_name,
              SUM(COALESCE(t.hours_monday,0) + COALESCE(t.hours_tuesday,0) +
                  COALESCE(t.hours_wednesday,0) + COALESCE(t.hours_thursday,0) +
                  COALESCE(t.hours_friday,0) + COALESCE(t.hours_saturday,0)) AS horas
         FROM mp_costeo_task_facts t
         JOIN mp_employees e ON e.employee_id = t.employee_id
         LEFT JOIN mp_equipo_proyecto ep
                ON ep.cost_center_id = ?
               AND ep.employee_id    = t.employee_id
               AND ep.is_active      = 1
        WHERE (t.project_name = ? OR t.project_name = ?)
          AND e.is_active = 1
          AND ep.team_member_id IS NULL
          -- Snapshot vigente de CADA (empleado, proyecto) — ver el
          -- comentario de la función.
          AND t.snapshot_date = (
            SELECT MAX(t2.snapshot_date) FROM mp_costeo_task_facts t2
             WHERE t2.employee_id = t.employee_id
               AND t2.project_name = t.project_name
          )
        GROUP BY e.employee_id, e.canonical_name
       HAVING horas > 0`,
      [cost_center_id, centro.project_name, centro.project_folder]
    ),
    query(
      `SELECT e.employee_id, e.canonical_name
         FROM mp_equipo_proyecto ep
         JOIN mp_employees e ON e.employee_id = ep.employee_id
        WHERE ep.cost_center_id = ?
          AND ep.is_active = 1
          AND (ep.hourly_cost IS NULL OR ep.hourly_cost = 0)`,
      [cost_center_id]
    ),
  ]);

  return [
    ...sinAsignacion.map((r) => ({
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      motivo: 'sin_asignacion',
      horas: Number(r.horas) || 0,
    })),
    ...tarifaCero.map((r) => ({
      employee_id: r.employee_id,
      canonical_name: r.canonical_name,
      motivo: 'tarifa_cero',
      horas: null,
    })),
  ];
}

// Evalúa las 19 alertas de un centro a partir de datos YA obtenidos (sin
// tocar la base) — separada de generarAlertasParaCentro() a propósito, para
// poder probar las 19 reglas de negocio (umbrales, severidades, mensajes)
// como pruebas unitarias puras, sin tener que sembrar fixtures en una base
// de datos real solo para ejercitar un `if`.
function evaluarAlertasDeCentro(centro, ind17, datos) {
  const { gastos, pmActivo, sinTarifa, diasAntesPreventiva, umbralPresupuesto } = datos;
  const alertas = [];
  // entidad: identifica de forma estable A QUIÉN/QUÉ le pertenece esta
  // alerta dentro del centro (una persona, un gasto, una hora extra),
  // cuando puede haber más de una del mismo tipo a la vez en el mismo
  // centro — sin esto, dos personas "sin tarifa" en el mismo proyecto
  // colapsarían en un solo evento de seguimiento (costo-alertas-eventos.js)
  // y la segunda desaparecería del historial. Si no se manda, cae a
  // decisionId (ya es un identificador único de por sí); si tampoco hay
  // decisionId, la alerta es única por centro y no necesita entidad.
  const push = (tipo, severidad, categoria, detalle, valor, decisionId = null, entidad = null) => {
    alertas.push({
      tipo, severidad, categoria, detalle, valor,
      cost_center_id: centro.cost_center_id, project_name: centro.project_name,
      decision_id: decisionId, entidad: entidad ?? decisionId,
    });
  };

  // 1 — Proyección de cierre
  if (ind17.ind4_se_queda_sin_plata_antes === true) {
    push('Proyección de cierre', 'critica', 'Presupuesto', 'El presupuesto se agotaría antes de la fecha fin del proyecto.', ind17.ind4_fecha_quiebre_presupuestal);
  }

  // 2, 3 y 17 (Aprobación pendiente / Decisión pendiente del PM / Hora extra
  // rechazada) se retiraron el 4 sep 2026, a pedido explícito: ya no existe
  // un flujo de aprobación de horas extra. Desde el 2 sep las horas extra se
  // registran ÚNICAMENTE desde la plataforma (createManualOvertime) y quedan
  // aprobadas en el mismo acto — no hay un segundo paso que alguien pueda
  // tener "pendiente".
  //
  // Mantenerlas era peor que inútil: las filas heredadas del RPA viejo
  // (agosto 2026, todas con extra_cost_final = 0, ninguna pagada) seguían
  // disparando alertas de severidad alta que mandaban al PM a "decidir" algo
  // que la interfaz ya no le deja decidir — un callejón sin salida.

  // 4 — Talento sin costo/hora registrado.
  // Crítica a propósito: mientras exista, las cifras de dinero de este centro
  // están subestimadas y no se puede confiar en su margen ni en su ejecutado.
  for (const t of sinTarifa) {
    const detalle = t.motivo === 'sin_asignacion'
      ? `${t.canonical_name} registra ${t.horas.toFixed(1)}h en este proyecto pero no está en el equipo: sus horas se están costeando en $0.`
      : `${t.canonical_name} está en el equipo con costo/hora en $0: sus horas no suman al costo del proyecto.`;
    push('Talento sin costo/hora registrado', 'critica', 'Equipo', detalle, t.horas, null, t.employee_id);
  }

  // 5 — Desviación presupuestal
  if (ind17.ind3_ritmo_gasto_vs_tiempo !== null && ind17.ind3_ritmo_gasto_vs_tiempo >= 8) {
    const sev = ind17.ind3_ritmo_gasto_vs_tiempo >= 20 ? 'critica' : 'alta';
    push('Desviación presupuestal', sev, 'Presupuesto', 'El gasto va más rápido que el tiempo transcurrido del proyecto.', Number(ind17.ind3_ritmo_gasto_vs_tiempo.toFixed(1)));
  }

  // 6 — Índice de no-calidad
  if (ind17.ind12_costo_errores_pct >= 1) {
    const sev = ind17.ind12_costo_errores_pct >= 10 ? 'alta' : 'media';
    push('Índice de no-calidad', sev, 'Calidad', 'Parte del costo del proyecto viene de corregir bugs/reprocesos.', ind17.ind12_costo_errores_pct);
  }

  // 7 — Trabajo no remunerado
  if (ind17.ind11_trabajo_no_remunerado > 0) {
    push('Trabajo no remunerado', 'media', 'Horas extra', 'Hay horas extra trabajadas que el proyecto nunca pagará.', ind17.ind11_trabajo_no_remunerado);
  }

  // 9 — Dato desactualizado
  if (centro.status !== 'inactivo' && gastos.length === 0) {
    push('Dato desactualizado', 'baja', 'Costo No Planeado', 'Centro activo sin ningún registro de Costo No Planeado.', null);
  }

  // 10, 11 — Vencimiento próximo / Vencido
  //
  // Antes era un único aviso en 'baja' desde que se entraba a la ventana de
  // dias_antes_preventiva (30 días por defecto) hasta el vencimiento — un PM
  // veía la misma alerta discreta 30 días seguidos y no había forma de
  // distinguir "todavía hay tiempo" de "esto es urgente" sin abrir el
  // proyecto. Ahora escala en 3 pasos según cuánto falta de verdad, con los
  // mismos 2 últimos escalones fijos (4 y 3 días, a pedido explícito) sin
  // importar qué tan grande sea la ventana preventiva configurada — así el
  // CEO/admin ve la severidad subir en el panel de Alertas según se acerca
  // la fecha, en vez de enterarse recién cuando ya está Vencido.
  if (centro.planned_end_date) {
    const dias = diasEntre(centro.planned_end_date);
    if (!centro.actual_end_date) {
      if (dias < 0) {
        push('Vencido', 'critica', 'Vigencia', `La fecha fin ya pasó hace ${Math.abs(dias)} día(s) y no hay Fecha Real de Entrega.`, Math.abs(dias));
      } else if (dias <= diasAntesPreventiva) {
        const sev = dias <= 3 ? 'alta' : dias <= 4 ? 'media' : 'baja';
        push('Vencimiento próximo', sev, 'Vigencia', `Faltan ${dias} día(s) para la fecha fin planeada.`, dias);
      }
    }
  }

  // 12 — Dependencia crítica de una persona
  if (ind17.ind6_bus_factor_pct >= 75) {
    push('Dependencia crítica de una persona', 'alta', 'Equipo', 'Una sola persona concentra la mayoría del costo laboral del proyecto.', ind17.ind6_bus_factor_pct);
  }

  // 13 — Equipo de una sola persona
  if (ind17.ind7_personas_trabajando === 1) {
    push('Equipo de una sola persona', 'media', 'Equipo', 'Solo una persona está asignada activamente al equipo de este proyecto.', 1);
  }

  // 14 — Exceso de horas extra
  if (ind17.ind9_proporcion_horas_extra_pct >= 8) {
    const sev = ind17.ind9_proporcion_horas_extra_pct >= 15 ? 'alta' : 'media';
    push('Exceso de horas extra', sev, 'Horas extra', 'Una proporción alta de las horas trabajadas son horas extra.', ind17.ind9_proporcion_horas_extra_pct);
  }

  // 15 — Gasto poco predecible
  if (ind17.ind14_gasto_no_predecible_pct >= 15) {
    push('Gasto poco predecible', 'media', 'Costo No Planeado', 'Buena parte del gasto ejecutado no estaba planeado.', ind17.ind14_gasto_no_predecible_pct);
  }

  // 16 — Gasto atípico registrado
  const presupuesto = Number(centro.budget) || 0;
  if (presupuesto > 0) {
    for (const g of gastos) {
      const pct = (Number(g.amount) / presupuesto) * 100;
      if (pct >= 3) {
        push('Gasto atípico registrado', 'alta', 'Costo No Planeado', `"${g.description}" representa ${pct.toFixed(1)}% del presupuesto del centro.`, Number(g.amount), null, g.expense_id);
      }
    }
  }

  // 18 — Sobrecostos mayormente internos
  if (ind17.ind13_responsable_sobrecosto_interno_pct !== null && ind17.ind13_responsable_sobrecosto_interno_pct >= 70) {
    push('Sobrecostos mayormente internos', 'media', 'Horas extra', 'La mayoría de las horas extra tienen causa interna, no externa.', ind17.ind13_responsable_sobrecosto_interno_pct);
  }

  // 19 — Sin PM asignado
  if (!pmActivo) {
    push('Sin PM asignado', 'baja', 'Centro de Costos', 'Este centro no tiene un líder/PM activo asignado en Planeación.', null);
  }

  // 20 — Presupuesto casi agotado
  if (ind17.ind1_presupuesto_ejecutado_pct !== null && ind17.ind1_presupuesto_ejecutado_pct >= umbralPresupuesto) {
    push('Presupuesto casi agotado', 'critica', 'Presupuesto', `Ya se ejecutó el ${ind17.ind1_presupuesto_ejecutado_pct.toFixed(1)}% del presupuesto autorizado.`, Number(ind17.ind1_presupuesto_ejecutado_pct.toFixed(1)));
  }

  return alertas;
}

// Wrapper: obtiene los datos de un centro y delega la evaluación a la
// función pura de arriba. Aquí sí vive el único `await` real.
async function generarAlertasParaCentro(centro, ind17, filters = {}) {
  // Ya no se consultan las horas extra del centro: las 3 alertas que las
  // usaban (aprobación/decisión pendiente, hora extra rechazada) se
  // retiraron el 4 sep 2026 al no existir flujo de aprobación. Se ahorra
  // una consulta por centro en cada carga de Alertas.
  const [gastos, pmActivo, sinTarifa, diasAntesPreventiva, umbralPresupuesto] = await Promise.all([
    getGastosDeCentro(centro.cost_center_id),
    getPMActivo(centro.project_folder),
    getTalentosSinTarifa(centro.cost_center_id, centro),
    getConfigNumber('dias_antes_preventiva'),
    getConfigNumber('umbral_presupuesto'),
  ]);

  return evaluarAlertasDeCentro(centro, ind17, {
    gastos, pmActivo, sinTarifa, diasAntesPreventiva, umbralPresupuesto,
  });
}

// Alerta 8 — mapeo puro de filas ya consultadas (sobrecarga cross-proyecto).
function mapearSobrecargaCross(rows) {
  return rows.map((r) => ({
    tipo: 'Sobrecarga cross-proyecto',
    severidad: r.n_centros >= 3 ? 'media' : 'baja',
    categoria: 'Equipo',
    detalle: `${r.canonical_name} registra horas en ${r.n_centros} centros de costos a la vez.`,
    valor: r.n_centros,
    cost_center_id: null,
    project_name: null,
    // entidad = la persona: sin esto, dos talentos distintos con sobrecarga
    // a la vez colapsarían en el mismo evento de seguimiento (misma clave
    // codigo+centro(null), ver costo-alertas-eventos.js).
    entidad: r.employee_id,
  }));
}

// 8 — Sobrecarga cross-proyecto (talento con horas en 2+ centros).
async function alertasSobrecargaCross() {
  const rows = await query(
    `SELECT ep.employee_id, e.canonical_name, COUNT(DISTINCT ep.cost_center_id) AS n_centros
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
      WHERE ep.is_active = 1
      GROUP BY ep.employee_id, e.canonical_name
     HAVING n_centros >= 2`
  );
  return mapearSobrecargaCross(rows);
}

// Alerta 21 — cálculo puro sobre filas ya consultadas (costo/hora ≥125% del
// promedio). Las tarifas en 0 quedan fuera del promedio a propósito: no son
// un costo barato, son un dato que falta (lo reporta la alerta 4). Si se
// promediaran, hundirían la media y el umbral de 125% marcaría como "caro"
// a cualquiera con una tarifa normal.
function calcularCostoHoraSobrePromedio(rows) {
  if (!rows.length) return [];
  const promedio = rows.reduce((sum, r) => sum + Number(r.hourly_cost), 0) / rows.length;
  const umbral = promedio * 1.25;
  return rows
    .filter((r) => Number(r.hourly_cost) >= umbral)
    .map((r) => ({
      tipo: 'Costo/hora por encima del promedio',
      severidad: 'baja',
      categoria: 'Equipo',
      detalle: `${r.canonical_name} (${r.project_name}) tiene costo/hora ${formatCOP(r.hourly_cost)}, ≥125% del promedio de la empresa (${formatCOP(promedio)}).`,
      valor: Number(r.hourly_cost),
      cost_center_id: null,
      project_name: null,
      entidad: r.employee_id,
    }));
}

// 21 — Costo/hora por encima del promedio de la empresa (≥125%).
async function alertasCostoHoraSobrePromedio() {
  const rows = await query(
    `SELECT ep.employee_id, e.canonical_name, ep.hourly_cost, cc.project_name
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
       JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
      WHERE ep.is_active = 1
        AND ep.hourly_cost > 0`
  );
  return calcularCostoHoraSobrePromedio(rows);
}

async function generarAlertasGlobales() {
  const [cross, sobrePromedio] = await Promise.all([alertasSobrecargaCross(), alertasCostoHoraSobrePromedio()]);
  return [...cross, ...sobrePromedio];
}

const ORDEN_SEVERIDAD = { critica: 0, alta: 1, media: 2, baja: 3 };

function ordenarPorSeveridad(alertas) {
  return [...alertas].sort((a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad]);
}

// Dueño (PM) de cada centro, para poder decir en el correo de quién es cada
// alerta sin que el que la lee tenga que ir a buscarlo al panel.
//
// El nombre legible sale de mp_dashboard_users; si ese PM todavía no tiene
// usuario en el dashboard se cae al correo, que igual lo identifica — es
// preferible a no decir nada y dejar la alerta sin responsable visible.
//
// scopeF: el {clause, params} de projectScopeClause resuelto contra
// cc.project_folder, igual que getEscalamientos — así un envío acotado a un
// PM no arrastra los dueños de centros que no va a ver.
async function getDuenosPorCentro(scopeF) {
  const rows = await query(
    `SELECT cc.cost_center_id, o.pmo_email, u.full_name
       FROM mp_centro_costo cc
       JOIN mp_project_owners o
         ON o.project_folder = cc.project_folder AND o.is_active = 1
       LEFT JOIN mp_dashboard_users u ON u.email = o.pmo_email
      WHERE 1=1 ${scopeF.clause}
      ORDER BY cc.cost_center_id, u.full_name, o.pmo_email`,
    scopeF.params
  );

  const porCentro = new Map();
  for (const r of rows) {
    const nombre = (r.full_name && String(r.full_name).trim()) || r.pmo_email;
    const lista = porCentro.get(r.cost_center_id) || [];
    // Un proyecto puede tener VARIOS dueños activos desde sql/16 (la llave
    // dejó de ser solo project_folder justamente para permitirlo), y dos
    // filas distintas pueden resolver al mismo nombre.
    if (!lista.includes(nombre)) lista.push(nombre);
    porCentro.set(r.cost_center_id, lista);
  }
  return porCentro;
}

// Marca cada alerta con `dueno`. Las globales (cross-proyecto) no tienen
// cost_center_id y se quedan sin dueño a propósito: no son de nadie en
// particular, son del portafolio.
function anotarDuenoDeProyecto(alertas, duenosPorCentro) {
  return (alertas || []).map((a) => {
    const duenos = a && a.cost_center_id ? duenosPorCentro.get(a.cost_center_id) : null;
    return duenos && duenos.length ? { ...a, dueno: duenos.join(', ') } : a;
  });
}

module.exports = {
  generarAlertasParaCentro, generarAlertasGlobales, ordenarPorSeveridad,
  evaluarAlertasDeCentro, diasEntre, mapearSobrecargaCross, calcularCostoHoraSobrePromedio,
  getDuenosPorCentro, anotarDuenoDeProyecto,
};
