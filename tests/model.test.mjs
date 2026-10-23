import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, entityDimensions, entityGrips, entityPoints, distanceToEntity, moveEntity,
  createDoc, applyOps, serializeScene, arcAngles } from '../js/model.mjs';
import { toDXF, toSVG } from '../js/dxf.mjs';
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const add = (doc, op) => { applyOps(doc, [op]); return doc.entities.at(-1); };

test('all six primitives have finite geometry, grips, and driving dimensions', () => {
  for (const type of ['line', 'circle', 'arc', 'rect', 'polygon', 'star']) {
    const e = makeEntity(type);
    assert.ok(entityPoints(e).every(p => p.every(Number.isFinite)));
    assert.ok(entityGrips(e).every(g => g.get().every(Number.isFinite)));
    for (const dim of entityDimensions(e)) {
      dim.set(12.345);
      near(entityDimensions(e).find(d => d.key === dim.key).value, 12.345);
    }
  }
});
test('invalid provided numbers are rejected, not silently defaulted or clamped', () => {
  for (const bad of [NaN, Infinity, -Infinity, '', ' ', null, true, {}, 1e300]) {
    assert.throws(() => makeEntity('circle', { radius: bad }));
    assert.throws(() => makeEntity('line', { from: [bad, 0] }));
  }
  for (const radius of [0, -2]) assert.throws(() => makeEntity('circle', { radius }));
  for (const sides of [2, 3.5, 65]) assert.throws(() => makeEntity('polygon', { sides }));
  assert.throws(() => makeEntity('star', { innerRatio: 1 }));
  assert.throws(() => makeEntity('arc', { start: 'bad' }));
  assert.equal(makeEntity('circle', { radius: '0.001' }).r, 0.001);
});
test('dimension validation preserves geometry, including direct setters', () => {
  for (const type of ['line', 'circle', 'arc', 'rect', 'polygon', 'star']) {
    const e = makeEntity(type), before = JSON.stringify(e);
    for (const dim of entityDimensions(e)) for (const bad of [0, -1, NaN, Infinity, null, '', '4mm']) {
      assert.throws(() => dim.set(bad));
      assert.equal(JSON.stringify(e), before);
    }
  }
});
test('coincident line can be dimensioned; tiny line keeps its true direction', () => {
  const e = makeEntity('line', { from: [2, 3], to: [2, 3] });
  near(distanceToEntity([5, 7], e), 5);
  entityDimensions(e)[0].set(9);
  assert.deepEqual(e.p2, [11, 3]);
  const tiny = makeEntity('line', { from: [0, 0], to: [0, 1e-8] });
  near(distanceToEntity([0, 5e-9], tiny), 0, 1e-15);
  entityDimensions(tiny)[0].set(12);
  assert.deepEqual(tiny.p2, [0, 12]);
});
test('moving lines uses midpoint and preserves endpoints distance', () => {
  const doc = createDoc(), e = add(doc, { op: 'line', from: [0, 0], to: [10, 0] });
  applyOps(doc, [{ op: 'move', id: e.id, to: [20, 30] }]);
  assert.deepEqual(e.p1, [15, 30]); assert.deepEqual(e.p2, [25, 30]);
  const before = JSON.stringify(e);
  assert.throws(() => moveEntity(e, [NaN, 0]));
  assert.equal(JSON.stringify(e), before);
});
test('arc sweeps wrap once, support full circles, and cannot allocate huge paths', () => {
  const arc = makeEntity('arc', { start: 350, end: 10 });
  assert.deepEqual(arcAngles(arc), { start: 350, sweep: 20, end: 370 });
  assert.equal(arcAngles(makeEntity('arc', { start: 0, end: 360 })).sweep, 360);
  assert.equal(arcAngles(makeEntity('arc', { start: 360, end: 0 })).sweep, 360);
  for (const [start, end] of [[1e12, -1e12], [-1e12, 1e12], [0, 0]]) {
    const pts = entityPoints(makeEntity('arc', { start, end }));
    assert.ok(pts.length <= 73); assert.ok(pts.every(p => p.every(Number.isFinite)));
  }
});
test('circular picking uses exact curves, and arcs exclude missing sectors', () => {
  const e = makeEntity('circle', { radius: 1000 });
  const a = Math.PI / 72;
  near(distanceToEntity([1000 * Math.cos(a), 1000 * Math.sin(a)], e), 0);
  const arc = makeEntity('arc', { radius: 10, start: 350, end: 10 });
  near(distanceToEntity([10, 0], arc), 0);
  assert.ok(distanceToEntity([-10, 0], arc) > 19);
  const full = makeEntity('arc', { radius: 10, start: 0, end: 360 });
  near(distanceToEntity([-10, 0], full), 0);
});
test('invalid grips never introduce NaN or partial rectangle changes', () => {
  for (const type of ['line', 'circle', 'arc', 'rect', 'polygon', 'star']) {
    const e = makeEntity(type), before = JSON.stringify(e);
    for (const grip of entityGrips(e)) {
      assert.throws(() => grip.set([0, NaN]));
      assert.equal(JSON.stringify(e), before);
    }
  }
});
test('AI operation batch is atomic for missing targets and invalid dimensions', () => {
  const doc = createDoc(), e = add(doc, { op: 'circle', radius: 5 });
  doc.selectedId = e.id;
  const before = JSON.stringify(doc);
  for (const bad of [{ op: 'move', id: 'missing', to: [0, 0] },
    { op: 'set_dimension', id: e.id, dimension: 'width', value: 9 },
    { op: 'set_dimension', id: e.id, dimension: 'radius', value: Infinity },
    { op: 'delete', id: 'missing' }, { op: 'unknown' }, null]) {
    assert.throws(() => applyOps(doc, [{ op: 'set_dimension', id: e.id, dimension: 'radius', value: 3 }, { op: 'rect' }, bad]), /Operation 3:/);
    assert.equal(JSON.stringify(doc), before); assert.strictEqual(doc.entities[0], e);
  }
});
test('delete and clear clear stale selections, result IDs only reference live entities', () => {
  const doc = createDoc(), e = add(doc, { op: 'circle' });
  doc.selectedId = e.id;
  applyOps(doc, [{ op: 'delete', id: e.id }]);
  assert.equal(doc.selectedId, null);
  const e2 = add(doc, { op: 'rect' }); doc.selectedId = e2.id;
  const result = applyOps(doc, [{ op: 'circle' }, { op: 'move', id: e2.id, to: [0, 0] }, { op: 'clear' }]);
  assert.deepEqual(result, { created: [], touched: [] });
  assert.equal(doc.selectedId, null); assert.equal(doc.entities.length, 0);
});
test('new IDs do not collide with imported/restored entities', () => {
  const doc = createDoc(); doc.entities.push({ id: 'e100000', type: 'circle', c: [0, 0], r: 1 });
  const e = add(doc, { op: 'circle' }); assert.notEqual(e.id, 'e100000');
  assert.ok(Number(e.id.slice(1)) > 100000);
});
test('serialized scene retains exact values, star ratio, rotation, and selection', () => {
  const doc = createDoc(), e = add(doc, { op: 'star', center: [0.123456, -0.987654], radius: 12.345678, rotation: 31.25, innerRatio: 0.42 });
  doc.selectedId = e.id;
  const s = serializeScene(doc).entities[0];
  assert.equal(s.radius, 12.345678); assert.equal(s.rotation, 31.25); assert.equal(s.innerRatio, 0.42); assert.equal(s.selected, true);
  assert.deepEqual(s.center, [0.123456, -0.987654]);
  s.center[0] = 100; assert.equal(e.c[0], 0.123456);
});
test('DXF declares correct version, millimetres, subclasses, and closed polylines', () => {
  const doc = createDoc();
  applyOps(doc, [{ op: 'rect', width: 20, height: 10 }, { op: 'circle', radius: 3 }, { op: 'arc', start: 350, end: 10 }]);
  const dxf = toDXF(doc);
  assert.match(dxf, /\$ACADVER\n1\nAC1015/); assert.match(dxf, /\$INSUNITS\n70\n4/);
  assert.match(dxf, /LWPOLYLINE\n100\nAcDbEntity\n8\n0\n100\nAcDbPolyline\n90\n4\n70\n1/);
  assert.match(dxf, /100\nAcDbArc\n50\n350\n51\n10/);
  assert.ok(dxf.endsWith('0\nEOF\n')); assert.equal(dxf.trim().split('\n').length % 2, 0);
});
test('SVG exports exact circles/arcs, y-up orientation, and physical units', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'circle', center: [4, 5], radius: 2 }, { op: 'arc', center: [0, 0], radius: 10, start: 0, end: 90 }]);
  const svg = toSVG(doc);
  assert.match(svg, /<circle cx="4" cy="-5" r="2"/);
  assert.match(svg, / A10 10 0 0 0 /); assert.match(svg, /viewBox="-10 -20 30 30"/);
  assert.match(svg, /width="30mm" height="30mm"/);
});
test('full-turn arcs export as full circles, not degenerate arcs', () => {
  const doc = createDoc(); add(doc, { op: 'arc', start: 30, end: 390 });
  assert.match(toDXF(doc), /\nCIRCLE\n/); assert.doesNotMatch(toDXF(doc), /\nARC\n/);
  assert.match(toSVG(doc), /<circle/); assert.match(toSVG(doc), /viewBox="-20 -20 40 40"/);
});
test('empty documents export valid finite files; corrupted geometry fails visibly', () => {
  const doc = createDoc(); assert.match(toSVG(doc), /viewBox="-10 -110 120 120"/); assert.match(toDXF(doc), /EOF/);
  doc.entities.push({ id: 'broken', type: 'circle', c: [0, 0], r: Infinity });
  assert.throws(() => toDXF(doc), /Cannot export/); assert.throws(() => toSVG(doc), /Cannot export/);
});
