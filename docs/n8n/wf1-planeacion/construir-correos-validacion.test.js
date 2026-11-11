'use strict';

/**
 * Prueba del nodo Code "Construir correos validación" de WF1 (Planeación), v16.
 *
 * El correo "impecable" debe nombrar a los PMs del EQUIPO de la persona, no lo
 * que escribió en "Líder de equipo" del Excel (a Oscar Naranjo, Equipo 2, le
 * salía Jonathan Anaya aunque el correo le llegó a Sara).
 *
 * Correr con:  node --test docs/n8n/wf1-planeacion/construir-correos-validacion.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const NODO = fs.readFileSync(path.join(__dirname, 'construir-correos-validacion.js'), 'utf8');

const SARA = 'sara@empresa.com';

const ctx = { executionId: 'test', snapshotDate: '2026-10-22', monthName: 'Octubre', monthNumber: 10, yearNumber: 2026 };

const CATALOGO = [
  { employee_id: 1, canonical_name: 'Oscar Naranjo', email: 'oscar@x.com' },
  { employee_id: 2, canonical_name: 'Alexander Valencia', email: 'alexander@x.com' },
  { employee_id: 3, canonical_name: 'Persona Sin Equipo', email: 'sin@x.com' },
];

function impecable(nombre, lider) {
  return { employeeFolderName: nombre, fileName: `${nombre}.xlsx`, tasksCount: 41, leaderName: lider, projectFolder: null, tasks: [] };
}

function correr() {
  const staticData = {
    validationErrors: [],
    successfulEmployees: [
      impecable('Oscar Naranjo', 'Jonathan Anaya'),
      impecable('Alexander Valencia', 'Otro Líder'),
      impecable('Persona Sin Equipo', 'Líder Del Excel'),
    ],
    folderToProject: { 'Oscar Naranjo': 'Equipo 2', 'Alexander Valencia': 'Equipo 1' },
    currentMonthWeek: 4,
  };
  const nodos = {
    'Generar contexto ejecución': [ctx],
    'Cargar catálogo empleados (early)': CATALOGO,
  };
  const $ = (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node '${nombre}' hasn't been executed`);
    return {
      first: () => ({ json: nodos[nombre][0] }),
      all: () => nodos[nombre].map((json) => ({ json })),
    };
  };
  const salida = new Function('$', '$getWorkflowStaticData', 'console', NODO)($, () => staticData, { log() {} });
  return Object.fromEntries(salida.map(({ json }) => [json.employee_folder_name, json]));
}

test('impecable: nombra al PM del Equipo, no al líder escrito en el Excel', () => {
  const oscar = correr()['Oscar Naranjo'];
  assert.match(oscar.body_html, /Tu líder <strong>Sara Piedad Lasso<\/strong> ya tiene/);
  assert.doesNotMatch(oscar.body_html, /Jonathan Anaya/);
  assert.ok(oscar.recipient_email.split(', ').includes(SARA));
});

test('impecable: un Equipo con dos PMs los nombra a ambos', () => {
  const alexander = correr()['Alexander Valencia'];
  assert.match(alexander.body_html, /Tus líderes <strong>Juan Carlos Díaz y Diego Chamorro<\/strong> ya tienen/);
});

test('impecable: sin Equipo conocido se usa el líder del Excel', () => {
  const sinEquipo = correr()['Persona Sin Equipo'];
  assert.match(sinEquipo.body_html, /Tu líder <strong>Líder Del Excel<\/strong> ya tiene/);
});
