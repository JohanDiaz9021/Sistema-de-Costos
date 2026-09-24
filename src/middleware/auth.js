'use strict';

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

function requireRole(...allowed) {
  return function (req, res, next) {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    if (!allowed.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Permiso insuficiente' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
