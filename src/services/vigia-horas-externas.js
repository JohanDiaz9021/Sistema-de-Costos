'use strict';

/**
 * Vigía de horas cargadas por FUERA de la app (21 sep 2026).
 *
 * La caché compartida de indicadores (src/lib/shared-cache.js) se vacía en
 * cada escritura que pasa por el servidor, y para lo que entra por fuera
 * confiaba en su TTL de 60 s. Eso bastaba mientras las horas solo llegaban
 * por la carga manual de Excel, que es una petición más del servidor.
 *
 * Desde que WF-COSTEO (n8n, docs/n8n/wf-costeo/) escribe directo en
 * mp_costeo_task_facts, el servidor no se entera: correr el flujo y
 * recargar Costeo mostraba unas veces el % nuevo y otras el viejo, según
 * cuánto le quedara de vida a la caché. Se leyó, con razón, como un bug
 * ("ejecuto, no sube; ejecuto otra vez, sí sube"). Y el usuario pide que
 * lo que cambia se vea ya (ver la memoria feedback-indicadores-en-vivo).
 *
 * Esto le pregunta a la base, cada INTERVALO_MS, si la tabla cambió, y si
 * cambió vacía la caché. Así lo que carga n8n se ve en ~10 s como máximo.
 *
 * Por qué MAX(fact_id) + COUNT(*) y no una marca de tiempo:
 *   - Cada corrida de n8n BORRA el corte del día y lo vuelve a INSERTAR, y
 *     fact_id es AUTO_INCREMENT: cualquier recarga sube el máximo, aunque
 *     traiga exactamente las mismas filas.
 *   - COUNT(*) cubre lo que MAX no ve: un borrado sin inserción después.
 *   - Las dos son baratas: MAX sale de la llave primaria y la tabla se
 *     mantiene chica (el nodo "Limpiar cortes viejos" borra lo de más de 7
 *     días).
 *
 * Por qué sondeo y no que n8n avise: avisar exigiría que n8n alcance la
 * app por HTTP con un secreto, algo que todavía no está resuelto (la misma
 * duda quedó abierta con el correo de alertas). El sondeo no depende de eso.
 */

const { query } = require('../db');
const { invalidarIndicadores } = require('../lib/shared-cache');

const INTERVALO_MS = 10 * 1000;

let ultimaVersion = null;

// Si la base está lenta y una consulta tarda más que el intervalo, no se
// apilan: el pool de src/db.js espera conexión indefinidamente, y un vigía
// que dispara cada 10 s sin esta guarda podría acaparar conexiones
// justo cuando la base ya está en problemas.
let enCurso = false;

async function leerVersion() {
  const rows = await query('SELECT MAX(fact_id) AS max_id, COUNT(*) AS filas FROM mp_costeo_task_facts');
  return `${rows[0].max_id ?? 0}:${rows[0].filas ?? 0}`;
}

/**
 * Una pasada. Devuelve true si vació la caché.
 *
 * La primera lectura solo fija la línea base: al arrancar el servidor la
 * caché está vacía, no hay nada viejo que tirar.
 *
 * `leer` e `invalidar` se inyectan para poder probar la política sin base.
 */
async function tick({ leer = leerVersion, invalidar = invalidarIndicadores } = {}) {
  if (enCurso) return false;
  enCurso = true;
  try {
    const actual = await leer();
    const cambio = ultimaVersion !== null && actual !== ultimaVersion;
    ultimaVersion = actual;
    if (cambio) invalidar();
    return cambio;
  } catch (err) {
    // Un fallo aquí no puede tumbar nada: en el peor caso los indicadores
    // vuelven a depender del TTL de 60 s, como antes de existir el vigía.
    console.error('[vigia-horas-externas] no se pudo leer la versión de mp_costeo_task_facts:', err.message);
    return false;
  } finally {
    // eslint-disable-next-line require-atomic-updates
    enCurso = false;
  }
}

function startVigiaHorasExternas() {
  tick();
  const interval = setInterval(tick, INTERVALO_MS);
  // No mantiene vivo el proceso por sí solo (scripts, pruebas).
  if (interval.unref) interval.unref();
  console.log(`[vigia-horas-externas] activo — revisa cada ${INTERVALO_MS / 1000} s si n8n cargó horas nuevas`);
  return interval;
}

// Solo para las pruebas: vuelve al estado de recién arrancado.
function resetVigia() {
  ultimaVersion = null;
  enCurso = false;
}

module.exports = { startVigiaHorasExternas, tick, resetVigia, INTERVALO_MS };
