'use strict';

/**
 * Verificación de solo lectura del módulo de Costeo.
 *
 * NO ESCRIBE NADA. Solo SELECT e information_schema. Se puede correr en
 * producción sin riesgo: no hay INSERT, UPDATE, DELETE, ALTER ni DROP.
 *
 * Responde las 4 preguntas de las que depende cualquier corrección:
 *   1. ¿Qué valor de horas legales está aplicando el sistema HOY?
 *   2. ¿El histórico de horas extra ya quedó mezclado con distintos valores?
 *   3. ¿Hay talentos duplicados dentro de un mismo centro de costos?
 *   4. ¿La migración sql/17 ya se aplicó?
 *
 * Uso: node scripts/verify-costeo-readonly.js
 */

require('dotenv').config();
const { pool, query } = require('../src/db');

// Mismo valor que CONFIG_DEFAULTS en src/queries/costo-common.js: lo que el
// motor aplicaría si la fila de config no existiera.
const FALLBACK_EN_CODIGO = 42;
const VALOR_SEMBRADO_EN_SQL = 46;

const line = (t = '') => console.log(t);
const rule = () => line('-'.repeat(72));

async function main() {
  line();
  line('VERIFICACIÓN DE SOLO LECTURA — MÓDULO DE COSTEO');
  line(`Base: ${process.env.DB_NAME}  ·  Host: ${process.env.DB_HOST}`);
  rule();

  // ---------------------------------------------------------------
  // 1. ¿Qué horas legales está aplicando el motor hoy?
  // ---------------------------------------------------------------
  line();
  line('[1] HORAS LEGALES VIGENTES');
  const cfg = await query(
    "SELECT config_key, config_value, updated_at FROM mp_costeo_config WHERE config_key = 'weekly_legal_hours'"
  );

  if (!cfg.length) {
    line(`    !! La fila NO existe. El motor está aplicando el respaldo del código: ${FALLBACK_EN_CODIGO}h`);
    line(`       El PDF y sql/10 dicen que debería ser ${VALOR_SEMBRADO_EN_SQL}h.`);
    line('       => Corregir el código a 46 CAMBIARÍA los cálculos en vivo.');
  } else {
    const v = Number(cfg[0].config_value);
    line(`    Fila encontrada: weekly_legal_hours = ${v}h (actualizada: ${cfg[0].updated_at || 'nunca'})`);
    if (v === VALOR_SEMBRADO_EN_SQL) {
      line('    OK: coincide con el PDF. El respaldo de 42 en el código es código muerto.');
      line('       => Alinearlo a 46 es cosmético y no cambia ningún cálculo.');
    } else {
      line(`    !! No coincide con el PDF (${VALOR_SEMBRADO_EN_SQL}h). Verificar cuál es el valor oficial.`);
    }
  }

  // Todos los umbrales, para ver cuáles faltan.
  const todos = await query('SELECT config_key, config_value FROM mp_costeo_config ORDER BY config_key');
  line(`    Umbrales configurados (${todos.length}): ${todos.map((r) => `${r.config_key}=${r.config_value}`).join(', ') || '(ninguno)'}`);

  // ---------------------------------------------------------------
  // 2. ¿El histórico de horas extra quedó mezclado?
  // ---------------------------------------------------------------
  line();
  line('[2] COHERENCIA DEL HISTÓRICO DE HORAS EXTRA');
  const mezcla = await query(
    `SELECT legal_hours, COUNT(*) AS filas,
            MIN(CONCAT(year_number,'-S',week_number)) AS desde,
            MAX(CONCAT(year_number,'-S',week_number)) AS hasta
       FROM mp_overtime_decisions
      GROUP BY legal_hours
      ORDER BY legal_hours`
  );

  if (!mezcla.length) {
    line('    Tabla vacía: no hay filas materializadas todavía.');
    line('    => Momento ideal para corregir la config ANTES de que se congele nada.');
  } else if (mezcla.length === 1) {
    line(`    OK: las ${mezcla[0].filas} filas usan el mismo valor (${mezcla[0].legal_hours}h), de ${mezcla[0].desde} a ${mezcla[0].hasta}.`);
  } else {
    line(`    !! HISTÓRICO MEZCLADO: ${mezcla.length} valores distintos de legal_hours conviviendo.`);
    mezcla.forEach((r) => line(`       ${r.legal_hours}h -> ${r.filas} filas (${r.desde} .. ${r.hasta})`));
    line('       Estas filas NO se recalculan solas: syncOvertimeDecisions usa INSERT IGNORE.');
  }

  // Cuántas de esas filas ya tienen plata comprometida (no se pueden tocar a la ligera).
  const comprometidas = await query(
    `SELECT approval_status, COUNT(*) AS filas, COALESCE(SUM(extra_cost_final),0) AS total_final
       FROM mp_overtime_decisions
      GROUP BY approval_status
      ORDER BY approval_status`
  );
  if (comprometidas.length) {
    line('    Estado de aprobación:');
    comprometidas.forEach((r) =>
      line(`       ${String(r.approval_status).padEnd(14)} ${String(r.filas).padStart(5)} filas · $${Number(r.total_final).toLocaleString('es-CO')} pagados`)
    );
  }

  // ---------------------------------------------------------------
  // 3. ¿Hay talentos duplicados en un mismo centro? (bloquea sql/17)
  // ---------------------------------------------------------------
  line();
  line('[3] DUPLICADOS EN mp_equipo_proyecto (bloquean la migración sql/17)');
  const dups = await query(
    `SELECT ep.cost_center_id, cc.project_name, ep.employee_id, e.canonical_name,
            COUNT(*) AS veces,
            GROUP_CONCAT(CONCAT(ep.team_member_id,':$',ep.hourly_cost,':',IF(ep.is_active,'activo','inactivo'))
                         ORDER BY ep.team_member_id SEPARATOR '  |  ') AS filas
       FROM mp_equipo_proyecto ep
       LEFT JOIN mp_centro_costo cc ON cc.cost_center_id = ep.cost_center_id
       LEFT JOIN mp_employees   e  ON e.employee_id     = ep.employee_id
      GROUP BY ep.cost_center_id, ep.employee_id
     HAVING COUNT(*) > 1
      ORDER BY veces DESC`
  );

  if (!dups.length) {
    line('    OK: ningún talento repetido dentro del mismo centro. La migración puede aplicarse.');
  } else {
    line(`    !! ${dups.length} caso(s) duplicado(s). La migración FALLARÍA con error 1062.`);
    line('       Requieren decisión humana: cuál fila conserva la tarifa correcta.');
    dups.forEach((r) => {
      line(`       - ${r.canonical_name || `empleado ${r.employee_id}`} en "${r.project_name || `centro ${r.cost_center_id}`}" (${r.veces}x)`);
      line(`         filas [id:tarifa:estado] -> ${r.filas}`);
    });
  }

  // ---------------------------------------------------------------
  // 4. ¿La migración sql/17 ya se aplicó?
  // ---------------------------------------------------------------
  line();
  line('[4] ESTADO DE LA MIGRACIÓN sql/17');
  const idx = await query(
    `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'mp_equipo_proyecto'
      GROUP BY INDEX_NAME, NON_UNIQUE`
  );
  const yaExiste = idx.some((r) => r.INDEX_NAME === 'uk_equipo_centro_talento');
  line(`    Índices en mp_equipo_proyecto: ${idx.map((r) => r.INDEX_NAME).join(', ')}`);
  if (yaExiste) {
    line('    Ya aplicada: el índice uk_equipo_centro_talento existe.');
    line('    => Re-ejecutar sql/17 tal como está fallaría con error 1061. Necesita el guard.');
  } else {
    line('    Pendiente: el índice NO existe.');
    line(dups.length
      ? '    => NO aplicar todavía: primero resolver los duplicados del punto [3].'
      : '    => Segura de aplicar (con guard de idempotencia).');
  }

  // ---------------------------------------------------------------
  // Contexto general
  // ---------------------------------------------------------------
  line();
  line('[5] CONTEXTO');
  const [centros] = await query('SELECT COUNT(*) AS n FROM mp_centro_costo');
  const [equipo] = await query('SELECT COUNT(*) AS n FROM mp_equipo_proyecto');
  const [sinTarifa] = await query(
    `SELECT COUNT(*) AS n FROM mp_equipo_proyecto WHERE hourly_cost IS NULL OR hourly_cost = 0`
  );
  line(`    Centros de costo: ${centros.n}  ·  Integrantes de equipo: ${equipo.n}  ·  Con tarifa en 0: ${sinTarifa.n}`);

  // El punto ciego del hallazgo 02: gente con horas registradas que NO está en el equipo.
  const huerfanos = await query(
    `SELECT e.canonical_name, cc.project_name, COUNT(*) AS filas_task
       FROM mp_task_facts t
       JOIN mp_employees    e  ON e.employee_id     = t.employee_id
       JOIN mp_centro_costo cc ON cc.project_folder = t.project_folder
       LEFT JOIN mp_equipo_proyecto ep
              ON ep.cost_center_id = cc.cost_center_id
             AND ep.employee_id    = t.employee_id
             AND ep.is_active      = 1
      WHERE ep.team_member_id IS NULL
        AND e.is_active = 1
      GROUP BY e.employee_id, cc.cost_center_id
      ORDER BY filas_task DESC
      LIMIT 15`
  );
  line();
  line('[6] TALENTOS CON HORAS PERO SIN TARIFA (hallazgo 02: cuestan $0 en silencio)');
  if (!huerfanos.length) {
    line('    OK: todo el que registra horas tiene tarifa en su centro.');
  } else {
    line(`    !! ${huerfanos.length} combinación(es) talento/proyecto sin tarifa. Sus horas valen $0 hoy:`);
    huerfanos.forEach((r) => line(`       - ${r.canonical_name} en "${r.project_name}" (${r.filas_task} registros)`));
  }

  line();
  rule();
  line('Fin. No se modificó ningún dato.');
  line();
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
