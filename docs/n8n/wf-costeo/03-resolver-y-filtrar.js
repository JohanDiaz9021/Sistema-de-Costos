// ============================================================
//  WF-COSTEO — Nodo "Resolver y filtrar" (n8n, tipo Code)
// ------------------------------------------------------------
//  Decide, para cada fila parseada, DE QUIEN es y A QUE CENTRO va.
//  Lo que no resuelve NO rompe la corrida: se marca y sigue.
//
//  Criterio acordado (21 sep 2026): primero automatizar. Falta gente por
//  dar de alta, asi que una persona sin ficha no puede frenar la carga de
//  los demas — se salta, queda anotada en `descartes` y se revisa despues.
//
//  ENTRADA (se leen por NOMBRE de nodo, no del nodo anterior)
//    - "Parsear todos los archivos": las filas de tareas parseadas.
//    - "Cargar empleados": SELECT employee_id, canonical_name, aliases,
//        project_folder, is_active FROM mp_employees
//    - "Cargar centros": SELECT cost_center_id, project_name,
//        project_folder FROM mp_centro_costo
//    - "Cargar equipo": SELECT employee_id, cost_center_id
//        FROM mp_equipo_proyecto
//        (23 sep 2026 — ver EQUIPO OBLIGATORIO, más abajo). Desde el 10 nov
//        2026 SIN "WHERE is_active = 1": a quien se inactiva se le siguen
//        leyendo las horas, porque son costo pagado del proyecto. Con el
//        filtro, la siguiente corrida le BORRABA las horas de ese proyecto
//        (el Excel leído reemplaza todo lo de la persona).
//
//  Se leen por nombre porque el nodo que va justo antes es "Cargar
//  centros" (un MySQL con "Execute Once"), no las filas: si se usara
//  $input se recibirian los centros en lugar de las tareas.
//
//  No se reusa "Cargar catálogo empleados (early)" del WF1 porque no trae
//  project_folder, y hace falta (ver la salida, mas abajo).
//
//  SALIDA
//    Un item por fila lista para insertar (con employee_id y project_folder
//    del centro), mas un item final `{ resumen: true, descartes: [...] }`
//    que el nodo siguiente usa para el aviso.
// ============================================================

// Cada nodo se busca por su nombre, y se aceptan las variantes que n8n le
// pone al copiar nodos entre workflows ("Parsear todos los archivos1"). En
// el lienzo real (6 nov 2026) el de las filas se llama así, con el 1, y los
// otros tres sin número. Se prueba cada nombre en orden y gana el primero
// que exista; si no existe ninguno, el error dice cuáles se buscaron.
const NOMBRE_NODO_FILAS = ['Parsear todos los archivos', 'Parsear todos los archivos1', 'Parsear todos los archivos2'];
const NOMBRE_NODO_EMPLEADOS = ['Cargar empleados', 'Cargar empleados1'];
const NOMBRE_NODO_CENTROS = ['Cargar centros', 'Cargar centros1'];
const NOMBRE_NODO_EQUIPO = ['Cargar equipo', 'Cargar equipo1'];

function itemsDelNodo(nombres) {
  for (const nombre of nombres) {
    let items;
    try {
      items = $(nombre).all();
    } catch {
      continue;
    }
    return items;
  }
  throw new Error(`No se encontró ninguno de estos nodos: ${nombres.map((n) => `"${n}"`).join(', ')}. Revisa el nombre del nodo en el lienzo.`);
}

// Misma normalizacion que usa la carga manual para comparar nombres de
// proyecto: sin tildes, sin espacios, sin signos, en minusculas. Asi
// "Sistema de costos" y "SISTEMA DE COSTOS" son el mismo, y "Cristina
// DeWolfe" cuadra con "Cristina De Wolfe".
function normalizarTexto(v) {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

// ---- Catalogo de empleados: canonical_name + aliases -> employee_id ----
//
// `aliases` viene como texto separado por comas ("Cristina DeWolfe,Cristina
// De Wolfe,..."). Se indexan TODAS las variantes porque el nombre de la
// carpeta de SharePoint casi nunca es el canonico.
//
// Los inactivos se indexan igual, pero se marcan: sus horas historicas son
// validas y no deben perderse solo porque la persona ya no este.
function construirIndiceEmpleados(filas) {
  const porNombre = new Map();
  // Activos primero: si un alias lo comparten una ficha vieja y una
  // vigente, gana la vigente. No se confía en el ORDER BY de la consulta
  // porque el nodo de empleados se heredó del WF1 y su SQL no es nuestro.
  const ordenadas = [...filas].sort((a, b) => Number(b.is_active || 0) - Number(a.is_active || 0));
  for (const e of ordenadas) {
    const variantes = [e.canonical_name, ...String(e.aliases || '').split(',')];
    for (const v of variantes) {
      const clave = normalizarTexto(v);
      if (!clave) continue;
      // El primero gana (ver el orden de arriba).
      if (!porNombre.has(clave)) {
        porNombre.set(clave, {
          employee_id: e.employee_id,
          canonical_name: e.canonical_name,
          project_folder: e.project_folder || null,
          is_active: e.is_active,
        });
      }
    }
  }
  return porNombre;
}

// El nombre de la CARPETA es el identificador de la persona. El del archivo
// ("2026_9876543210_CRISTINA_DEWOLFE.xlsx") se usa como segundo intento:
// se le quita el año y la cedula y se juntan las palabras que quedan.
function nombresCandidatos(item) {
  const cand = [];
  if (item.persona) cand.push(item.persona);
  if (item.archivo) {
    const base = String(item.archivo).replace(/\.xlsx?$/i, '');
    const partes = base.split('_').filter((p) => p && !/^\d+$/.test(p));
    if (partes.length) cand.push(partes.join(' '));
  }
  return cand;
}

function resolverEmpleado(indice, item) {
  for (const nombre of nombresCandidatos(item)) {
    const hit = indice.get(normalizarTexto(nombre));
    if (hit) return hit;
  }
  return null;
}

// ---- Centros: solo entra lo que Costeo sabe costear ----
//
// Mismo criterio que la carga manual (filtrarPorCentro): vale contra
// project_name o contra project_folder, porque el Excel unas veces escribe
// uno y otras el otro ("Sistema de costos" -> carpeta "sistema-de-costos").
// Si aqui se filtrara distinto a como despues se cobran las horas, se
// guardarian filas que nadie cobra, o al reves.
function construirIndiceCentros(filas) {
  const porNombre = new Map();
  for (const c of filas) {
    for (const v of [c.project_name, c.project_folder]) {
      const clave = normalizarTexto(v);
      if (clave && !porNombre.has(clave)) porNombre.set(clave, c);
    }
  }
  return porNombre;
}

// ---- Equipo del Proyecto: solo se lee a quien está registrado ----
//
// 23 sep 2026, decisión explícita del usuario, con ejemplo concreto: en
// Sistema de costos solo está registrado Johan Sebastian Diaz Caicedo —
// aunque Thomas Medina Trujillo TAMBIÉN reporte horas a Sistema de costos
// en su Excel, esas horas no se leen porque él no está en el Equipo de
// ESE proyecto. En Management hay varias personas registradas y a todas
// se les lee, porque todas están en su Equipo.
//
// Aplica a TODOS los proyectos por igual — es una regla
// aparte, más estricta que la que ya existía. Es DISTINTA de lo que hace
// el motor de costos (costo-motor.js): allí no estar en el Equipo significa
// "cuesta $0" pero la hora igual se ve en la barra (LEFT JOIN). Aquí la
// fila directamente no entra: ni horas ni plata, para ningún proyecto.
//
// Se compara por (employee_id, cost_center_id) — el mismo par que usa
// mp_equipo_proyecto — no por nombre, para no heredar los problemas de
// tildes/mayúsculas que sí aplican a texto libre.
function construirIndiceEquipo(filas) {
  const set = new Set();
  for (const r of filas) set.add(`${r.employee_id}::${r.cost_center_id}`);
  return set;
}

function estaEnElEquipo(indiceEquipo, employeeId, costCenterId) {
  return indiceEquipo.has(`${employeeId}::${costCenterId}`);
}

// ---- Subproyectos: "Nombre (Agrupador)" ----
//
// La lista desplegable "Proyecto" del Excel trae los SUBPROYECTOS con el
// formato "Nombre (Agrupador)": "Notificaciones (Transversales)",
// "Colaboradores y terceros (Transversales)", "Compras (MIA)", "Basica
// (Sescol)"... y algunos sin paréntesis ("Management", "CRM", "Digno").
//
// 6 nov 2026, decisión explícita del usuario: CADA SUBPROYECTO ES SU PROPIO
// CENTRO DE COSTOS, con su propio presupuesto. Lo que va entre paréntesis
// es solo una ayuda visual para los PM en la planeación y se IGNORA: la
// fila va al centro que se llama como el nombre de afuera.
//
//   "Notificaciones (Transversales)"            -> centro "Notificaciones"
//   "Colaboradores y terceros (Transversales)"  -> centro "Colaboradores y Terceros"
//   "Contratación(MIA)"  (sin espacio)          -> centro "Contratación"
//
// ANTES (21 sep - 6 nov 2026) era al revés: la fila iba al centro de lo de
// ADENTRO del paréntesis ("Transversales", "MIA"...), y "MIA" / "SESCOL" /
// "Document Online" / "Transversales" a secas se rechazaban por "requerir
// módulo". Esos centros padre ya no existen, así que desde ahí ninguna fila
// con paréntesis encontraba centro y Costeo quedó sin horas. Las dos reglas
// viejas se retiraron.
//
// Orden de búsqueda:
//   1. El nombre COMPLETO, tal cual (con paréntesis incluido). Sirve para
//      "Management", "CRM", y para un centro cuya carpeta se llame
//      literalmente "CRM (Transversales)". También es la salida si algún
//      día dos agrupadores tienen un subproyecto con el mismo nombre: se
//      crea el centro con el nombre completo y gana este paso.
//   2. EXCEPCIONES (abajo), por nombre completo o por el nombre de afuera.
//   3. El nombre de AFUERA del paréntesis.
// Si nada cuadra, la fila se descarta como 'proyecto_sin_centro' (queda en
// el resumen con el nombre del Excel: basta crear ese centro en Costeo).
//
// EXCEPCIONES: para mandar un nombre del Excel a un centro que se llama
// distinto. Clave = nombre en el Excel (completo o el de afuera del
// paréntesis); valor = project_name EXACTO del centro de costos.
const EXCEPCIONES = {
  // El centro se llama "Habilitadores" pero las fichas de la gente (y lo
  // que suelen escribir) dicen "Habilitador", en singular. "Habilitadores"
  // tampoco está en la lista desplegable del Excel (21 sep 2026).
  'Habilitador': 'Habilitadores',
};

const PATRON_SUBPROYECTO = /^(.+?)\s*\(([^()]*)\)\s*$/;

// NOTA: el piso de meses (septiembre 2026) NO vive aquí. Es universal (aplica a
// CUALQUIER proyecto), así que se filtra ANTES, por pestaña completa, en
// "Resolver hoja del mes" (01b-resolver-hojas-meses.js, ANIO_MINIMO/
// MES_MINIMO). Cuando una fila llega hasta aquí, ya pasó ese filtro; este
// archivo solo decide A QUÉ CENTRO va.

/**
 * Centro al que va una fila según el "Proyecto" que trae el Excel.
 * Devuelve { centro, agrupador } — agrupador es lo que venía entre
 * paréntesis (solo informativo, para el resumen), o null — o null si no hay
 * centro para esa fila.
 */
function centroParaProyecto(indiceCentros, nombreProyecto, excepciones = EXCEPCIONES) {
  const nombre = String(nombreProyecto ?? '').trim();
  if (!nombre) return null;

  const m = nombre.match(PATRON_SUBPROYECTO);
  const afuera = m ? m[1].trim() : nombre;
  const agrupador = m && m[2].trim() ? m[2].trim() : null;

  // 1. Nombre completo, tal cual.
  const directo = indiceCentros.get(normalizarTexto(nombre));
  if (directo) return { centro: directo, agrupador };

  // 2. Excepciones (normalizadas, igual que todo lo demás).
  const excepcion = Object.entries(excepciones).find(([clave]) => {
    const c = normalizarTexto(clave);
    return c === normalizarTexto(nombre) || c === normalizarTexto(afuera);
  });
  if (excepcion) {
    const destino = indiceCentros.get(normalizarTexto(excepcion[1]));
    return destino ? { centro: destino, agrupador } : null;
  }

  // 3. El nombre de afuera del paréntesis.
  if (!m || !afuera) return null;
  const centro = indiceCentros.get(normalizarTexto(afuera));
  return centro ? { centro, agrupador } : null;
}

// ---- A quién se le leyó el Excel COMPLETO ----
//
// 22 sep 2026, reportado por el usuario: quitó de su Excel todas las horas
// de GTC Project, volvió a correr el flujo, y GTC Project siguió en 5%. El
// reemplazo era por pareja (persona, proyecto): si la corrida nueva ya no
// traía NINGUNA fila de esa pareja, no había nada que dispare su borrado y
// las filas de la corrida anterior seguían contando.
//
// La regla correcta: el Excel leído es la verdad COMPLETA de esa persona.
// Si su archivo se leyó entero, "Construir SQL" le reemplaza TODO lo del
// día, en todos los proyectos — lo que quitó del Excel desaparece.
//
// "Entero" importa: si una hoja de su archivo falló en Graph (archivo
// abierto, throttling), reemplazarle todo le borraría ese mes. A esas
// personas no se les toca nada en esta corrida (ver el bucle de abajo).
//
// Se clasifican TODAS las filas parseadas, incluso las que después se
// descartan por proyecto sin centro: alguien que dejó de reportar a
// cualquier proyecto con centro también tiene que quedar en cero.
function clasificarEmpleadosLeidos(filas, indiceEmpleados, archivosConError) {
  const completos = new Set();
  const incompletos = new Set();
  for (const f of filas) {
    const emp = resolverEmpleado(indiceEmpleados, f);
    if (!emp) continue;
    if (archivosConError.has(f.archivo)) incompletos.add(emp.employee_id);
    else completos.add(emp.employee_id);
  }
  // Con un archivo malo basta: si la persona tuviera dos archivos y uno
  // falló, no está completa.
  for (const id of incompletos) completos.delete(id);
  return { completos: [...completos], incompletos: [...incompletos] };
}

// ---- Ejecucion ----
const empleados = construirIndiceEmpleados(itemsDelNodo(NOMBRE_NODO_EMPLEADOS).map((i) => i.json));
const centros = construirIndiceCentros(itemsDelNodo(NOMBRE_NODO_CENTROS).map((i) => i.json));
const equipo = construirIndiceEquipo(itemsDelNodo(NOMBRE_NODO_EQUIPO).map((i) => i.json));

const salida = [];
const descartes = []; // { motivo, persona, proyecto, archivo, filas }
const reasignados = new Map(); // subproyecto del Excel -> a qué centro se mandó

// Se agrupa el conteo de descartes para no escupir una linea por fila: lo
// util es "a Fulano no se le pudo cargar nada", no 90 avisos iguales.
function anotarDescarte(motivo, item) {
  const clave = `${motivo}|${item.persona || ''}|${item.project_name || ''}`;
  const previo = descartes.find((d) => d.clave === clave);
  if (previo) { previo.filas += 1; return; }
  descartes.push({
    clave,
    motivo,
    persona: item.persona || null,
    archivo: item.archivo || null,
    proyecto: item.project_name || null,
    filas: 1,
  });
}

// El último item de "Parsear" no es una fila: trae los archivos con hojas
// que fallaron (ver 02-parsear-hojas.js).
const itemsParseo = itemsDelNodo(NOMBRE_NODO_FILAS).map((i) => i.json);
const resumenParseo = itemsParseo.find((j) => j.resumen_parseo) || {};
const filasParseadas = itemsParseo.filter((j) => !j.resumen_parseo);
const leidos = clasificarEmpleadosLeidos(
  filasParseadas, empleados, new Set(resumenParseo.archivos_con_error || [])
);

// A quien se le leyó el archivo a medias (alguna hoja no llegó) NO se le
// toca nada en esta corrida: ni se le borra ni se le escribe, y conserva lo
// de la corrida anterior hasta que una corrida lo lea entero.
//
// 22 sep 2026: la hoja de Agosto de una persona no llegó en una corrida y
// sí en la siguiente, 7 minutos después. En esos 7 minutos esa persona
// perdió TODO agosto en Costeo, también en proyectos que nunca tocó: el
// flujo le reemplazó lo suyo con lo que alcanzó a leer. En la corrida
// automática de las 7 a.m. eso duraría hasta el día siguiente.
const incompletos = new Set(leidos.incompletos);

for (const f of filasParseadas) {
  const empFila = resolverEmpleado(empleados, f);
  if (empFila && incompletos.has(empFila.employee_id)) {
    anotarDescarte('archivo_incompleto_se_conserva_lo_anterior', f);
    continue;
  }

  const destino = centroParaProyecto(centros, f.project_name);
  if (!destino) {
    // Proyecto del Excel sin centro de costos: o Costeo no lo sigue
    // (licitaciones, SIRUR, Infraestructura...) o falta crear ese centro.
    anotarDescarte('proyecto_sin_centro', f);
    continue;
  }
  const { centro } = destino;
  // El piso de meses (septiembre 2026) ya se aplicó antes de llegar aquí (por pestaña,
  // en "Resolver hoja del mes"): si esta fila existe, su mes ya pasó ese
  // filtro. Nada que revisar por fecha en este archivo.

  const emp = empFila;
  if (!emp) {
    // Persona sin ficha en mp_employees, o con la carpeta escrita distinto
    // a su nombre y sin alias que lo cubra. Se revisa despues.
    anotarDescarte('empleado_no_encontrado', f);
    continue;
  }

  // EQUIPO OBLIGATORIO (23 sep 2026): la persona resolvió a un proyecto real
  // y tiene ficha, pero si no está en el Equipo de ESE proyecto, su hora no
  // se lee — para NINGÚN proyecto. Ejemplo real:
  // Thomas Medina Trujillo reporta horas a "Sistema de costos" en su Excel,
  // pero solo Johan Sebastian Diaz Caicedo está en el Equipo de ese
  // proyecto, así que las de Thomas ahí se descartan.
  if (!estaEnElEquipo(equipo, emp.employee_id, centro.cost_center_id)) {
    anotarDescarte('empleado_no_registrado_en_equipo', f);
    continue;
  }

  // Para el resumen: qué nombre del Excel cayó en qué centro, cuando no es
  // exactamente el mismo texto (paréntesis, mayúsculas, excepciones).
  if (f.project_name !== centro.project_name) {
    reasignados.set(f.project_name, {
      proyecto_excel: f.project_name,
      centro: centro.project_name,
      filas: (reasignados.get(f.project_name)?.filas || 0) + 1,
    });
  }

  salida.push({
    json: {
      employee_id: emp.employee_id,
      empleado: emp.canonical_name,
      cost_center_id: centro.cost_center_id,
      // project_folder es la carpeta de la PERSONA (su ficha), no la del
      // centro — igual que la carga manual (guardarHorasDesdeExcel guarda
      // empleado.project_folder). El costo NO depende de esto (se cobra por
      // project_name), pero Horas Semanales de Costeo filtra por esta
      // columna lo que ve cada PM: cambiarla le quitaria horas de su vista.
      project_folder: emp.project_folder || centro.project_folder,
      // Siempre con el nombre DEL CENTRO: el motor cobra las horas cruzando
      // project_name contra el centro (costo-motor.js), así que
      // "Notificaciones (Transversales)" tal cual no lo cobraría nadie.
      project_name: centro.project_name,
      week_number: f.week_number,
      activity: f.activity,
      planned_type: f.planned_type,
      budgeted_hours: f.budgeted_hours,
      estimated_delivery_date: f.estimated_delivery_date,
      actual_delivery_date: f.actual_delivery_date,
      hours_monday: f.hours_monday,
      hours_tuesday: f.hours_tuesday,
      hours_wednesday: f.hours_wednesday,
      hours_thursday: f.hours_thursday,
      hours_friday: f.hours_friday,
      hours_saturday: f.hours_saturday,
      total_executed_hours: f.total_executed_hours,
      task_status: f.task_status,
      observations: f.observations,
      month_number: f.month_number,
      year_number: f.year_number,
      hoja: f.hoja,
      archivo: f.archivo,
    },
  });
}

salida.push({
  json: {
    resumen: true,
    filas_listas: salida.length,
    // Para revisar de un vistazo que cada nombre del Excel cayó donde debía.
    subproyectos_reasignados: [...reasignados.values()],
    // "Construir SQL" le reemplaza TODO lo del día a los completos; a los
    // incompletos (alguna hoja falló) no se les toca nada: sus filas ni
    // siquiera salen de este nodo, y conservan lo de la corrida anterior.
    empleados_completos: leidos.completos,
    empleados_incompletos: leidos.incompletos,
    descartes: descartes.map(({ clave, ...d }) => d),
  },
});

return salida;

// Exportado solo para la prueba local (03-resolver-y-filtrar.test.js).
module.exports = {
  normalizarTexto, construirIndiceEmpleados, construirIndiceCentros,
  nombresCandidatos, resolverEmpleado, centroParaProyecto, clasificarEmpleadosLeidos,
};
