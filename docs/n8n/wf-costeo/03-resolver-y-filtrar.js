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
//        FROM mp_equipo_proyecto WHERE is_active = 1
//        (23 sep 2026 — ver EQUIPO OBLIGATORIO, más abajo)
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

const NOMBRE_NODO_FILAS = 'Parsear todos los archivos';
const NOMBRE_NODO_EMPLEADOS = 'Cargar empleados';
const NOMBRE_NODO_CENTROS = 'Cargar centros';
const NOMBRE_NODO_EQUIPO = 'Cargar equipo';

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
// ("2026_1143963601_CRISTINA_DEWOLFE.xlsx") se usa como segundo intento:
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
// Aplica a TODOS los proyectos, no solo a los 4 con módulo — es una regla
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

// ---- Subproyectos: "Algo (Proyecto)" ----
//
// La lista desplegable del Excel no trae solo proyectos: trae SUBPROYECTOS
// con el formato "Nombre (Proyecto)" — "Notificaciones (Transversales)",
// "Sueco eventos (Transversales)", "CRM (Transversales)". Ninguno es un
// centro de costos, así que sin esta regla se descartaban enteros: el 21
// sep 2026 una semana completa de trabajo real de una persona (ACT-114 a
// ACT-130, "Notificaciones (Transversales)") no llegó a Costeo.
//
// 23 sep 2026: SharePoint reorganizó el desplegable ENTERO en este formato.
// Antes se elegía el proyecto directo ("MIA", "Transversales"...); ahora
// trae 35 módulos repartidos en 4 proyectos (Transversales, Document
// Online, SESCOL, MIA) más "Management", que sigue siendo el único que se
// elige directo, sin módulo. La regla de abajo ya era genérica (lee lo que
// hay entre paréntesis, no una lista fija), así que cubrió los 35 módulos
// nuevos sin cambiar una línea — verificado contra los centros reales de
// la base y contra la lista completa en
// 03-resolver-y-filtrar.test.js ("los 35 módulos del desplegable nuevo...").
// Si SharePoint vuelve a reorganizar el desplegable, esa prueba es la que
// avisa qué módulo dejó de cuadrar.
//
// Esos mismos 4 proyectos (MIA, SESCOL, Document Online, Transversales)
// tienen ADEMÁS una regla propia, más abajo: no se aceptan "pelados"
// (requiereModulo). Es una regla SEPARADA del piso de agosto 2026 —el piso
// es universal y vive en "Resolver hoja del mes" (01b-resolver-hojas-
// meses.js), aplica a CUALQUIER proyecto por igual, Management incluido.
// Esta de aquí (requiereModulo) es la única que distingue por proyecto.
//
// Regla: si el nombre no es un centro pero lo de adentro del paréntesis
// sí, la fila va a ESE centro. El nombre del subproyecto no se pierde:
// queda al inicio de la actividad ("[Notificaciones] ACT-114 ...").
//
// EXCEPCIONES manda sobre la regla: sirve para mandar un subproyecto a un
// centro distinto del que dice su paréntesis. Clave = nombre tal cual en
// el Excel; valor = project_name EXACTO del centro de costos. Ejemplo:
//   'Sueco eventos (Transversales)': 'SUECO CRM',
const EXCEPCIONES = {
  // El centro se llama "Habilitadores" pero las fichas de la gente (y lo
  // que suelen escribir) dicen "Habilitador", en singular. "Habilitadores"
  // tampoco está en la lista desplegable del Excel (21 sep 2026).
  'Habilitador': 'Habilitadores',
};

const PATRON_SUBPROYECTO = /^(.+?)\s*\(([^()]+)\)\s*$/;

// ---- Proyectos que YA NO se pueden elegir "pelados" ----
//
// 23 sep 2026, decisión explícita del usuario: desde que SharePoint
// reorganizó el desplegable en módulos, estos 4 proyectos SOLO se ofrecen
// como "Módulo (Proyecto)" — "Gestion comercial (MIA)", "Administracion
// (Sescol)"... Una fila que diga "MIA" a secas hoy es un resto del
// desplegable viejo (¡hay ~10.000 horas así, hasta en septiembre!), y
// aceptarla mezclaría, bajo el mismo balde, horas que pasaron por el
// desplegable nuevo con horas que lo esquivaron.
//
// La decisión fue ENDURECER ya: estas horas se descartan (no se pierden en
// silencio — quedan anotadas como 'proyecto_requiere_modulo' en el resumen,
// ver el bucle principal más abajo) hasta que cada persona reescriba su
// Excel con el módulo correcto. Eso va a bajar de golpe las barras de estos
// 4 proyectos en la próxima corrida — es el efecto esperado, no un bug.
//
// "Management" NO está en esta lista a propósito: es el ÚNICO de los 5
// proyectos que el desplegable nuevo sigue ofreciendo directo, sin módulo.
const REQUIERE_MODULO = ['MIA', 'SESCOL', 'Document Online', 'Transversales'];
const REQUIERE_MODULO_NORMALIZADO = new Set(REQUIERE_MODULO.map(normalizarTexto));

function requiereModulo(centro) {
  return REQUIERE_MODULO_NORMALIZADO.has(normalizarTexto(centro.project_name));
}

// NOTA: el piso de agosto 2026 NO vive aquí. Es universal (aplica a
// CUALQUIER proyecto, Management y Sistema de Costos incluidos — 23 sep
// 2026, confirmado por el usuario: "tanto management y sistema de costo
// tambien se lee desde agosto"), así que se filtra ANTES, por pestaña
// completa, en "Resolver hoja del mes" (01b-resolver-hojas-meses.js,
// ANIO_MINIMO/MES_MINIMO). Cuando una fila llega hasta aquí, ya pasó ese
// filtro; este archivo solo decide A QUÉ CENTRO va y si le exige módulo.
//
// (Hubo un intento de poner el piso aquí, solo para los 4 de
// REQUIERE_MODULO — se revirtió el mismo día al confirmar que el piso es
// para todos, no solo para esos 4.)

/**
 * Centro al que va una fila según el "Proyecto" que trae el Excel.
 * Devuelve { centro, subproyecto } — subproyecto es null si el nombre ya
 * era un centro — o null si no hay a dónde mandarla (incluye el caso de un
 * proyecto de REQUIERE_MODULO elegido pelado: ver el comentario arriba).
 */
function centroParaProyecto(indiceCentros, nombreProyecto, excepciones = EXCEPCIONES) {
  const nombre = String(nombreProyecto ?? '').trim();
  if (!nombre) return null;

  const directo = indiceCentros.get(normalizarTexto(nombre));
  if (directo && !requiereModulo(directo)) return { centro: directo, subproyecto: null };

  const m = nombre.match(PATRON_SUBPROYECTO);
  const subproyecto = m ? m[1].trim() : null;

  // Las excepciones se comparan normalizadas, igual que todo lo demás:
  // "sueco eventos (transversales)" y "Sueco Eventos (Transversales)" son
  // la misma entrada.
  const excepcion = Object.entries(excepciones)
    .find(([clave]) => normalizarTexto(clave) === normalizarTexto(nombre));
  if (excepcion) {
    const destino = indiceCentros.get(normalizarTexto(excepcion[1]));
    return destino ? { centro: destino, subproyecto: subproyecto || nombre } : null;
  }

  if (!m) return null;
  const padre = indiceCentros.get(normalizarTexto(m[2]));
  return padre ? { centro: padre, subproyecto } : null;
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
const empleados = construirIndiceEmpleados($(NOMBRE_NODO_EMPLEADOS).all().map((i) => i.json));
const centros = construirIndiceCentros($(NOMBRE_NODO_CENTROS).all().map((i) => i.json));
const equipo = construirIndiceEquipo($(NOMBRE_NODO_EQUIPO).all().map((i) => i.json));

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
const itemsParseo = $(NOMBRE_NODO_FILAS).all().map((i) => i.json);
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
    // Dos motivos posibles, y se distinguen porque piden acciones distintas:
    //  - 'proyecto_requiere_modulo': el proyecto SI tiene centro, pero se
    //    eligió pelado ("MIA") cuando ahora exige módulo. Se corrige
    //    reescribiendo esa fila del Excel con el desplegable nuevo.
    //  - 'proyecto_sin_centro': proyecto de Planeación que de plano no
    //    tiene centro de costos (licitaciones, SIRUR, Infraestructura...).
    //    No es un error: Costeo no lo sigue.
    const centroSinModulo = centros.get(normalizarTexto(String(f.project_name ?? '').trim()));
    const motivo = centroSinModulo && requiereModulo(centroSinModulo)
      ? 'proyecto_requiere_modulo' : 'proyecto_sin_centro';
    anotarDescarte(motivo, f);
    continue;
  }
  const { centro, subproyecto } = destino;
  // El piso de agosto 2026 ya se aplicó antes de llegar aquí (por pestaña,
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
  // se lee — para NINGÚN proyecto, no solo los 4 con módulo. Ejemplo real:
  // Thomas Medina Trujillo reporta horas a "Sistema de costos" en su Excel,
  // pero solo Johan Sebastian Diaz Caicedo está en el Equipo de ese
  // proyecto, así que las de Thomas ahí se descartan.
  if (!estaEnElEquipo(equipo, emp.employee_id, centro.cost_center_id)) {
    anotarDescarte('empleado_no_registrado_en_equipo', f);
    continue;
  }

  if (subproyecto) {
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
      // Un subproyecto se guarda con el nombre DEL CENTRO: el motor cobra
      // las horas cruzando project_name contra el centro (costo-motor.js),
      // así que "Notificaciones (Transversales)" tal cual no lo cobraría
      // nadie. El subproyecto se conserva al inicio de la actividad.
      project_name: subproyecto ? centro.project_name : f.project_name,
      week_number: f.week_number,
      activity: subproyecto ? `[${subproyecto}] ${f.activity || ''}`.trim() : f.activity,
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
    // Para revisar de un vistazo que cada subproyecto cayó donde debía.
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
