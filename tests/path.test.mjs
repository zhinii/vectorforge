import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, applyOps, createDoc, serializeScene, entityPoints, entityDimensions, entityGrips, moveEntity, distanceToEntity, isClosed, MAX_PATH_POINTS, MAX_SCENE_POINTS, MAX_VALUE } from '../js/model.mjs';
import { toSVG, toDXF } from '../js/dxf.mjs';
import { snapCandidates, nearbyMeasurements } from '../js/spatial.mjs';
const points = [[0, 0], [20, 0], [20, 10], [0, 10]];
const path = params => makeEntity('path', { points, closed: true, ...params });

test('paths copy bounded point arrays and validate geometry and fabrication metadata', () => {
  const e = path();
  assert.equal(e.layer, 'cut'); assert.equal(e.group, ''); assert.equal(e.hole, false); assert.equal(isClosed(e), true);
  assert.notStrictEqual(e.points, points); assert.notStrictEqual(e.points[0], points[0]);
  assert.equal(entityPoints(e).length, 4);
  for (const p of [{ points: null }, { points: [[0, 0]] }, { points: [[0, 0], [1, 1]] }, { points: Array(MAX_PATH_POINTS + 1).fill([0, 0]) },
    { points: [[0, 0], [1, NaN], [2, 2]] }, { closed: 'yes' }, { layer: 'CUT' }, { layer: null }, { group: 12 }, { group: null }, { name: 'bad\nname' }, { hole: 1 }]) assert.throws(() => path(p));
  assert.equal(path({ points: Array(MAX_PATH_POINTS).fill([0, 0]) }).points.length, MAX_PATH_POINTS);
  assert.equal(path({ points: [[0, 0], [1, 1]], closed: false }).closed, false);
});

test('path dimensions drive true spans, preserve center, and reject invalid/overflow edits atomically', () => {
  const e = path(), dims = entityDimensions(e);
  assert.deepEqual(dims.map(d => [d.key, d.value]), [['width', 20], ['height', 10]]);
  dims[0].set(40); dims[1].set(6);
  assert.deepEqual(e.points, [[-10, 2], [30, 2], [30, 8], [-10, 8]]);
  const tiny = path({ points: [[0, 0], [1e-12, 0]], closed: false });
  assert.deepEqual(entityDimensions(tiny).map(d => d.key), ['width']);
  entityDimensions(tiny)[0].set(10); assert.equal(tiny.points[1][0] - tiny.points[0][0], 10);
  const collapsed = path({ points: [[2, 2], [2, 2]], closed: false }); assert.deepEqual(entityDimensions(collapsed), []);
  const edge = path({ points: [[MAX_VALUE - 2, 0], [MAX_VALUE, 0]], closed: false }), before = JSON.stringify(edge);
  assert.throws(() => entityDimensions(edge)[0].set(10)); assert.equal(JSON.stringify(edge), before);
  for (const bad of [0, -1, Infinity, null]) assert.throws(() => dims[0].set(bad));
});

test('path moves and grips validate all coordinates before mutating', () => {
  const e = path(); moveEntity(e, [2, 3]); assert.deepEqual(e.points[0], [2, 3]);
  const grips = entityGrips(e); grips[2].set([22, 16]); assert.deepEqual(grips[2].get(), [22, 16]);
  const before = JSON.stringify(e); assert.throws(() => moveEntity(e, [MAX_VALUE, 0])); assert.equal(JSON.stringify(e), before);
  assert.throws(() => grips[0].set([0, NaN])); assert.equal(JSON.stringify(e), before);
  assert.equal(distanceToEntity([2, 8], e), 0);
});

test('path operations retain metadata and rollback nested points, metadata, IDs and selection', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'path', points, closed: true, group: 'panel', hole: true, name: 'pocket' }]);
  const e = doc.entities[0]; doc.selectedId = e.id;
  applyOps(doc, [{ op: 'move', id: e.id, to: [40, 50] }, { op: 'set_metadata', id: e.id, layer: 'engrave' }]);
  assert.deepEqual(e.points[0], [30, 45]); assert.equal(e.layer, 'engrave'); assert.equal(e.group, 'panel');
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [{ op: 'move', id: e.id, to: [0, 0] }, { op: 'set_metadata', id: e.id, group: 'changed' }, { op: 'path', points }, { op: 'set_metadata', id: e.id, layer: 'invalid' }]));
  assert.equal(JSON.stringify(doc), before); assert.strictEqual(doc.entities[0], e);
  applyOps(doc, [{ op: 'path', points }]); assert.equal(Number(doc.entities[1].id.slice(1)), Number(e.id.slice(1)) + 1);
  const serial = serializeScene(doc).entities[0], restored = makeEntity('path', serial);
  assert.deepEqual({ ...restored, id: e.id }, e); serial.points[0][0] = 99; assert.equal(e.points[0][0], 30);
});

test('scene path budget rejects the whole operation batch', () => {
  const doc = createDoc(); const ops = Array.from({ length: Math.floor(MAX_SCENE_POINTS / MAX_PATH_POINTS) + 1 }, () => ({ op: 'path', points: Array(MAX_PATH_POINTS).fill([1, 1]) }));
  assert.throws(() => applyOps(doc, ops), /Scene limit/); assert.deepEqual(doc, createDoc());
});

test('SVG and DXF preserve open/closed geometry and separate fabrication layers without references', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'path', points, closed: true, layer: 'cut', group: 'A<&', hole: true, name: 'piece' },
    { op: 'path', points: [[30, 0], [40, 0]], layer: 'engrave' }, { op: 'path', points: [[900, 900], [1000, 900]], layer: 'reference' }]);
  const svg = toSVG(doc), dxf = toDXF(doc);
  assert.match(svg, /data-layer="cut"/); assert.match(svg, /data-layer="engrave"/); assert.doesNotMatch(svg, /data-layer="reference"|900/);
  assert.match(svg, /M0 0 L20 0 L20 -10 L0 -10Z/); assert.match(svg, /M30 0 L40 0"/); assert.match(svg, /data-group="A&lt;&amp;" data-hole="true" data-name="piece"/);
  assert.match(dxf, /AcDbEntity\n8\ncut\n100\nAcDbPolyline\n90\n4\n70\n1/);
  assert.match(dxf, /AcDbEntity\n8\nengrave\n100\nAcDbPolyline\n90\n2\n70\n0/); assert.doesNotMatch(dxf, /\n900\n/);
  assert.match(toSVG(doc, { includeReference: true }), /data-layer="reference"/);
  assert.match(toDXF(doc, { includeReference: true }), /AcDbEntity\n8\nreference/);
  for (const bad of [{ ...doc.entities[0], closed: 'false' }, { ...doc.entities[0], group: 'x\n0' }, { ...doc.entities[0], points: [[0, Infinity]] }]) {
    assert.throws(() => toSVG({ entities: [bad] })); assert.throws(() => toDXF({ entities: [bad] }));
  }
});

test('path snapping and measurements use actual segments and no closing edge for open paths', () => {
  const e = path({ closed: false });
  assert.ok(snapCandidates([10, 0], [e]).some(c => c.kind === 'midpoint'));
  assert.equal(distanceToEntity([0, 5], e), 5);
  assert.ok(nearbyMeasurements(e, [makeEntity('line', { from: [0, -5], to: [20, -5] })]).some(m => m.clearance === 5));
});

test('aggregate expansion budget counts every primitive and stops before sampling a giant scene', async () => {
  const { assertSceneBudget, MAX_SCENE_RENDER_POINTS } = await import('../js/model.mjs');
  const huge = makeEntity('bezier', { from: [-MAX_VALUE, -MAX_VALUE], control1: [-MAX_VALUE, MAX_VALUE], control2: [MAX_VALUE, MAX_VALUE], to: [MAX_VALUE, -MAX_VALUE] });
  const count = entityPoints(huge).length;
  assert.ok(count > 4000);
  const many = Array(2000).fill(huge);
  let visits = 0;
  assert.throws(() => assertSceneBudget(many, { validateEntity: () => { visits++; } }), /expanded geometry points/);
  assert.equal(visits, Math.floor(MAX_SCENE_RENDER_POINTS / count) + 1);
  const mixed = [huge, makeEntity('circle'), makeEntity('arc'), makeEntity('rect'), makeEntity('star'), makeEntity('polygon'), makeEntity('line'), makeEntity('text'), path()];
  assert.equal(assertSceneBudget(mixed).points, mixed.reduce((n, e) => n + entityPoints(e).length, 0));
  assert.equal(assertSceneBudget(mixed).pathPoints, 4);
  assert.throws(() => assertSceneBudget(Array(1000).fill(makeEntity('circle'))), /expanded geometry points/);
});

test('oversized cubic operation batches restore geometry, timeline, selection, references and IDs', () => {
  const d = createDoc(); applyOps(d, [{ op: 'rect', width: 12 }]);
  const existing = d.entities[0]; d.selectedId = existing.id;
  const before = JSON.stringify(d);
  const huge = { op: 'bezier', from: [-MAX_VALUE, -MAX_VALUE], control1: [-MAX_VALUE, MAX_VALUE], control2: [MAX_VALUE, MAX_VALUE], to: [MAX_VALUE, -MAX_VALUE] };
  assert.throws(() => applyOps(d, [{ op: 'move', id: existing.id, to: [100, 100] }, ...Array(2000).fill(huge)]), /expanded geometry points/);
  assert.equal(JSON.stringify(d), before); assert.strictEqual(d.entities[0], existing);
  applyOps(d, [{ op: 'line' }]); assert.equal(Number(d.entities[1].id.slice(1)), Number(existing.id.slice(1)) + 1);
});

test('both export formats reject aggregate curve expansion and malformed scenes before allocation', () => {
  const huge = makeEntity('bezier', { from: [-MAX_VALUE, -MAX_VALUE], control1: [-MAX_VALUE, MAX_VALUE], control2: [MAX_VALUE, MAX_VALUE], to: [MAX_VALUE, -MAX_VALUE] });
  for (const exporter of [toSVG, toDXF]) {
    assert.throws(() => exporter({ entities: Array(2000).fill(huge) }), /Cannot export.*expanded geometry points/);
    for (const bad of [null, {}, { entities: null }, { entities: [null] }, { entities: [{ type: 'polygon', c: [0, 0], R: 10, rot: 0, n: 1e9 }] },
      { entities: [{ type: 'path', points: {}, closed: true }] }, { entities: [{ ...huge, c1: [NaN, 0] }] }]) assert.throws(() => exporter(bad), /Cannot export/);
  }
});
