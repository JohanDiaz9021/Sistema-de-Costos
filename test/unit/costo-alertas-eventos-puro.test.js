'use strict';

/**
 * Funciones puras de src/queries/costo-alertas-eventos.js — el seguimiento
 * de alertas (sql/19) que le da a cada una una fecha estable de "primera
 * vez detectada", base del escalamiento 3/5 días.
 */

const test = require('node:test');
const assert = require('node:assert');

const { TIPO_A_CODIGO, construirClaveDedup, anotarDiasAbierta } = require('../../src/queries/costo-alertas-eventos');
const { evaluarAlertasDeCentro, mapearSobrecargaCross, calcularCostoHoraSobrePromedio } = require('../../src/queries/costo-alertas');

// Los 21 tipos que emite costo-alertas.js (evaluarAlertasDeCentro +
// mapearSobrecargaCross + calcularCostoHoraSobrePromedio) tienen que tener
// TODOS un código en el catálogo — si falta uno, sincronizarEventos lo
// descarta en silencio y ese tipo nunca entra al historial ni escala.
const TIPOS_REALES = [
  'Proyección de cierre', 'Aprobación pendiente', 'Hora extra rechazada',
  'Decisión pendiente del PM', 'Talento sin costo/hora registrado',
  'Desviación presupuestal', 'Índice de no-calidad', 'Trabajo no remunerado',
  'Dato desactualizado', 'Vencido', 'Vencimiento próximo',
  'Dependencia crítica de una persona', 'Equipo de una sola persona',
  'Exceso de horas extra', 'Gasto poco predecible', 'Gasto atípico registrado',
  'Sobrecostos mayormente internos', 'Sin PM asignado', 'Presupuesto casi agotado',
  'Sobrecarga cross-proyecto', 'Costo/hora por encima del promedio',
];

test('TIPO_A_CODIGO: cubre los 21 tipos reales que emite el motor de alertas', () => {
  for (const tipo of TIPOS_REALES) {
    assert.ok(TIPO_A_CODIGO[tipo], `falta el código de "${tipo}" en TIPO_A_CODIGO`);
  }
  assert.strictEqual(Object.keys(TIPO_A_CODIGO).length, TIPOS_REALES.length, 'no debería haber códigos de más (tipos que ya no existen)');
});

test('construirClaveDedup: dos alertas del mismo tipo y centro con distinta entidad NO chocan', () => {
  const c1 = construirClaveDedup('talento_sin_tarifa', { cost_center_id: 5, entidad: 10 });
  const c2 = construirClaveDedup('talento_sin_tarifa', { cost_center_id: 5, entidad: 11 });
  assert.notStrictEqual(c1, c2);
});

test('construirClaveDedup: la misma alerta (mismo tipo+centro+entidad) siempre da la misma clave', () => {
  const c1 = construirClaveDedup('talento_sin_tarifa', { cost_center_id: 5, entidad: 10 });
  const c2 = construirClaveDedup('talento_sin_tarifa', { cost_center_id: 5, entidad: 10 });
  assert.strictEqual(c1, c2);
});

test('construirClaveDedup: dos alertas globales (cost_center_id null) de distinta persona NO chocan', () => {
  const c1 = construirClaveDedup('sobrecarga_cross', { cost_center_id: null, entidad: 1 });
  const c2 = construirClaveDedup('sobrecarga_cross', { cost_center_id: null, entidad: 2 });
  assert.notStrictEqual(c1, c2);
});

test('construirClaveDedup: entidad ausente no revienta (alertas únicas por centro, ej. "Vencido")', () => {
  assert.doesNotThrow(() => construirClaveDedup('proyecto_vencido', { cost_center_id: 5 }));
});

// Verifica que evaluarAlertasDeCentro() ya trae `entidad` poblada donde
// puede haber más de una alerta del mismo tipo en el mismo centro — si
// esto se rompe, sincronizarEventos empieza a colapsar alertas de personas
// distintas en un solo evento sin que ningún test lo note hasta producción.
test('evaluarAlertasDeCentro: "Talento sin costo/hora" trae employee_id como entidad', () => {
  const centro = { cost_center_id: 5, project_name: 'X', status: 'vigente', budget: 0, planned_end_date: null };
  const ind17 = { ind4_se_queda_sin_plata_antes: false, ind3_ritmo_gasto_vs_tiempo: null, ind12_costo_errores_pct: 0, ind11_trabajo_no_remunerado: 0, ind6_bus_factor_pct: 0, ind7_personas_trabajando: 2, ind9_proporcion_horas_extra_pct: 0, ind14_gasto_no_predecible_pct: 0, ind13_responsable_sobrecosto_interno_pct: null, ind1_presupuesto_ejecutado_pct: null };
  const datos = {
    overtimeRows: [], gastos: [], pmActivo: true,
    sinTarifa: [{ employee_id: 42, canonical_name: 'X', motivo: 'tarifa_cero', horas: null }],
    diasAntesPreventiva: 30, umbralPresupuesto: 85,
  };
  const alertas = evaluarAlertasDeCentro(centro, ind17, datos);
  const a = alertas.find((x) => x.tipo === 'Talento sin costo/hora registrado');
  assert.strictEqual(a.entidad, 42);
});

test('mapearSobrecargaCross: trae employee_id como entidad', () => {
  const [a] = mapearSobrecargaCross([{ employee_id: 7, canonical_name: 'X', n_centros: 2 }]);
  assert.strictEqual(a.entidad, 7);
});

test('calcularCostoHoraSobrePromedio: trae employee_id como entidad', () => {
  const rows = [
    { employee_id: 1, canonical_name: 'A', hourly_cost: 1000, project_name: 'P' },
    { employee_id: 2, canonical_name: 'B', hourly_cost: 5000, project_name: 'P' },
  ];
  const [a] = calcularCostoHoraSobrePromedio(rows);
  assert.strictEqual(a.entidad, 2);
});

// ---------------------------------------------------------------
// anotarDiasAbierta (10 sep 2026) — marca cada alerta con los dias que
// lleva abierta para que el panel resalte las no corregidas DENTRO de la
// lista completa, en vez de repetirlas en una lista aparte.
// ---------------------------------------------------------------

// El caso que obliga a cruzar por clave_dedup y no por tipo+centro: dos
// alertas del MISMO tipo en el MISMO centro, que solo se distinguen por su
// entidad (aqui, dos personas distintas). Cruzando sin la entidad, las dos
// se llevarian los dias de la primera.
test('anotarDiasAbierta: dos alertas del mismo tipo y centro no se contagian los dias', () => {
  const tipo = 'Costo/hora por encima del promedio';
  const codigo = TIPO_A_CODIGO[tipo];
  assert.ok(codigo, 'el tipo de prueba deberia estar en el catalogo');

  const alertas = [
    { tipo, cost_center_id: 1, entidad: 7, detalle: 'Persona 7' },
    { tipo, cost_center_id: 1, entidad: 9, detalle: 'Persona 9' },
  ];
  const escalamientos = [
    { clave_dedup: construirClaveDedup(codigo, alertas[1]), dias_abierta: 6, nivel: 'ceo', es_ultimo_aviso: false },
  ];

  const [p7, p9] = anotarDiasAbierta(alertas, escalamientos);
  assert.strictEqual(p7.dias_abierta, undefined, 'la que no escalo no deberia quedar marcada');
  assert.strictEqual(p9.dias_abierta, 6);
  assert.strictEqual(p9.nivel, 'ceo');
});

test('anotarDiasAbierta: sin escalamientos devuelve las alertas intactas', () => {
  const alertas = [{ tipo: 'Proyección de cierre', cost_center_id: 1, detalle: 'x' }];
  assert.deepStrictEqual(anotarDiasAbierta(alertas, []), alertas);
});

// Una alerta global (sin centro) tiene cost_center_id null; construirClaveDedup
// usa 'global' justamente para que no choque con otras.
test('anotarDiasAbierta: un tipo fuera del catalogo no revienta ni se marca', () => {
  const alertas = [{ tipo: 'Tipo inventado que no existe', cost_center_id: null, detalle: 'x' }];
  const [a] = anotarDiasAbierta(alertas, [{ clave_dedup: 'x:global:', dias_abierta: 9, nivel: 'ceo' }]);
  assert.strictEqual(a.dias_abierta, undefined);
});
