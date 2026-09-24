'use strict';

/**
 * Trocear un archivo .sql en sentencias, respetando comillas y comentarios.
 *
 * Vivía duplicado en scripts/run-migration.js y test/helpers/db.js. Se
 * extrajo aquí cuando nació scripts/migrar-todo.js (28 ago 2026) para no
 * tener una tercera copia: si el troceo diverge entre el runner y las
 * pruebas, las migraciones se prueban de una forma y se aplican de otra.
 *
 * No basta con partir por ';': varias migraciones usan el patrón
 * SET @sql := '...ALTER...'; PREPARE stmt FROM @sql; y ese texto lleva
 * punto y coma adentro de comillas.
 */

// Quita comentarios de línea (-- ...) sin romper el contenido de las cadenas.
function quitarComentarios(sql) {
  return sql
    .split('\n')
    .map((linea) => {
      let dentro = null;
      for (let i = 0; i < linea.length; i++) {
        const c = linea[i];
        if (dentro) {
          if (c === dentro && linea[i - 1] !== '\\') dentro = null;
        } else if (c === "'" || c === '"') {
          dentro = c;
        } else if (c === '-' && linea[i + 1] === '-') {
          return linea.slice(0, i);
        }
      }
      return linea;
    })
    .join('\n');
}

// Separa por ';' respetando las comillas.
function separarSentencias(sql) {
  const out = [];
  let actual = '';
  let dentro = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dentro) {
      if (c === dentro && sql[i - 1] !== '\\') dentro = null;
    } else if (c === "'" || c === '"') {
      dentro = c;
    } else if (c === ';') {
      if (actual.trim()) out.push(actual.trim());
      actual = '';
      continue;
    }
    actual += c;
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

// Un archivo con DROP/TRUNCATE no se aplica automáticamente por ningún
// runner: eso exige ir a la base a conciencia y con respaldo previo.
const PROHIBIDO = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i;

function tieneSentenciasDestructivas(sqlBruto) {
  return PROHIBIDO.test(quitarComentarios(sqlBruto));
}

function sentenciasDe(sqlBruto) {
  return separarSentencias(quitarComentarios(sqlBruto));
}

module.exports = { quitarComentarios, separarSentencias, sentenciasDe, tieneSentenciasDestructivas, PROHIBIDO };
