'use strict';

/**
 * costo-export-format.js y ordenarPorSeveridad() — lo que el usuario
 * termina viendo en el PDF/Excel y en el orden del panel de Alertas.
 *
 * Los indicadores se exportan tal cual salen de aqui. Un `null` mal
 * formateado no revienta el export: escribe "NaN" o "null" en un informe
 * que alguien va a firmar, que es peor porque nadie lo nota.
 *
 * #10 y #12-#17 se retiraron de INDICATOR_DEFS (ago-sep 2026, sin dato
 * real o a pedido explícito) — quedan 9 (1..9).
 * El backend los sigue calculando; solo dejaron de mostrarse/exportarse.
 *
 * Funciones puras: no tocan la base.
 */

const test = require('node:test');
const assert = require('node:assert');

const { INDICATOR_DEFS, indicatorRows, formatCOP } = require('../../src/queries/costo-export-format');
const { ordenarPorSeveridad } = require('../../src/queries/costo-alertas');

// ---------------------------------------------------------------
// formatCOP
// ---------------------------------------------------------------

test('formatCOP: separa miles y redondea a peso entero', () => {
  // El separador depende de la locale es-CO; se comprueba la forma, no el
  // caracter exacto, para no atarse a la version de ICU de Node.
  const s = formatCOP(1234567.89);
  assert.match(s, /^\$ /);
  assert.strictEqual(s.replace(/[^\d]/g, ''), '1234568', `redondeo: ${s}`);
});

test('formatCOP: null, undefined y texto se muestran como $ 0 (no NaN)', () => {
  for (const v of [null, undefined, '', 'abc', NaN]) {
    assert.strictEqual(formatCOP(v).replace(/[^\d]/g, ''), '0', String(v));
    assert.ok(!formatCOP(v).includes('NaN'), String(v));
  }
});

test('formatCOP: conserva el signo de un valor negativo', () => {
  assert.match(formatCOP(-5000), /-/);
});

// ---------------------------------------------------------------
// INDICATOR_DEFS / indicatorRows
// ---------------------------------------------------------------

test('INDICATOR_DEFS tiene los 8 indicadores que quedan, sin repetir, renumerados 1..8 sin huecos', () => {
  assert.strictEqual(INDICATOR_DEFS.length, 8);
  assert.deepStrictEqual(
    INDICATOR_DEFS.map((d) => d.num),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
});

// Un centro recien creado, sin horas ni gastos: es lo que devuelve de
// verdad computeIndicadoresDesde() en ese caso — TODOS los campos
// presentes, los porcentajes en null y los conteos en 0.
const CENTRO_SIN_DATOS = {
  presupuesto: 0,
  ejecutado_total: 0,
  ind1_presupuesto_ejecutado_pct: null,
  ind2_tiempo_transcurrido_pct: null,
  ind2_dias_transcurridos: null,
  ind2_dias_totales: null,
  ind3_ritmo_gasto_vs_tiempo: null,
  ind4_fecha_quiebre_presupuestal: null,
  ind4_se_queda_sin_plata_antes: null,
  ind5_ritmo_gasto_semanal: 0,
  ind6_bus_factor_pct: 0,
  ind6_bus_factor_employee_id: null,
  ind6_bus_factor_employee_name: null,
  ind7_personas_trabajando: 0,
  ind8_costo_real_por_hora: 0,
  ind9_proporcion_horas_extra_pct: 0,
  ind9_horas_extra: 0,
  ind9_horas_ejecutadas: 0,
  ind11_trabajo_no_remunerado: 0,
  ind11_trabajo_no_remunerado_pct: null,
  ind12_costo_errores_pct: 0,
  ind12_costo_errores_valor: 0,
  ind13_responsable_sobrecosto_interno_pct: null,
  ind13_horas_interno_valor: 0,
  ind13_horas_con_motivo_valor: 0,
};

test('indicatorRows: un centro sin datos no imprime NaN, undefined ni null', () => {
  for (const def of INDICATOR_DEFS) {
    const valor = def.value(CENTRO_SIN_DATOS);
    assert.strictEqual(typeof valor, 'string', `#${def.num} ${def.name} no devolvio texto`);
    for (const basura of ['NaN', 'undefined', 'null', '[object Object]']) {
      assert.ok(!valor.includes(basura), `#${def.num} ${def.name} imprimio "${basura}": ${valor}`);
    }
  }
});

test('indicatorRows: #6 (Personas Trabajando) NO tolera que falte su campo (hallazgo QA-01)', () => {
  // Se documenta el limite real del formateo, no se tapa: los demas
  // indicadores sobreviven a un objeto incompleto (sus formatPct* siempre
  // revisan null/undefined primero) y este no (`String(undefined)` sin guarda).
  //
  // Hoy NO es alcanzable desde los exports: resolveExportContext() siempre
  // pasa por computeIndicadores17(), que llena todos los campos. Queda como
  // deuda defensiva — si algun dia se exporta un snapshot guardado con una
  // version vieja del motor, ese informe diria "undefined".
  //
  // Esta prueba falla A PROPOSITO el dia que alguien endurezca el formateo:
  // es la señal para borrarla y mover el indicador a la de arriba.
  assert.strictEqual(INDICATOR_DEFS.find((d) => d.num === 6).value({}), 'undefined');

  const fragiles = INDICATOR_DEFS.filter((d) => /undefined/.test(String(d.value({}))));
  assert.deepStrictEqual(
    fragiles.map((d) => d.num), [6],
    'cambio la lista de indicadores que no toleran un objeto incompleto'
  );
});

test('indicatorRows formatea un centro con datos reales', () => {
  const ind17 = {
    presupuesto: 2839400,
    ejecutado_total: 1202806,
    ind1_presupuesto_ejecutado_pct: 42.345,
    ind2_tiempo_transcurrido_pct: 50,
    ind2_dias_transcurridos: 92,
    ind2_dias_totales: 184,
    ind3_ritmo_gasto_vs_tiempo: -7.65,
    ind4_fecha_quiebre_presupuestal: '2026-11-30',
    ind4_se_queda_sin_plata_antes: true,
    ind5_ritmo_gasto_semanal: 1200000,
    ind6_bus_factor_pct: 80,
    ind6_bus_factor_employee_id: 7,
    ind6_bus_factor_employee_name: 'Persona de Prueba',
    ind7_personas_trabajando: 3,
    ind8_costo_real_por_hora: 25000,
    ind9_proporcion_horas_extra_pct: 12.5,
    ind9_horas_extra: 10,
    ind9_horas_ejecutadas: 80,
    ind11_trabajo_no_remunerado: 0,
    ind11_trabajo_no_remunerado_pct: 0,
    ind12_costo_errores_pct: 3.2,
    ind12_costo_errores_valor: 38489.79,
    ind13_responsable_sobrecosto_interno_pct: 70,
    ind13_horas_interno_valor: 700000,
    ind13_horas_con_motivo_valor: 1000000,
  };
  const filas = indicatorRows(ind17);
  assert.strictEqual(filas.length, 8);

  const porNum = new Map(filas.map((f) => [f.num, f.value]));
  assert.match(porNum.get(1), /^42\.3%/, 'redondea a 1 decimal');
  assert.match(porNum.get(1), /de \$ 2\.839\.400/, 'muestra el presupuesto detras del %');
  assert.match(porNum.get(2), /92 de 184 días/, 'muestra los dias detras del %');
  assert.strictEqual(porNum.get(3), '-7.7 pts', 'signo explicito y unidad');
  assert.match(porNum.get(4), /2026-11-30/);
  assert.match(porNum.get(4), /antes de la fecha fin/, 'debe avisar del riesgo');
  assert.strictEqual(porNum.get(6), '3', 'personas trabajando');
  assert.match(porNum.get(8), /10\.0 de 80\.0 horas/, 'muestra las horas extra detras del %');
});

test('indicatorRows: el signo + aparece en una variacion positiva', () => {
  const filas = indicatorRows({ ind3_ritmo_gasto_vs_tiempo: 12.34 });
  const porNum = new Map(filas.map((f) => [f.num, f.value]));
  assert.strictEqual(porNum.get(3), '+12.3 pts');
});

test('indicatorRows: distingue "sin datos" de cero', () => {
  // Confundirlos es un error de lectura caro: 0% ejecutado es un proyecto
  // que no ha gastado; "sin datos" es un proyecto sin presupuesto cargado.
  const sinDatos = new Map(indicatorRows({}).map((f) => [f.num, f.value]));
  const enCero = new Map(indicatorRows({
    ind1_presupuesto_ejecutado_pct: 0, ejecutado_total: 0, presupuesto: 5000000,
    ind3_ritmo_gasto_vs_tiempo: 0,
  }).map((f) => [f.num, f.value]));

  assert.strictEqual(sinDatos.get(1), 'Sin datos');
  assert.match(enCero.get(1), /^0\.0%/);
  assert.strictEqual(sinDatos.get(3), 'Sin datos suficientes');
  assert.strictEqual(enCero.get(3), '+0.0 pts');
});

test('el formato del export coincide con el del front (misma lista de indicadores)', () => {
  // costo-export-format.js duplica a proposito INDICATOR_DEFS de
  // public/js/costeo-core.js porque no comparten runtime. Si los nombres
  // divergen, el usuario ve una cosa en pantalla y descarga otra.
  const fs = require('node:fs');
  const path = require('node:path');
  const front = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'js', 'costeo-core.js'), 'utf8'
  );
  for (const def of INDICATOR_DEFS) {
    assert.ok(
      front.includes(`name: '${def.name}'`) || front.includes(`name: "${def.name}"`),
      `el indicador #${def.num} "${def.name}" no aparece igual en el front`
    );
  }
});

// ---------------------------------------------------------------
// ordenarPorSeveridad
// ---------------------------------------------------------------

test('ordenarPorSeveridad: critica < alta < media < baja', () => {
  const entrada = [
    { severidad: 'baja', id: 1 },
    { severidad: 'critica', id: 2 },
    { severidad: 'media', id: 3 },
    { severidad: 'alta', id: 4 },
  ];
  assert.deepStrictEqual(
    ordenarPorSeveridad(entrada).map((a) => a.severidad),
    ['critica', 'alta', 'media', 'baja']
  );
});

test('ordenarPorSeveridad: no muta el arreglo original', () => {
  const entrada = [{ severidad: 'baja' }, { severidad: 'critica' }];
  const copia = [...entrada];
  ordenarPorSeveridad(entrada);
  assert.deepStrictEqual(entrada, copia, 'el llamador puede seguir usando su arreglo');
});

test('ordenarPorSeveridad: mantiene el orden relativo dentro de una misma severidad', () => {
  // Estabilidad: dos alertas criticas del mismo centro deben salir en el
  // orden en que se generaron, no barajadas en cada recarga.
  const entrada = [
    { severidad: 'critica', id: 'a' },
    { severidad: 'critica', id: 'b' },
    { severidad: 'critica', id: 'c' },
  ];
  assert.deepStrictEqual(ordenarPorSeveridad(entrada).map((a) => a.id), ['a', 'b', 'c']);
});

test('ordenarPorSeveridad: un arreglo vacio no revienta', () => {
  assert.deepStrictEqual(ordenarPorSeveridad([]), []);
});
