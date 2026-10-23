import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, entityPoints, entityGrips, entityDimensions, distanceToEntity,
  isClosed, moveEntity, createDoc, applyOps, serializeScene,
  BEZIER_TOLERANCE, BEZIER_MAX_DEPTH, MAX_VALUE } from '../js/model.mjs';
import { toSVG, toDXF } from '../js/dxf.mjs';

const params = { from: [0, 0], control1: [0, 30], control2: [40, 30], to: [40, 0] };
const curve = () => makeEntity('bezier', params);
const evaluate = (e, t) => [0, 1].map(k => (1 - t) ** 3 * e.p1[k] +
  3 * (1 - t) ** 2 * t * e.c1[k] + 3 * (1 - t) * t ** 2 * e.c2[k] + t ** 3 * e.p2[k]);

test('cubic Bezier schema validates and copies all four points', () => {
  const e = curve();
  assert.equal(e.type, 'bezier');
  for (const [internal, external] of [['p1', 'from'], ['c1', 'control1'], ['c2', 'control2'], ['p2', 'to']]) {
    assert.deepEqual(e[internal], params[external]);
    assert.notStrictEqual(e[internal], params[external]);
    for (const bad of [[NaN, 0], [0, Infinity], [MAX_VALUE + 1, 0], [0], null, '0,0']) {
      assert.throws(() => makeEntity('bezier', { ...params, [external]: bad }));
    }
  }
  assert.equal(isClosed(e), false);
  assert.ok(entityPoints(makeEntity('bezier')).length > 2);
});

test('adaptive flattening preserves endpoints and targets 0.05 mm on practical curves', () => {
  const e = curve(), points = entityPoints(e);
  assert.deepEqual(points[0], e.p1);
  assert.deepEqual(points.at(-1), e.p2);
  assert.ok(points.length > 2 && points.length <= 2 ** BEZIER_MAX_DEPTH + 1);
  for (let i = 0; i <= 1000; i++) {
    assert.ok(distanceToEntity(evaluate(e, i / 1000), e) <= BEZIER_TOLERANCE + 1e-10);
  }
  // No implicit closing chord: its midpoint is far from this arch.
  assert.ok(distanceToEntity([20, 0], e) > 15);
});

test('degenerate, collinear reversal, loop, and huge curves flatten safely', () => {
  const degenerate = makeEntity('bezier', { from: [2, 3], control1: [2, 3], control2: [2, 3], to: [2, 3] });
  assert.deepEqual(entityPoints(degenerate), [[2, 3], [2, 3]]);
  assert.equal(distanceToEntity([5, 7], degenerate), 5);
  const reversal = makeEntity('bezier', { from: [0, 0], control1: [100, 0], control2: [-100, 0], to: [1, 0] });
  const reversalPoints = entityPoints(reversal);
  assert.ok(reversalPoints.some(p => p[0] > 20) && reversalPoints.some(p => p[0] < -20));
  const loop = makeEntity('bezier', { from: [0, 0], control1: [100, 100], control2: [-100, 100], to: [0, 0] });
  assert.ok(entityPoints(loop).some(p => p[1] >= 75));
  assert.equal(isClosed(loop), false);
  const huge = makeEntity('bezier', { from: [-MAX_VALUE, -MAX_VALUE], control1: [-MAX_VALUE, MAX_VALUE], control2: [MAX_VALUE, MAX_VALUE], to: [MAX_VALUE, -MAX_VALUE] });
  const points = entityPoints(huge);
  assert.ok(points.length <= 2 ** BEZIER_MAX_DEPTH + 1);
  assert.ok(points.every(p => p.every(Number.isFinite)));
});

test('four independent grips have endpoint/control kinds and validated setters', () => {
  const e = curve(), grips = entityGrips(e);
  assert.deepEqual(grips.map(g => g.kind), ['endpoint', 'control', 'control', 'endpoint']);
  for (const [i, key] of ['p1', 'c1', 'c2', 'p2'].entries()) {
    grips[i].set([i + 2, i + 3]);
    assert.deepEqual(e[key], [i + 2, i + 3]);
    const before = JSON.stringify(e);
    assert.throws(() => grips[i].set([0, Infinity]));
    assert.equal(JSON.stringify(e), before);
  }
});

test('moves preserve curve shape, use endpoint midpoint, and reject atomically', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'bezier', ...params }]);
  const e = doc.entities[0];
  applyOps(doc, [{ op: 'move', id: e.id, to: [50, 60] }]);
  assert.deepEqual(e.p1, [30, 60]); assert.deepEqual(e.c1, [30, 90]);
  assert.deepEqual(e.c2, [70, 90]); assert.deepEqual(e.p2, [70, 60]);
  const before = JSON.stringify(e);
  assert.throws(() => moveEntity(e, [MAX_VALUE - 50, 0]));
  assert.equal(JSON.stringify(e), before);
});

test('chord dimension is explicitly not curve length and preserves end tangent', () => {
  const e = curve(), dim = entityDimensions(e)[0];
  assert.equal(dim.key, 'chord'); assert.equal(dim.value, 40); assert.equal(dim.label, 'Chord 40 mm');
  dim.set(60); assert.deepEqual(e.p2, [60, 0]); assert.deepEqual(e.c2, [60, 30]);
  const before = JSON.stringify(e);
  for (const bad of [0, -1, NaN, Infinity, '']) {
    assert.throws(() => dim.set(bad)); assert.equal(JSON.stringify(e), before);
  }
  const loop = makeEntity('bezier', { from: [2, 3], to: [2, 3] });
  entityDimensions(loop)[0].set(9); assert.deepEqual(loop.p2, [11, 3]);
  const limit = makeEntity('bezier', { from: [0, 0], to: [1, 0], control2: [MAX_VALUE, 0] });
  const limitBefore = JSON.stringify(limit);
  assert.throws(() => entityDimensions(limit)[0].set(2));
  assert.equal(JSON.stringify(limit), limitBefore);
});

test('Bezier operation batches remain transactional including IDs and controls', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'bezier', ...params }]);
  const e = doc.entities[0]; doc.selectedId = e.id;
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [
    { op: 'move', id: e.id, to: [50, 60] },
    { op: 'set_dimension', id: e.id, dimension: 'chord', value: 90 },
    { op: 'bezier' }, { op: 'bezier', control1: [0, Infinity] },
  ]), /Operation 4:/);
  assert.equal(JSON.stringify(doc), before); assert.strictEqual(doc.entities[0], e);
  applyOps(doc, [{ op: 'bezier' }]);
  assert.equal(Number(doc.entities[1].id.slice(1)), Number(e.id.slice(1)) + 1);
});

test('serialized cubic points round-trip without sharing mutable arrays', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'bezier', ...params }]);
  doc.selectedId = doc.entities[0].id;
  const s = serializeScene(doc).entities[0], restored = makeEntity(s.type, s);
  assert.equal(s.selected, true);
  for (const [key, field] of [['p1', 'from'], ['c1', 'control1'], ['c2', 'control2'], ['p2', 'to']]) {
    assert.deepEqual(restored[key], doc.entities[0][key]);
    s[field][0] += 123;
    assert.notDeepEqual(s[field], doc.entities[0][key]);
  }
});

test('SVG is an exact cubic with conservative bounds; DXF openly samples an open polyline', () => {
  const e = curve(), doc = { entities: [e] };
  const svg = toSVG(doc), dxf = toDXF(doc);
  assert.match(svg, /d="M0 0 C0 -30 40 -30 40 0"/);
  assert.match(svg, /viewBox="-10 -40 60 50"/);
  assert.doesNotMatch(svg, /\bL|Z"/);
  assert.match(dxf, /999\nCubic Bezier approximation: sampled LWPOLYLINE; target tolerance 0.05 mm; maximum 4096 segments/);
  assert.match(dxf, new RegExp(`AcDbPolyline\\n90\\n${entityPoints(e).length}\\n70\\n0`));
  assert.doesNotMatch(dxf, /\nSPLINE\n/);
  assert.equal(dxf.trim().split('\n').length % 2, 0);
});

test('export rejects malformed Bezier controls instead of silently flattening them', () => {
  for (const key of ['p1', 'c1', 'c2', 'p2']) {
    const e = curve(); e[key] = [NaN, 0];
    assert.throws(() => toSVG({ entities: [e] }), /Cannot export invalid Bezier/);
    assert.throws(() => toDXF({ entities: [e] }), /Cannot export invalid Bezier/);
  }
});
