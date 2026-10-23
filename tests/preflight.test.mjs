import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, createDoc, applyOps } from '../js/model.mjs';
import { preflight, MAX_INTERSECTION_CHECKS } from '../js/preflight.mjs';
const doc = (...entities) => ({ entities });
const path = (points, more = {}) => makeEntity('path', { points, ...more });
const codes = result => result.issues.map(i => i.code);

test('preflight is pure, structured, unit-aware, and never certifies readiness', () => {
  const d = createDoc(); applyOps(d, [{ op: 'rect', width: 40, height: 20 }]);
  const before = JSON.stringify(d), r = preflight(d, { bedWidth: 100, bedHeight: 50 });
  assert.equal(JSON.stringify(d), before); assert.equal(r.units, 'mm');
  assert.deepEqual(r.bounds, { minX: -20, minY: -10, maxX: 20, maxY: 10, width: 40, height: 20 });
  assert.deepEqual(r.issues, []); assert.equal(r.counts.cut, 1); assert.ok(r.limitations.length >= 2);
  assert.equal(r.ready, undefined); assert.equal(r.safe, undefined);
  assert.ok(codes(preflight({ units: 'in', entities: d.entities })).includes('units_mismatch'));
});

test('cut open contours are warnings; engraving and exact full-turn arcs are not', () => {
  const open = path([[0, 0], [10, 0]]), engraving = path([[0, 1], [10, 1]], { layer: 'engrave' });
  const full = makeEntity('arc', { start: 32, end: 392 }), nearly = makeEntity('arc', { start: 32, end: 391.99999999 });
  const r = preflight(doc(open, engraving, full, nearly));
  assert.deepEqual(r.issues.filter(i => i.code === 'open_cut_path').map(i => i.entityId), [open.id, nearly.id]);
  assert.equal(r.issues.some(i => i.entityId === full.id && i.code === 'tiny_segment'), false);
  for (const issue of r.issues) assert.deepEqual(Object.keys(issue).sort(), ['code', 'detail', 'entityId', 'severity']);
});

test('references are reported but never affect bounds, duplicate checks, or bed fit', () => {
  const reference = path([[1e6, 1e6], [2e6, 2e6]], { layer: 'reference' });
  const r = preflight(doc(makeEntity('circle', { center: [5, 6], radius: 2 }), reference), { bedWidth: 5, bedHeight: 5 });
  assert.equal(r.bounds.width, 4); assert.equal(r.bounds.height, 4); assert.equal(r.counts.reference, 1); assert.equal(r.counts.exported, 1);
  assert.deepEqual(codes(r), ['reference_excluded']);
  const only = preflight(doc(reference)); assert.equal(only.bounds, null); assert.ok(codes(only).includes('no_export_geometry'));
});

test('duplicate checks detect reversed open paths and rotated/reversed closed rings across layers', () => {
  const a = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const r = preflight(doc(path(a), path(a.slice().reverse()), path(a, { closed: true }),
    path([a[2], a[1], a[0], a[3]], { closed: true, layer: 'engrave' }),
    path([...a, a[0]], { closed: true })));
  assert.equal(r.issues.filter(i => i.code === 'duplicate_geometry').length, 3);
  assert.ok(r.issues.filter(i => i.code === 'duplicate_geometry').every(i => /duplicates e\d+/.test(i.detail)));
});

test('duplicate circles/full arcs and reversed Bézier controls are detected exactly', () => {
  const a = makeEntity('bezier'), b = makeEntity('bezier', { from: a.p2, control1: a.c2, control2: a.c1, to: a.p1 });
  const r = preflight(doc(a, b, makeEntity('circle'), makeEntity('arc', { start: 20, end: 380 })));
  assert.equal(r.issues.filter(i => i.code === 'duplicate_geometry').length, 2);
});

test('tiny segments, collapsed area, and text needing outlines are explicit warnings', () => {
  const r = preflight(doc(path([[0, 0], [0.001, 0], [1, 0]], { closed: true }), makeEntity('text', { text: 'Label' })));
  for (const code of ['tiny_segment', 'tiny_area', 'text_not_outlined']) assert.ok(codes(r).includes(code));
  assert.ok(r.issues.every(i => i.severity === 'warning'));
});

test('self-crossings, nonadjacent contacts and collinear overlaps are caught; simple rings are not', () => {
  const simple = path([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
  const repeatedClosure = path([...simple.points, simple.points[0]], { closed: true });
  const bow = path([[0, 0], [10, 10], [0, 10], [10, 0]], { closed: true });
  const overlap = path([[0, 0], [10, 0], [10, 1], [3, 0], [8, 0]]);
  const r = preflight(doc(simple, repeatedClosure, bow, overlap));
  assert.deepEqual(r.issues.filter(i => i.code === 'self_intersection').map(i => i.entityId), [bow.id, overlap.id]);
});

test('intersection workload is bounded and incomplete checks are disclosed', () => {
  const p = Array.from({ length: 1000 }, (_, i) => [i, i * i]);
  const r = preflight(doc(path(p)));
  assert.ok(MAX_INTERSECTION_CHECKS <= 200000); assert.ok(codes(r).includes('intersection_check_incomplete'));
});

test('bed checks compare actual dimensions and validate each bed input', () => {
  const d = doc(makeEntity('rect', { width: 40, height: 20 }));
  assert.equal(preflight(d, { bedWidth: 39, bedHeight: 19 }).issues.filter(i => i.code === 'bed_exceeded').length, 2);
  assert.equal(preflight(d, { bedWidth: 40, bedHeight: 20 }).issues.length, 0);
  for (const bad of [0, -1, NaN, Infinity, '100']) assert.ok(codes(preflight(d, { bedWidth: bad })).includes('invalid_bed_size'));
});

test('invalid and oversized scenes fail visibly without unbounded work', () => {
  assert.ok(codes(preflight({})).includes('invalid_scene'));
  assert.ok(codes(preflight(doc({ type: 'path', points: [[0, 0], [NaN, 0]], closed: false }))).includes('invalid_geometry'));
  const huge = path(Array.from({ length: 4096 }, (_, i) => [i, 0]));
  const r = preflight(doc(...Array(5).fill(huge))); assert.deepEqual(codes(r), ['scene_limit']); assert.equal(r.bounds, null);
});

test('adjacent collinear backtracking is reported as overlap, but a straight continuation is not', () => {
  const back = path([[0, 0], [10, 0], [5, 0]]), forward = path([[0, 0], [5, 0], [10, 0]]);
  assert.deepEqual(preflight(doc(back, forward)).issues.filter(i => i.code === 'self_intersection').map(i => i.entityId), [back.id]);
});

test('preflight shares the actual aggregate curve expansion budget and does not analyze oversized scenes', () => {
  const huge = makeEntity('bezier', { from: [-1e12, -1e12], control1: [-1e12, 1e12], control2: [1e12, 1e12], to: [1e12, -1e12] });
  const r = preflight(doc(...Array(2000).fill(huge)));
  assert.deepEqual(codes(r), ['scene_limit']); assert.match(r.issues[0].detail, /expanded geometry points/);
  assert.equal(r.bounds, null); assert.equal(r.counts.exported, 0);
});
