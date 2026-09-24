'use strict';

/**
 * Cierre de sesiones de un usuario concreto.
 *
 * Por qué existe: requireAuth (src/middleware/auth.js) solo mira si hay
 * sesión — nunca revalida contra la base. Así que desactivar a alguien en
 * Accesos no le cortaba el acceso: seguía trabajando con sus permisos hasta
 * que caducara la cookie, 8 horas después, aunque cerrara el navegador.
 *
 * Importa más desde que las sesiones viven en disco (ver session() en
 * server.js). Antes, reconstruir el contenedor las borraba todas y eso
 * funcionaba como interruptor de emergencia por accidente. Al hacerlas
 * sobrevivir a los despliegues, esa protección se perdió; esto la devuelve,
 * pero a propósito.
 *
 * Se revoca en el MOMENTO de la acción administrativa y no revalidando en
 * cada petición: lo segundo añadiría ~100 ms por clic contra la base remota
 * (medidos), el mismo error que se evitó al elegir el store en archivo.
 *
 * Nada de esto es una barrera de seguridad por sí solo: si falla, el sistema
 * queda como estaba (la sesión sobrevive hasta caducar), nunca deja a nadie
 * fuera por error. Por eso los errores se registran y no se propagan: que
 * falle el borrado de un archivo no puede tumbar la desactivación de una
 * cuenta, que es la operación que el usuario pidió.
 */

const fs = require('fs/promises');
const path = require('path');

// El MISMO directorio que configura server.js. Si se separaran, esto
// borraría en una carpeta vacía y no se notaría: la desactivación
// respondería "listo" sin cerrar ninguna sesión.
function directorioDeSesiones() {
  return process.env.SESSION_DIR || path.join(__dirname, '..', '..', '.sesiones');
}

/**
 * Cierra todas las sesiones abiertas de un usuario. Devuelve cuántas cerró.
 *
 * Recorre los archivos del store porque no hay índice por usuario: el nombre
 * del archivo es el id de sesión, y de quién es solo se sabe abriéndolo. Con
 * 8 usuarios son un puñado de archivos; si algún día fueran miles, esto pide
 * un store con índice (Redis o base) en vez de un bucle.
 */
async function cerrarSesionesDe(userId) {
  const dir = directorioDeSesiones();
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return 0;

  let archivos;
  try {
    archivos = await fs.readdir(dir);
  } catch (err) {
    // El directorio no existe todavía (nadie ha entrado desde el último
    // despliegue): no hay sesiones que cerrar, no es un error.
    if (err.code === 'ENOENT') return 0;
    console.error('[sesiones] no se pudo leer el directorio de sesiones:', err.message);
    return 0;
  }

  let cerradas = 0;
  for (const archivo of archivos) {
    if (!archivo.endsWith('.json')) continue;
    const ruta = path.join(dir, archivo);
    try {
      const sesion = JSON.parse(await fs.readFile(ruta, 'utf8'));
      if (Number(sesion?.user?.user_id) !== id) continue;
      await fs.unlink(ruta);
      cerradas += 1;
    } catch (err) {
      // Un archivo ilegible (a medio escribir, o ya borrado por el barrido
      // de caducadas que corre en paralelo) se salta: no es de este usuario
      // o ya no existe, y en ninguno de los dos casos hay nada que hacer.
      if (err.code !== 'ENOENT') {
        console.error(`[sesiones] no se pudo revisar ${archivo}:`, err.message);
      }
    }
  }
  return cerradas;
}

module.exports = { cerrarSesionesDe, directorioDeSesiones };
