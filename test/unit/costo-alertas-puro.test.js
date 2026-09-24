'use strict';

/**
 * Funciones puras de src/queries/costo-alertas.js — evaluarAlertasDeCentro()
 * (las 19 reglas de negocio de un centro, separadas de sus queries),
 * diasEntre(), mapearSobrecargaCross() y calcularCostoHoraSobrePromedio()
 * (alertas 8 y 21, separadas de sus queries). Nada de esto toca la base de
 * datos, así que se prueba con fixtures armados a mano.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  evaluarAlertasDeCentro,
  diasEntre,
  mapearSobrecargaCross,
  calcularCostoHoraSobrePromedio,
} = require('../../src/queries/costo-alertas');

// Centro/ind17/datos neutrales: no deberían disparar NINGUNA alerta. Cada
// test copia esta base y cambia solo el campo que quiere probar.
const CENTRO_BASE = {
  cost_center_id: 1,
  project_name: 'Proyecto X',
  status: 'activo',
  project_folder: 'ALFA',
  planned_end_date: null,
  actual_end_date: null,
  budget: 1000,
};

const IND17_BASE = {
  ind4_se_queda_sin_plata_antes: false,
  ind4_fecha_quiebre_presupuestal: null,
  ind3_ritmo_gasto_vs_tiempo: 0,
  ind12_costo_errores_pct: 0,
  ind11_trabajo_no_remunerado: 0,
  ind6_bus_factor_pct: 0,
  ind7_personas_trabajando: 2,
  ind9_proporcion_horas_extra_pct: 0,
  ind14_gasto_no_predecible_pct: 0,
  ind13_responsable_sobrecosto_interno_pct: 0,
  ind1_presupuesto_ejecutado_pct: 0,
};

const DATOS_BASE = {
  overtimeRows: [],
  // Un gasto minúsculo (0.1% del presupuesto) para no disparar la alerta 9
  // (Dato desactualizado, que exige gastos.length === 0) ni la 16 (Gasto
  // atípico, que exige >=3% del presupuesto).
  gastos: [{ expense_id: 1, description: 'Gasto normal', amount: 1 }],
  pmActivo: true,
  sinTarifa: [],
  diasAntesPreventiva: 7,
  umbralPresupuesto: 90,
};

function evaluar({ centro, ind17, datos } = {}) {
  return evaluarAlertasDeCentro(
    { ...CENTRO_BASE, ...centro },
    { ...IND17_BASE, ...ind17 },
    { ...DATOS_BASE, ...datos }
  );
}

function tipos(alertas) {
  return alertas.map((a) => a.tipo);
}

test('evaluarAlertasDeCentro: estado neutral no dispara ninguna alerta', () => {
  assert.deepStrictEqual(evaluar(), []);
});

test('evaluarAlertasDeCentro: 1 — Proyección de cierre', () => {
  const alertas = evaluar({ ind17: { ind4_se_queda_sin_plata_antes: true, ind4_fecha_quiebre_presupuestal: '2026-09-01' } });
  assert.deepStrictEqual(tipos(alertas), ['Proyección de cierre']);
  assert.strictEqual(alertas[0].severidad, 'critica');
  assert.strictEqual(alertas[0].valor, '2026-09-01');
});

// Las alertas 2, 3 y 17 (Aprobación pendiente / Hora extra rechazada /
// Decisión pendiente del PM) se retiraron el 4 sep 2026, a pedido explícito:
// no existe flujo de aprobación de horas extra — se registran desde la
// plataforma y quedan aprobadas en el mismo acto. Esta prueba fija lo
// contrario de lo que probaban las cuatro que había aquí: una hora extra en
// cualquier estado NO debe generar ninguna alerta.
test('evaluarAlertasDeCentro: las horas extra ya no generan alertas de aprobación/decisión', () => {
  const estados = [
    { approval_status: 'pendiente', pm_decision: 'pendiente' },
    { approval_status: 'pendiente', pm_decision: 'si' },
    { approval_status: 'rechazado', pm_decision: 'si' },
    { approval_status: 'aprobado', pm_decision: 'pendiente' },
  ];
  for (const estado of estados) {
    const alertas = evaluar({
      datos: { overtimeRows: [{ decision_id: 9, canonical_name: 'Ana', extra_cost_potential: 50, ...estado }] },
    });
    assert.deepStrictEqual(
      tipos(alertas), [],
      `no deberia salir ninguna alerta para ${JSON.stringify(estado)}`
    );
  }
});

test('evaluarAlertasDeCentro: 4 — Talento sin costo/hora (caso sin_asignacion)', () => {
  const alertas = evaluar({ datos: { sinTarifa: [{ canonical_name: 'Ana', motivo: 'sin_asignacion', horas: 12.345 }] } });
  assert.deepStrictEqual(tipos(alertas), ['Talento sin costo/hora registrado']);
  assert.strictEqual(alertas[0].severidad, 'critica');
  assert.match(alertas[0].detalle, /12\.3h/);
  assert.match(alertas[0].detalle, /no está en el equipo/);
});

test('evaluarAlertasDeCentro: 4 — Talento sin costo/hora (caso tarifa_cero)', () => {
  const alertas = evaluar({ datos: { sinTarifa: [{ canonical_name: 'Ana', motivo: 'tarifa_cero', horas: null }] } });
  assert.match(alertas[0].detalle, /costo\/hora en \$0/);
});

test('evaluarAlertasDeCentro: 5 — Desviación presupuestal, alta entre 8 y 20', () => {
  const alertas = evaluar({ ind17: { ind3_ritmo_gasto_vs_tiempo: 10 } });
  assert.deepStrictEqual(tipos(alertas), ['Desviación presupuestal']);
  assert.strictEqual(alertas[0].severidad, 'alta');
});

test('evaluarAlertasDeCentro: 5 — Desviación presupuestal, crítica desde 20', () => {
  const alertas = evaluar({ ind17: { ind3_ritmo_gasto_vs_tiempo: 25 } });
  assert.strictEqual(alertas[0].severidad, 'critica');
});

test('evaluarAlertasDeCentro: 5 — no dispara con null (dato no calculable todavía)', () => {
  assert.deepStrictEqual(evaluar({ ind17: { ind3_ritmo_gasto_vs_tiempo: null } }), []);
});

test('evaluarAlertasDeCentro: 6 — Índice de no-calidad, media bajo 10%', () => {
  const alertas = evaluar({ ind17: { ind12_costo_errores_pct: 5 } });
  assert.strictEqual(alertas[0].severidad, 'media');
});

test('evaluarAlertasDeCentro: 6 — Índice de no-calidad, alta desde 10%', () => {
  const alertas = evaluar({ ind17: { ind12_costo_errores_pct: 15 } });
  assert.strictEqual(alertas[0].severidad, 'alta');
});

test('evaluarAlertasDeCentro: 7 — Trabajo no remunerado', () => {
  const alertas = evaluar({ ind17: { ind11_trabajo_no_remunerado: 3.5 } });
  assert.deepStrictEqual(tipos(alertas), ['Trabajo no remunerado']);
  assert.strictEqual(alertas[0].severidad, 'media');
});

test('evaluarAlertasDeCentro: 9 — Dato desactualizado (centro activo sin ningún gasto)', () => {
  const alertas = evaluar({ datos: { gastos: [] } });
  assert.deepStrictEqual(tipos(alertas), ['Dato desactualizado']);
});

test('evaluarAlertasDeCentro: 9 — no dispara en centro inactivo aunque no tenga gastos', () => {
  assert.deepStrictEqual(evaluar({ centro: { status: 'inactivo' }, datos: { gastos: [] } }), []);
});

test('evaluarAlertasDeCentro: 10 — Vencimiento próximo dentro del umbral de días (baja)', () => {
  const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  // diasAntesPreventiva del fixture es 7: a 7 días entra a la ventana pero
  // no a los escalones fijos de 4/3 días, así que se queda en 'baja'.
  const alertas = evaluar({ centro: { planned_end_date: enDias(7) } });
  assert.deepStrictEqual(tipos(alertas), ['Vencimiento próximo']);
  assert.strictEqual(alertas[0].severidad, 'baja');
});

test('evaluarAlertasDeCentro: 10 — Vencimiento próximo escala a media a 4 días', () => {
  const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const alertas = evaluar({ centro: { planned_end_date: enDias(4) } });
  assert.deepStrictEqual(tipos(alertas), ['Vencimiento próximo']);
  assert.strictEqual(alertas[0].severidad, 'media');
});

test('evaluarAlertasDeCentro: 10 — Vencimiento próximo escala a alta a 3 días o menos', () => {
  const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const alertas = evaluar({ centro: { planned_end_date: enDias(3) } });
  assert.deepStrictEqual(tipos(alertas), ['Vencimiento próximo']);
  assert.strictEqual(alertas[0].severidad, 'alta');
});

test('evaluarAlertasDeCentro: 11 — Vencido si la fecha fin ya pasó y no hay fecha real de entrega', () => {
  const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const alertas = evaluar({ centro: { planned_end_date: haceDias(5) } });
  assert.deepStrictEqual(tipos(alertas), ['Vencido']);
  assert.strictEqual(alertas[0].severidad, 'critica');
});

test('evaluarAlertasDeCentro: 10/11 — no dispara si ya hay Fecha Real de Entrega', () => {
  const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  assert.deepStrictEqual(evaluar({ centro: { planned_end_date: haceDias(5), actual_end_date: '2026-08-01' } }), []);
});

test('evaluarAlertasDeCentro: 12 — Dependencia crítica de una persona (bus factor >= 75)', () => {
  const alertas = evaluar({ ind17: { ind6_bus_factor_pct: 80 } });
  assert.deepStrictEqual(tipos(alertas), ['Dependencia crítica de una persona']);
});

test('evaluarAlertasDeCentro: 13 — Equipo de una sola persona', () => {
  const alertas = evaluar({ ind17: { ind7_personas_trabajando: 1 } });
  assert.deepStrictEqual(tipos(alertas), ['Equipo de una sola persona']);
});

test('evaluarAlertasDeCentro: 14 — Exceso de horas extra, media entre 8 y 15', () => {
  const alertas = evaluar({ ind17: { ind9_proporcion_horas_extra_pct: 10 } });
  assert.strictEqual(alertas[0].severidad, 'media');
});

test('evaluarAlertasDeCentro: 14 — Exceso de horas extra, alta desde 15', () => {
  const alertas = evaluar({ ind17: { ind9_proporcion_horas_extra_pct: 20 } });
  assert.strictEqual(alertas[0].severidad, 'alta');
});

test('evaluarAlertasDeCentro: 15 — Gasto poco predecible', () => {
  const alertas = evaluar({ ind17: { ind14_gasto_no_predecible_pct: 20 } });
  assert.deepStrictEqual(tipos(alertas), ['Gasto poco predecible']);
});

test('evaluarAlertasDeCentro: 16 — Gasto atípico registrado (>=3% del presupuesto)', () => {
  const alertas = evaluar({ datos: { gastos: [{ expense_id: 1, description: 'Viático grande', amount: 50 }] } });
  assert.deepStrictEqual(tipos(alertas), ['Gasto atípico registrado']);
  assert.match(alertas[0].detalle, /5\.0%/);
});

test('evaluarAlertasDeCentro: 16 — no dispara si el presupuesto del centro es 0 (evita división por cero)', () => {
  assert.deepStrictEqual(
    evaluar({ centro: { budget: 0 }, datos: { gastos: [{ expense_id: 1, description: 'x', amount: 999 }] } }),
    []
  );
});

test('evaluarAlertasDeCentro: 18 — Sobrecostos mayormente internos', () => {
  const alertas = evaluar({ ind17: { ind13_responsable_sobrecosto_interno_pct: 80 } });
  assert.deepStrictEqual(tipos(alertas), ['Sobrecostos mayormente internos']);
});

test('evaluarAlertasDeCentro: 19 — Sin PM asignado', () => {
  const alertas = evaluar({ datos: { pmActivo: false } });
  assert.deepStrictEqual(tipos(alertas), ['Sin PM asignado']);
});

test('evaluarAlertasDeCentro: 20 — Presupuesto casi agotado (>= umbral configurado)', () => {
  const alertas = evaluar({ ind17: { ind1_presupuesto_ejecutado_pct: 95 }, datos: { umbralPresupuesto: 90 } });
  assert.deepStrictEqual(tipos(alertas), ['Presupuesto casi agotado']);
  assert.strictEqual(alertas[0].severidad, 'critica');
});

test('evaluarAlertasDeCentro: 20 — no dispara por debajo del umbral configurado', () => {
  assert.deepStrictEqual(evaluar({ ind17: { ind1_presupuesto_ejecutado_pct: 50 }, datos: { umbralPresupuesto: 90 } }), []);
});

// ---------------------------------------------------------------
// diasEntre
// ---------------------------------------------------------------

test('diasEntre: fecha futura da un número positivo', () => {
  const futura = new Date(Date.now() + 5 * 86400000).toISOString();
  assert.ok(diasEntre(futura) >= 4);
});

test('diasEntre: fecha pasada da un número negativo', () => {
  const pasada = new Date(Date.now() - 5 * 86400000).toISOString();
  assert.ok(diasEntre(pasada) <= -4);
});

// ---------------------------------------------------------------
// mapearSobrecargaCross (alerta 8)
// ---------------------------------------------------------------

test('mapearSobrecargaCross: 2 centros da severidad baja', () => {
  const r = mapearSobrecargaCross([{ canonical_name: 'Ana', n_centros: 2 }]);
  assert.strictEqual(r[0].severidad, 'baja');
  assert.strictEqual(r[0].tipo, 'Sobrecarga cross-proyecto');
});

test('mapearSobrecargaCross: 3+ centros da severidad media', () => {
  const r = mapearSobrecargaCross([{ canonical_name: 'Ana', n_centros: 3 }]);
  assert.strictEqual(r[0].severidad, 'media');
});

// ---------------------------------------------------------------
// calcularCostoHoraSobrePromedio (alerta 21)
// ---------------------------------------------------------------

test('calcularCostoHoraSobrePromedio: sin filas, arreglo vacío', () => {
  assert.deepStrictEqual(calcularCostoHoraSobrePromedio([]), []);
});

test('calcularCostoHoraSobrePromedio: solo reporta a quien está >=125% del promedio', () => {
  const rows = [
    { canonical_name: 'Ana', hourly_cost: 10, project_name: 'ALFA' },
    { canonical_name: 'Beto', hourly_cost: 10, project_name: 'ALFA' },
    { canonical_name: 'Caro', hourly_cost: 25, project_name: 'BETA' },
  ];
  // promedio = (10+10+25)/3 = 15; umbral = 18.75 -> solo Caro (25) califica
  const r = calcularCostoHoraSobrePromedio(rows);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].detalle.includes('Caro'), true);
  assert.strictEqual(r[0].valor, 25);
});

test('calcularCostoHoraSobrePromedio: todos iguales no dispara nada (nadie supera el 125% de sí mismo)', () => {
  const rows = [
    { canonical_name: 'Ana', hourly_cost: 10, project_name: 'ALFA' },
    { canonical_name: 'Beto', hourly_cost: 10, project_name: 'ALFA' },
  ];
  assert.deepStrictEqual(calcularCostoHoraSobrePromedio(rows), []);
});
