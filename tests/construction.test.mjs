import test from 'node:test';
import assert from 'node:assert/strict';
import { constructionPreview } from '../js/construction.mjs';

const at = (curve, t) => [0, 1].map(k => (1 - t) ** 3 * curve.p1[k] +
  3 * (1 - t) ** 2 * t * curve.c1[k] + 3 * (1 - t) * t ** 2 * curve.c2[k] + t ** 3 * curve.p2[k]);
const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('inactive tools and invalid pending geometry have no preview', () => {
  for (const [tool, pending] of [['line', { start: [0, 0] }], ['arc', null], ['bezier', {}],
    ['bezier', { start: [NaN, 0] }], ['bezier', { start: [0, 0], control1: [Infinity, 0] }],
    ['bezier', { start: [0, 0], control2: [1, 1] }], ['arc', { start: [0, 0], radius: -1, a0: 0 }],
    ['arc', { start: [0, 0], radius: 10, a0: Infinity }], ['arc', { start: [0, 0], radius: 1e13, a0: 0 }]]) {
    assert.deepEqual(constructionPreview(tool, pending, [2, 3]), { guides: [], curve: null, markers: [], stepKey: '' });
  }
});

test('Bezier first tap is visible even with cursor at the start', () => {
  const p = constructionPreview('bezier', { start: [2, 3] }, [2, 3]);
  assert.equal(p.curve, null);
  assert.deepEqual(p.markers[0], { point: [2, 3], label: 'Start', kind: 'committed' });
  assert.equal(p.markers.length, 1);
  assert.deepEqual(p.guides, []);
  assert.match(p.stepKey, /2\/4/);
});

test('first Bezier handle previews a genuinely curved cubic with tentative defaults', () => {
  const p = constructionPreview('bezier', { start: [0, 0] }, [0, 30]);
  assert.deepEqual(p.curve, { type: 'bezier', p1: [0, 0], c1: [0, 30], c2: [30, 30], p2: [30, 0] });
  assert.deepEqual(at(p.curve, 0.5), [15, 22.5]);
  assert.deepEqual(p.markers.map(m => m.kind), ['committed', 'tentative', 'tentative', 'tentative']);
  assert.equal(p.markers.at(-1).label, 'End (preview)');
  assert.equal(p.guides[0].length, 4);
});

test('second Bezier tap preserves guides and visible bend before another pointer move', () => {
  const pending = { start: [0, 0], control1: [0, 30] };
  const p = constructionPreview('bezier', pending, pending.control1);
  assert.deepEqual(p.curve.c1, [0, 30]);
  assert.deepEqual(p.curve.c2, [0, 30]);
  assert.deepEqual(p.curve.p2, [30, 0]);
  assert.ok(at(p.curve, 0.5)[1] > 0);
  assert.deepEqual(p.markers.map(m => m.kind), ['committed', 'committed', 'tentative', 'tentative']);
  assert.match(p.stepKey, /3\/4/);
  assert.deepEqual(constructionPreview('bezier', pending, null), p);
  const moved = constructionPreview('bezier', pending, [0.000001, 30]);
  assert.ok(Math.hypot(...moved.curve.p2.map((v, i) => v - p.curve.p2[i])) < 0.00001);
});

test('second handle moves independently while suggested endpoint stays tentative', () => {
  const p = constructionPreview('bezier', { start: [0, 0], control1: [0, 30] }, [40, 30]);
  assert.deepEqual(p.curve.c2, [40, 30]);
  assert.deepEqual(p.curve.p2, [40, 0]);
  assert.equal(p.markers.at(-1).kind, 'tentative');
});

test('last Bezier stage exactly matches existing start/control1/control2/end semantics', () => {
  const pending = { start: [0, 0], control1: [0, 30], control2: [40, 30] };
  const p = constructionPreview('bezier', pending, [40, 0]);
  assert.deepEqual(p.curve, { type: 'bezier', p1: [0, 0], c1: [0, 30], c2: [40, 30], p2: [40, 0] });
  assert.deepEqual(p.markers.map(m => m.kind), ['committed', 'committed', 'committed', 'tentative']);
  assert.match(p.stepKey, /4\/4/);
  const stationary = constructionPreview('bezier', pending, pending.control2);
  assert.deepEqual(stationary.curve.p2, [40, 30]);
  assert.equal(stationary.guides[0].length, 4);
  assert.notDeepEqual(at(stationary.curve, 0.5), stationary.curve.p1);
});

test('arc first tap and radius stage retain center and full-circle preview', () => {
  for (const cursor of [[5, 6], [15, 6]]) {
    const p = constructionPreview('arc', { start: [5, 6] }, cursor);
    assert.equal(p.curve.end - p.curve.start, 360);
    assert.equal(p.curve.radius, cursor[0] === 5 ? 0.5 : 10);
    assert.equal(p.guides[0].length, 65);
    assert.deepEqual(p.guides[0][0], p.guides[0].at(-1));
    assert.deepEqual(p.markers[0], { point: [5, 6], label: 'Center', kind: 'committed' });
    assert.equal(p.markers[1].kind, 'tentative');
    assert.match(p.stepKey, /2\/3/);
  }
});

test('arc final stage is CCW in y-up space and wraps through zero', () => {
  const radians = 10 * Math.PI / 180;
  const p = constructionPreview('arc', { start: [0, 0], radius: 10, a0: 350 }, [10 * Math.cos(radians), 10 * Math.sin(radians)]);
  close(p.curve.start, 350); close(p.curve.end, 370);
  close(p.markers.at(-1).point[1], 10 * Math.sin(radians));
  assert.deepEqual(p.markers.map(m => m.kind), ['committed', 'committed', 'tentative']);
  assert.match(p.stepKey, /3\/3/);
});

test('arc radius circle and fixed start persist when cursor matches the last tap', () => {
  const p = constructionPreview('arc', { start: [0, 0], radius: 10, a0: 90 }, [0, 10]);
  close(p.curve.end - p.curve.start, 0);
  assert.equal(p.guides[0].length, 65);
  close(p.markers[1].point[0], 0); close(p.markers[1].point[1], 10);
  assert.equal(p.markers[1].kind, 'committed');
});

test('preview does not mutate, retain, or return references to input geometry', () => {
  for (const tool of ['bezier', 'arc']) {
    const pending = freeze(tool === 'bezier' ? { start: [0, 0], control1: [0, 30], control2: [40, 30] } : { start: [0, 0], radius: 10, a0: 350 });
    const cursor = freeze([40, 0]);
    const before = JSON.stringify({ pending, cursor });
    const p = constructionPreview(tool, pending, cursor);
    p.guides[0][0][0] = 123;
    p.markers[0].point[0] = 456;
    if (tool === 'bezier') p.curve.p1[0] = 789;
    else p.curve.center[0] = 789;
    assert.equal(JSON.stringify({ pending, cursor }), before);
    assert.equal(constructionPreview(tool, pending, cursor).markers[0].point[0], 0);
  }
});

test('degenerate and extreme inputs are finite with constant work bounds', () => {
  const scenarios = [
    ['bezier', { start: [0, 0], control1: [0, 0], control2: [0, 0] }, [0, 0]],
    ['bezier', { start: [-1e12, 1e12] }, [1e12, -1e12]],
    ['bezier', { start: [-1e12, 1e12], control1: [1e12, -1e12] }, [1e12, -1e12]],
    ['arc', { start: [1e12, 1e12], radius: 1e12, a0: 1e12 }, [-1e12, -1e12]],
    ['arc', { start: [-1e12, -1e12] }, [1e12, 1e12]],
  ];
  const check = x => {
    if (typeof x === 'number') assert.ok(Number.isFinite(x) && Math.abs(x) <= 2e12);
    else if (x && typeof x === 'object') Object.values(x).forEach(check);
  };
  for (const args of scenarios) {
    const p = constructionPreview(...args); check(p);
    assert.ok(p.guides.flat().length <= 69);
    assert.ok(p.markers.length <= 4);
  }
});
