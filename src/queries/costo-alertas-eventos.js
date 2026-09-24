'use strict';

/**
 * Seguimiento y escalamiento de alertas (sql/19 + a pedido explícito, 1 sep
 * 2026) — conecta el motor de reglas de costo-alertas.js (que recalcula en
 * vivo y nunca guarda nada) con las 3 tablas de sql/19 que ya existían pero
 * nadie usaba: mp_alerta_tipo (catálogo), mp_alerta_evento (CUÁNDO se
 * detectó cada alerta por primera vez y si sigue abierta) y mp_alerta_envio
 * (queda sin usar por ahora: no hay canal de correo configurado, el
 * seguimiento vive dentro de la app).
 *
 * La idea, en una frase: cada vez que alguien abre Alertas, se sincroniza
 * lo que el motor está detectando AHORA contra lo que ya se venía seguido
 * — así mp_alerta_evento.primera_vez_at queda como la fecha real en que
 * ese problema apareció, sin importar cuántas veces se haya recalculado.
 * Con esa fecha se puede responder "¿esto lleva 3+ días sin corregirse?".
 *
 * Escalamiento (a pedido explícito, ajustado 2 sep 2026):
 *   3-4 días abierta -> recordatorio al PM del centro (nivel 'pm').
 *   5   días abierta -> último aviso al PM (nivel 'pm' + es_ultimo_aviso):
 *                       "si no se corrige, mañana la ve el CEO".
 *   6+  días abierta -> se le muestra también al CEO/admin (nivel 'ceo').
 * No hay "avisos" que se manden aparte: es la MISMA alerta, que se vuelve
 * más visible mientras más tiempo lleve sin corregirse — no hace falta
 * guardar "ya se le avisó" porque no hay un envío que evitar duplicar.
 */

const { query } = require('../db');

// Traduce el texto de "tipo" que arma costo-alertas.js al código estable
// del catálogo (mp_alerta_tipo, sembrado en sql/19). Es la única alerta que
// NO aparece aquí es 'autorizacion_jair': se quitó del flujo el 25 ago
// 2026 y costo-alertas.js ya no la emite.
const TIPO_A_CODIGO = {
  'Proyección de cierre': 'proyeccion_cierre',
  'Presupuesto casi agotado': 'presupuesto_agotado',
  'Desviación presupuestal': 'desviacion_presupuestal',
  'Aprobación pendiente': 'aprobacion_pendiente',
  'Decisión pendiente del PM': 'decision_pendiente_pm',
  'Hora extra rechazada': 'hora_extra_rechazada',
  'Trabajo no remunerado': 'trabajo_no_remunerado',
  'Exceso de horas extra': 'exceso_horas_extra',
  'Sobrecostos mayormente internos': 'sobrecostos_internos',
  'Talento sin costo/hora registrado': 'talento_sin_tarifa',
  'Dependencia crítica de una persona': 'bus_factor',
  'Equipo de una sola persona': 'equipo_una_persona',
  'Sobrecarga cross-proyecto': 'sobrecarga_cross',
  'Costo/hora por encima del promedio': 'costo_hora_sobre_promedio',
  'Índice de no-calidad': 'indice_no_calidad',
  Vencido: 'proyecto_vencido',
  'Vencimiento próximo': 'vencimiento_proximo',
  'Gasto atípico registrado': 'gasto_atipico',
  'Gasto poco predecible': 'gasto_no_predecible',
  'Dato desactualizado': 'dato_desactualizado',
  'Sin PM asignado': 'sin_pm_asignado',
};

// Identidad estable de una alerta: tipo + centro + entidad (persona, gasto,
// decisión de hora extra... lo que distinga DOS alertas del mismo tipo en
// el mismo centro). 'global' en vez de NULL en el centro porque una UNIQUE
// KEY en MySQL trata cada NULL como distinto — dos alertas globales sin
// esto NUNCA chocarían entre sí ni se detectarían como la misma.
function construirClaveDedup(codigo, alerta) {
  return `${codigo}:${alerta.cost_center_id ?? 'global'}:${alerta.entidad ?? ''}`;
}

// Vuelca lo que el motor detectó AHORA a mp_alerta_evento: abre lo nuevo,
// refresca lo que sigue igual (sin tocar primera_vez_at — esa fecha es la
// que le da sentido a los 3/5 días) y cierra lo que ya no se detecta.
//
// `alcance` dice qué pedazo de la realidad se acaba de recalcular, para NO
// cerrar por accidente alertas de centros que esta llamada ni siquiera
// miró (un PM solo ve —y por lo tanto solo sincroniza— sus propios
// centros; si se cerrara todo lo que no está en `alertas`, las alertas de
// TODOS los demás proyectos se marcarían "resueltas" cada vez que ese PM
// abre su pantalla).
async function sincronizarEventos(alertas, alcance) {
  const { costCenterIds = [], incluyeGlobales = false } = alcance;
  const dedupsVigentes = [];

  for (const a of alertas) {
    const codigo = TIPO_A_CODIGO[a.tipo];
    if (!codigo) continue; // no debería pasar; si pasa, no se sigue en vez de reventar la pantalla
    const clave = construirClaveDedup(codigo, a);
    dedupsVigentes.push(clave);
    // mp_alerta_evento.valor es DECIMAL(14,2): la mayoría de las alertas
    // mandan un número, pero "Proyección de cierre" manda una FECHA como
    // valor (ind4_fecha_quiebre_presupuestal, ver costo-alertas.js) — eso
    // no cabe en una columna decimal y MySQL lo rechaza. Aquí solo importa
    // guardar un número si lo hay; el detalle en texto ya trae la fecha.
    const valorNumerico = a.valor !== null && a.valor !== undefined && Number.isFinite(Number(a.valor))
      ? Number(a.valor) : null;
    await query(
      `INSERT INTO mp_alerta_evento
         (codigo, cost_center_id, clave_dedup, severidad, detalle, valor, estado, primera_vez_at, ultima_vez_at)
       VALUES (?, ?, ?, ?, ?, ?, 'abierta', NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         severidad = VALUES(severidad),
         detalle = VALUES(detalle),
         valor = VALUES(valor),
         ultima_vez_at = NOW(),
         -- Si venía 'resuelta' y reaparece, es una recaída nueva: el
         -- contador de días vuelve a arrancar en 0, no sigue desde la vez
         -- pasada. Si venía 'abierta', primera_vez_at no se toca.
         primera_vez_at = IF(estado = 'resuelta', NOW(), primera_vez_at),
         -- 'silenciada' la dejó alguien a propósito (fuera del alcance de
         -- esta sesión: no hay UI para eso todavía) — no se reabre sola.
         estado = IF(estado = 'silenciada', 'silenciada', 'abierta')`,
      [codigo, a.cost_center_id, clave, a.severidad, a.detalle, valorNumerico]
    );
  }

  const condiciones = [];
  const params = [];
  if (costCenterIds.length) {
    condiciones.push(`cost_center_id IN (${costCenterIds.map(() => '?').join(',')})`);
    params.push(...costCenterIds);
  }
  if (incluyeGlobales) condiciones.push('cost_center_id IS NULL');
  if (!condiciones.length) return; // nada en el alcance de esta llamada

  const clausulaVigentes = dedupsVigentes.length
    ? `AND clave_dedup NOT IN (${dedupsVigentes.map(() => '?').join(',')})`
    : '';
  await query(
    `UPDATE mp_alerta_evento SET estado = 'resuelta', resuelta_at = NOW()
      WHERE estado = 'abierta' AND (${condiciones.join(' OR ')}) ${clausulaVigentes}`,
    [...params, ...dedupsVigentes]
  );
}

// Tipos que NO entran al escalamiento por días (17 sep 2026, a pedido
// explícito: "las que se puedan solucionar colócalas en Alertas sin
// corregir"). El resto de las 19 alertas por centro mide un ESTADO actual
// (% de presupuesto, si hay tarifa, si hay PM asignado...) que se corrige
// solo cuando el dato mejora — sincronizarEventos las cierra solas y ahí sí
// tiene sentido subirle la presión al PM cada día que sigan abiertas.
//
// Estas dos no: se disparan por un registro YA decidido/cerrado que no
// vuelve a evaluarse distinto por su cuenta, así que "sin corregir" nunca
// se apaga sola y terminaría escalando al CEO para siempre sin que nadie
// hubiera hecho nada mal:
//   - trabajo_no_remunerado: suma horas extra con pm_decision='no'. Esa
//     decisión es irreversible por diseño (decideOvertime: "una vez
//     resuelta, no se puede volver a decidir sobre la misma fila") — la
//     única forma de que baje es borrar esa hora extra (admin/ceo).
//   - gasto_atipico: un gasto puntual YA aprobado que pesa ≥3% del
//     presupuesto. Un gasto aprobado no cambia solo; solo se resuelve
//     editándolo/borrándolo (admin/ceo) o subiendo el presupuesto.
// Siguen viéndose normal en su pestaña de severidad — solo no entran a
// "sin corregir" ni a la escalada de días.
const CODIGOS_SIN_ESCALAMIENTO = ['trabajo_no_remunerado', 'gasto_atipico'];

// Alertas visibles en "Sin corregir" desde el día en que se detectan (21
// sep 2026, a pedido explícito: mostrarla antes NO le quita días al PM —
// el umbral que de verdad importa es cuándo escala al CEO, y ese sigue en
// 6 días completos). Solo las de un centro puntual: las globales
// (cross-proyecto, costo/hora sobre promedio) ya son exclusivas de
// admin/ceo en el catálogo (sql/19, destinatario_regla='admin'), no hay a
// qué PM recordárselas.
//
// nivel: 'pm' de 0 a 5 días (5 es el último aviso, ver es_ultimo_aviso),
// 'ceo' de 6 días en adelante — el PM tiene el día 5 completo como última
// oportunidad antes de que esto se vuelva visible para el CEO.
//
// scopeF: misma forma que projectScopeClause pero ya resuelta contra
// mp_centro_costo (ver getEscalamientos) — así un leader solo ve el
// escalamiento de SUS proyectos, y admin/ceo los de todos.
async function getEscalamientos(scopeF) {
  const rows = await query(
    `SELECT ev.evento_id, ev.codigo, ev.clave_dedup, at.nombre AS tipo, ev.cost_center_id, cc.project_name,
            ev.severidad, ev.detalle, ev.valor, ev.primera_vez_at,
            DATEDIFF(NOW(), ev.primera_vez_at) AS dias_abierta
       FROM mp_alerta_evento ev
       JOIN mp_alerta_tipo at ON at.codigo = ev.codigo
       JOIN mp_centro_costo cc ON cc.cost_center_id = ev.cost_center_id
      WHERE ev.estado = 'abierta'
        AND ev.cost_center_id IS NOT NULL
        AND ev.codigo NOT IN (${CODIGOS_SIN_ESCALAMIENTO.map(() => '?').join(',')})
        -- Marcada como corregida HOY: se oculta el resto del día (sql/41).
        -- Mañana vuelve a entrar y son los datos los que deciden: si el
        -- problema se arregló de verdad, el motor ya no la detecta y
        -- sincronizarEventos la cierra sola; si sigue, reaparece.
        --
        -- Se compara por DÍA y no por horas a propósito: "lo corrijo y lo
        -- confirmamos mañana" es la promesa, no "lo corrijo y me deja en paz
        -- 24 horas exactas" — con horas, marcarla a las 5 de la tarde la
        -- escondería media mañana del día siguiente.
        AND (ev.corregida_at IS NULL OR DATE(ev.corregida_at) < CURDATE())
        ${scopeF.clause}
      ORDER BY dias_abierta DESC, ev.severidad`,
    [...CODIGOS_SIN_ESCALAMIENTO, ...scopeF.params]
  );
  return rows.map((r) => ({
    evento_id: r.evento_id,
    codigo: r.codigo,
    // La usa anotarDiasAbierta() para cruzar cada escalamiento con la
    // alerta que el motor está detectando ahora mismo.
    clave_dedup: r.clave_dedup,
    tipo: r.tipo,
    cost_center_id: r.cost_center_id,
    project_name: r.project_name,
    severidad: r.severidad,
    detalle: r.detalle,
    valor: r.valor !== null ? Number(r.valor) : null,
    dias_abierta: Number(r.dias_abierta),
    // 'pm' = todavía es un recordatorio para quien lidera el proyecto.
    // 'ceo' = ya pasó el umbral y se le muestra también al CEO/admin.
    nivel: Number(r.dias_abierta) >= 6 ? 'ceo' : 'pm',
    // Exactamente el día 5: última oportunidad antes de escalar — el
    // front lo usa para cambiar el mensaje sin inventar un tercer nivel.
    es_ultimo_aviso: Number(r.dias_abierta) === 5,
  }));
}

// Marca cada alerta con los días que lleva abierta, para que el panel pueda
// resaltar en la lista completa las que no se han corregido (10 sep 2026, a
// pedido explícito) sin tener que mostrarlas en una lista aparte.
//
// El cruce va por clave_dedup y no por tipo+centro, que es lo que se
// pareciría a mano: la identidad de una alerta es codigo:centro:ENTIDAD
// (ver construirClaveDedup), así que dos alertas del mismo tipo en el mismo
// centro — dos gastos atípicos, dos personas sin tarifa — son distintas.
// Cruzar sin la entidad les pondría a todas los días de la primera.
//
// Se hace aquí y no en el front porque el front solo conoce el `tipo`
// legible: el codigo del catálogo y la entidad viven de este lado.
function anotarDiasAbierta(alertas, escalamientos) {
  const porClave = new Map(escalamientos.map((e) => [e.clave_dedup, e]));
  return alertas.map((a) => {
    const codigo = TIPO_A_CODIGO[a.tipo];
    const esc = codigo ? porClave.get(construirClaveDedup(codigo, a)) : null;
    if (!esc) return a;
    return { ...a, dias_abierta: esc.dias_abierta, nivel: esc.nivel, es_ultimo_aviso: esc.es_ultimo_aviso };
  });
}

/**
 * Busca el evento abierto de una alerta por su clave. Devuelve null si no
 * existe o ya no está abierta.
 *
 * Va separado de la escritura a proposito: devuelve cost_center_id para que
 * el route compruebe el ALCANCE antes de escribir nada — sin eso, un líder
 * podría marcar como corregida una alerta de un proyecto que ni siquiera ve.
 */
async function buscarEventoAbierto(claveDedup) {
  const filas = await query(
    `SELECT ev.evento_id, ev.cost_center_id, ev.estado, at.nombre AS tipo
       FROM mp_alerta_evento ev
       JOIN mp_alerta_tipo at ON at.codigo = ev.codigo
      WHERE ev.clave_dedup = ? AND ev.estado = 'abierta'
      LIMIT 1`,
    [claveDedup]
  );
  if (!filas.length) return null;
  return filas[0];
}

/**
 * Marca el evento como corregido a mano (sql/41).
 *
 * NO cierra la alerta: la esconde de "sin corregir" el resto del día. Quien
 * decide si de verdad se corrigió son los datos, mañana — si el problema
 * sigue, el motor la vuelve a detectar y reaparece con TODOS los días que
 * lleva, porque primera_vez_at no se toca (ver el comentario de sql/41:
 * reiniciarlo permitiría esquivar el escalamiento marcando cada mañana).
 */
async function guardarCorregida(eventoId, userId) {
  await query(
    'UPDATE mp_alerta_evento SET corregida_at = NOW(), corregida_por = ? WHERE evento_id = ?',
    [userId || null, eventoId]
  );
}

module.exports = {
  buscarEventoAbierto, guardarCorregida, CODIGOS_SIN_ESCALAMIENTO,
  TIPO_A_CODIGO, construirClaveDedup, sincronizarEventos, getEscalamientos, anotarDiasAbierta,
};
