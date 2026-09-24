'use strict';

/**
 * Comprobaciones estáticas sobre los archivos de sql/. No tocan ninguna
 * base de datos: leen el DDL como texto.
 *
 * Existen por el hallazgo QA-06 (docs/testing.md): sql/03 declaraba
 * mp_validation_errors con un esquema viejo e incompatible con el que
 * consulta src/routes/validation.js. En producción no se notaba porque la
 * tabla ya existía (creada por n8n) y el IF NOT EXISTS no hacía nada — o
 * sea que NINGUNA prueba contra una base real podía detectarlo, porque en
 * la base de pruebas la tabla también se crea antes (ver
 * test/fixtures/00-schema-externo.sql).
 *
 * Por eso la verificación es sobre el texto del archivo: es el único lugar
 * donde el error es visible.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SQL_DIR = path.join(__dirname, '..', '..', 'sql');

function leer(archivo) {
  return fs.readFileSync(path.join(SQL_DIR, archivo), 'utf8');
}

/**
 * Devuelve solo el CREATE TABLE de `tabla` dentro de un .sql, sin
 * comentarios. Hace falta acotar: sql/03 declara DOS tablas y
 * mp_ingestion_runs tiene su propia columna `workflow_name` — buscar sobre
 * el archivo entero daría un falso positivo. Los comentarios se quitan
 * porque el encabezado del archivo nombra a propósito las columnas viejas,
 * para documentar qué se corrigió.
 */
function ddlDeTabla(sql, tabla) {
  const inicio = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tabla} (`);
  assert.notStrictEqual(inicio, -1, `no se encontró el CREATE TABLE de ${tabla}`);
  const fin = sql.indexOf('ENGINE=InnoDB', inicio);
  assert.notStrictEqual(fin, -1, `el CREATE TABLE de ${tabla} no cierra`);

  return sql
    .slice(inicio, fin)
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n');
}

// Columnas que src/routes/validation.js consulta de verdad (SELECT, WHERE
// y UPDATE). Si el DDL no las declara, todo /api/validation/* responde
// "Unknown column" en una base creada solo con sql/.
const COLUMNAS_QUE_USA_LA_APP = [
  'snapshot_date', 'execution_id', 'employee_folder_name', 'employee_id',
  'project_folder', 'file_name', 'error_type', 'severity', 'error_message',
  'week_number', 'notified', 'created_at',
];

// Columnas del esquema VIEJO. Que reaparezca cualquiera de estas significa
// que alguien revirtió la corrección.
const COLUMNAS_DEL_ESQUEMA_VIEJO = [
  'detected_at', 'workflow_name', 'source_filename',
  'employee_name_guess', 'cedula_guess', 'raw_context', 'acknowledged',
];

test('QA-06: sql/03 declara mp_validation_errors con las columnas que la app consulta', () => {
  const ddl = ddlDeTabla(leer('03_ingestion_and_validation.sql'), 'mp_validation_errors');
  for (const columna of COLUMNAS_QUE_USA_LA_APP) {
    assert.match(
      ddl, new RegExp(`\\b${columna}\\b`),
      `sql/03 no declara la columna "${columna}" — /api/validation/* fallaría en una base nueva`
    );
  }
});

test('QA-06: sql/03 ya no trae ninguna columna del esquema viejo', () => {
  const ddl = ddlDeTabla(leer('03_ingestion_and_validation.sql'), 'mp_validation_errors');
  for (const columna of COLUMNAS_DEL_ESQUEMA_VIEJO) {
    assert.doesNotMatch(
      ddl, new RegExp(`\\b${columna}\\b`),
      `sql/03 volvió a declarar "${columna}": es el esquema viejo, incompatible con src/routes/validation.js`
    );
  }
});

test('QA-06: el DDL de sql/03 y el del fixture de pruebas declaran las mismas columnas', () => {
  // Si divergen, la suite de integración estaría probando contra un
  // esquema que no es el que levantaría un entorno nuevo — justo el punto
  // ciego que dejó pasar QA-06 (en la base de pruebas la tabla la crea el
  // fixture, así que ninguna prueba contra la base podía notar el error).
  const enSql03 = ddlDeTabla(leer('03_ingestion_and_validation.sql'), 'mp_validation_errors');
  const enFixture = ddlDeTabla(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', '00-schema-externo.sql'), 'utf8'),
    '`mp_validation_errors`'
  );

  for (const columna of COLUMNAS_QUE_USA_LA_APP) {
    const re = new RegExp(`\\b${columna}\\b`);
    assert.ok(
      re.test(enSql03) && re.test(enFixture),
      `"${columna}" no está en los dos sitios: sql/03 y el fixture divergieron`
    );
  }
});
