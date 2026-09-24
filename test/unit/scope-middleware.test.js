'use strict';

/**
 * attachScope() de src/middleware/scope.js — solo las 2 ramas que NO tocan
 * la base de datos (sin sesión -> 401, ceo/admin -> allowedProjects null).
 * La rama de "leader" sí hace una query real contra mp_project_owners y ya
 * está cubierta por los tests de integración (aislamiento.test.js).
 */

const test = require('node:test');
const assert = require('node:assert');

const { attachScope } = require('../../src/middleware/scope');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

test('attachScope: sin usuario en sesión, responde 401 y no llama next()', async () => {
  const req = { session: {} };
  const res = fakeRes();
  let nextCalled = false;
  await attachScope(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'No autenticado' });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(req.scope, undefined);
});

test('attachScope: rol ceo, allowedProjects null (sin filtro) y llama next()', async () => {
  const req = { session: { user: { role: 'ceo', email: 'ceo@ejemplo.test' } } };
  const res = fakeRes();
  let nextCalled = false;
  await attachScope(req, res, () => { nextCalled = true; });
  assert.deepStrictEqual(req.scope, { role: 'ceo', allowedProjects: null });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('attachScope: rol admin, allowedProjects null (sin filtro) y llama next()', async () => {
  const req = { session: { user: { role: 'admin', email: 'admin@ejemplo.test' } } };
  const res = fakeRes();
  let nextCalled = false;
  await attachScope(req, res, () => { nextCalled = true; });
  assert.deepStrictEqual(req.scope, { role: 'admin', allowedProjects: null });
  assert.strictEqual(nextCalled, true);
});
