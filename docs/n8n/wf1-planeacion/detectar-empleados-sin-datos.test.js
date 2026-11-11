'use strict';

/**
 * Prueba de "Filtrar carpetas válidas" (v6) + "Detectar empleados sin datos"
 * (v4) de WF1, con el código real de los nodos y n8n simulado.
 *
 * Caso real del 30 sep 2026: Diana Ximena Duque y Germán Tovar tienen la
 * carpeta en "Backup", Juan Esteban Canabal no llena planeación (excepción),
 * y a los tres les llegaba "No se cargó ninguna tarea".
 *
 * Correr con:  node --test docs/n8n/wf1-planeacion/detectar-empleados-sin-datos.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILTRAR = fs.readFileSync(path.join(__dirname, 'filtrar-carpetas-validas.js'), 'utf8');
const DETECTAR = fs.readFileSync(path.join(__dirname, 'detectar-empleados-sin-datos.js'), 'utf8');

const CATALOGO = [
  { employee_id: 8, canonical_name: 'Juan Esteban Canabal', aliases: '["Juan Esteban Canabal","Juan Canabal"]', is_active: 1, project_folder: 'Document Online' },
  { employee_id: 12, canonical_name: 'Diana Ximena Duque Arévalo', aliases: '["Diana Duque","Diana Ximena Duque"]', is_active: 1, project_folder: null },
  { employee_id: 24, canonical_name: 'Germán Tovar', aliases: null, is_active: 1, project_folder: 'Transversales 2' },
  { employee_id: 32, canonical_name: 'Jaider Bermudez', aliases: null, is_active: 1, project_folder: 'SESCOL' },
  { employee_id: 50, canonical_name: 'Pedro Sin Tareas', aliases: null, is_active: 1, project_folder: 'MIA' },
];

const carpeta = (name) => ({ name, folder: { childCount: 1 }, id: `id-${name}` });

function correr() {
  const staticData = { folderToProject: {}, invalidFolders: [], validationErrors: [] };
  const nodos = {
    // Lo que hay en SharePoint: Backup (con Diana y Germán adentro, que el flujo
    // no abre), la carpeta de Canabal con su alias, Jaider y Pedro.
    'Listar carpetas empleados1': [
      { value: [carpeta('Backup'), carpeta('Juan Canabal'), carpeta('Jaider Bermudez')] },
      { value: [carpeta('Pedro Sin Tareas')] },
    ],
    'Guardar Drive ID1': [
      { projectFolder: 'Equipo 2', folderPath: 'Planeación 2026/Equipo 2 - Sara Piedad' },
      { projectFolder: 'Equipo 4', folderPath: 'Planeación 2026/Equipo 4 - Cesar Arbelaez' },
    ],
    'Generar contexto ejecución2': [{ snapshotDate: '2026-09-30', executionId: 'test' }],
    'Cargar catálogo empleados (early)1': CATALOGO,
  };
  const $ = (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node '${nombre}' hasn't been executed`);
    return { first: () => ({ json: nodos[nombre][0] }), all: () => nodos[nombre].map((json) => ({ json })) };
  };
  const consola = { log() {} };

  const validas = new Function('$', '$input', '$getWorkflowStaticData', 'console', FILTRAR)(
    $, { all: () => CATALOGO.map((json) => ({ json })) }, () => staticData, consola).map((i) => i.json);

  // "Buscar empleados sin tareas" (SQL): todos los activos sin tareas ese día.
  // Jaider sí tiene tareas, así que no sale.
  const sinTareas = CATALOGO.filter((e) => e.employee_id !== 32)
    .map(({ employee_id, canonical_name, project_folder }) => ({ employee_id, canonical_name, project_folder }));
  const salida = new Function('$', '$input', '$getWorkflowStaticData', 'console', DETECTAR)(
    $, { all: () => sinTareas.map((json) => ({ json })) }, () => staticData, consola);

  return { validas, staticData, salida: salida[0].json };
}

test('Filtrar carpetas: Backup y las excepciones se saltan sin error', () => {
  const { validas, staticData } = correr();
  assert.deepStrictEqual(validas.map((v) => v.employeeFolderName).sort(), ['Jaider Bermudez', 'Pedro Sin Tareas']);
  assert.deepStrictEqual(staticData.invalidFolders, [], 'ni Backup ni Canabal deben salir como "carpeta no reconocida"');
});

test('NO_DATA_INGESTED: solo a quien tiene carpeta y no tiene tareas', () => {
  const { staticData, salida } = correr();
  const reportados = staticData.validationErrors.filter((e) => e.error_type === 'NO_DATA_INGESTED').map((e) => e.employee_folder_name);
  assert.deepStrictEqual(reportados, ['Pedro Sin Tareas']);
  assert.strictEqual(salida.insertCount, 1);
  assert.doesNotMatch(salida.sqlQuery, /Diana|Germán|Canabal/);
});
