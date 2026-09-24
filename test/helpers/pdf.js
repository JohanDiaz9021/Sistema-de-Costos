'use strict';

/**
 * Extrae el texto de un PDF generado por PDFKit.
 *
 * Hace falta porque PDFKit comprime los content streams con FlateDecode.
 * Buscar una cadena en el binario crudo NO sirve: no encuentra nada nunca,
 * y una prueba del tipo "el PDF no contiene datos de otro proyecto"
 * pasaria siempre, incluso con un PDF lleno de datos ajenos. Ese falso
 * verde fue el primer intento de esta suite, y por eso
 * assertTextoDePdf() exige ademas un `debeContener`.
 *
 * No se usa una libreria de parseo de PDF para no sumar dependencias:
 * basta con inflar los streams y sacar los operandos de texto.
 */

const zlib = require('node:zlib');

/**
 * Devuelve todo el texto visible del PDF, concatenado.
 * Lanza si no encuentra ningun stream: es preferible un error ruidoso a
 * devolver '' y que la prueba pase por la razon equivocada.
 */
function textoDePdf(buffer) {
  const crudo = buffer.toString('latin1');
  const trozos = [];

  const patronStream = /stream\r?\n/g;
  let m;
  while ((m = patronStream.exec(crudo)) !== null) {
    const inicio = m.index + m[0].length;
    const fin = crudo.indexOf('endstream', inicio);
    if (fin === -1) continue;

    const datos = Buffer.from(crudo.slice(inicio, fin), 'latin1');
    let inflado;
    try {
      inflado = zlib.inflateSync(datos);
    } catch {
      // Streams de fuentes o sin comprimir: se usan tal cual.
      inflado = datos;
    }
    trozos.push(inflado.toString('latin1'));
  }

  if (!trozos.length) {
    throw new Error('no se encontro ningun stream en el PDF: el extractor no sirve para este archivo');
  }

  const contenido = trozos.join('\n');
  const partes = [];

  // PDFKit escribe el texto en DOS formatos y hay que soportar los dos:
  //
  //  1. HEX, que es lo que usa con una fuente incrustada (el caso de este
  //     proyecto):   [<5265706f72> -40 <7465> 0] TJ
  //     Ese hex es WinAnsi, no ids de glifo, asi que decodifica directo.
  //  2. Literal entre parentesis, con las fuentes estandar: (Texto) Tj
  const patronHex = /<([0-9A-Fa-f\s]+)>/g;
  let hx;
  while ((hx = patronHex.exec(contenido)) !== null) {
    const hex = hx[1].replace(/\s+/g, '');
    if (hex.length === 0 || hex.length % 2 !== 0) continue;
    partes.push(Buffer.from(hex, 'hex').toString('latin1'));
  }

  const patronLiteral = /\(((?:\\.|[^\\()])*)\)/g;
  let l;
  while ((l = patronLiteral.exec(contenido)) !== null) {
    partes.push(
      l[1]
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        // Octales: asi escapa PDFKit los acentos en WinAnsi.
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    );
  }

  // Sin separador: TJ parte una misma palabra en varios trozos para
  // ajustar el kerning ("Repor" + "te"), y meter espacios la romperia.
  return partes.join('');
}

/**
 * Comprueba el contenido de un PDF.
 *
 * `debeContener` no es opcional en la practica: es el control que
 * demuestra que el extractor funciona con ESTE archivo. Sin el, un
 * `noDebeContener` no prueba nada.
 */
function assertTextoDePdf(buffer, { debeContener = [], noDebeContener = [] }, assert) {
  assert.ok(buffer && buffer.length > 500, 'el PDF vino vacio o demasiado corto');
  assert.strictEqual(buffer.subarray(0, 4).toString(), '%PDF', 'no tiene cabecera de PDF');

  const texto = textoDePdf(buffer);

  for (const aguja of debeContener) {
    assert.ok(
      texto.includes(aguja),
      `el PDF deberia contener "${aguja}" y no aparece. ` +
      'Si el PDF es correcto, es el extractor el que falla, y entonces el ' +
      `resto de afirmaciones de esta prueba no valen. Texto extraido: ${texto.slice(0, 300)}`
    );
  }
  for (const aguja of noDebeContener) {
    assert.ok(!texto.includes(aguja), `el PDF NO deberia contener "${aguja}"`);
  }
  return texto;
}

module.exports = { textoDePdf, assertTextoDePdf };
