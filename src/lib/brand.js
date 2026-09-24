'use strict';

/**
 * Identidad corporativa GTC para los archivos que salen del sistema
 * (PDF y Excel). Un reporte que alguien reenvía por correo o imprime para
 * una reunión es la cara de la empresa: hasta ahora salían sin logo y sin
 * paleta, indistinguibles de una plantilla genérica.
 *
 * El logo es el MISMO archivo que usa el dashboard (public/img/logo_gtc.png),
 * no una copia: si algún día cambia la marca, se reemplaza una sola vez y
 * los reportes salen actualizados solos.
 */

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'img', 'logo_gtc.png');

// Proporción real del PNG (216x181). Se guarda aquí para poder calcular el
// ancho a partir del alto sin volver a leer la cabecera del archivo en cada
// reporte, y para que el logo nunca salga deformado.
const LOGO_RATIO = 216 / 181;

// Paleta oficial de marca — los mismos pasos que definen las cuatro
// familias en public/css/styles.css (:root). Los reportes deben verse como
// una extensión del dashboard, no como otra herramienta, asi que cuando
// cambie la paleta hay que mover LOS DOS lugares: aqui y ese :root.
const COLOR = {
  // El azul PRINCIPAL de la marca manda tambien en los reportes: banda de
  // encabezado, titulos de seccion y cabecera de las tablas. La clave se
  // sigue llamando navy porque esta usada en los tres generadores; lo que
  // cambio es a que color apunta.
  navy: '#25007A',      // Deep Blue 500 - PRINCIPAL
  navySoft: '#140043',  // Deep Blue 800 - para oscurecer sobre el principal
  // Aqua 700, no el 500 (#39D4CC): aqui el teal se usa como TINTA (texto de
  // pastilla a 6.4pt, titulos) y sobre papel blanco el 500 es ilegible. El
  // brillante se queda para la franja de acento bajo el encabezado oscuro,
  // que es relleno sobre fondo navy.
  teal: '#289791',      // Aqua 700
  tealBright: '#39D4CC',// Aqua 500
  lime: '#3D855E',      // Light Lime 800
  yellow: '#FFC107',    // estado: pendiente (fuera de la paleta a proposito)
  blueMid: '#25007A',   // Deep Blue 500 - primario
  purple: '#6D54A6',    // Deep Blue 300
  grey: '#F3F4FA',
  border: '#DCDCEA',
  text: '#0C113B',      // Navy 900
  muted: '#5F6690',
  white: '#FFFFFF',
};

// Mismos colores en el formato ARGB que pide exceljs (sin '#', con alfa FF).
const ARGB = Object.fromEntries(
  Object.entries(COLOR).map(([k, v]) => [k, 'FF' + v.replace('#', '').toUpperCase()])
);

// El archivo se lee una sola vez por proceso: son 5 KB, pero leerlo en cada
// descarga es I/O de disco dentro del request por gusto.
//
// Si el archivo no está (despliegue mal armado, alguien lo movió), NO se
// revienta la descarga: el reporte sale sin logo. Perder el logo es un
// detalle estético; perder el reporte que alguien necesita para una reunión
// no lo es. Queda en el log del servidor para que se note.
let logoCache;
function logoBuffer() {
  if (logoCache === undefined) {
    try {
      logoCache = fs.readFileSync(LOGO_PATH);
    } catch (err) {
      console.error(`[brand] no se pudo leer el logo (${LOGO_PATH}): ${err.message} — los reportes saldrán sin logo`);
      logoCache = null;
    }
  }
  return logoCache;
}

/**
 * Dibuja el logo en un PDF de pdfkit sobre una "pastilla" blanca.
 *
 * La pastilla no es decorativa: el logo es un PNG con fondo transparente y
 * las letras "GTC" son morado oscuro, así que puesto directo sobre la banda
 * azul del encabezado quedaría prácticamente invisible. El fondo blanco lo
 * despega de cualquier color de fondo.
 *
 * No hace nada si el logo no se pudo cargar (ver logoBuffer).
 */
function drawLogo(doc, x, y, alto) {
  const buf = logoBuffer();
  if (!buf) return 0;
  const ancho = alto * LOGO_RATIO;
  const pad = alto * 0.16;

  doc.save();
  doc.roundedRect(x - pad, y - pad, ancho + pad * 2, alto + pad * 2, 6)
    .fill(COLOR.white);
  doc.image(buf, x, y, { fit: [ancho, alto] });
  doc.restore();
  return ancho + pad * 2;
}

// El logo como data: URI, para PREVISUALIZAR un correo en el navegador. En el
// correo de verdad NO se usa esto: se manda adjunto con cid (ver
// scripts/enviar-alertas-email.js) porque Outlook y Gmail descartan las
// imagenes en data: URI. Devuelve null si el archivo no esta, y entonces el
// correo sale sin logo en vez de romperse.
function logoDataUri() {
  const buf = logoBuffer();
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

module.exports = { COLOR, ARGB, LOGO_RATIO, LOGO_PATH, logoBuffer, logoDataUri, drawLogo };
