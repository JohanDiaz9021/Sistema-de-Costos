'use strict';

/**
 * Comportamiento del sidebar (.cst-sidebar) compartido entre index.html
 * (Planeación) y costeo.html: colapsar/expandir (persistido por usuario,
 * 5.5) y switch de rol visual. La navegación entre módulos (Planeación <->
 * Costeo) es con <a href> normales, no se maneja aquí.
 */

// Helper global (window.withBusy) — sidebar.js es el primer <script> en
// ambas páginas, así que cualquier otro archivo puede usarlo. Deshabilita el
// botón y le pone la clase .is-busy (spinner + texto temporal, ver
// styles.css) mientras `action` está en vuelo, y lo revierte siempre al
// terminar (éxito o error) para que un doble clic no dispare dos peticiones.
// Si el botón ya estaba disabled (una petición anterior sigue en curso), no
// hace nada — evita que dos llamadas paralelas se pisen la una a la otra.
async function withBusy(btn, action, labelWhileBusy) {
  if (!btn || btn.disabled) return undefined;
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (labelWhileBusy) btn.textContent = labelWhileBusy;
  try {
    return await action();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.innerHTML = originalHTML;
  }
}
window.withBusy = withBusy;
// --sidebar-width se define en :root (costeo.css) y la usa .cst-shell para
// el ancho de columna del grid. Se cambia en <html>, no en .cst-sidebar,
// porque las variables CSS solo se heredan hacia los hijos del elemento
// donde se definen — .cst-shell es el padre de .cst-sidebar, no su hijo.
function applySidebarCollapsed(sidebar, collapseBtn, collapsed) {
  sidebar.classList.toggle('is-collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '›' : '‹';
  document.documentElement.style.setProperty('--sidebar-width', collapsed ? '64px' : '240px');
}

// PM (role 'leader') ve un menú aplanado — un botón directo por función
// (Costo Planeado, Costo No Planeado, Equipo del Proyecto, Horas Extra,
// Catálogo de Cargos, Historial) — scopeado a su propio proyecto por el
// backend (req.scope). CEO/admin ve el mismo menú aplanado (31 ago 2026:
// antes tenía que entrar por un solo botón "Equipo y Gastos · Edición" con
// 7 pestañas adentro — dos clics para llegar a lo mismo que el PM alcanza
// con uno), más Accesos y Configuración, que son exclusivos suyos. Por
// dentro todos apuntan a los mismos paneles (data-panel/data-subtab), solo
// cambia si el botón está marcado data-ceo-only o data-pm-only.
// Marcado con data-ceo-only / data-pm-only en el HTML (index.html y
// costeo.html), no por texto, para que funcione igual en ambos.
// Los data-ceo-only arrancan con visibility:hidden por CSS (costeo.css) en
// vez de con el atributo hidden, porque hasta que no responde /api/auth/me
// no sabemos el rol — si arrancaran visibles (como estaba antes), un PM
// los veía parpadear un instante en cada navegación entre páginas antes de
// que este código los ocultara.
function applyRoleNav(role) {
  const esCeoAdmin = role === 'ceo' || role === 'admin';
  document.querySelectorAll('.cst-nav .cst-nav-item').forEach((item) => {
    if (item.hasAttribute('data-ceo-only')) {
      item.hidden = !esCeoAdmin;
      item.style.visibility = 'visible';
    } else if (item.hasAttribute('data-pm-only')) {
      item.hidden = esCeoAdmin;
    }
  });
}

// El badge de "Alertas" en costeo.html ya lo llena costeo.js con más
// detalle (junto al resto del panel). En index.html (Planeación) no se
// carga costeo.js, así que sin esto el badge se quedaba siempre en 0 —
// aquí solo cubrimos esa página.
//
// Alertas ya no es exclusivo de CEO/admin (26 ago 2026): GET /alertas
// scopea al PM a su propio proyecto (req.scope), así que el badge se llena
// para cualquier rol autenticado — el `role` ya no filtra nada aquí, se
// deja como parámetro solo por si algún día vuelve a hacer falta.
async function loadAlertasBadge() {
  const badge = document.getElementById('cst-nav-alertas-badge');
  if (!badge || document.getElementById('cst-panel-alertas')) return;
  try {
    const res = await fetch('/api/costeo/alertas', { credentials: 'same-origin' });
    if (!res.ok) return;
    const { alertas } = await res.json();
    badge.textContent = String((alertas || []).length);
  } catch {
    // Sin conexión: el badge se queda en 0, no es crítico.
  }
}

// El subtitulo del sidebar pasa a decir QUIEN esta dentro en vez de que
// herramienta es (el nombre del modulo ya esta en el <title> y en la pagina).
//
// Importa porque las mismas pantallas muestran cosas distintas segun quien
// entro: un PM ve solo sus centros (req.scope) y el CEO ve el portafolio
// entero. Con varias cuentas rotando sobre el mismo navegador, leer un numero
// creyendo que es del portafolio cuando es el de un solo proyecto es un error
// caro y silencioso — el nombre a la vista lo corta de raiz.
//
// Se cae al correo si la cuenta no tiene full_name, y si /api/auth/me no
// responde se queda el texto del HTML: el hueco nunca se ve vacio.
function applyBrandUser(user) {
  const el = document.getElementById('cst-brand-user');
  if (!el || !user) return;
  const nombre = (user.full_name && user.full_name.trim()) || user.email;
  if (nombre) el.textContent = nombre;
}

async function loadSidebarPreference(sidebar, collapseBtn) {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return;
    const { user } = await res.json();
    applySidebarCollapsed(sidebar, collapseBtn, Boolean(user.sidebar_collapsed));
    applyRoleNav(user.role);
    applyBrandUser(user);
    loadAlertasBadge();
  } catch {
    // Sin conexión o sesión vencida: se queda con el estado por defecto
    // (expandido) y el resto de la página maneja el redirect a /login.
  }
}

function saveSidebarPreference(collapsed) {
  fetch('/api/auth/me/sidebar', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collapsed }),
  }).catch(() => {
    // La preferencia de UI no es crítica: si falla el guardado, el sidebar
    // igual queda colapsado/expandido en esta sesión, solo no persiste.
  });
}

function initSidebarChrome() {
  const sidebar = document.getElementById('cst-sidebar');
  const collapseBtn = document.getElementById('cst-collapse-btn');
  if (sidebar && collapseBtn) {
    loadSidebarPreference(sidebar, collapseBtn);
    collapseBtn.addEventListener('click', () => {
      const collapsed = !sidebar.classList.contains('is-collapsed');
      applySidebarCollapsed(sidebar, collapseBtn, collapsed);
      saveSidebarPreference(collapsed);
    });
  }

  // Cerrar sesión — visible en el sidebar en ambas páginas (Planeación y Costeo),
  // encima de "Ayuda visible".
  const logoutBtn = document.getElementById('cst-sidebar-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => withBusy(logoutBtn, async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      window.location.href = '/login';
    }, 'Saliendo…'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initSidebarChrome();
  // Rellena los <span class="cst-ico" data-ico="..."> del HTML estatico con
  // su SVG (ver iconos.js). Va aqui porque este archivo es el unico que
  // cargan las dos paginas; en Costeo, costeo-nav.js lo llama ademas al
  // inicio de su propio arranque, y la funcion solo toca los huecos vacios,
  // asi que llamarla dos veces no repinta nada.
  if (typeof pintarIconos === 'function') pintarIconos();
});
