'use strict';

/**
 * 5.1 (automático) — antes el snapshot diario dependía de que alguien
 * entrara y le diera clic al botón "Guardar snapshot". Este servicio corre
 * dentro del mismo proceso de server.js y, una vez al día, guarda solo
 * (sin intervención humana) un snapshot del portafolio completo y uno por
 * cada centro de costos activo — mismo criterio que usa el botón manual
 * (POST /api/costeo/snapshot en src/routes/costeo/snapshots.js).
 *
 * No usamos node-cron para no sumar una dependencia nueva: un setInterval
 * que revisa cada hora si ya se guardó hoy es suficiente para "una vez al
 * día" y sobrevive a reinicios del contenedor sin duplicar snapshots.
 *
 * OJO si algún día esto escala a más de una réplica: el "¿ya existe uno de
 * hoy?" es un SELECT seguido de un INSERT, no una operación atómica, así
 * que dos contenedores arrancando a la vez podrían guardar el mismo
 * snapshot dos veces. Con un solo contenedor (el despliegue actual) no
 * pasa. La solución sería una UNIQUE KEY (cost_center_id, snapshot_date),
 * pero hoy rompería el botón manual, que sí permite guardar a demanda.
 */

const { query } = require('../db');
const { computeIndicadores17, computeIndicadoresPortafolio } = require('../queries/costo-indicadores-17');
const { createSnapshot } = require('../queries/costo-snapshot');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // revisa cada hora
const RUN_AFTER_HOUR = 6; // no dispara antes de las 6am

// El tick anterior puede seguir corriendo: con muchos centros, calcular los
// 17 indicadores de cada uno tarda, y si el proceso se atasca contra la base
// el setInterval igual dispara al cumplirse la hora. Sin esta bandera, dos
// pasadas simultáneas se pisan y ambas creerían que "todavía no hay
// snapshot de hoy", duplicando filas.
let enCurso = false;

async function getCentrosActivos() {
  return query(
    `SELECT cost_center_id, project_folder, project_name, budget, status,
            contract_value, start_date, planned_end_date, actual_end_date
       FROM mp_centro_costo
      WHERE status != 'inactivo'
      ORDER BY project_name`
  );
}

/**
 * Fecha y hora SEGÚN LA BASE, no según el contenedor.
 *
 * Antes esto mezclaba dos relojes: la hora salía de new Date().getHours()
 * (zona horaria del contenedor) y el "¿ya hay uno de hoy?" comparaba contra
 * CURDATE() (zona horaria de MariaDB). El pool además está configurado en
 * timezone 'Z'. Con esas tres zonas en juego, cerca de la medianoche el
 * snapshot diario se saltaba un día o se guardaba dos veces. Preguntándole
 * la hora a la misma base que guarda el dato, el problema desaparece sin
 * tener que configurar TZ en el contenedor.
 */
async function ahoraSegunLaBase() {
  const rows = await query('SELECT CURDATE() AS hoy, HOUR(NOW()) AS hora');
  return { hoy: rows[0].hoy, hora: Number(rows[0].hora) };
}

// Qué centros YA tienen snapshot de hoy, en UNA sola query.
// Antes era un SELECT por centro dentro del bucle (N+1).
async function centrosConSnapshotHoy() {
  const rows = await query(
    `SELECT cost_center_id FROM mp_costeo_snapshot WHERE snapshot_date = CURDATE()`
  );
  return {
    // cost_center_id NULL identifica al snapshot del portafolio.
    portafolio: rows.some((r) => r.cost_center_id === null),
    centros: new Set(rows.filter((r) => r.cost_center_id !== null).map((r) => r.cost_center_id)),
  };
}

async function guardarSnapshotsAutomaticos() {
  const centros = await getCentrosActivos();
  if (!centros.length) return;

  const yaGuardado = await centrosConSnapshotHoy();

  if (!yaGuardado.portafolio) {
    const ind17 = await computeIndicadoresPortafolio(centros);
    if (ind17) {
      await createSnapshot({
        costCenterId: null,
        projectName: 'Todos los proyectos (portafolio)',
        ind17,
        userId: null,
      });
      console.log('[snapshot-scheduler] snapshot automático del portafolio guardado');
    }
  }

  for (const centro of centros) {
    if (yaGuardado.centros.has(centro.cost_center_id)) continue;
    const ind17 = await computeIndicadores17(centro);
    await createSnapshot({
      costCenterId: centro.cost_center_id,
      projectName: centro.project_name,
      ind17,
      userId: null,
    });
    console.log(`[snapshot-scheduler] snapshot automático guardado: ${centro.project_name}`);
  }
}

// tick() recibe sus dos dependencias caras (leer el reloj, guardar) como
// parametros con default. Es el unico cambio de este archivo hecho SOLO
// por testeabilidad: sin esto, probar la guarda "no dispara antes de las
// 6am" o la reentrancia exigiria manipular la hora real de MariaDB o
// esperar a que pasara una hora de verdad entre dos llamadas. Con la
// inyeccion, una prueba puede pasar un `ahora` falso que devuelva
// { hora: 3 } y comprobar que `guardar` NUNCA se llamo, o un `guardar`
// lento para forzar la carrera de reentrancia a voluntad. El comportamiento
// por defecto (sin argumentos) es exactamente el de antes.
async function tick({ ahora = ahoraSegunLaBase, guardar = guardarSnapshotsAutomaticos } = {}) {
  if (enCurso) {
    console.warn('[snapshot-scheduler] la pasada anterior sigue corriendo, se salta esta');
    return { corrio: false, motivo: 'reentrancia' };
  }
  enCurso = true;
  try {
    const { hora } = await ahora();
    if (hora < RUN_AFTER_HOUR) return { corrio: false, motivo: 'fuera_de_horario' };
    await guardar();
    return { corrio: true };
  } catch (err) {
    console.error('[snapshot-scheduler] error guardando snapshots automáticos:', err);
    return { corrio: false, motivo: 'error', error: err };
  } finally {
    // El chequeo de arriba (if (enCurso) return; enCurso = true;) no tiene
    // ningun await en medio, asi que es atomico en JavaScript: no hay forma
    // de que dos ticks entren a la vez. La regla no sabe distinguir este
    // patron de guarda de una condicion de carrera real.
    // eslint-disable-next-line require-atomic-updates
    enCurso = false;
  }
}

function startSnapshotScheduler() {
  tick(); // por si el contenedor arranca después de las 6am y aún no hay snapshot de hoy
  // Se devuelve el handle del intervalo (antes se descartaba). server.js no
  // lo usa — el proceso vive mientras el servidor esté arriba —, pero
  // test/integration/snapshot-scheduler.test.js sí necesita poder pararlo
  // con clearInterval() al terminar la prueba, o el intervalo de una hora
  // seguiría disparando tick() durante el resto de la suite.
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[snapshot-scheduler] activo — revisa cada hora, guarda 1 vez al día después de las 06:00');
  return interval;
}

module.exports = {
  startSnapshotScheduler,
  // Expuestas para test/integration/snapshot-scheduler.test.js. No las usa
  // nada mas del proyecto — server.js solo llama a startSnapshotScheduler().
  tick,
  guardarSnapshotsAutomaticos,
  ahoraSegunLaBase,
  centrosConSnapshotHoy,
  getCentrosActivos,
  RUN_AFTER_HOUR,
};
