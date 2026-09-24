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
  return new Function(`${src.slice(0, corte)}; return { construirIndiceEmpleados, construirIndiceCentros, resolverEmpleado, nombresCandidatos, centroParaProyecto, clasificarEmpleadosLeidos, requiereModulo, REQUIERE_MODULO, construirIndiceEquipo, estaEnElEquipo };`)();
}

const { construirIndiceEmpleados, construirIndiceCentros, resolverEmpleado, nombresCandidatos, centroParaProyecto, clasificarEmpleadosLeidos, requiereModulo, REQUIERE_MODULO, construirIndiceEquipo, estaEnElEquipo } = cargar();

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
    archivo: '2026_1143963601_CRISTINA_DEWOLFE.xlsx',
  });
  assert.ok(hit, 'no uso el nombre del archivo');
  assert.strictEqual(hit.employee_id, 44);
});

test('el nombre del archivo descarta año y cedula', () => {
  assert.deepStrictEqual(
    nombresCandidatos({ persona: null, archivo: '2026_1143963601_CRISTINA_DEWOLFE.xlsx' }),
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

// ---- Subproyectos "Algo (Proyecto)" ----
const CENTROS_REALES = construirIndiceCentros([
  { cost_center_id: 9, project_name: 'Transversales', project_folder: 'Transversales' },
  { cost_center_id: 28, project_name: 'SUECO CRM', project_folder: 'sueco-crm' },
  { cost_center_id: 4, project_name: 'Management', project_folder: 'Management' },
]);

test('un proyecto que ya es centro va directo, sin subproyecto', () => {
  const r = centroParaProyecto(CENTROS_REALES, 'Management', {});
  assert.strictEqual(r.centro.cost_center_id, 4);
  assert.strictEqual(r.subproyecto, null);
});

test('EL CASO REAL: "Notificaciones (Transversales)" va a Transversales', () => {
  const r = centroParaProyecto(CENTROS_REALES, 'Notificaciones (Transversales)', {});
  assert.strictEqual(r.centro.cost_center_id, 9);
  assert.strictEqual(r.subproyecto, 'Notificaciones');
});

test('por regla, "Sueco eventos (Transversales)" va a Transversales', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Sueco eventos (Transversales)', {}).centro.cost_center_id, 9);
});

test('una excepcion manda sobre la regla (y no importan mayusculas)', () => {
  const r = centroParaProyecto(CENTROS_REALES, 'Sueco Eventos (Transversales)',
    { 'Sueco eventos (Transversales)': 'SUECO CRM' });
  assert.strictEqual(r.centro.cost_center_id, 28);
  assert.strictEqual(r.subproyecto, 'Sueco Eventos');
});

test('una excepcion hacia un centro que no existe descarta la fila en vez de adivinar', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Algo (Transversales)', { 'Algo (Transversales)': 'No Existe' }), null);
});

test('si lo de adentro del parentesis no es un centro, se descarta', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'Licitacion (Villa Rica)', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, 'SIRUR', {}), null);
});

test('vacio o null no revienta', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, '', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_REALES, null, {}), null);
});

test('"Habilitador" (singular, sin parentesis) va al centro Habilitadores por la excepcion', () => {
  const centros = construirIndiceCentros([
    { cost_center_id: 27, project_name: 'Habilitadores', project_folder: 'habilitadores' },
  ]);
  const r = centroParaProyecto(centros, 'Habilitador', { 'Habilitador': 'Habilitadores' });
  assert.strictEqual(r.centro.cost_center_id, 27);
  // Con subproyecto no nulo, el nodo reescribe project_name al del centro:
  // si no, el motor no cobraria esas horas (cruza por project_name).
  assert.ok(r.subproyecto);
  assert.strictEqual(centroParaProyecto(centros, 'Habilitadores', {}).subproyecto, null);
});

// ---- SharePoint reorganizó el desplegable "Proyecto" en MÓDULOS (23 sep
// 2026) ----
//
// Antes se elegía directo el proyecto ("MIA", "Transversales"...). Ahora el
// desplegable trae el trabajo repartido en módulos con el formato
// "Módulo (Proyecto)" — "CRM (Transversales)", "Comunicaciones (Document
// Online)"... y "Management" sigue siendo el único que se elige directo, sin
// módulo. Es el mismo patrón "Notificaciones (Transversales)" que ya
// resolvía centroParaProyecto desde el 21 sep 2026, solo que ahora es TODO
// el desplegable, no un caso suelto.
//
// La lista de abajo es la que el usuario confirmó contra el Excel real (23
// sep 2026) y se verificó contra mp_centro_costo antes de escribir esta
// prueba: los 35 módulos resuelven sin tocar el código, porque
// centroParaProyecto ya leía el paréntesis con una regla genérica, no con
// una lista fija. Si SharePoint vuelve a reorganizar el desplegable, esta
// prueba es la que avisa qué módulo dejó de cuadrar.
const CENTROS_MODULOS = construirIndiceCentros([
  { cost_center_id: 4, project_name: 'Management', project_folder: 'Management' },
  { cost_center_id: 9, project_name: 'Transversales', project_folder: 'Transversales' },
  { cost_center_id: 3, project_name: 'Document Online', project_folder: 'Document Online' },
  { cost_center_id: 8, project_name: 'SESCOL', project_folder: 'SESCOL' },
  { cost_center_id: 7, project_name: 'MIA', project_folder: 'MIA' },
]);

const MODULOS_23_SEP_2026 = [
  ['Management', 'Management'],
  ['CRM (Transversales)', 'Transversales'],
  ['Sueco eventos (Transversales)', 'Transversales'],
  ['Notificaciones (Transversales)', 'Transversales'],
  ['Colaboradores y terceros (Transversales)', 'Transversales'],
  ['Tickets (Transversales)', 'Transversales'],
  ['Seguridad (Transversales)', 'Transversales'],
  ['Sueco project (Transversales)', 'Transversales'],
  ['Auditoria (Transversales)', 'Transversales'],
  ['Formularios dinámicos (Transversales)', 'Transversales'],
  ['Comunicaciones (Document Online)', 'Document Online'],
  ['Configuración documental (Document Online)', 'Document Online'],
  ['Estructura documental (Document Online)', 'Document Online'],
  ['Almacenamiento (Document Online)', 'Document Online'],
  ['Archivo físico (Document Online)', 'Document Online'],
  ['Gestión de formularios (Document Online)', 'Document Online'],
  ['Flujos documentales (Document Online)', 'Document Online'],
  ['Administracion (Sescol)', 'SESCOL'],
  ['Tablas generales (Sescol)', 'SESCOL'],
  ['Admisiones (Sescol)', 'SESCOL'],
  ['Planes de Estudio (Sescol)', 'SESCOL'],
  ['Programacion academica (Sescol)', 'SESCOL'],
  ['Calificaciones (Sescol)', 'SESCOL'],
  ['Historia academica (Sescol)', 'SESCOL'],
  ['Gestion economica (Sescol)', 'SESCOL'],
  ['Matricula (Sescol)', 'SESCOL'],
  ['Grados (Sescol)', 'SESCOL'],
  ['Normativa (Sescol)', 'SESCOL'],
  ['Reportes (Sescol)', 'SESCOL'],
  ['Gestion financiera (MIA)', 'MIA'],
  ['Gestion administrativa (MIA)', 'MIA'],
  ['Gestion comercial (MIA)', 'MIA'],
  ['Gestion de proveedores (MIA)', 'MIA'],
  ['Gestion publica y municipal (MIA)', 'MIA'],
  ['Talento humano inteligente (MIA)', 'MIA'],
];

test('los 35 módulos del desplegable nuevo resuelven al proyecto correcto', () => {
  for (const [modulo, proyectoEsperado] of MODULOS_23_SEP_2026) {
    const r = centroParaProyecto(CENTROS_MODULOS, modulo, {});
    assert.ok(r, `"${modulo}" no resolvió a ningún centro`);
    assert.strictEqual(r.centro.project_name, proyectoEsperado, `"${modulo}" fue a "${r.centro.project_name}", esperaba "${proyectoEsperado}"`);
  }
});

test('"Management" es el único módulo sin paréntesis: va directo, sin subproyecto', () => {
  const r = centroParaProyecto(CENTROS_MODULOS, 'Management', {});
  assert.strictEqual(r.subproyecto, null);
});

test('cada módulo con paréntesis guarda su nombre como subproyecto (se ve en la actividad)', () => {
  const r = centroParaProyecto(CENTROS_MODULOS, 'Gestion financiera (MIA)', {});
  assert.strictEqual(r.subproyecto, 'Gestion financiera');
});

// ---- 4 proyectos ya NO se aceptan "pelados" (23 sep 2026, decisión
// explícita: ~10.000 h así, hasta en septiembre, se dejan de contar hasta
// que se reescriba el Excel con el módulo) ----

test('EL CASO REAL: "MIA" a secas (sin módulo) se rechaza, aunque MIA sea un centro real', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_MODULOS, 'MIA', {}), null);
});

test('"SESCOL", "Document Online" y "Transversales" pelados también se rechazan', () => {
  assert.strictEqual(centroParaProyecto(CENTROS_MODULOS, 'SESCOL', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_MODULOS, 'Sescol', {}), null); // normalizado, minusculas
  assert.strictEqual(centroParaProyecto(CENTROS_MODULOS, 'Document Online', {}), null);
  assert.strictEqual(centroParaProyecto(CENTROS_MODULOS, 'Transversales', {}), null);
});

test('"Management" SIGUE aceptándose pelado: es el único que el desplegable nuevo ofrece así', () => {
  const r = centroParaProyecto(CENTROS_MODULOS, 'Management', {});
  assert.ok(r, '"Management" no debería rechazarse');
  assert.strictEqual(r.centro.project_name, 'Management');
});

test('con módulo, los 4 proyectos restringidos SI resuelven (la restricción es solo contra la forma pelada)', () => {
  assert.ok(centroParaProyecto(CENTROS_MODULOS, 'Gestion financiera (MIA)', {}));
  assert.ok(centroParaProyecto(CENTROS_MODULOS, 'Admisiones (Sescol)', {}));
  assert.ok(centroParaProyecto(CENTROS_MODULOS, 'Comunicaciones (Document Online)', {}));
  assert.ok(centroParaProyecto(CENTROS_MODULOS, 'CRM (Transversales)', {}));
});

test('requiereModulo() identifica los 4 proyectos, y a ningún otro centro (ni Management)', () => {
  const centros = [
    { cost_center_id: 4, project_name: 'Management' },
    { cost_center_id: 9, project_name: 'Transversales' },
    { cost_center_id: 10, project_name: 'Transversales 2' }, // distinto: NO está en la lista
    { cost_center_id: 28, project_name: 'SUECO CRM' },
  ];
  const resultado = centros.map((c) => [c.project_name, requiereModulo(c)]);
  assert.deepStrictEqual(resultado, [
    ['Management', false],
    ['Transversales', true],
    ['Transversales 2', false],
    ['SUECO CRM', false],
  ]);
  assert.strictEqual(REQUIERE_MODULO.length, 4);
});

// El piso de agosto 2026 NO vive en este archivo: es universal (aplica a
// cualquier proyecto por igual, Management y Sistema de Costos incluidos)
// y se filtra antes, por pestaña completa, en "Resolver hoja del mes"
// (01b-resolver-hojas-meses.js — ver sus pruebas de "el piso en agosto
// 2026 es universal"). Aquí solo vive requiereModulo, que SÍ distingue
// por proyecto (ver las pruebas de arriba).

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
