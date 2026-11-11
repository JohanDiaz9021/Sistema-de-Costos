'use strict';

/**
 * Prueba del nodo Code "Resolver y filtrar" (03-resolver-y-filtrar.js).
 *
 * Usa nombres reales de la base (Cristina De Wolfe Giraldo con su alias
 * "Cristina DeWolfe", que es como se llama la carpeta en SharePoint) para
 * comprobar que el cruce carpeta -> empleado funciona de verdad.
 *
 * Correr con:  node --test docs/n8n/wf-costeo/03-resolver-y-filtrar.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function cargar() {
  const src = fs.readFileSync(path.join(__dirname, '03-resolver-y-filtrar.js'), 'utf8');
  const corte = src.indexOf('// ---- Ejecucion ----');
  assert.ok(corte > 0, 'no se encontro el marcador de ejecucion');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(0, corte)}; return { construirIndiceEmpleados, construirIndiceCentros, resolverEmpleado, nombresCandidatos, centroParaProyecto, clasificarEmpleadosLeidos, construirIndiceEquipo, estaEnElEquipo };`)();
}

const { construirIndiceEmpleados, construirIndiceCentros, resolverEmpleado, nombresCandidatos, centroParaProyecto, clasificarEmpleadosLeidos, construirIndiceEquipo, estaEnElEquipo } = cargar();

// Filas tal como salen del SELECT a mp_employees.
const EMPLEADOS = [
  { employee_id: 44, canonical_name: 'Cristina De Wolfe Giraldo', aliases: 'Cristina DeWolfe,Cristina De Wolfe,Cristina Wolfe,Cristina Giraldo', is_active: 1 },
  { employee_id: 21, canonical_name: 'Alexander Valencia', aliases: 'Alex Valencia,Alexander V.', is_active: 1 },
  { employee_id: 36, canonical_name: 'Alexander Alberto Muñoz Coneo', aliases: 'Alexander Muñoz,Alexander Munoz', is_active: 1 },
  { employee_id: 99, canonical_name: 'Sin Alias Perez', aliases: null, is_active: 1 },
];

const CENTROS = [
  { cost_center_id: 26, project_name: 'Sistema de costos', project_folder: 'sistema-de-costos' },
  { cost_center_id: 7, project_name: 'MIA', project_folder: 'MIA' },
  { cost_center_id: 4, project_name: 'Management', project_folder: 'Management' },
];

const indiceEmp = construirIndiceEmpleados(EMPLEADOS);
const indiceCen = construirIndiceCentros(CENTROS);

test('la carpeta de SharePoint cuadra con el empleado via alias', () => {
  const hit = resolverEmpleado(indiceEmp, { persona: 'Cristina DeWolfe' });
  assert.ok(hit, 'no resolvio a Cristina');
  assert.strictEqual(hit.employee_id, 44);
});

test('resuelve igual con el nombre canonico exacto', () => {
  assert.strictEqual(resolverEmpleado(indiceEmp, { persona: 'Alexander Valencia' }).employee_id, 21);
});

test('las tildes no impiden el cruce', () => {
  assert.strictEqual(resolverEmpleado(indiceEmp, { persona: 'Alexander Alberto Munoz Coneo' }).employee_id, 36);
  assert.strictEqual(resolverEmpleado(indiceEmp, { persona: 'Alexander Muñoz' }).employee_id, 36);
});

test('si la carpeta no cuadra, cae al nombre del archivo sin año ni cedula', () => {
  const hit = resolverEmpleado(indiceEmp, {
    persona: 'Carpeta Rara',
    archivo: '2026_9876543210_CRISTINA_DEWOLFE.xlsx',
  });
  assert.ok(hit, 'no uso el nombre del archivo');
  assert.strictEqual(hit.employee_id, 44);
});

test('el nombre del archivo descarta año y cedula', () => {
  assert.deepStrictEqual(
    nombresCandidatos({ persona: null, archivo: '2026_9876543210_CRISTINA_DEWOLFE.xlsx' }),
    ['CRISTINA DEWOLFE']
  );
});

test('una persona sin ficha devuelve null, no revienta', () => {
  assert.strictEqual(resolverEmpleado(indiceEmp, { persona: 'Persona Nueva Sin Ficha' }), null);
});

test('un empleado sin alias igual resuelve por su nombre canonico', () => {
  assert.strictEqual(resolverEmpleado(indiceEmp, { persona: 'Sin Alias Perez' }).employee_id, 99);
});

test('el centro se reconoce por nombre o por carpeta, sin importar mayusculas', () => {
  assert.strictEqual(indiceCen.get('sistemadecostos').cost_center_id, 26);
  const norm = (s) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  assert.strictEqual(indiceCen.get(norm('SISTEMA DE COSTOS')).cost_center_id, 26);
  assert.strictEqual(indiceCen.get(norm('sistema-de-costos')).cost_center_id, 26);
});

test('un proyecto sin centro no aparece en el indice', () => {
  const norm = (s) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  assert.strictEqual(indiceCen.get(norm('Licitación Villa Rica')), undefined);
  assert.strictEqual(indiceCen.get(norm('SIRUR')), undefined);
});

test('aliases guardados como lista JSON (["a","b"]) tambien resuelven', () => {
  // En mp_employees conviven dos formatos: texto con comas y JSON. El WF1
  // solo entiende JSON; este nodo tiene que entender los dos.
  const idx = construirIndiceEmpleados([
    { employee_id: 1, canonical_name: 'Johana Natalia Aldana Diaz', aliases: '["Johana Aldana", "Johana Natalia Aldana"]', is_active: 0 },
  ]);
  assert.strictEqual(resolverEmpleado(idx, { persona: 'Johana Aldana' }).employee_id, 1);
  assert.strictEqual(resolverEmpleado(idx, { persona: 'Johana Natalia Aldana' }).employee_id, 1);
});

test('aliases que llegan ya como arreglo desde n8n tambien resuelven', () => {
  const idx = construirIndiceEmpleados([
    { employee_id: 2, canonical_name: 'Edynson Muñoz Perez', aliases: ['Edynson Muñoz', 'Edynson Munoz'], is_active: 1 },
  ]);
  assert.strictEqual(resolverEmpleado(idx, { persona: 'Edynson Muñoz' }).employee_id, 2);
});

test('si un alias lo comparten una ficha inactiva y una activa, gana la activa', () => {
  // El orden de entrada pone primero la inactiva a proposito.
  const idx = construirIndiceEmpleados([
    { employee_id: 5, canonical_name: 'Carol Piramanrique', aliases: 'Carol P', is_active: 0 },
    { employee_id: 39, canonical_name: 'Carol Milena Piramanrique Perdomo', aliases: 'Carol Piramanrique,Carol P', is_active: 1 },
  ]);
  assert.strictEqual(resolverEmpleado(idx, { persona: 'Carol P' }).employee_id, 39);
});

// ---- Subproyectos "Nombre (Agrupador)" (6 nov 2026) ----
//
// Cada subproyecto es su PROPIO centro de costos, con su propio
// presupuesto. Lo de entre paréntesis es solo una ayuda visual para los PM
// y se ignora. Centros tal como están en mp_centro_costo el 6 nov 2026.
const CENTROS_REALES = construirIndiceCentros([
  { cost_center_id: 46, project_name: 'Auditoria', project_folder: 'Auditoria' },
  { cost_center_id: 40, project_name: 'Colaboradores y Terceros', project_folder: 'Transversales Colaboradores y Terceros' },
  { cost_center_id: 41, project_name: 'CRM', project_folder: 'CRM (Transversales)' },
  { cost_center_id: 39, project_name: 'DIGNO', project_folder: 'DIGNO' },
  { cost_center_id: 47, project_name: 'Formularios dinámicas', project_folder: 'Formularios dinámicas' },
  { cost_center_id: 43, project_name: 'Notificaciones', project_folder: 'Notificaciones' },
  { cost_center_id: 45, project_name: 'Seguridad', project_folder: 'Seguridad' },
  { cost_center_id: 42, project_name: 'Sueco eventos', project_folder: 'Sueco eventos' },
  { cost_center_id: 48, project_name: 'Sueco project', project_folder: 'Sueco project' },
  { cost_center_id: 44, project_name: 'Tickets', project_folder: 'Tickets' },
  { cost_center_id: 4, project_name: 'Management', project_folder: 'Management' },
]);

test('EL CASO REAL: "Notificaciones (Transversales)" va al centro Notificaciones, no a Transversales', () => {
  const r = centroParaProyecto(CENTROS_REALES, 'Notificaciones (Transversales)', {});
  assert.strictEqual(r.centro.cost_center_id, 43);
  assert.strictEqual(r.agrupador, 'Transversales', 'el paréntesis solo queda como dato informativo');
});

test('EL CASO REAL: "Colaboradores y terceros (Transversales)" va a "Colaboradores y Terceros" (sin importar mayúsculas)', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Colaboradores y terceros (Transversales)', {}).centro.cost_center_id, 40);
});

test('un nombre sin paréntesis que ya es centro va directo', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Management', {}).centro.cost_center_id, 4);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Digno', {}).centro.cost_center_id, 39);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Sueco Eventos', {}).centro.cost_center_id, 42);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Management', {}).agrupador, null);
});

test('el nombre completo con paréntesis gana si así se llama la carpeta del centro', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'CRM (Transversales)', {}).centro.cost_center_id, 41);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'CRM', {}).centro.cost_center_id, 41);
});

test('paréntesis pegado o con doble espacio también resuelve', () => {
  const centros = construirIndiceCentros([
    { cost_center_id: 60, project_name: 'Contratación', project_folder: 'Contratación' },
    { cost_center_id: 61, project_name: 'Medios Magneticos', project_folder: 'Medios Magneticos' },
  ]);
  assert.strictEqual(centroParaProyecto(centros, 'Contratación(MIA)', {}).centro.cost_center_id, 60);
  assert.strictEqual(centroParaProyecto(centros, 'Medios Magneticos  (MIA)', {}).centro.cost_center_id, 61);
});

test('un subproyecto que todavía no tiene centro se descarta, aunque exista un centro con el nombre del paréntesis', () => {
  const centros = construirIndiceCentros([
    { cost_center_id: 9, project_name: 'Transversales', project_folder: 'Transversales' },
    { cost_center_id: 7, project_name: 'MIA', project_folder: 'MIA' },
  ]);
  assert.strictEqual(centroParaProyecto(centros, 'Compras (MIA)', {}), null, 'ya no se manda al centro del paréntesis');
  assert.strictEqual(centroParaProyecto(centros, 'Licitacion (Villa Rica)', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'SIRUR', {}), null);
});

test('un proyecto a secas que es centro se acepta (ya no se exige "módulo")', () => {
  const centros = construirIndiceCentros([
    { cost_center_id: 3, project_name: 'Document Online', project_folder: 'Document Online' },
    { cost_center_id: 7, project_name: 'MIA', project_folder: 'MIA' },
  ]);
  assert.strictEqual(centroParaProyecto(centros, 'Document Online', {}).centro.cost_center_id, 3);
  assert.strictEqual(centroParaProyecto(centros, 'MIA', {}).centro.cost_center_id, 7);
});

test('una excepción manda sobre la regla, por nombre completo o por el de afuera del paréntesis', () => {
  const centros = construirIndiceCentros([
    { cost_center_id: 28, project_name: 'SUECO CRM', project_folder: 'sueco-crm' },
    { cost_center_id: 27, project_name: 'Habilitadores', project_folder: 'habilitadores' },
  ]);
  assert.strictEqual(centroParaProyecto(centros, 'Sueco Eventos (Transversales)', { 'Sueco eventos (Transversales)': 'SUECO CRM' }).centro.cost_center_id, 28);
  assert.strictEqual(centroParaProyecto(centros, 'Habilitador', { 'Habilitador': 'Habilitadores' }).centro.cost_center_id, 27);
  assert.strictEqual(centroParaProyecto(centros, 'Habilitador (Transversales)', { 'Habilitador': 'Habilitadores' }).centro.cost_center_id, 27);
});

test('una excepción hacia un centro que no existe descarta la fila en vez de adivinar', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Algo (Transversales)', { 'Algo (Transversales)': 'No Existe' }), null);
});

test('vacío, null o solo paréntesis no revienta', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, '', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, null, {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, '(Transversales)', {}), null);
});

// La lista "Proyectos" del Excel de planeación (6 nov 2026, captura del
// usuario) contra los centros que existen hoy: los que tienen centro
// resuelven a ÉL, y el resto queda para cuando se cree su centro.
const PROYECTOS_EXCEL_6_NOV_2026 = [
  ['Management', 'Management'],
  ['CRM', 'CRM'],
  ['Sueco Eventos', 'Sueco eventos'],
  ['Notificaciones (Transversales)', 'Notificaciones'],
  ['Colaboradores y terceros (Transversales)', 'Colaboradores y Terceros'],
  ['Tickets (Transversales)', 'Tickets'],
  ['Seguridad (Transversales)', 'Seguridad'],
  ['Sueco Project', 'Sueco project'],
  ['Auditoria (Transversales)', 'Auditoria'],
  ['Formularios dinámicas (Transversales)', 'Formularios dinámicas'],
  ['Digno', 'DIGNO'],
  ['Compras (MIA)', null],
  ['Basica (Sescol)', null],
  ['Document Online', null],
];

test('la lista del Excel del 6 nov 2026 cae en el centro de su subproyecto', () => {
  for (const [nombre, esperado] of PROYECTOS_EXCEL_6_NOV_2026) {
    const r = centroParaProyecto(CENTROS_REALES, nombre, {});
    assert.strictEqual(r ? r.centro.project_name : null, esperado, `"${nombre}"`);
  }
});

// El piso de agosto 2026 NO vive en este archivo: es universal (aplica a
// cualquier proyecto por igual) y se filtra antes, por pestaña completa, en
// "Resolver hoja del mes" (01b-resolver-hojas-meses.js).

// ---- Equipo del Proyecto: EL CASO REAL del usuario (23 sep 2026) ----
//
// "en Sistema de costos solo esta Johan Sebastian Diaz... si yo en costo
// planeado en sistema de costos tengo a Johan Sebastian Diaz solo debe
// leerme esas horas asi Thomas Medina tenga horas en Sistema de costos no
// deben ser leidas a menos que el este registrado... en Management como
// tengo a 5 agregados en costo planeado de ese proyecto a los 5 se les lee
// las horas porque los 5 estan registrados"
const EQUIPO_REAL = construirIndiceEquipo([
  { employee_id: 37, cost_center_id: 26 }, // Johan Sebastian Diaz -> Sistema de costos
  { employee_id: 12, cost_center_id: 4 },  // los 5 de Management...
  { employee_id: 26, cost_center_id: 4 },
  { employee_id: 7, cost_center_id: 4 },
  { employee_id: 25, cost_center_id: 4 },
  { employee_id: 18, cost_center_id: 4 },
]);

test('EL CASO REAL: Johan Sebastian (registrado) SI se lee en Sistema de costos', () => {
  assert.strictEqual(estaEnElEquipo(EQUIPO_REAL, 37, 26), true);
});

test('EL CASO REAL: Thomas Medina reporta a Sistema de costos pero NO esta registrado ahi -> no se lee', () => {
  // Aunque Thomas SI este en el Equipo de OTRO proyecto (p. ej. Management,
  // id 38 no esta en la lista de arriba a proposito), en Sistema de costos
  // (26) no cuenta.
  assert.strictEqual(estaEnElEquipo(EQUIPO_REAL, 38, 26), false);
});

test('EL CASO REAL: los 5 registrados en Management SI se leen, todos', () => {
  for (const id of [12, 26, 7, 25, 18]) {
    assert.strictEqual(estaEnElEquipo(EQUIPO_REAL, id, 4), true, `employee_id ${id} deberia estar en Management`);
  }
});

test('estar en el Equipo de UN proyecto no cuenta para OTRO proyecto', () => {
  // Johan Sebastian esta en Sistema de costos (26), no en Management (4).
  assert.strictEqual(estaEnElEquipo(EQUIPO_REAL, 37, 4), false);
});

test('construirIndiceEquipo no revienta con una lista vacia', () => {
  const vacio = construirIndiceEquipo([]);
  assert.strictEqual(estaEnElEquipo(vacio, 1, 1), false);
});

// ---- Quién se leyó COMPLETO (22 sep 2026: GTC Project quedó en 5%) ----
const IDX_LEIDOS = construirIndiceEmpleados([
  { employee_id: 42, canonical_name: 'Angela Lucia Trujillo', aliases: '["Lucia Trujillo"]', is_active: 1 },
  { employee_id: 22, canonical_name: 'Jose Flórez Mendoza', aliases: null, is_active: 1 },
]);

test('persona con su archivo leído sin errores queda como completa', () => {
  const r = clasificarEmpleadosLeidos(
    [{ persona: 'Lucia Trujillo', archivo: 'a.xlsx', project_name: 'MIA' }], IDX_LEIDOS, new Set()
  );
  assert.deepStrictEqual(r, { completos: [42], incompletos: [] });
});

test('EL CASO REPORTADO: quien ya no tiene filas en proyectos con centro igual queda completa', () => {
  // Quitó todo lo de GTC Project; lo único que le queda es un proyecto sin
  // centro. Tiene que quedar completa para que se le borre lo del día.
  const r = clasificarEmpleadosLeidos(
    [{ persona: 'Lucia Trujillo', archivo: 'a.xlsx', project_name: 'Licitación Villa Rica' }], IDX_LEIDOS, new Set()
  );
  assert.deepStrictEqual(r.completos, [42]);
});

test('si una hoja de su archivo falló, la persona queda incompleta (no se le borra todo)', () => {
  const r = clasificarEmpleadosLeidos(
    [{ persona: 'Jose Flórez Mendoza', archivo: 'jose.xlsx', project_name: 'MIA' }], IDX_LEIDOS, new Set(['jose.xlsx'])
  );
  assert.deepStrictEqual(r, { completos: [], incompletos: [22] });
});

test('con dos archivos y uno malo, la persona es incompleta', () => {
  const r = clasificarEmpleadosLeidos([
    { persona: 'Jose Flórez Mendoza', archivo: 'bueno.xlsx', project_name: 'MIA' },
    { persona: 'Jose Flórez Mendoza', archivo: 'malo.xlsx', project_name: 'MIA' },
  ], IDX_LEIDOS, new Set(['malo.xlsx']));
  assert.deepStrictEqual(r, { completos: [], incompletos: [22] });
});

test('una persona sin ficha no entra en ninguna lista', () => {
  const r = clasificarEmpleadosLeidos(
    [{ persona: 'Alguien Nuevo', archivo: 'x.xlsx', project_name: 'MIA' }], IDX_LEIDOS, new Set()
  );
  assert.deepStrictEqual(r, { completos: [], incompletos: [] });
});
