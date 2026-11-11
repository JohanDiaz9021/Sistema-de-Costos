'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { limitarIntentosLogin, registrarIntentoFallido, limpiarIntentos } = require('../middleware/rate-limit');

const router = express.Router();

// Hash descartable de una contraseña que no es de nadie. Sirve para gastar
// el mismo tiempo de bcrypt cuando el usuario NO existe: sin esto, la
// respuesta a un correo inexistente volvía notablemente más rápido que la de
// uno real con contraseña equivocada, y esa diferencia de tiempo permite
// averiguar qué correos tienen cuenta antes de intentar adivinar nada.
const HASH_SEÑUELO = bcrypt.hashSync('contraseña-que-nunca-coincide', 10);

router.post('/login', limitarIntentosLogin, async (req, res, next) => {
  try {
    const identifier = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Correo/usuario y contraseña son obligatorios' });
    }

    // Acepta login por correo (siempre existió) o por username (3.4 —
    // Gestión de PMs). Las cuentas sin username definido (CEO, admin,
    // líderes creados antes de esta fase) solo hacen match por email.
    //
    // OJO: aquí ya NO se filtra por is_active — se valida la contraseña
    // primero y is_active aparte, para poder avisarle a un PM desactivado
    // por qué no puede entrar en vez de darle "credenciales inválidas"
    // genérico (que lo haría pensar que escribió mal la contraseña).
    const rows = await query(
      `SELECT user_id, email, password_hash, full_name, role, is_active, sidebar_collapsed
         FROM mp_dashboard_users
        WHERE (LOWER(email) = ? OR LOWER(username) = ?)
        LIMIT 1`,
      [identifier, identifier]
    );

    const user = rows[0];
    // Se compara SIEMPRE, exista o no el usuario, para que las dos ramas
    // tarden lo mismo (ver HASH_SEÑUELO arriba).
    const ok = await bcrypt.compare(password, user ? user.password_hash : HASH_SEÑUELO);
    if (!user || !ok) {
      registrarIntentoFallido(req);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'No puedes ingresar, te encuentras "Inactivo/a". Comunícate con el CEO.' });
    }

    // Entró bien: se borra el contador para que equivocarse un par de veces
    // antes de acertar no deje al usuario a un intento del bloqueo.
    limpiarIntentos(req);

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        user_id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        sidebar_collapsed: Boolean(user.sidebar_collapsed),
      };
      res.json({
        ok: true,
        user: req.session.user,
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('gtc.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  res.json({ user: req.session.user });
});

// 5.5 — Persiste la preferencia de sidebar colapsado/expandido del usuario
// conectado. Cualquier usuario autenticado puede cambiar la suya (no es un
// dato administrativo, es una preferencia personal de UI).
router.put('/me/sidebar', async (req, res, next) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const collapsed = Boolean(req.body.collapsed);
    await query('UPDATE mp_dashboard_users SET sidebar_collapsed = ? WHERE user_id = ?', [
      collapsed ? 1 : 0,
      req.session.user.user_id,
    ]);

    req.session.user.sidebar_collapsed = collapsed;
    res.json({ ok: true, sidebar_collapsed: collapsed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
