/* ============================================================
 *  Guardia de idempotencia y calendario para WFs n8n
 *  ------------------------------------------------------------
 *  Pegar este código en un nodo "Function" como PRIMER paso del WF.
 *  Si la corrida no debe ejecutarse hoy, registra el motivo en
 *  mp_ingestion_runs como 'skipped' y termina el flujo.
 *
 *  Reglas de negocio (acordadas con CEO):
 *
 *  WF1 (Diario):
 *    - Corre martes a sábado.
 *    - Si AYER fue festivo → no corre hoy (porque hoy recogería
 *      la planeación de ayer, y ayer fue festivo).
 *    - Si ya corrió hoy → no corre otra vez.
 *    - Si por bug llega a correr 2 veces, la 2da queda en 'skipped'
 *      y NO sobreescribe los datos del primer run.
 *
 *  WF3 (Semanal):
 *    - Corre SOLO los sábados.
 *
 *  Variables n8n esperadas:
 *    $env.MARIADB_HOST, $env.MARIADB_USER, $env.MARIADB_PASS, $env.MARIADB_DB
 *
 *  Salida:
 *    items[0].json.shouldRun = true/false
 *    items[0].json.runId      = id de mp_ingestion_runs (si corre)
 *    items[0].json.skipReason = motivo si no corre
 *    items[0].json.workflowName  (lo recibe del item)
 *
 *  Usar un nodo IF después que rute según shouldRun.
 * ============================================================ */

// ---------- 1) Calendario ----------

// 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
const WF1_DAYS = new Set([2, 3, 4, 5, 6]); // Mar a Sáb
const WF3_DAYS = new Set([6]);             // Sáb

function todayInBogota() {
  // Forzamos zona horaria de Colombia (UTC-5).
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  return now;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function previousDay(d) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() - 1);
  return x;
}

// ---------- 2) Helper SQL via n8n MySQL node simulado ----------
// En n8n real, se usa un nodo MySQL aparte. Acá emulamos con $execute().
// Si tu instancia de n8n permite ejecutar SQL directamente desde Function,
// usa el helper provisto por tu librería. Si no, conviértelo en 2 nodos:
//   [Function: este script] -> [MySQL: SELECT festivo + check duplicado]
//   -> [Function: decidir shouldRun]
//
// Para simplificar pegamos pseudocódigo: tendrás que adaptarlo al patrón
// que ya uses en WF1 (probablemente nodos MySQL separados).

async function holidayExists(dateStr) {
  // PSEUDO: reemplazar con un nodo MySQL que devuelva COUNT(*)
  // SELECT COUNT(*) AS n FROM mp_holidays WHERE holiday_date = ?
  // Asume que el resultado viene en $node["holiday_check"].json[0].n
  return false;
}

async function runAlreadyExists(workflowName, runDateStr) {
  // PSEUDO: SELECT run_id, status FROM mp_ingestion_runs
  //           WHERE workflow_name = ? AND run_date = ?
  return null;
}

async function insertRun(workflowName, runDateStr, status, skipReason, triggeredBy) {
  // PSEUDO: INSERT INTO mp_ingestion_runs (workflow_name, run_date, status, skip_reason, triggered_by)
  //         VALUES (?, ?, ?, ?, ?)
  // ON DUPLICATE KEY UPDATE NO HACE FALTA por el UNIQUE — si el insert falla, ya existe.
  return { run_id: 0 };
}

// ---------- 3) Lógica principal ----------

async function decide(workflowName, triggeredBy) {
  const today = todayInBogota();
  const dow = today.getDay();
  const todayStr = isoDate(today);

  // 3.1 ¿Día permitido para este WF?
  const allowed = workflowName === 'WF3' ? WF3_DAYS : WF1_DAYS;
  if (!allowed.has(dow)) {
    const reason = `Día ${dow} no es día válido de ejecución para ${workflowName}.`;
    await insertRun(workflowName, todayStr, 'skipped', reason, triggeredBy);
    return { shouldRun: false, skipReason: reason };
  }

  // 3.2 ¿Ayer fue festivo? (solo aplica a WF1)
  if (workflowName === 'WF1') {
    const yesterday = isoDate(previousDay(today));
    const wasHoliday = await holidayExists(yesterday);
    if (wasHoliday) {
      const reason = `Ayer (${yesterday}) fue festivo. No hay planeación para recoger hoy.`;
      await insertRun(workflowName, todayStr, 'skipped', reason, triggeredBy);
      return { shouldRun: false, skipReason: reason };
    }
  }

  // 3.3 ¿Ya corrió hoy?
  const existing = await runAlreadyExists(workflowName, todayStr);
  if (existing) {
    const reason = `${workflowName} ya tiene una corrida hoy (run_id=${existing.run_id}, status=${existing.status}). No se reejecuta — los datos no se sobreescriben.`;
    // NO insertamos otra fila — el UNIQUE lo bloquearía. Solo reportamos.
    return { shouldRun: false, skipReason: reason, runId: existing.run_id };
  }

  // 3.4 Insertar la corrida en estado 'running' (el UNIQUE bloquea race conditions).
  let inserted;
  try {
    inserted = await insertRun(workflowName, todayStr, 'running', null, triggeredBy);
  } catch (e) {
    // Race condition: dos triggers casi simultáneos. El segundo recibe error de UNIQUE.
    const reason = `Race condition al iniciar corrida: ${e.message}`;
    return { shouldRun: false, skipReason: reason };
  }

  return { shouldRun: true, runId: inserted.run_id };
}

// ---------- 4) Entry point n8n ----------

const out = [];
for (const item of items) {
  const workflowName = item.json.workflowName || 'WF1';
  const triggeredBy = item.json.triggeredBy || 'cron';
  const decision = await decide(workflowName, triggeredBy);
  out.push({
    json: {
      ...item.json,
      shouldRun: decision.shouldRun,
      runId: decision.runId || null,
      skipReason: decision.skipReason || null,
      workflowName,
    },
  });
}
return out;

// ============================================================
//  Cómo conectarlo:
//    [Cron trigger] -> [Function: este guard]
//      -> [IF shouldRun=true]  -> [resto del WF (parser, inserts, etc)]
//      -> [IF shouldRun=false] -> [LOG / Notificar / Terminar]
//
//  Al finalizar el WF, otro nodo Function debe hacer:
//    UPDATE mp_ingestion_runs
//       SET status='completed', completed_at=NOW(),
//           files_processed=?, files_rejected=?, rows_inserted=?
//     WHERE run_id = ?
//
//  Si el WF falla a mitad de camino, dejar status='failed' con
//  manejo de error (n8n Error Trigger).
// ============================================================
