'use strict';

// Estaba embebido en login.html. Se saco a un archivo propio para que la
// Content-Security-Policy pueda prohibir TODO script inline
// (script-src 'self'): mientras hubiera uno solo, habia que permitir
// 'unsafe-inline', y eso desactiva justamente la proteccion que la CSP
// aporta contra un XSS.

const form = document.getElementById('login-form');
const btn = document.getElementById('login-btn');
const errEl = document.getElementById('form-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Verificando…';

  const data = new FormData(form);
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: data.get('email'),
        password: data.get('password'),
      }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || 'No se pudo iniciar sesión');
    window.location.href = '/';
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});
