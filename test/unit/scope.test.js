'use strict';

/**
 * projectScopeClause() y costCenterScopeClause() — el aislamiento entre
 * proyectos depende ENTERAMENTE de estas dos funciones.
 *
 * Si alguna devolviera una clausula vacia cuando el usuario SI tiene un
 * scope acotado, un PM pasaria a ver los proyectos de todos los demas y
 * ninguna otra capa lo detendria: las rutas concatenan lo que estas
 * funciones devuelvan y confian en ello. Por eso las tres ramas se prueban
 * por separado, incluida la que a primera vista parece un detalle
 * (lista vacia => 'AND 1=0').
 *
 * Son funciones puras: no tocan la base.
 */

const test = require('node:test');
const assert = require('node:assert');

const { projectScopeClause } = require('../../src/middleware/scope');
const { costCenterScopeClause } = require('../../src/queries/costo-common');

// Las dos funciones tienen el mismo contrato de tres ramas; se prueban en
// paralelo para que ninguna se quede atras si alguien toca solo una.
const IMPLEMENTACIONES = [
  ['projectScopeClause', projectScopeClause, 'project_folder'],
  ['costCenterScopeClause', costCenterScopeClause, 'cost_center_id'],
];

for (const [nombre, clause, columnaPorDefecto] of IMPLEMENTACIONES) {
  test(`${nombre}: allowedProjects null (ceo/admin) => sin filtro`, () => {
    const r = clause({ role: 'ceo', allowedProjects: null });
    assert.strictEqual(r.clause, '', 'ceo/admin no debe filtrar nada');
    assert.deepStrictEqual(r.params, []);
  });

  test(`${nombre}: scope indefinido => sin filtro`, () => {
    // Rama defensiva: si attachScope no corrio, no hay nada que filtrar.
    // Es permisiva a proposito, y por eso el orden del middleware importa.
    assert.strictEqual(clause(undefined).clause, '');
    assert.strictEqual(clause(null).clause, '');
  });

  test(`${nombre}: lista VACIA => 'AND 1=0' (no devuelve todo)`, () => {
    // El caso peligroso: un lider sin proyectos asignados. Si esta rama
    // devolviera '' en vez de 1=0, ese usuario veria TODA la empresa.
    const r = clause({ role: 'leader', allowedProjects: [] });
    assert.match(r.clause, /\bAND\s+1\s*=\s*0\b/);
    assert.deepStrictEqual(r.params, []);
    assert.notStrictEqual(r.clause.trim(), '', 'jamas puede quedar vacia');
  });

  test(`${nombre}: un proyecto => un placeholder y un parametro`, () => {
    const r = clause({ role: 'leader', allowedProjects: ['CRM'] });
    assert.strictEqual((r.clause.match(/\?/g) || []).length, 1);
    assert.deepStrictEqual(r.params, ['CRM']);
  });

  test(`${nombre}: N proyectos => N placeholders, en el mismo orden`, () => {
    const proyectos = ['CRM', 'MIA', 'QA', 'SESCOL'];
    const r = clause({ role: 'leader', allowedProjects: proyectos });
    assert.strictEqual((r.clause.match(/\?/g) || []).length, proyectos.length);
    assert.deepStrictEqual(r.params, proyectos);
    assert.match(r.clause, /IN\s*\(\s*\?(\s*,\s*\?)*\s*\)/);
  });

  test(`${nombre}: los valores NUNCA se interpolan en el SQL`, () => {
    // Un project_folder viene de la base, pero igual tiene que viajar como
    // parametro. Si apareciera dentro de la cadena, un nombre con comilla
    // rompe la query (y abre la puerta a inyeccion).
    const veneno = "CRM'; DROP TABLE mp_centro_costo; --";
    const r = clause({ role: 'leader', allowedProjects: [veneno] });
    assert.ok(!r.clause.includes('DROP'), 'el valor no puede estar en el SQL');
    assert.ok(!r.clause.includes(veneno));
    assert.deepStrictEqual(r.params, [veneno]);
  });

  test(`${nombre}: usa el alias de columna que se le pase`, () => {
    const r = clause({ role: 'leader', allowedProjects: ['CRM'] }, 'cc.una_columna');
    assert.ok(r.clause.includes('cc.una_columna'), r.clause);
  });

  test(`${nombre}: sin alias usa el de por defecto`, () => {
    const r = clause({ role: 'leader', allowedProjects: ['CRM'] });
    assert.ok(r.clause.includes(columnaPorDefecto), r.clause);
  });

  test(`${nombre}: no muta ni comparte el arreglo del scope`, () => {
    // Las rutas hacen [...scopeF.params, otroValor]. Si params fuera el
    // MISMO arreglo del scope, un push accidental contaminaria la sesion
    // del usuario para el resto de la peticion.
    const scope = { role: 'leader', allowedProjects: ['CRM', 'MIA'] };
    const r = clause(scope);
    assert.notStrictEqual(r.params, scope.allowedProjects, 'debe ser una copia');
    r.params.push('INYECTADO');
    assert.deepStrictEqual(scope.allowedProjects, ['CRM', 'MIA'], 'el scope no debe cambiar');
  });
}

test('costCenterScopeClause filtra por subconsulta sobre mp_centro_costo', () => {
  // Las tablas de Costeo guardan cost_center_id, no project_folder: el
  // puente tiene que ser explicito o el filtro no aplica.
  const r = costCenterScopeClause({ role: 'leader', allowedProjects: ['CRM'] });
  assert.match(r.clause, /SELECT\s+cost_center_id\s+FROM\s+mp_centro_costo/i);
  assert.match(r.clause, /project_folder\s+IN/i);
});

test('las dos clausulas encajan detras de un WHERE 1=1 sin romper el SQL', () => {
  // Asi las concatenan todas las rutas. Si a alguna le faltara el AND o el
  // espacio inicial, el SQL quedaria invalido (o peor, valido y mal).
  for (const [, clause] of IMPLEMENTACIONES) {
    for (const scope of [
      { role: 'ceo', allowedProjects: null },
      { role: 'leader', allowedProjects: [] },
      { role: 'leader', allowedProjects: ['CRM', 'MIA'] },
    ]) {
      const sql = `SELECT 1 FROM t WHERE 1=1 ${clause(scope).clause} ORDER BY 1`;
      assert.ok(!/WHERE 1=1\s+[a-z_]+\s+IN/i.test(sql), `falta el AND: ${sql}`);
      assert.ok(!sql.includes('1=1AND'), `falta el espacio: ${sql}`);
    }
  }
});
