/* ====== Sistema de tooltips de predominancia (textos LITERALES de la especificacion) ======
 * Cada indicador tiene su frecuencia (DIARIO/SEMANAL/MENSUAL), un texto explicativo,
 * la formula con que se calcula y, cuando aplica, una advertencia de lectura.
 * El popover se ancla al boton "i" al hacer click. Se cierra al hacer click fuera o pulsar Esc.
 */
(function () {
  'use strict';

  const TIPS = {
    1:  { title: '% Cumplimiento semanal',                       freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. Mide las horas ejecutadas frente a las presupuestadas de cada semana.',
          formula: 'Por cada semana del mes:\n  SUM(total_executed_hours) ÷ SUM(budgeted_hours) × 100\nMeta = 100 % (línea horizontal en el gráfico).',
          warn: 'A mitad de semana se verá bajo porque las tareas aún están en progreso; se completa al cerrar la semana.' },
    2:  { title: '% Entrega a tiempo',                            freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. De las tareas terminadas, qué porcentaje se entregó en o antes de la fecha estimada.',
          formula: 'COUNT(task_status = "Terminado"\n  AND actual_delivery_date ≤ estimated_delivery_date)\n÷ COUNT(task_status = "Terminado" con fecha real) × 100',
          warn: 'Solo considera tareas ya terminadas; a inicio de semana puede haber pocas y el valor fluctúa.' },
    3:  { title: 'Actividades vencidas sin cerrar',               freq: 'SEMANAL · DIARIO',
          text: 'Indicador semanal con actualización diaria. Cuenta tareas cuya fecha estimada ya pasó y siguen sin terminarse. Confiable cualquier día. No cuenta fechas que caen en festivo o fin de semana.',
          formula: 'COUNT(*) DONDE:\n  estimated_delivery_date < HOY\n  AND task_status ≠ "Terminado"\n  AND el día es L-V (no festivo de mp_holidays)',
          warn: null },
    4:  { title: 'Días de desfase promedio',                      freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. Promedio de días de adelanto/atraso de las tareas terminadas.',
          formula: 'AVG(actual_delivery_date − estimated_delivery_date)\nsobre tareas con task_status = "Terminado"\ny actual_delivery_date NO nulo.\nPositivo = tarde · Negativo = antes.',
          warn: 'Solo cuenta terminadas; con pocas terminadas el promedio puede ser volátil.' },
    5:  { title: '% Actividades terminadas',                      freq: 'DIARIO',
          text: 'Predominancia DIARIA. Proporción de tareas terminadas sobre el total. Confiable cualquier día, sube progresivamente conforme avanza el mes.',
          formula: 'COUNT(task_status = "Terminado") ÷ COUNT(total tareas con estado) × 100\nLa dona se divide en: Terminado · En Progreso · Pendiente · Bloqueado.',
          warn: null },
    6:  { title: '% Actividades bloqueadas',                      freq: 'DIARIO',
          text: 'Predominancia DIARIA. Porcentaje de tareas bloqueadas. Confiable cualquier día — un bloqueo requiere atención inmediata.',
          formula: 'COUNT(task_status = "Bloqueado") ÷ COUNT(total tareas con estado) × 100',
          warn: null },
    7:  { title: 'Horas ejecutadas vs presupuestadas',            freq: 'DIARIO',
          text: 'Predominancia DIARIA. Compara horas ejecutadas vs presupuestadas.',
          formula: 'SUM(budgeted_hours) y SUM(total_executed_hours)\nagrupado por semana (o por proyecto si filtras una semana).',
          warn: 'El ejecutado crece durante el mes; a mitad de mes lo normal es ver ejecutado por debajo del presupuestado.' },
    8:  { title: 'Indicador general por recurso',                 freq: 'SEMANAL · DIARIO',
          text: 'Indicador semanal con actualización diaria. Vista consolidada por recurso. Combina varias métricas; las de horas y entrega tienen lectura semanal/mensual (ver cada columna).',
          formula: 'Una fila por recurso. Las columnas se calculan:\n  • Cumpl. = SUM(ejec) ÷ SUM(presup) × 100\n  • Presup./Ejec. = sumas del mes\n  • % Term. = terminadas ÷ total × 100\n  • Bloq. = COUNT(status = "Bloqueado")\n  • % A tiempo = entregadas a tiempo ÷ terminadas con fecha real\nSemáforo: bloq>0 → ROJO; ≥100% → VERDE; 80-99 → AMARILLO; <80 → ROJO.\nClic en el nombre del recurso = todas sus tareas del mes.',
          warn: null },
    9:  { title: 'Semáforo de gestión',                           freq: 'SEMANAL · DIARIO',
          text: 'Indicador semanal con actualización diaria. Estado de salud general en 3 niveles: global del mes, top recursos, conteo por tarea.',
          formula: 'Regla de color (aplica a global, por recurso y por tarea):\n  si bloqueadas ≥ 1 → 🔴 ROJO\n  si cumplimiento ≥ 100% → 🟢 VERDE\n  si cumplimiento 80–99% → 🟡 AMARILLO\n  si cumplimiento < 80% → 🔴 ROJO',
          warn: 'El nivel global usa cumplimiento mensual: a mitad de mes tenderá a rojo/amarillo porque aún no se ejecutan todas las horas. Las tareas bloqueadas lo fuerzan a rojo de inmediato.' },
    10: { title: 'Recursos compartidos entre proyectos',          freq: 'DIARIO',
          text: 'Predominancia DIARIA. Identifica recursos que trabajan en varios proyectos a la vez. Útil para detectar sobreasignación. Si eres líder, ves a tu gente con TODOS sus proyectos (también los que no son tuyos) para detectar quién está estirado.',
          formula: 'Por cada empleado:\n  COUNT(DISTINCT project_folder) sobre todo el snapshot del mes.\nSe muestra si ese conteo > 1.\nAmarillo si está en > 2 proyectos.\nEl scope del PMO y el filtro de proyecto solo deciden QUIÉN aparece, no cuántos proyectos cuenta.',
          warn: null },
    11: { title: '% Tareas no planeadas',                         freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. Porcentaje de tareas que surgieron sin planear. Un valor alto indica mucha reactividad o planeación inicial débil.',
          formula: 'COUNT(planned_type = "NP")\n÷ COUNT(tareas con planned_type definido)\n× 100',
          warn: null },
    12: { title: 'Tasa de reestimación',                          freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. Porcentaje de tareas que requirieron reestimación. Indica qué tan estable fue la planeación de la semana.',
          formula: 'COUNT(adjustment_reason_1 NO vacío) ÷ COUNT(total tareas) × 100\nLos motivos más frecuentes agrupan reason_1, _2 y _3 vía UNION.',
          warn: null },
    13: { title: '% Imprevistos internos vs externos',            freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. De los ajustes que hubo, cuáles fueron por causas internas vs externas. Ayuda a entender el origen de los cambios.',
          formula: 'De los adjustment_type_1/2/3 NO vacíos:\n  % Interno = COUNT("Interno") ÷ total ajustes × 100\n  % Externo = COUNT("Externo") ÷ total ajustes × 100',
          warn: null },
    14: { title: 'Carga de trabajo por recurso',                  freq: 'DIARIO',
          text: 'Predominancia DIARIA. Compara las horas presupuestadas del recurso contra su capacidad real (44h/semana: lunes 8h, martes a viernes 9h, menos festivos). Detecta sobrecarga.',
          formula: 'Por cada (recurso × semana):\n  carga = SUM(budgeted_hours)\n  capacidad = lunes 8h + martes-viernes 9h × 4 = 44h\n             menos las horas de los días festivos (mp_holidays)\n  sobrecarga = carga > capacidad',
          warn: null },
    15: { title: 'Velocidad de cierre',                           freq: 'SEMANAL',
          text: 'Predominancia SEMANAL. Para cada recurso muestra cuántas de sus tareas terminadas cerraron antes de la fecha estimada, a tiempo, 1-3 días tarde o 4+ días tarde. Ayuda a ver de un vistazo quién entrega a tiempo y quién acumula retrasos.',
          warn: 'Solo cuenta tareas ya terminadas con fecha real de entrega.' },
    16: { title: 'Actividad diaria por recurso',                  freq: 'DIARIO',
          text: 'Predominancia DIARIA. Heatmap de horas ejecutadas por día de la semana (Lun-Sáb) para cada recurso, sumadas en el mes filtrado. Permite detectar días sin actividad, patrones de carga tardía o sobrecarga puntual. Los recursos con ★ son de prestación de servicios.',
          formula: 'Por cada (recurso × día):\n  horas = SUM(hours_monday | hours_tuesday | ... | hours_saturday)\n         excluyendo filas con palabras "permiso", "festivo", "vacaciones", "incapacidad", "licencia"\n  sobrecarga = horas > capacidad_dia × 1.25\n  capacidad_ref: Lun 8h, Mar-Vie 9h, Sáb 0h',
          warn: 'Requiere que WF1 (parser v17) ya esté escribiendo las columnas hours_monday..hours_saturday en mp_task_facts.' },
    17: { title: 'Auditoría cambios fecha estimada',              freq: 'DIARIO',
          text: 'Predominancia DIARIA. Detecta tareas cuya fecha estimada de entrega fue modificada entre snapshots. Sirve para identificar "trampa" de mover la fecha al cierre y ganar cumplimiento artificial.',
          formula: 'Identidad de tarea: (recurso, semana, proyecto, actividad).\n  changes_count = COUNT(DISTINCT estimated_delivery_date) por identidad\n  modificada = changes_count >= 2\n  days_moved = última fecha estimada − primera fecha estimada (positivo = postergó)',
          warn: 'Compara TODOS los snapshots del mes filtrado, no solo el último.' },
    18: { title: 'Reconocimientos del mes',                       freq: 'MENSUAL',
          text: 'Top 3 recursos por score compuesto del mes, más menciones honoríficas para quienes acumulan ≥3 logros. Mínimo 3 tareas en el mes para entrar al ranking.',
          formula: 'score = MIN(cumplimiento,100) × 0.45\n      + % a tiempo × 0.30\n      − bloqueadas × 8\n      − fechas modificadas × 4\n      + 5 si tiene ≥4 logros\n\nLogros: 🎯 100% cumpl · ⚡ Cero bloqueadas · 📅 Fechas estables · ✅ 100% a tiempo · 🚀 Alto volumen (≥P75)',
          warn: null },
  };

  const BADGE_CLASS = { DIARIO: 'badge-daily', SEMANAL: 'badge-weekly', MENSUAL: 'badge-monthly' };

  const pop = document.getElementById('tooltip-popover');
  let openFor = null;

  function render(n) {
    const t = TIPS[n];
    if (!t) return '';
    const badge = `<span class="badge ${BADGE_CLASS[t.freq]}">${t.freq}</span>`;
    const warn = t.warn ? `<span class="warn">${icono('advertencia')} ${t.warn}</span>` : '';
    return `<h4>${badge}${t.title}</h4><div>${t.text}</div>${warn}`;
  }

  function show(btn, n) {
    pop.innerHTML = render(n);
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - popW - 8, r.left + window.scrollX));
    const top = r.bottom + window.scrollY + 6;
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
    openFor = btn;
  }

  function hide() {
    pop.hidden = true;
    openFor = null;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.info[data-tip]');
    if (btn) {
      e.stopPropagation();
      const n = Number(btn.dataset.tip);
      if (openFor === btn) return hide();
      show(btn, n);
      return;
    }
    if (openFor && !pop.contains(e.target)) hide();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, { passive: true });

  window.GTC_TOOLTIPS = TIPS;
})();
