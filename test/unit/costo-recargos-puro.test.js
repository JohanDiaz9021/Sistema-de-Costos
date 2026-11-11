'use strict';

/**
 * La fórmula de nómina de GTC (sql/33), contrastada contra la tabla que
 * entregó la empresa. Es la prueba que hay que mirar si alguien discute un
 * valor de hora extra: cada assert es un renglón literal de esa hoja.
 */

const test = require('node:test');
const assert = require('node:assert');

const { valorHoraDesdeSalario, factorRecargo, tablaRecargos } = require('../../src/queries/costo-recargos');

// Los cuatro componentes tal como quedan sembrados por sql/33.
const P = {
  extraDiurnaPct: 25,
  extraNocturnaPct: 75,
  nocturnoOrdinarioPct: 35,
  dominicalFestivoPct: 90,
};

// ---------------------------------------------------------------
// valorHoraDesdeSalario — salario / 210
// ---------------------------------------------------------------

test('valorHoraDesdeSalario: el caso real de GTC (1.750.950 / 210 = 8.338)', () => {
  // Es el único dato real cargado en el sistema: si este assert se cae, el
  // valor hora de la app dejó de coincidir con la hoja de la empresa.
  assert.strictEqual(valorHoraDesdeSalario(1750950, 210), 8338);
});

test('valorHoraDesdeSalario: redondea al peso, no deja fracciones', () => {
  // 1.750.950 / 210 = 8.337,857… La nómina colombiana no maneja centavos de
  // peso y el número se muestra como moneda en toda la app.
  assert.strictEqual(valorHoraDesdeSalario(1750950, 210), 8338);
  assert.strictEqual(valorHoraDesdeSalario(1000000, 210), 4762); // 4761,90…
});

test('valorHoraDesdeSalario: usa 210 por defecto si no se pasa el divisor', () => {
  assert.strictEqual(valorHoraDesdeSalario(1750950), 8338);
});

test('valorHoraDesdeSalario: divisor configurable (si GTC liquida sobre otro número)', () => {
  assert.strictEqual(valorHoraDesdeSalario(1750950, 240), 7296);
});

test('valorHoraDesdeSalario: datos faltantes o divisor en cero dan 0, nunca NaN ni Infinity', () => {
  // Un NaN aquí se propagaría como "NaN" a un indicador de dinero y a la
  // base de datos; devolver 0 lo deja visible como "sin tarifa".
  for (const v of [null, undefined, '', 0, -100, 'abc']) {
    assert.strictEqual(valorHoraDesdeSalario(v, 210), 0, `salario ${JSON.stringify(v)}`);
  }
  assert.strictEqual(valorHoraDesdeSalario(1750950, 0), 0);
  assert.strictEqual(valorHoraDesdeSalario(1750950, null), 0);
});

// ---------------------------------------------------------------
// factorRecargo — los 8 casos de la tabla de GTC
// ---------------------------------------------------------------

test('factorRecargo: hora ordinaria diurna en día hábil no lleva recargo (1,00)', () => {
  assert.strictEqual(factorRecargo({}, P), 1);
});

test('factorRecargo: recargo nocturno en jornada ordinaria = 1,35 (35%)', () => {
  assert.strictEqual(factorRecargo({ nocturno: true }, P), 1.35);
});

test('factorRecargo: hora extra diurna = 1,25 (125%)', () => {
  assert.strictEqual(factorRecargo({ extra: true }, P), 1.25);
});

test('factorRecargo: hora extra nocturna = 1,75 (175%)', () => {
  assert.strictEqual(factorRecargo({ extra: true, nocturno: true }, P), 1.75);
});

test('factorRecargo: dominical o festivo en jornada ordinaria = 1,90 (190%)', () => {
  assert.strictEqual(factorRecargo({ festivo: true }, P), 1.9);
});

test('factorRecargo: recargo nocturno en dominical o festivo = 2,25 (225%)', () => {
  // 1 + 0,90 (festivo) + 0,35 (nocturno ordinario)
  assert.strictEqual(factorRecargo({ festivo: true, nocturno: true }, P), 2.25);
});

test('factorRecargo: hora extra diurna en dominical o festivo = 2,15 (215%)', () => {
  // 1 + 0,90 (festivo) + 0,25 (extra diurna)
  assert.strictEqual(factorRecargo({ festivo: true, extra: true }, P), 2.15);
});

test('factorRecargo: hora extra nocturna en dominical o festivo = 2,65 (265%)', () => {
  // 1 + 0,90 (festivo) + 0,75 (extra nocturna)
  assert.strictEqual(factorRecargo({ festivo: true, extra: true, nocturno: true }, P), 2.65);
});

test('factorRecargo: una hora extra nocturna NO acumula además el recargo nocturno ordinario', () => {
  // El 35% es el recargo de la hora que NO es extra: si se sumaran los dos
  // (0,75 + 0,35) la hora extra nocturna daría 2,10 en vez de 1,75 y GTC
  // estaría pagando de más en cada turno de noche.
  assert.strictEqual(factorRecargo({ extra: true, nocturno: true }, P), 1.75);
});

test('factorRecargo: cambiar un componente mueve TODOS los casos que lo usan', () => {
  // Es la razón de componer en vez de enumerar: subir el recargo dominical
  // no puede dejar la columna de festivos a medio actualizar.
  const conDominicalAl100 = { ...P, dominicalFestivoPct: 100 };
  assert.strictEqual(factorRecargo({ festivo: true }, conDominicalAl100), 2);
  assert.strictEqual(factorRecargo({ festivo: true, extra: true }, conDominicalAl100), 2.25);
  assert.strictEqual(factorRecargo({ festivo: true, extra: true, nocturno: true }, conDominicalAl100), 2.75);
  // Lo que no depende del dominical no se mueve.
  assert.strictEqual(factorRecargo({ extra: true }, conDominicalAl100), 1.25);
});

// ---------------------------------------------------------------
// factorRecargo — contractType (prestación de servicios no lleva recargos)
// ---------------------------------------------------------------

test('factorRecargo: por defecto (sin contractType) se comporta como planta', () => {
  assert.strictEqual(factorRecargo({ festivo: true, extra: true, nocturno: true }, P), 2.65);
});

test('factorRecargo: contractType "planta" explícito no cambia nada', () => {
  assert.strictEqual(factorRecargo({ extra: true }, P, 'planta'), 1.25);
  assert.strictEqual(factorRecargo({ festivo: true, extra: true, nocturno: true }, P, 'planta'), 2.65);
});

test('factorRecargo: "prestacion_servicios" no lleva recargo aunque sea festivo+nocturno+extra (1,00)', () => {
  // Los recargos de esta tabla son prestaciones del Código Sustantivo del
  // Trabajo — solo cubren a planta. Un contratista se paga a tarifa plana.
  assert.strictEqual(factorRecargo({ festivo: true, extra: true, nocturno: true }, P, 'prestacion_servicios'), 1);
});

test('factorRecargo: "prestacion_servicios" da 1,00 en cada uno de los 8 casos de la tabla', () => {
  const casos = [
    {}, { nocturno: true }, { extra: true }, { extra: true, nocturno: true },
    { festivo: true }, { festivo: true, nocturno: true },
    { festivo: true, extra: true }, { festivo: true, extra: true, nocturno: true },
  ];
  for (const c of casos) {
    assert.strictEqual(factorRecargo(c, P, 'prestacion_servicios'), 1, JSON.stringify(c));
  }
});

// ---------------------------------------------------------------
// tablaRecargos — lo que se muestra en Configuración
// ---------------------------------------------------------------

test('tablaRecargos: devuelve los 8 casos con su factor y su porcentaje', () => {
  const tabla = tablaRecargos(P);
  assert.strictEqual(tabla.length, 8);
  const porFactor = tabla.map((f) => f.factor).sort((a, b) => a - b);
  assert.deepStrictEqual(porFactor, [1, 1.25, 1.35, 1.75, 1.9, 2.15, 2.25, 2.65]);
});

test('tablaRecargos: el porcentaje mostrado es el factor × 100 (1,90 -> 190%)', () => {
  const tabla = tablaRecargos(P);
  const festivo = tabla.find((f) => f.etiqueta.startsWith('Trabajo dominical'));
  assert.strictEqual(festivo.factor, 1.9);
  assert.strictEqual(festivo.pct, 190);
});
