'use strict';

/**
 * Configuracion de ESLint (formato "flat config", ESLint 9+).
 *
 * Para activarlo:  npm i -D eslint     y luego  npm run lint
 *
 * Las reglas estan puestas al minimo a proposito: el objetivo NO es
 * reformatear un proyecto que ya funciona, sino atrapar la clase de error
 * que se cuela sola — una variable que no existe (typo en un nombre de
 * campo), una promesa sin await, un case sin break. Si se arranca con un
 * preset estricto, salen cientos de avisos de estilo, nadie los mira y el
 * linter deja de servir. Se puede ir apretando despues.
 */

/**
 * Los archivos de public/js son <script> clasicos, no modulos: TODA
 * declaracion de nivel superior (function, const, let) queda compartida
 * entre ellos, igual que en el navegador. ESLint no tiene forma de saberlo
 * y marcaria cada referencia entre archivos como 'no definido'.
 *
 * En vez de mantener a mano una lista de 60+ nombres (que se desactualiza
 * al primer cambio), se derivan de los propios archivos. El efecto es el
 * mismo que tiene el navegador al cargarlos en orden, y no-undef sigue
 * sirviendo para lo que importa: detectar un nombre que no existe en
 * NINGUN archivo, o sea un typo.
 */
function globalesCompartidasDelFront() {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, 'public', 'js');
  const globales = {};
  for (const archivo of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, archivo), 'utf8');
    // Solo declaraciones que empiezan en la columna 0: las de nivel
    // superior. Lo que esta indentado vive dentro de una funcion y no se
    // comparte.
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
      globales[m[1]] = 'readonly';
    }
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      globales[m[1]] = 'writable';
    }
  }
  return globales;
}

module.exports = [
  {
    // Entrada suelta (sin `files`): asi ignora de verdad. Dentro de un bloque
    // con `files`, `ignores` solo excluye de ese bloque.
    //
    // docs/n8n-*.js no son modulos: son fragmentos que se pegan dentro de un
    // nodo de n8n, que los envuelve en una funcion. Por eso tienen `return`
    // en el nivel superior y no parsean como archivo suelto.
    ignores: ['node_modules/**', 'backups/**', 'docs/n8n-*.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', __dirname: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', clearTimeout: 'readonly',
        setImmediate: 'readonly', URL: 'readonly',
        // Globales estandar desde Node 18/20 (el package.json ya pide >=20).
        URLSearchParams: 'readonly', fetch: 'readonly',
        AbortController: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      // Un identificador que no existe casi siempre es un typo en un nombre
      // de columna o de funcion, y en JavaScript solo se descubre en runtime.
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Una promesa sin await dentro de un try/catch se sale del catch: el
      // error se vuelve un unhandled rejection y tumba el proceso.
      'require-atomic-updates': 'warn',
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // El front son <script> clasicos: otros globales, y las funciones se
    // comparten entre archivos via window.
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', fetch: 'readonly',
        localStorage: 'readonly', location: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', alert: 'readonly',
        confirm: 'readonly', prompt: 'readonly', FormData: 'readonly',
        Node: 'readonly', CustomEvent: 'readonly', Event: 'readonly',
        MutationObserver: 'readonly', ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        URLSearchParams: 'readonly', navigator: 'readonly',
        echarts: 'readonly', module: 'writable',
        // Todas las funciones y constantes de nivel superior de public/js:
        // en <script> clasicos se comparten entre archivos.
        ...globalesCompartidasDelFront(),
      },
    },
    rules: { 'no-unused-vars': 'off' },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly',
        console: 'readonly', setTimeout: 'readonly', setImmediate: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', Buffer: 'readonly', __dirname: 'readonly',
        URLSearchParams: 'readonly', FormData: 'readonly',
      },
    },
  },
  {
    // Las pruebas e2e mezclan DOS entornos en el mismo archivo: el codigo
    // de node:test corre en Node, pero lo que va dentro de
    // `pagina.evaluate(...)` se serializa y se ejecuta EN EL NAVEGADOR,
    // donde `document` y `window` si existen. ESLint no distingue los dos
    // ambitos, asi que hay que declararle los globales del navegador
    // tambien aqui.
    files: ['test/e2e/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', localStorage: 'readonly',
      },
    },
  },
  {
    // Nodos de n8n (docs/n8n/**): NO son modulos de Node. Se pegan dentro
    // de un nodo Code y n8n los envuelve en una funcion, inyectandoles sus
    // propias globales ($, $input, $getWorkflowStaticData...).
    //
    // Se lintean igual — no se ignoran — porque aqui `no-undef` es de lo
    // MAS util del proyecto: cada vez que una de estas funciones se llamo
    // con un nombre que no existia, el flujo se rompio en produccion y
    // costo una corrida entera encontrarlo. Lo unico que hace falta es
    // declararle a ESLint el entorno en el que ese codigo corre de verdad.
    //
    // Antes vivian sueltos en docs/n8n-*.js, y la regla `ignores` de arriba
    // los tapaba. Al mudarlos a docs/n8n/wf-costeo/ dejaron de coincidir
    // con ese patron y aparecieron 20 errores de golpe.
    //
    // Los *.test.js de esa misma carpeta NO entran aqui: son pruebas de
    // Node normales (cargan el archivo con new Function) y les aplican las
    // reglas de test/ de arriba.
    files: ['docs/n8n/**/*.js'],
    ignores: ['docs/n8n/**/*.test.js'],
    languageOptions: {
      globals: {
        // Lo que n8n pone en el ambito de un nodo Code.
        $: 'readonly',
        $input: 'readonly',
        $json: 'readonly',
        $getWorkflowStaticData: 'readonly',
        $now: 'readonly',
        $workflow: 'readonly',
        $execution: 'readonly',
      },
    },
    rules: {
      // El `module.exports` del final va DESPUES del `return` a proposito:
      // dentro de n8n nunca se alcanza (y no estorba), pero las pruebas
      // locales cortan el archivo en el marcador de ejecucion y se quedan
      // solo con la parte de arriba. Es la forma de probar estas funciones
      // sin un n8n corriendo.
      'no-unreachable': 'off',
    },
  },
];
