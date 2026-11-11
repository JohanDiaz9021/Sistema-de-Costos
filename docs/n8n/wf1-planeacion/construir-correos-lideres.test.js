'use strict';

/**
 * Prueba del nodo Code "Construir correos líderes" de WF1 (Planeación), v11.
 *
 * Encadena los dos nodos REALES: la salida de "Parsear todos los archivos"
 * (v20) entra a este nodo. Verifica que:
 *   - sale UN correo por Equipo de SharePoint, a los PMs de ese Equipo
 *     (+ Emily, César y Mónica en copia), con cada persona una sola vez;
 *   - el proyecto de las tareas (MIA, SESCOL...) no mezcla Equipos;
 *   - asunto y cuerpo muestran el Equipo, nunca el proyecto;
 *   - en MODO_PRUEBA no sale nada a una persona real.
 *
 * Correr con:  node --test docs/n8n/wf1-planeacion/construir-correos-lideres.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PARSER = fs.readFileSync(path.join(__dirname, 'parsear-todos-los-archivos.js'), 'utf8');
const CORREOS = fs.readFileSync(path.join(__dirname, 'construir-correos-lideres.js'), 'utf8');

const CESAR = 'cesar@empresa.com';
const JUAN_CARLOS = 'juancarlos@empresa.com';
const MONICA = 'monica@empresa.com';
const ANAYA = 'jonathan@empresa.com';
const EMILY = 'emily@empresa.com';
const CEO = 'gerencia@empresa.com';
const LUCIA = 'lucia@empresa.com';
const CHAMORRO = 'diego@empresa.com';
const JAIR = 'gerencia@empresa.com';

const CATALOGO = [
  { employee_id: 1, canonical_name: 'Jaider Bermudez', email: 'jaider@x.com', project_folder: 'SESCOL' },
  { employee_id: 2, canonical_name: 'Dimas Hernández Mendoza', email: 'dimas@x.com', project_folder: 'SESCOL' },
  { employee_id: 3, canonical_name: 'Emily Tench', email: 'emily@x.com', project_folder: 'Document Online' },
  { employee_id: 4, canonical_name: 'Edynson Muñoz Jiménez', email: 'edynson@x.com', project_folder: 'CRM' },
  { employee_id: 5, canonical_name: 'Jose Flórez Mendoza', email: 'jose@x.com', project_folder: 'Transversales' },
  { employee_id: 6, canonical_name: 'Angela Lucia Trujillo', email: 'angela@x.com', project_folder: 'QA' },
  { employee_id: 7, canonical_name: 'Thomas Medina Trujillo', email: 'thomas@x.com', project_folder: 'Habilitador' },
  { employee_id: 8, canonical_name: 'Alexander Valencia', email: 'alexander@x.com', project_folder: 'MIA' },
  { employee_id: 9, canonical_name: 'Rafael Argotty', email: 'rafael@x.com', project_folder: 'Habilitador' },
];

// Lo llena "Filtrar carpetas válidas": carpeta de la persona → Equipo.
const EQUIPO_DE = {
  'Jaider Bermudez': 'Equipo 4',
  'Dimas Hernández Mendoza': 'Equipo 4',
  'Emily Tench': 'Equipo 9',
  'Edynson Muñoz Jiménez': 'Equipo 3',
  'Jose Flórez Mendoza': 'Equipo 5',
  'Angela Lucia Trujillo': 'Equipo 6',
  'Thomas Medina Trujillo': 'Equipo 8',
  'Alexander Valencia': 'Equipo 1',
  'Rafael Argotty': 'Equipo 7',
};

const BUZONES_PRUEBA = new Set(['prueba1@empresa.com', 'prueba2@ejemplo.com', 'prueba3@ejemplo.com']);

function serie(iso) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}

// Plantilla NUEVA (con "Tipo de Actividad"). Semana 5 = la semana del 30-sep.
const ENCABEZADO = ['# Consec.', 'Semana', '▼ Proyecto', 'Actividad', 'Tipo de Actividad', '▼ P / NP', 'Horas Presupues\ntadas',
  'Fecha Estimada de Entrega', 'Fecha Entrega', 'L', 'M', 'X', 'J', 'V', 'S', 'TT', '▼ Estado', 'Cumplimie\nnto', 'Desfase', 'Esfuerzo %', '▼ A Cargo De'];

function fila(consec, proyecto, actividad, { estado = 'En Progreso', aCargo = 'Jonathan Anaya' } = {}) {
  return [consec, 5, proyecto, actividad, 'Desarrollo', 'P', 4, serie('2026-10-02'), '', 1, 1, '', '', '', '', 2, estado, '', '', '', aCargo];
}

function hoja(nombre, filas) {
  return [
    ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
    ['Nombre del talento:', nombre, 'Líder de equipo:', 'Jonathan Anaya'],
    ['IDENTIFICACIÓN'], ENCABEZADO, ['Consecutivo', 'N° semana', 'Elige proyecto'],
    ...filas,
    ['Cumplimiento'],
  ];
}

function archivo(nombre, filas) {
  return {
    fileCtx: { fileId: nombre, fileName: `${nombre}.xlsx`, employeeFolderName: nombre, projectFolder: EQUIPO_DE[nombre], targetSheetName: 'Septiembre' },
    values: hoja(nombre, filas),
  };
}

const ctx = { executionId: 'test', snapshotDate: '2026-09-30', monthName: 'Septiembre', monthNumber: 9, yearNumber: 2026 };

function correr({ modoPrueba, ceoRecibeTodo = false }) {
  const staticData = {
    // Dimas no subió archivo.
    foldersWithoutFile: [{ employeeFolderName: 'Dimas Hernández Mendoza', projectFolder: 'Equipo 4' }],
    folderToProject: { ...EQUIPO_DE },
  };
  const archivos = [
    // Jaider (Equipo 4) tiene tareas de MIA, SESCOL y Transversales: todo va al Equipo 4.
    archivo('Jaider Bermudez', [
      fila(1, 'Gestion financiera (MIA)', 'Conciliación'),
      fila(2, 'Talento humano inteligente (MIA)', 'Nómina', { estado: '' }),
      fila(3, 'Admisiones (Sescol)', 'Inscripción', { aCargo: '' }),
      fila(4, 'Tickets (Transversales)', 'Soporte tickets'),
      fila(5, 'Management', 'Scrum daily'),
    ]),
    archivo('Emily Tench', [fila(1, 'Management', 'Planeación semanal'), fila(2, 'Management', 'Daily')]),
    archivo('Edynson Muñoz Jiménez', [fila(1, 'Tickets (Transversales)', 'Soporte')]),
    archivo('Jose Flórez Mendoza', [fila(1, 'Tickets (Transversales)', 'Soporte')]),
    // Angela (QA, Equipo 6) prueba módulos de MIA y Document Online.
    archivo('Angela Lucia Trujillo', [
      fila(1, 'Gestion financiera (MIA)', 'Pruebas conciliación'),
      fila(2, 'Document Online', 'Pruebas firma'),
    ]),
    archivo('Thomas Medina Trujillo', [fila(1, 'Tickets (Transversales)', 'Diseño')]),
    archivo('Alexander Valencia', [fila(1, 'Gestion financiera (MIA)', 'Conciliación')]),
    archivo('Rafael Argotty', [fila(1, 'Soporte Servidores (Infraestructura)', 'Servidores')]),
  ];

  const nodos = {
    'Guardar Drive ID1': [ctx],
    'Resolver hoja del mes1': archivos.map((a) => a.fileCtx),
    'Generar contexto ejecución2': [ctx],
    'Cargar catálogo empleados (early)1': CATALOGO,
    'Cargar project owners': [],
  };
  // Como en n8n: pedir un nodo que no se ejecutó lanza error.
  const $ = (nombre) => {
    if (!(nombre in nodos)) throw new Error(`Node '${nombre}' hasn't been executed`);
    return {
      first: () => ({ json: nodos[nombre][0] }),
      all: () => nodos[nombre].map((json) => ({ json })),
      itemMatching: (i) => ({ json: nodos[nombre][i] }),
    };
  };
  const consola = { log() {} };

  new Function('$', '$input', '$getWorkflowStaticData', 'console', PARSER)(
    $, { all: () => archivos.map((a) => ({ json: { values: a.values } })) }, () => staticData, consola);

  // Funciona con el valor que tenga el archivo (true en prueba, false en producción).
  const marcas = [/const MODO_PRUEBA = (true|false);/, /const CEO_RECIBE_TODO = (true|false);/];
  for (const m of marcas) assert.match(CORREOS, m, `no se encontró ${m} en el nodo`);
  const fuente = CORREOS
    .replace(marcas[0], `const MODO_PRUEBA = ${modoPrueba};`)
    .replace(marcas[1], `const CEO_RECIBE_TODO = ${ceoRecibeTodo};`);
  return new Function('$', '$getWorkflowStaticData', 'console', fuente)($, () => staticData, consola).map((i) => i.json);
}

const lista = (e) => e.recipient_email.split(', ').sort();
const porEquipo = (emails) => Object.fromEntries(emails.map((e) => [e.project_folder, e]));
const personas = (e) => [...e.body_html.matchAll(/👤 ([^<·]+?)\s*(?:<|·)/g)].map((m) => m[1].trim()).sort();

test('un correo por Equipo, a sus PMs + Emily, César y Mónica', () => {
  const por = porEquipo(correr({ modoPrueba: false }));
  assert.deepStrictEqual(Object.keys(por).sort(), ['Equipo 1', 'Equipo 3', 'Equipo 4', 'Equipo 5', 'Equipo 6', 'Equipo 7', 'Equipo 8', 'Equipo 9']);

  assert.deepStrictEqual(lista(por['Equipo 3']), [CESAR, EMILY, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 4']), [CESAR, EMILY, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 5']), [CESAR, EMILY, JUAN_CARLOS, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 1']), [CESAR, CHAMORRO, EMILY, JUAN_CARLOS, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 6']), [LUCIA, CESAR, EMILY, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 7']), [CESAR, EMILY, JAIR, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 8']), [CESAR, EMILY, MONICA].sort());
  assert.deepStrictEqual(lista(por['Equipo 9']), [CESAR, EMILY, MONICA].sort());

  assert.strictEqual(por['Equipo 4'].recipient_name, 'César Arbeláez');
  assert.strictEqual(por['Equipo 5'].recipient_name, 'Juan Carlos Díaz y Mónica Bastidas');
  assert.strictEqual(por['Equipo 1'].recipient_name, 'Juan Carlos Díaz y Diego Chamorro');
  assert.strictEqual(por['Equipo 6'].recipient_name, 'Angela Lucia Trujillo');
  assert.strictEqual(por['Equipo 7'].recipient_name, 'Jair Lucumi');
  assert.strictEqual(por['Equipo 9'].recipient_name, 'Mónica Bastidas y César Arbeláez');

  // El CEO no recibe nada.
  // El CEO (Jair) solo recibe el del Equipo 7, donde es PM; ninguno más.
  for (const [equipo, e] of Object.entries(por)) {
    if (equipo !== 'Equipo 7') assert.ok(!e.recipient_email.includes(CEO), `el CEO no debe ir en ${equipo}`);
  }
});

test('cada persona sale una sola vez, en el correo de SU Equipo, con todas sus tareas', () => {
  const por = porEquipo(correr({ modoPrueba: false }));
  assert.deepStrictEqual(personas(por['Equipo 4']), ['Dimas Hernández Mendoza', 'Jaider Bermudez']);
  assert.deepStrictEqual(personas(por['Equipo 3']), ['Edynson Muñoz Jiménez']);
  assert.deepStrictEqual(personas(por['Equipo 5']), ['Jose Flórez Mendoza']);
  assert.deepStrictEqual(personas(por['Equipo 6']), ['Angela Lucia Trujillo']);
  assert.deepStrictEqual(personas(por['Equipo 8']), ['Thomas Medina Trujillo']);
  assert.deepStrictEqual(personas(por['Equipo 9']), ['Emily Tench']);

  // Jaider: sus 5 tareas (MIA, SESCOL, Transversales, Management) en una sola tarjeta,
  // con los errores de todas ellas.
  assert.match(por['Equipo 4'].body_html, /Jaider Bermudez[\s\S]*?5 tareas/);
  assert.match(por['Equipo 4'].body_html, /Falta estado de la tarea/);
  assert.match(por['Equipo 4'].body_html, /Falta responsable/);
  assert.match(por['Equipo 4'].body_html, /SIN ARCHIVO/); // Dimas
});

test('asunto y cuerpo muestran el Equipo, nunca el proyecto', () => {
  const por = porEquipo(correr({ modoPrueba: false }));
  for (const [equipo, e] of Object.entries(por)) {
    assert.match(e.subject, new RegExp(`^\\[PLANEACION\\] .*\\[${equipo}\\]`));
    assert.match(e.body_html, new RegExp(`Estado diario de planeación · ${equipo}<`));
    assert.doesNotMatch(e.subject, /MIA|SESCOL|Transversales|Document Online|QA/);
    assert.doesNotMatch(e.body_html, /proyecto <strong>/);
    assert.doesNotMatch(e.body_html, /CORREO DE PRUEBA/);
  }
});

test('CEO_RECIBE_TODO = true lo vuelve a poner en copia', () => {
  for (const e of correr({ modoPrueba: false, ceoRecibeTodo: true })) assert.ok(e.recipient_email.includes(CEO));
});

test('prueba: solo salen correos a los 3 buzones, con el destinatario real a la vista', () => {
  const emails = correr({ modoPrueba: true, ceoRecibeTodo: true });
  assert.ok(emails.length > 0);
  for (const e of emails) {
    for (const d of e.recipient_email.split(', ')) assert.ok(BUZONES_PRUEBA.has(d), `${d} no es un buzón de prueba (${e.project_folder})`);
    assert.match(e.body_html, /CORREO DE PRUEBA/);
    for (const real of e.recipient_email_real.split(', ')) assert.ok(e.body_html.includes(real));
  }
  // Mónica (gmail) recibe TODOS los Equipos (va en copia universal), cada uno en su propio correo.
  const deMonica = emails.filter((e) => e.recipient_email.includes('prueba2@ejemplo.com')).map((e) => e.project_folder).sort();
  assert.deepStrictEqual(deMonica, ['Equipo 1', 'Equipo 3', 'Equipo 4', 'Equipo 5', 'Equipo 6', 'Equipo 7', 'Equipo 8', 'Equipo 9']);
});

test('cada hallazgo muestra la fila del Excel donde está', () => {
  const por = porEquipo(correr({ modoPrueba: false }));
  // Jaider: "Nómina" (consec 2) está en la fila 11 de la hoja y no tiene estado;
  // "Inscripción" (consec 3, fila 12) no tiene responsable.
  assert.match(por['Equipo 4'].body_html, /Falta estado de la tarea[\s\S]*?fila <strong>11<\/strong>/);
  assert.match(por['Equipo 4'].body_html, /Falta responsable[\s\S]*?fila <strong>12<\/strong>/);
});
