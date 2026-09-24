'use strict';

/**
 * 2.3 — Flujo de horas extra: sincroniza filas desde el cálculo en vivo
 * (weeklyAggregate) hacia mp_overtime_decisions, y expone las operaciones
 * de decisión (líder, admin o ceo) y aprobación (solo admin/ceo) sobre
 * esas filas.
 */

const { query } = require('../db');
const { costCenterScopeClause } = require('./costo-common');
const { getParametrosNomina, factorRecargo, HORA_INICIO_NOCTURNO, HORA_INICIO_DIURNO } = require('./costo-recargos');
const { weeklyAggregate, getLegalHoursPerWeek } = require('./costo-weekly-hours');
const { loadHolidaysSet } = require('../capacity');

function pad2(n) { return String(n).padStart(2, '0'); }
function fechaISO(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

const RE_FECHA_HORA = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// Parsea el formato nativo de <input type="datetime-local">
// ('YYYY-MM-DDTHH:MM') a un Date en hora local, o null si no es una fecha
// real. No basta con mirar el formato: `new Date(2026,1,30)` (30 de
// febrero) NO da NaN, JavaScript la normaliza en silencio al 2 de marzo.
// Reconstruir el Date y comparar sus componentes contra lo que se pidió es
// la única forma de detectar eso — así una fecha inexistente nunca llega a
// convertirse en dinero.
function parseFechaHora(valor) {
  const m = RE_FECHA_HORA.exec(String(valor || ''));
  if (!m) return null;
  const [, yStr, moStr, dStr, hStr, miStr] = m;
  const y = Number(yStr), mo = Number(moStr), d = Number(dStr), h = Number(hStr), mi = Number(miStr);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

// Suma los minutos de [desde, hasta) que caen en horario nocturno (7pm-6am,
// el horario que declara la tabla de GTC — sql/33) de CUALQUIER día que el
// rango toque: recorre día por día en vez de asumir que el turno dura menos
// de 24h, así que un rango largo (aunque no debería pasar en la práctica)
// igual da el resultado correcto.
function minutosNocturnosEntre(desde, hasta) {
  let total = 0;
  let cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() - 1);
  const limite = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate() + 1);
  while (cursor.getTime() < limite.getTime()) {
    const nocheIni = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), HORA_INICIO_NOCTURNO, 0);
    const nocheFin = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, HORA_INICIO_DIURNO, 0);
    const ini = Math.max(desde.getTime(), nocheIni.getTime());
    const fin = Math.min(hasta.getTime(), nocheFin.getTime());
    if (fin > ini) total += (fin - ini) / 60000;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return total;
}

// Divide un turno [inicioDt, finDt) (Date, hora local) en los días
// calendario que toca y, dentro de cada uno, en horas diurnas vs nocturnas
// (7pm-6am). Ya no hace falta inferir si "cruza medianoche": inicioDt y
// finDt traen su propia fecha, sin ambigüedad.
//
// Devuelve un array de 1+ segmentos: [{ fecha, horasDiurnas, horasNocturnas }].
// Cada segmento puede tener un tipo de día distinto (festivo) — por eso se
// calcula por separado.
function dividirTurnoPorDia(inicioDt, finDt) {
  const segmentos = [];
  let cursor = new Date(inicioDt.getFullYear(), inicioDt.getMonth(), inicioDt.getDate());
  while (cursor.getTime() < finDt.getTime()) {
    const diaSiguiente = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const desde = new Date(Math.max(inicioDt.getTime(), cursor.getTime()));
    const hasta = new Date(Math.min(finDt.getTime(), diaSiguiente.getTime()));
    if (hasta.getTime() > desde.getTime()) {
      const totalMin = (hasta.getTime() - desde.getTime()) / 60000;
      const nocheMin = minutosNocturnosEntre(desde, hasta);
      segmentos.push({
        fecha: fechaISO(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()),
        horasDiurnas: Number(((totalMin - nocheMin) / 60).toFixed(4)),
        horasNocturnas: Number((nocheMin / 60).toFixed(4)),
      });
    }
    cursor = diaSiguiente;
  }
  return segmentos;
}

// Clasifica los segmentos de dividirTurnoPorDia en 4 baldes según si su
// fecha es festivo (holidaysSet trae fechas 'YYYY-MM-DD') y los costea con
// los 4 recargos de mp_costeo_config (sql/25, sql/26). Domingo se trata
// igual que festivo a propósito (mismo recargo de ley) — ver sql/26.
//
// contractType: un talento por prestación de servicios no tiene recargos
// legales (ver factorRecargo en costo-recargos.js) — su turno manual se
// costea a tarifa plana, sin el 25-265% que sí aplica a planta.
function costearTurno(segmentos, holidaysSet, hourlyCost, recargos, contractType = 'planta') {
  let horasDiurnasNormales = 0, horasNocturnasNormales = 0;
  let horasDiurnasFestivas = 0, horasNocturnasFestivas = 0;

  for (const s of segmentos) {
    const dow = new Date(`${s.fecha}T00:00:00`).getDay();
    const esFestivoODomingo = dow === 0 || holidaysSet.has(s.fecha);
    if (esFestivoODomingo) {
      horasDiurnasFestivas += s.horasDiurnas;
      horasNocturnasFestivas += s.horasNocturnas;
    } else {
      horasDiurnasNormales += s.horasDiurnas;
      horasNocturnasNormales += s.horasNocturnas;
    }
  }

  // Todo lo que se registra por esta vía es hora EXTRA (es el alta manual
  // de horas extra), así que los 4 baldes salen de la mitad "extra" de la
  // tabla: 1,25 / 1,75 / 2,15 / 2,65.
  const extraHours = horasDiurnasNormales + horasNocturnasNormales + horasDiurnasFestivas + horasNocturnasFestivas;
  const extraCostPotential =
    horasDiurnasNormales * hourlyCost * factorRecargo({ extra: true }, recargos, contractType) +
    horasNocturnasNormales * hourlyCost * factorRecargo({ extra: true, nocturno: true }, recargos, contractType) +
    horasDiurnasFestivas * hourlyCost * factorRecargo({ extra: true, festivo: true }, recargos, contractType) +
    horasNocturnasFestivas * hourlyCost * factorRecargo({ extra: true, festivo: true, nocturno: true }, recargos, contractType);

  return {
    extraHours: Number(extraHours.toFixed(2)),
    extraCostPotential: Number(extraCostPotential.toFixed(2)),
  };
}

// La tabla "Decisión del PM y aprobación" pide ver, por cada hora extra,
// si fue diurna/nocturna y si cayó en festivo o fin de semana (2 sep 2026,
// a pedido explícito — SOLO visualización, no toca el dinero: la tabla de
// recargos de GTC en costo-recargos.js no tiene tarifa distinta para
// sábado, así que "fin de semana" se sigue pagando igual que un día
// hábil; domingo SÍ es festivo de verdad, mismo criterio que costearTurno).
//
// construirTurnoDesdeBD reconstruye el turno desde lo guardado en
// mp_overtime_decisions (fecha + hora_inicio + hora_fin, sql/26). La tabla
// NO guarda la fecha de FIN por separado — si hora_fin <= hora_inicio se
// infiere que cruzó a la medianoche del día siguiente, el mismo criterio
// con el que quedó guardado en createManualOvertime.
function construirTurnoDesdeBD(fecha, horaInicio, horaFin) {
  if (!fecha || !horaInicio || !horaFin) return null;
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const [hi, mi] = String(horaInicio).split(':').map(Number);
  const [hf, mf] = String(horaFin).split(':').map(Number);
  const inicioDt = new Date(y, m - 1, d, hi, mi);
  let finDt = new Date(y, m - 1, d, hf, mf);
  if (finDt.getTime() <= inicioDt.getTime()) finDt = new Date(y, m - 1, d + 1, hf, mf);
  return { inicioDt, finDt };
}

// Reutiliza dividirTurnoPorDia (arriba) para partir el turno en segmentos
// diurno/nocturno por día, y clasifica cada segmento en una de las 6
// etiquetas. Un turno de varias horas puede caer en más de una a la vez
// (ej. empieza diurno un sábado y termina nocturno un domingo) — por eso
// devuelve una lista, no una sola categoría.
function clasificarTurno(inicioDt, finDt, holidaysSet) {
  const segmentos = dividirTurnoPorDia(inicioDt, finDt);
  const porCategoria = new Map();
  for (const s of segmentos) {
    const dow = new Date(`${s.fecha}T00:00:00`).getDay();
    const esFestivo = dow === 0 || holidaysSet.has(s.fecha);
    const esSabado = dow === 6 && !esFestivo;
    const sufijo = esFestivo ? ' festivo' : esSabado ? ' fin de semana' : '';
    for (const [horas, tipo] of [[s.horasDiurnas, 'Diurno'], [s.horasNocturnas, 'Nocturno']]) {
      if (!(horas > 0)) continue;
      const etiqueta = tipo + sufijo;
      porCategoria.set(etiqueta, (porCategoria.get(etiqueta) || 0) + horas);
    }
  }
  return [...porCategoria.entries()]
    .map(([categoria, horas]) => ({ categoria, horas: Number(horas.toFixed(2)) }))
    .sort((a, b) => b.horas - a.horas);
}

// Esta es la única vía que conoce la hora exacta del turno, así que es la
// única que puede aplicar los 4 factores de la tabla de GTC (sql/33).
async function getRecargosCompletos() {
  return getParametrosNomina();
}

// Crea en mp_overtime_decisions las filas talento/proyecto/semana con
// hExtra > 0 que todavía no existen. Si una fila YA existe pero sigue sin
// decisión (pm_decision Y approval_status ambos 'pendiente'), se refresca
// con el cálculo actual — antes usaba INSERT IGNORE puro, así que si el
// umbral de horas legales (Configuración) cambiaba después de que la fila
// se creó, se quedaba con las horas/costo de la configuración vieja para
// siempre, aunque el resto del sistema ya calculara con la nueva.
// Una vez que el PM decide o admin/ceo aprueba/rechaza, la fila deja de
// tocarse — esas cifras ya son un registro histórico de lo que se decidió
// de verdad, no algo que deba moverse solo porque cambió un umbral después.
async function syncOvertimeDecisions(scope, filters) {
  const rows = await weeklyAggregate(scope, filters);
  const legalHours = await getLegalHoursPerWeek();
  const withExtra = rows.filter((r) => r.h_extra > 0 && r.cost_center_id);

  if (!withExtra.length) return 0;

  // UN solo INSERT multi-fila en vez de uno por talento/semana. Con un par de
  // meses de datos esto eran decenas de idas y vueltas a una base remota,
  // secuenciales, cada vez que alguien abria el panel de Horas Extra.
  //
  // Se trocea porque el paquete tiene un tope (max_allowed_packet) y porque
  // cada fila lleva 9 parametros: 200 filas son 1.800 placeholders, que sigue
  // holgado frente al limite de 65.535 de MySQL.
  const TAMANO_LOTE = 200;
  for (let i = 0; i < withExtra.length; i += TAMANO_LOTE) {
    const lote = withExtra.slice(i, i + TAMANO_LOTE);
    const placeholders = lote.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = lote.flatMap((r) => [
      r.employee_id, r.cost_center_id, r.week_number, r.month_number, r.year_number,
      r.h_ejec, legalHours, r.h_extra, r.costo_extra_potencial,
    ]);

    // hours_overridden = 0 en las 4 condiciones (sql/31): si el PM ya
    // corrigió las horas a mano mientras la fila seguía pendiente
    // (editOvertimeHours más abajo), esta sincronización NO puede volver a
    // pisarlas — si no, la corrección se perdería sola en el próximo
    // refresh de la pestaña, que dispara este mismo sync.
    await query(
      `INSERT INTO mp_overtime_decisions
         (employee_id, cost_center_id, week_number, month_number, year_number,
          executed_hours, legal_hours, extra_hours, extra_cost_potential)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         executed_hours = IF(pm_decision = 'pendiente' AND approval_status = 'pendiente' AND hours_overridden = 0, VALUES(executed_hours), executed_hours),
         legal_hours = IF(pm_decision = 'pendiente' AND approval_status = 'pendiente' AND hours_overridden = 0, VALUES(legal_hours), legal_hours),
         extra_hours = IF(pm_decision = 'pendiente' AND approval_status = 'pendiente' AND hours_overridden = 0, VALUES(extra_hours), extra_hours),
         extra_cost_potential = IF(pm_decision = 'pendiente' AND approval_status = 'pendiente' AND hours_overridden = 0, VALUES(extra_cost_potential), extra_cost_potential)`,
      params
    );
  }
  return withExtra.length;
}

// "Semana N del mes" = días [7(N-1)+1..7N] — misma convención de
// capacity.js:getWeekDays, en sentido inverso (de fecha a semana).
function weekNumberFromDate(fechaStr) {
  const dia = Number(fechaStr.split('-')[2]);
  return Math.ceil(dia / 7);
}

// Alta manual (24 ago 2026, con inicio+fin exactos desde el 26 ago 2026;
// única vía desde el 2 sep 2026, a pedido explícito): el PM registra cada
// hora extra a mano desde la plataforma — el Excel de Planeación ya NO
// genera horas extra por su cuenta, solo alimenta Costo Planeado/horas
// ejecutadas. syncOvertimeDecisions() de abajo sigue existiendo y probada
// (por si algún día se necesita un disparador manual/admin), pero el front
// ya no la llama sola. Una persona puede tener VARIAS horas extra en la
// misma semana (sql/42): cada turno manual lleva su turno_key dentro de la
// unique key, así que solo se rechaza el MISMO turno exacto dos veces
// (ver 'ya_existe' abajo), no otro turno de la misma semana.
//
// Se piden inicioDt/finDt (Date, ya validados por la ruta con
// parseFechaHora), NO un número de horas a mano: así la cantidad de horas Y
// su recargo (diurna/nocturna/festiva, ver costearTurno arriba) salen del
// turno real, no de lo que alguien tipeó.
//
// Auto-aprobada (26 ago 2026, a pedido explícito): si el PM la está creando
// a mano, esa misma acción ya es su decisión Y su aprobación — no hay un
// segundo paso de admin/ceo esperando después, ni forma de revertirla
// (mismo criterio que Costo No Planeado, que nunca tuvo aprobación). Queda
// en el historial de auditoría igual que cualquier otra escritura.
async function createManualOvertime({ employeeId, costCenterId, inicioDt, finDt, decidedByUserId }) {
  const tarifaRows = await query(
    `SELECT ep.hourly_cost, e.contract_type
       FROM mp_equipo_proyecto ep
       JOIN mp_employees e ON e.employee_id = ep.employee_id
      WHERE ep.employee_id = ? AND ep.cost_center_id = ? AND ep.is_active = 1 LIMIT 1`,
    [employeeId, costCenterId]
  );
  if (!tarifaRows.length) return { error: 'no_asignado' };

  // Sin tarifa la hora extra entra valiendo $0 y no lo nota nadie hasta que
  // alguien la aprueba y el costo no se mueve. El mensaje de la ruta ya
  // prometia detectar este caso; ahora el codigo si lo detecta.
  const hourlyCost = Number(tarifaRows[0].hourly_cost) || 0;
  if (!(hourlyCost > 0)) return { error: 'sin_tarifa' };
  const contractType = tarifaRows[0].contract_type || 'planta';

  const [legalHours, recargos] = await Promise.all([getLegalHoursPerWeek(), getRecargosCompletos()]);

  const segmentos = dividirTurnoPorDia(inicioDt, finDt);
  const years = [...new Set(segmentos.map((s) => Number(s.fecha.split('-')[0])))];
  const sets = await Promise.all(years.map((y) => loadHolidaysSet(y)));
  const holidaysSet = new Set();
  for (const s of sets) for (const f of s) holidaysSet.add(f);

  const { extraHours, extraCostPotential } = costearTurno(segmentos, holidaysSet, hourlyCost, recargos, contractType);
  if (!(extraHours > 0)) return { error: 'sin_horas' };

  // El registro se atribuye al día en que EMPIEZA el turno — mismo criterio
  // que un turno nocturno de nómina real. fecha/hora_inicio/hora_fin son
  // solo para mostrar en pantalla; el costo ya viene repartido por día en
  // costearTurno, no depende de qué fecha quede aquí.
  const fecha = fechaISO(inicioDt.getFullYear(), inicioDt.getMonth() + 1, inicioDt.getDate());
  const horaInicio = `${pad2(inicioDt.getHours())}:${pad2(inicioDt.getMinutes())}`;
  const horaFin = `${pad2(finDt.getHours())}:${pad2(finDt.getMinutes())}`;
  const weekNumber = weekNumberFromDate(fecha);

  try {
    const result = await query(
      `INSERT INTO mp_overtime_decisions
         (employee_id, cost_center_id, week_number, month_number, year_number,
          executed_hours, legal_hours, extra_hours, extra_cost_potential,
          fecha, hora_inicio, hora_fin, turno_key,
          pm_decision, approval_status, extra_cost_final, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'si', 'aprobado', ?, ?, NOW())`,
      [employeeId, costCenterId, weekNumber, inicioDt.getMonth() + 1, inicioDt.getFullYear(),
        legalHours + extraHours, legalHours, extraHours, extraCostPotential,
        fecha, horaInicio, horaFin, `${fecha} ${horaInicio}-${horaFin}`, extraCostPotential, decidedByUserId || null]
    );
    return { decision_id: result.insertId };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { error: 'ya_existe' };
    throw err;
  }
}

async function listOvertimeDecisions(scope) {
  const scopeF = costCenterScopeClause(scope, 'od.cost_center_id');
  const rows = await query(
    `SELECT od.decision_id, od.employee_id, e.canonical_name, od.cost_center_id, cc.project_name,
            od.week_number, od.month_number, od.year_number,
            od.executed_hours, od.legal_hours, od.extra_hours, od.extra_cost_potential,
            od.pm_decision, od.pm_decision_note, od.motivo, od.calidad, od.approval_status,
            od.approved_by, od.approved_at, od.extra_cost_final,
            od.fecha, od.hora_inicio, od.hora_fin
       FROM mp_overtime_decisions od
       JOIN mp_employees e ON e.employee_id = od.employee_id
       JOIN mp_centro_costo cc ON cc.cost_center_id = od.cost_center_id
      WHERE 1=1 ${scopeF.clause}
      ORDER BY od.year_number DESC, od.week_number DESC, e.canonical_name`,
    scopeF.params
  );

  // El desglose diurno/nocturno/festivo/fin de semana se calcula aquí, no
  // se guarda: fecha/hora_inicio/hora_fin ya son la fuente de verdad del
  // turno, así que reconstruirlo cada vez evita tener dos lugares que
  // puedan desincronizarse. Solo las filas del alta manual (única vía
  // desde el 2 sep 2026) traen esos tres campos.
  const anios = [...new Set(rows.filter((r) => r.fecha).map((r) => Number(String(r.fecha).slice(0, 4))))];
  const sets = await Promise.all(anios.map((y) => loadHolidaysSet(y)));
  const holidaysSet = new Set();
  for (const s of sets) for (const f of s) holidaysSet.add(f);

  return rows.map((r) => {
    const turno = construirTurnoDesdeBD(r.fecha, r.hora_inicio, r.hora_fin);
    return { ...r, desglose_turno: turno ? clasificarTurno(turno.inicioDt, turno.finDt, holidaysSet) : null };
  });
}

// Distingue "la fila no existe" (404) de "existe pero no era aprobable/
// decidible" (409), sin volver a confiar en un SELECT previo para autorizar.
async function existeDecision(decisionId) {
  const rows = await query('SELECT 1 FROM mp_overtime_decisions WHERE decision_id = ?', [decisionId]);
  return rows.length > 0;
}

// Decisión del líder: ¿se paga la hora extra? Si 'no', queda en 'no_aplica'
// (nadie aprueba nada). Si 'si', queda aprobada de una vez — sin esperar un
// segundo paso de admin/ceo (auto-aprobación, 26 ago 2026, a pedido
// explícito: la decisión del PM ya es la última palabra, sin control
// posterior). approveOvertime() de abajo se deja intacto por compatibilidad
// con filas que hayan quedado en 'pendiente' antes de este cambio.
// motivo/calidad solo aplican con decision='si' (alimentan los
// indicadores #12 y #13).
async function decideOvertime(decisionId, decision, note, motivo, calidad, decidedByUserId) {
  const esSi = decision === 'si';
  const approvalStatus = esSi ? 'aprobado' : 'no_aplica';

  // La guarda vive en el WHERE, no en un IF de JavaScript. Antes esto era
  // SELECT -> validar en JS -> UPDATE, tres pasos sin transacción: dos
  // peticiones simultáneas pasaban ambas la validación y la segunda pisaba a
  // la primera. Con la condición dentro del UPDATE, la base decide, y el
  // resultado se lee de affectedRows.
  //
  // La condición en sí no cambia: una vez resuelta (aprobada o rechazada),
  // no se puede volver a decidir sobre la misma fila.
  const result = await query(
    `UPDATE mp_overtime_decisions
        SET pm_decision = ?, pm_decision_note = ?, motivo = ?, calidad = ?,
            approval_status = ?,
            extra_cost_final = IF(?, COALESCE(extra_cost_potential, 0), 0),
            approved_by = IF(?, ?, approved_by),
            approved_at = IF(?, NOW(), approved_at)
      WHERE decision_id = ?
        AND approval_status NOT IN ('aprobado', 'rechazado')`,
    [
      decision,
      note || null,
      esSi ? (motivo || null) : null,
      esSi ? !!calidad : false,
      approvalStatus,
      esSi,
      esSi, decidedByUserId || null,
      esSi,
      decisionId,
    ]
  );

  if (result.affectedRows) return { approval_status: approvalStatus };
  return (await existeDecision(decisionId)) ? { error: 'ya_resuelto' } : null;
}

// Aprobación del Administrador/CEO: solo entonces se escribe extra_cost_final.
async function approveOvertime(decisionId, approved, approvedByUserId) {
  const approvalStatus = approved ? 'aprobado' : 'rechazado';

  // BUG DE DINERO corregido: antes esta guarda miraba solo approval_status, y
  // el DEFAULT de esa columna en sql/09 YA es 'pendiente'. O sea que una fila
  // recién sincronizada, sobre la que el líder nunca decidió nada, pasaba la
  // validación: admin/ceo podía aprobarla y escribir extra_cost_final,
  // sumando al ejecutado una hora extra que nadie autorizó. El comentario
  // original decía "solo se puede aprobar lo que el líder decidió que sí",
  // pero el código no lo verificaba.
  //
  // pm_decision = 'si' es la condición que faltaba. Y, igual que en
  // decideOvertime, la guarda va en el WHERE para que dos aprobaciones
  // simultáneas no puedan cruzarse.
  const result = await query(
    `UPDATE mp_overtime_decisions
        SET approval_status  = ?,
            extra_cost_final = IF(? = 'aprobado', COALESCE(extra_cost_potential, 0), 0),
            approved_by      = ?,
            approved_at      = NOW()
      WHERE decision_id     = ?
        AND pm_decision     = 'si'
        AND approval_status IN ('pendiente', 'requiere_jair')`,
    [approvalStatus, approvalStatus, approvedByUserId, decisionId]
  );

  if (!result.affectedRows) {
    return (await existeDecision(decisionId)) ? { error: 'no_aprobable' } : null;
  }

  const rows = await query(
    'SELECT approval_status, extra_cost_final FROM mp_overtime_decisions WHERE decision_id = ?',
    [decisionId]
  );
  return {
    approval_status: rows[0].approval_status,
    extra_cost_final: Number(rows[0].extra_cost_final),
  };
}

// Corrige las horas de una fila mientras siga en 'pendiente'/'pendiente'
// (sql/31, 28 ago 2026, a pedido explícito): el PM detecta que el sistema
// calculó mal (o cambió la realidad) antes de decidir si se paga.
//
// extra_cost_potential se REESCALA en vez de recalcularse desde cero: no
// hay hora_inicio/hora_fin en una fila detectada por sync (solo las trae
// el alta manual), así que no hay cómo repartir las horas nuevas entre
// diurna/nocturna/festiva. Reescalar conserva la mezcla de recargos que sí
// se calculó en el sync ($/hora implícito), aplicada a la cantidad nueva.
//
// La guarda vive en el WHERE (mismo patrón que decideOvertime/
// approveOvertime): dos ediciones simultáneas no pueden cruzarse, y una
// fila ya decidida no se puede tocar. hours_overridden=1 dentro del mismo
// UPDATE es lo que evita que el próximo sync la vuelva a pisar.
// Quién/cuándo corrigió las horas no se persiste en esta tabla (no hay
// columna para eso) — queda en el historial de auditoría, que sí registra
// quién y cuándo (ver la ruta PUT /overtime/:id).
async function editOvertimeHours(decisionId, extraHours) {
  const result = await query(
    `UPDATE mp_overtime_decisions
        SET extra_cost_potential = ROUND(extra_cost_potential / extra_hours * ?, 2),
            extra_hours          = ?,
            hours_overridden     = 1
      WHERE decision_id      = ?
        AND pm_decision      = 'pendiente'
        AND approval_status  = 'pendiente'
        AND extra_hours      > 0`,
    [extraHours, extraHours, decisionId]
  );
  if (!result.affectedRows) {
    return (await existeDecision(decisionId)) ? { error: 'no_editable' } : null;
  }
  const rows = await query(
    'SELECT extra_hours, extra_cost_potential FROM mp_overtime_decisions WHERE decision_id = ?',
    [decisionId]
  );
  return {
    extra_hours: Number(rows[0].extra_hours),
    extra_cost_potential: Number(rows[0].extra_cost_potential),
  };
}

// Elimina una fila de mp_overtime_decisions. Un líder solo mientras siga en
// 'pendiente'/'pendiente' (sql/31, a pedido explícito): "de la nada se
// soluciona y no se necesita la hora extra". admin/ceo pueden eliminar
// CUALQUIER registro, incluso uno ya decidido/aprobado (17 sep 2026, a
// pedido explícito: "el CEO o admin pueden tener la opción de eliminar en
// caso de que se haya registrado una por error"). Además, el propio líder
// que registró a mano la hora extra (approved_by = quien la creó, ver
// createManualOvertime) puede eliminarla aunque ya nazca aprobada: es el
// "me equivoqué recién, déjenme borrarla" del mini-historial de la sesión
// del modal de alta (17 sep 2026, a pedido explícito).
//
// OJO — esto no borra el hecho de que la persona trabajó esas horas: si
// mp_task_facts siguiera trayendo las mismas horas reales, el próximo
// syncOvertimeDecisions() volvería a crear la fila pendiente. Para el alta
// manual (única vía desde el 2 sep 2026) no hay sync, así que una hora
// extra registrada por error queda fuera de verdad; aun así conviene
// avisarlo en pantalla para que no sorprenda verla reaparecer cuando el
// registro vino del Excel.
async function deleteOvertimeDecision(decisionId, isAdminCeo = false, isCreador = false, userId = null) {
  let sql = 'DELETE FROM mp_overtime_decisions WHERE decision_id = ?';
  const params = [decisionId];
  if (!isAdminCeo) {
    if (isCreador) {
      sql += ' AND approved_by = ?';
      params.push(userId);
    } else {
      sql += " AND pm_decision = 'pendiente' AND approval_status = 'pendiente'";
    }
  }
  const result = await query(sql, params);
  if (result.affectedRows) return { deleted: true };
  return (await existeDecision(decisionId)) ? { error: 'no_eliminable' } : null;
}

module.exports = {
  syncOvertimeDecisions,
  createManualOvertime,
  listOvertimeDecisions,
  decideOvertime,
  approveOvertime,
  editOvertimeHours,
  deleteOvertimeDecision,
  // Puras, exportadas para poder probarlas sin base de datos.
  parseFechaHora,
  weekNumberFromDate,
  dividirTurnoPorDia,
  costearTurno,
  construirTurnoDesdeBD,
  clasificarTurno,
};
