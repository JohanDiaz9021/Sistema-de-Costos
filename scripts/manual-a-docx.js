'use strict';

/**
 * Convierte docs/n8n/MANUAL-TECNICO.md en un .docx que se abre en Word.
 *
 * Existe para que el Word NO sea una copia que se queda vieja: la fuente
 * sigue siendo el Markdown, que vive junto al código y viaja en el mismo
 * commit cuando alguien cambia un nodo. Cuando el manual cambie, se vuelve a
 * correr esto y listo.
 *
 *   node scripts/manual-a-docx.js
 *   node scripts/manual-a-docx.js docs/otro.md docs/otro.docx
 *
 * Un .docx es un ZIP con XML adentro (OOXML), y se arma a mano con jszip —
 * que ya está instalado porque lo usa exceljs. No se agregó una dependencia
 * nueva solo para esto.
 *
 * Deliberadamente NO incluye numbering.xml: las viñetas y los números se
 * escriben como texto ("•", "1.") con sangría. Word los muestra igual, y
 * evita toda una parte del paquete que, mal armada, hace que el archivo
 * abra corrupto. Lo que sí se conserva es la numeración exacta del Markdown,
 * que es lo que importa en una guía de pasos.
 *
 * Cubre lo que el manual usa de verdad: encabezados h1-h4, párrafos con
 * **negrita** y `código`, viñetas, listas numeradas, bloques de código
 * cercados, tablas, citas y reglas horizontales.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const RAIZ = path.join(__dirname, '..');
const ENTRADA = process.argv[2] || path.join(RAIZ, 'docs', 'n8n', 'MANUAL-TECNICO.md');
const SALIDA = process.argv[3] || ENTRADA.replace(/\.md$/i, '.docx');

// Ancho útil de una carta con márgenes de 1 pulgada, en twips (1/20 de punto).
const ANCHO_UTIL = 9360;

// Paleta de marca (src/lib/brand.js). El documento debe verse como una
// extensión del dashboard, no como una plantilla genérica de Word.
const AZUL = '25007A';      // Deep Blue 500
const AZUL_OSCURO = '140043';
const AQUA = '1F7A75';
const GRIS_TEXTO = '3B3660';
const FONDO_CODIGO = 'F2F0F8';
const LINEA = 'DAD5EC';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Texto en línea: **negrita** y `código`.
//
// Va con una máquina de estados y no con un regex de alternativas porque los
// dos se ANIDAN, y el manual lo hace todo el tiempo:
// "**El sandbox no tiene `TextEncoder`**". Con el regex, `[^*]+` se tragaba
// las comillas invertidas y quedaban impresas dentro de la negrita.
//
// Las comillas invertidas mandan sobre los asteriscos, igual que en Markdown:
// dentro de un `código con **asteriscos**` no hay negrita que valga.
// ---------------------------------------------------------------------------
function runsDeTexto(texto, base = {}) {
  const partes = [];
  let bold = false;
  let italic = false;
  let buffer = '';
  let i = 0;

  const volcar = () => {
    if (buffer) partes.push({ t: buffer, bold: bold || undefined, italic: italic || undefined, ...base });
    buffer = '';
  };

  while (i < texto.length) {
    if (texto[i] === '`') {
      const fin = texto.indexOf('`', i + 1);
      if (fin > i) {
        volcar();
        partes.push({ t: texto.slice(i + 1, fin), code: true, bold: bold || undefined, italic: italic || undefined, ...base });
        i = fin + 1;
        continue;
      }
    }
    if (texto[i] === '*' && texto[i + 1] === '*') {
      volcar();
      bold = !bold;
      i += 2;
      continue;
    }
    // Cursiva de un solo asterisco. Va DESPUÉS de la negrita, o "**" se
    // leería como dos cursivas seguidas. Solo cuenta cuando abre o cierra
    // pegado a texto, para no convertir en formato un asterisco que es
    // literal — p. ej. la ruta `wf-costeo/*.test.js`.
    if (texto[i] === '*') {
      const abre = !italic && /\S/.test(texto[i + 1] || '') && texto[i + 1] !== '*';
      const cierra = italic && /\S/.test(texto[i - 1] || '');
      if (abre || cierra) {
        volcar();
        italic = !italic;
        i += 1;
        continue;
      }
    }
    buffer += texto[i++];
  }
  volcar();
  if (!partes.length) partes.push({ t: '', ...base });

  return partes.map((p) => {
    const props = [];
    if (p.code) {
      props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      props.push('<w:sz w:val="18"/>');
      props.push(`<w:color w:val="${AZUL}"/>`);
      props.push(`<w:shd w:val="clear" w:fill="${FONDO_CODIGO}"/>`);
    }
    if (p.bold) props.push('<w:b/>');
    if (p.italic) props.push('<w:i/>');
    if (p.color) props.push(`<w:color w:val="${p.color}"/>`);
    if (p.sz) props.push(`<w:sz w:val="${p.sz}"/>`);
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    return `<w:r>${rPr}<w:t xml:space="preserve">${esc(p.t)}</w:t></w:r>`;
  }).join('');
}

function parrafo(texto, { estilo, sangria, espacioAntes, espacioDespues } = {}) {
  const pPr = [];
  if (estilo) pPr.push(`<w:pStyle w:val="${estilo}"/>`);
  if (sangria) pPr.push(`<w:ind w:left="${sangria}" w:hanging="220"/>`);
  if (espacioAntes != null || espacioDespues != null) {
    pPr.push(`<w:spacing${espacioAntes != null ? ` w:before="${espacioAntes}"` : ''}${espacioDespues != null ? ` w:after="${espacioDespues}"` : ''}/>`);
  }
  const props = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${props}${runsDeTexto(texto)}</w:p>`;
}

function lineaDeCodigo(texto) {
  // Sin runsDeTexto: dentro de un bloque de código los asteriscos y las
  // comillas invertidas son literales, no formato.
  return '<w:p><w:pPr><w:pStyle w:val="Codigo"/></w:pPr>'
    + `<w:r><w:t xml:space="preserve">${esc(texto) || ' '}</w:t></w:r></w:p>`;
}

function celda(texto, { ancho, encabezado }) {
  const sombra = encabezado ? `<w:shd w:val="clear" w:fill="${FONDO_CODIGO}"/>` : '';
  const contenido = encabezado
    ? `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${runsDeTexto(texto, { bold: true, color: AZUL_OSCURO })}</w:p>`
    : `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${runsDeTexto(texto)}</w:p>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${ancho}" w:type="dxa"/>${sombra}</w:tcPr>${contenido}</w:tc>`;
}

function tabla(filas) {
  const columnas = Math.max(...filas.map((f) => f.length));
  const ancho = Math.floor(ANCHO_UTIL / columnas);
  const bordes = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="${LINEA}"/>`)
    .join('');
  const grid = `<w:tblGrid>${Array.from({ length: columnas }, () => `<w:gridCol w:w="${ancho}"/>`).join('')}</w:tblGrid>`;

  const cuerpo = filas.map((fila, i) => {
    const celdas = Array.from({ length: columnas }, (_, c) => celda(fila[c] || '', { ancho, encabezado: i === 0 }));
    // repeatHeader: si la tabla parte de página, Word repite el encabezado.
    const trPr = i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${trPr}${celdas.join('')}</w:tr>`;
  }).join('');

  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>'
    + `<w:tblBorders>${bordes}</w:tblBorders>`
    + '<w:tblCellMar><w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>'
    + `</w:tblPr>${grid}${cuerpo}</w:tbl>`
    + '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>';
}

function separador() {
  return '<w:p><w:pPr><w:pBdr>'
    + `<w:bottom w:val="single" w:sz="6" w:space="6" w:color="${LINEA}"/>`
    + '</w:pBdr><w:spacing w:before="240" w:after="240"/></w:pPr></w:p>';
}

// ---------------------------------------------------------------------------
// Markdown -> cuerpo del documento
// ---------------------------------------------------------------------------
function convertir(md) {
  const lineas = md.split(/\r?\n/);
  const salida = [];
  let i = 0;

  const esFilaDeTabla = (l) => /^\s*\|.*\|\s*$/.test(l);
  const esSeparadorDeTabla = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const partirFila = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  while (i < lineas.length) {
    const linea = lineas[i];

    // Bloque de código cercado
    if (/^\s*```/.test(linea)) {
      i++;
      const dentro = [];
      while (i < lineas.length && !/^\s*```/.test(lineas[i])) dentro.push(lineas[i++]);
      i++; // cierre
      dentro.forEach((l) => salida.push(lineaDeCodigo(l)));
      salida.push('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>');
      continue;
    }

    // Tabla
    if (esFilaDeTabla(linea) && esSeparadorDeTabla(lineas[i + 1] || '')) {
      const filas = [partirFila(linea)];
      i += 2; // encabezado + separador
      while (i < lineas.length && esFilaDeTabla(lineas[i])) filas.push(partirFila(lineas[i++]));
      salida.push(tabla(filas));
      continue;
    }

    // Regla horizontal
    if (/^\s*---+\s*$/.test(linea)) { salida.push(separador()); i++; continue; }

    // Encabezados
    const h = linea.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      salida.push(parrafo(h[2], { estilo: `Titulo${h[1].length}` }));
      i++;
      continue;
    }

    // Cita
    if (/^\s*>\s?/.test(linea)) {
      const dentro = [];
      while (i < lineas.length && /^\s*>\s?/.test(lineas[i])) dentro.push(lineas[i++].replace(/^\s*>\s?/, ''));
      salida.push(parrafo(dentro.join(' ').trim(), { estilo: 'Cita' }));
      continue;
    }

    // Viñeta
    const vin = linea.match(/^(\s*)[-*]\s+(.*)$/);
    if (vin) {
      const nivel = Math.floor(vin[1].length / 2);
      salida.push(parrafo(`•  ${vin[2]}`, { sangria: 360 + nivel * 360, espacioDespues: 60 }));
      i++;
      continue;
    }

    // Lista numerada (se conserva el número del Markdown)
    const num = linea.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (num) {
      const nivel = Math.floor(num[1].length / 3);
      salida.push(parrafo(`${num[2]}.  ${num[3]}`, { sangria: 360 + nivel * 360, espacioDespues: 60 }));
      i++;
      continue;
    }

    // Línea en blanco
    if (!linea.trim()) { i++; continue; }

    // Párrafo: junta las líneas seguidas en uno solo, como hace Markdown.
    const bloque = [];
    while (
      i < lineas.length && lineas[i].trim()
      && !/^(#{1,4})\s/.test(lineas[i]) && !/^\s*```/.test(lineas[i])
      && !/^\s*>\s?/.test(lineas[i]) && !/^\s*[-*]\s/.test(lineas[i])
      && !/^\s*\d+\.\s/.test(lineas[i]) && !esFilaDeTabla(lineas[i])
      && !/^\s*---+\s*$/.test(lineas[i])
    ) bloque.push(lineas[i++]);
    salida.push(parrafo(bloque.join(' ')));
  }

  return salida.join('');
}

// ---------------------------------------------------------------------------
// Las partes del paquete
// ---------------------------------------------------------------------------
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function estilo(id, nombre, { sz, color, bold, antes, despues, fuente, sombra, bordeIzq, italic }) {
  const rPr = [
    fuente ? `<w:rFonts w:ascii="${fuente}" w:hAnsi="${fuente}"/>` : '',
    bold ? '<w:b/>' : '',
    italic ? '<w:i/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    sz ? `<w:sz w:val="${sz}"/>` : '',
    sombra ? `<w:shd w:val="clear" w:fill="${sombra}"/>` : '',
  ].join('');
  const pPr = [
    `<w:spacing w:before="${antes || 0}" w:after="${despues || 0}"/>`,
    sombra ? `<w:shd w:val="clear" w:fill="${sombra}"/>` : '',
    bordeIzq ? `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${bordeIzq}"/></w:pBdr><w:ind w:left="200"/>` : '',
  ].join('');
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${nombre}"/>`
    + `<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:color w:val="${GRIS_TEXTO}"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${estilo('Titulo1', 'heading 1', { sz: 48, color: AZUL_OSCURO, bold: true, antes: 0, despues: 200, fuente: 'Georgia' })}
${estilo('Titulo2', 'heading 2', { sz: 32, color: AZUL, bold: true, antes: 400, despues: 160, fuente: 'Georgia' })}
${estilo('Titulo3', 'heading 3', { sz: 26, color: AZUL_OSCURO, bold: true, antes: 300, despues: 120, fuente: 'Georgia' })}
${estilo('Titulo4', 'heading 4', { sz: 22, color: AQUA, bold: true, antes: 220, despues: 80 })}
${estilo('Codigo', 'Codigo', { sz: 18, color: AZUL_OSCURO, fuente: 'Consolas', antes: 0, despues: 0, sombra: FONDO_CODIGO })}
${estilo('Cita', 'Cita', { sz: 20, color: GRIS_TEXTO, italic: true, antes: 100, despues: 160, bordeIzq: AQUA })}
</w:styles>`;

function documento(cuerpo) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${cuerpo}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;
}

(async () => {
  const md = fs.readFileSync(ENTRADA, 'utf8');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  const word = zip.folder('word');
  word.file('document.xml', documento(convertir(md)));
  word.file('styles.xml', STYLES);
  word.folder('_rels').file('document.xml.rels', DOC_RELS);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(SALIDA, buf);
  console.log(`${path.relative(RAIZ, SALIDA)} — ${(buf.length / 1024).toFixed(1)} KB`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
