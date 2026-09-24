'use strict';

/**
 * Prueba del nodo "Construir SQL" de WF-COSTEO (04-construir-sql.js).
 *
 * Los textos viajan en hexadecimal (CONVERT(X'...' USING utf8mb4)) desde
 * que el separador de sentencias de n8n partió un INSERT en la primera
 * corrida real con los 9 equipos. Estas pruebas cubren justo eso: que
 * ningún contenido del Excel pueda dejar un ";" o una comilla suelta en la
 * sentencia.
 *
 * Correr con:  node --test docs/n8n/wf-costeo/04-construir-sql.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Se evalúa con TextEncoder, Buffer y require TAPADOS (undefined), porque
// el sandbox de los nodos Code de n8n no los tiene. La primera versión
// usaba TextEncoder: pasaba aquí (Node sí lo tiene) y reventaba en n8n con
// "TextEncoder is not defined". Así esa clase de error aparece en la prueba.
function cargar() {
  const src = fs.readFileSync(path.join(__dirname, '04-construir-sql.js'), 'utf8');
  const corte = src.indexOf('// ---- n8n ----');
  assert.ok(corte > 0, 'no se encontro el marcador de la seccion de n8n');
  // eslint-disable-next-line no-new-func
  return new Function('TextEncoder', 'Buffer', 'require',
    `${src.slice(0, corte)}; return { construirSentencias, sqlTexto, sqlNumero, sqlFecha, utf8Hex };`)(
    undefined, undefined, undefined);
}

const { construirSentencias, sqlTexto, sqlNumero, sqlFecha, utf8Hex } = cargar();

test('utf8Hex da exactamente los mismos bytes que el codificador de Node', () => {
  const casos = ['', 'abc', 'ñandú', 'áéíóú ÁÉÍÓÚ ü', '€ y ™', 'emoji 🚀 y 👍🏽', '中文', 'tab\tsalto\n',
    'O\'Brien; "x" \\ {{ $json }}', '\u0000 nulo'];
  for (const c of casos) assert.strictEqual(utf8Hex(c), Buffer.from(c, 'utf8').toString('hex'), `distinto para ${JSON.stringify(c)}`);
});

test('utf8Hex no revienta con una media pareja de emoji suelta', () => {
  const roto = 'a\uD83Db'; // media pareja sin su compañera
  assert.strictEqual(utf8Hex(roto), Buffer.from(roto, 'utf8').toString('hex'));
});

test('el nodo no usa nada que el sandbox de n8n no tenga', () => {
  const src = fs.readFileSync(path.join(__dirname, '04-construir-sql.js'), 'utf8');
  const codigo = src.slice(0, src.indexOf('// ---- n8n ----'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\bTextEncoder\b|\bBuffer\b|\brequire\(/.test(codigo), 'usa TextEncoder, Buffer o require');
});

/** Inversa de sqlTexto(), para comprobar que el texto vuelve idéntico. */
function decodificar(literal) {
  if (literal === 'NULL') return null;
  if (literal === "''") return '';
  const m = literal.match(/^CONVERT\(X'([0-9a-f]*)' USING utf8mb4\)$/);
  assert.ok(m, `no es un literal hexadecimal: ${literal}`);
  return Buffer.from(m[1], 'hex').toString('utf8');
}

/**
 * Imita al separador de n8n: parte en cada ";" que no esté dentro de
 * comillas simples, SIN entender las comillas escapadas (\'), que es
 * justamente lo que lo hizo fallar. Si una sentencia sale en más de un
 * pedazo, n8n la habría roto.
 */
function partirComoN8n(sql) {
  return sql.split(/;(?=(?:[^']*'[^']*')*[^']*$)/).map((x) => x.trim()).filter(Boolean);
}

const CENTROS = new Map([
  [4, { cost_center_id: 4, project_name: 'Management', project_folder: 'Management' }],
  [9, { cost_center_id: 9, project_name: 'Transversales', project_folder: 'Transversales' }],
  [26, { cost_center_id: 26, project_name: 'Sistema de costos', project_folder: 'sistema-de-costos' }],
]);

function fila(extra = {}) {
  return {
    employee_id: 13, cost_center_id: 4, project_folder: 'CRM', project_name: 'Management',
    week_number: 3, activity: 'Daily', planned_type: 'P', budgeted_hours: 1,
    estimated_delivery_date: '2026-09-18', actual_delivery_date: '2026-09-18',
    hours_monday: 0, hours_tuesday: 0.25, hours_wednesday: 0.25, hours_thursday: 0.25,
    hours_friday: 0.25, hours_saturday: 0, total_executed_hours: 1,
    task_status: 'Terminado', observations: null, month_number: 9, year_number: 2026,
    ...extra,
  };
}

const TEXTOS_DIFICILES = [
  "Reunión con O'Brien",
  "Revisar O'Brien; luego ajustar",
  'termina en punto y coma;',
  'barra \\ invertida',
  'comillas "dobles"',
  'salto\nde linea\r\ny tab\t',
  "'); DROP TABLE mp_costeo_task_facts; --",
  'llaves {{ $json.sql }} y $1',
  'ñandú, tildes: áéíóú, emoji 🚀',
];

test('cualquier texto vuelve idéntico después de pasar a hexadecimal', () => {
  for (const t of TEXTOS_DIFICILES) assert.strictEqual(decodificar(sqlTexto(t)), t, `cambió: ${t}`);
});

test('el literal de texto no contiene comillas, ";", barras, llaves ni "$" del contenido', () => {
  for (const t of TEXTOS_DIFICILES) {
    const lit = sqlTexto(t);
    const interior = lit.match(/X'([^']*)'/)[1];
    assert.match(interior, /^[0-9a-f]*$/, `quedó algo interpretable en: ${t}`);
  }
});

test('null y undefined salen como NULL; el texto vacío como cadena vacía', () => {
  assert.strictEqual(sqlTexto(null), 'NULL');
  assert.strictEqual(sqlTexto(undefined), 'NULL');
  assert.strictEqual(sqlTexto(''), "''");
  assert.strictEqual(sqlNumero(null), 'NULL');
  assert.strictEqual(sqlFecha(null), 'NULL');
});

test('un numero invalido entra como NULL, nunca sin comillas', () => {
  assert.strictEqual(sqlNumero('1; DROP TABLE x'), 'NULL');
  assert.strictEqual(sqlNumero('abc'), 'NULL');
  assert.strictEqual(sqlNumero('2.5'), '2.5');
  assert.strictEqual(sqlNumero(0), '0');
});

test('una fecha que no es YYYY-MM-DD entra como NULL', () => {
  assert.strictEqual(sqlFecha('2026-09-18'), "'2026-09-18'");
  assert.strictEqual(sqlFecha("2026-09-18'; DROP"), "'2026-09-18'"); // se corta a 10 caracteres
  assert.strictEqual(sqlFecha('18/09/2026'), 'NULL');
});

test('EL CASO QUE FALLÓ: el separador de n8n ya no puede partir ninguna sentencia', () => {
  const filas = TEXTOS_DIFICILES.map((t, i) => fila({ activity: t, observations: t, week_number: i + 1 }));
  for (const s of construirSentencias(filas, '2026-09-21', CENTROS)) {
    assert.strictEqual(partirComoN8n(s.sql).length, 1, `n8n partiría esta sentencia: ${s.sql.slice(0, 120)}`);
    assert.ok(!s.sql.includes(';'), 'no debe quedar ningún ";" en la sentencia');
  }
});

test('primero van los DELETE y despues los INSERT', () => {
  const s = construirSentencias([fila(), fila({ cost_center_id: 9, project_name: 'Transversales' })], '2026-09-21', CENTROS);
  assert.deepStrictEqual(s.map((x) => x.tipo), ['delete', 'delete', 'insert']);
});

test('un DELETE por persona y centro, acotado a HOY y a ese proyecto', () => {
  const s = construirSentencias([fila(), fila(), fila()], '2026-09-21', CENTROS);
  const deletes = s.filter((x) => x.tipo === 'delete');
  assert.strictEqual(deletes.length, 1);
  assert.match(deletes[0].sql, /^DELETE FROM mp_costeo_task_facts WHERE employee_id = 13 AND snapshot_date = '2026-09-21' AND project_name IN \(/);
  assert.ok(deletes[0].sql.includes(sqlTexto('Management')));
});

test('el DELETE cubre el nombre, la carpeta del centro y lo escrito en el Excel', () => {
  const del = construirSentencias(
    [fila({ cost_center_id: 26, project_name: 'SISTEMA DE COSTOS' })], '2026-09-21', CENTROS
  ).find((x) => x.tipo === 'delete').sql;
  for (const nombre of ['Sistema de costos', 'sistema-de-costos', 'SISTEMA DE COSTOS']) {
    assert.ok(del.includes(sqlTexto(nombre)), `falta ${nombre}`);
  }
});

test('nunca arma un DELETE sin filtro de persona (no borra todo lo de hoy)', () => {
  for (const d of construirSentencias([fila()], '2026-09-21', CENTROS).filter((x) => x.tipo === 'delete')) {
    assert.match(d.sql, /WHERE employee_id = \d+ AND snapshot_date = /);
  }
});

test('los INSERT van en lotes de 100 y no se pierde ninguna fila', () => {
  const filas = Array.from({ length: 537 }, (_, i) => fila({ activity: `tarea ${i}` }));
  const inserts = construirSentencias(filas, '2026-09-21', CENTROS).filter((x) => x.tipo === 'insert');
  assert.deepStrictEqual(inserts.map((x) => x.filas), [100, 100, 100, 100, 100, 37]);
});

test('el INSERT tiene 22 columnas y los valores en el orden correcto', () => {
  const ins = construirSentencias([fila()], '2026-09-21', CENTROS).find((x) => x.tipo === 'insert').sql;
  const columnas = ins.match(/\(([^)]*)\) VALUES/)[1].split(',').length;
  assert.strictEqual(columnas, 22);
  const esperado = `VALUES ('2026-09-21', 13, ${sqlTexto('CRM')}, ${sqlTexto('Septiembre')}, 9, 2026, 3, `
    + `${sqlTexto('Management')}, ${sqlTexto('Daily')}, ${sqlTexto('P')}, 1, '2026-09-18', '2026-09-18', `
    + `0, 0.25, 0.25, 0.25, 0.25, 0, 1, ${sqlTexto('Terminado')}, NULL)`;
  assert.ok(ins.endsWith(esperado), `el final del INSERT no es el esperado:\n${ins.slice(-400)}`);
});

test('sin mes en la fila, usa el mes y año del corte (igual que la carga manual)', () => {
  const ins = construirSentencias([fila({ month_number: null, year_number: null })], '2026-09-21', CENTROS)
    .find((x) => x.tipo === 'insert').sql;
  assert.ok(ins.includes(`${sqlTexto('Septiembre')}, 9, 2026`));
});

test('una fecha de corte invalida detiene todo antes de armar nada', () => {
  assert.throws(() => construirSentencias([fila()], 'hoy', CENTROS), /snapshotDate/);
});

test('sin filas no arma ninguna sentencia', () => {
  assert.deepStrictEqual(construirSentencias([], '2026-09-21', CENTROS), []);
});

// ---- Reemplazo por persona completa (22 sep 2026: GTC Project quedó en 5%) ----

test('EL CASO REPORTADO: persona completa sin filas de un proyecto -> el DELETE del día la cubre entera', () => {
  // Angela (42) quitó todo lo de GTC Project: la corrida no trae ninguna
  // fila suya de ese proyecto, pero igual hay que borrarle lo de hoy.
  const s = construirSentencias([fila({ employee_id: 42 })], '2026-09-22', CENTROS, { empleadosCompletos: [42] });
  const del = s.find((x) => x.tipo === 'delete');
  assert.strictEqual(del.sql, "DELETE FROM mp_costeo_task_facts WHERE snapshot_date = '2026-09-22' AND employee_id IN (42)");
  assert.ok(!/project_name/.test(del.sql), 'no debe filtrar por proyecto');
});

test('persona completa sin NINGUNA fila hoy igual recibe el DELETE y la limpieza', () => {
  const s = construirSentencias([], '2026-09-22', CENTROS, { empleadosCompletos: [42] });
  assert.deepStrictEqual(s.map((x) => x.tipo), ['delete', 'limpieza']);
});

test('orden: DELETE completos, DELETE por pareja de incompletos, INSERT, limpieza al final', () => {
  const s = construirSentencias(
    [fila({ employee_id: 42 }), fila({ employee_id: 13, cost_center_id: 9, project_name: 'Transversales' })],
    '2026-09-22', CENTROS, { empleadosCompletos: [42] }
  );
  assert.deepStrictEqual(s.map((x) => x.tipo), ['delete', 'delete', 'insert', 'limpieza']);
  assert.match(s[0].sql, /employee_id IN \(42\)$/);
  // El incompleto (13) conserva el reemplazo por pareja de siempre.
  assert.match(s[1].sql, /WHERE employee_id = 13 AND snapshot_date = '2026-09-22' AND project_name IN \(/);
});

test('la limpieza solo toca días ANTERIORES, solo de los completos, y solo parejas que hoy no existen', () => {
  const lim = construirSentencias([fila({ employee_id: 42 })], '2026-09-22', CENTROS, { empleadosCompletos: [42, 7] })
    .find((x) => x.tipo === 'limpieza').sql;
  assert.match(lim, /WHERE snapshot_date = '2026-09-22'\) hoy/);
  assert.match(lim, /t\.snapshot_date < '2026-09-22'/);
  assert.match(lim, /t\.employee_id IN \(42, 7\)/);
  assert.match(lim, /hoy\.employee_id IS NULL$/);
});

test('sin lista de completos se comporta como antes: solo pareja, sin limpieza', () => {
  const s = construirSentencias([fila()], '2026-09-22', CENTROS);
  assert.deepStrictEqual(s.map((x) => x.tipo), ['delete', 'insert']);
});

test('ids raros en la lista de completos no llegan al IN', () => {
  const s = construirSentencias([], '2026-09-22', CENTROS, { empleadosCompletos: [42, '1; DROP TABLE x', null, 42] });
  assert.match(s[0].sql, /employee_id IN \(42\)$/);
});

test('las sentencias nuevas tampoco dejan ";" para el separador de n8n', () => {
  const s = construirSentencias([fila({ employee_id: 42, activity: "O'Brien; x" })], '2026-09-22', CENTROS, { empleadosCompletos: [42] });
  for (const x of s) {
    assert.ok(!x.sql.includes(';'), `quedó un ";" en ${x.tipo}`);
    assert.strictEqual(partirComoN8n(x.sql).length, 1);
  }
});
