import test from 'node:test';
import assert from 'node:assert/strict';
import { simplifyGuidedSegment } from '../js/guided-simplify.mjs';

const opts = { width: 256, height: 256 };
const uv = (x, y, width = 256, height = 256) => [x / (width - 1), y / (height - 1)];
const pixels = (points, options = opts) => points.map(([x, y]) => [x * (options.width - 1), y * (options.height - 1)]);
function pointToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distanceToPolyline(point, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, pointToSegment(point, line[i - 1], line[i]));
  return best;
}
function assertErrorBound(input, output, options = opts, tolerance = 1.5) {
  const original = pixels(input, options), simplified = pixels(output, options);
  for (const [source, target] of [[original, simplified], [simplified, original]]) {
    for (let i = 1; i < source.length; i++) for (let step = 0; step <= 16; step++) {
      const t = step / 16, a = source[i - 1], b = source[i];
      const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      assert.ok(distanceToPolyline(point, target) <= tolerance + 1e-10, 'continuous sampled error is within tolerance in both directions');
    }
  }
}

test('nearly straight traces reduce to exact, independently copied user anchors', () => {
  const input = Array.from({ length: 201 }, (_, i) => uv(20 + i, 50 + .5 * Math.sin(i)));
  const snapshot = structuredClone(input);
  input.forEach(Object.freeze); Object.freeze(input);
  const result = simplifyGuidedSegment(input, opts);
  assert.deepEqual(result, [input[0], input.at(-1)]);
  assert.notStrictEqual(result[0], input[0]);
  assert.notStrictEqual(result.at(-1), input.at(-1));
  assert.deepEqual(input, snapshot);
  assertErrorBound(input, result);
});

test('smooth circular chains become a small set of editable polyline points', () => {
  const input = Array.from({ length: 501 }, (_, i) => {
    const theta = Math.PI * i / 500;
    return uv(128 + 90 * Math.cos(theta), 128 + 90 * Math.sin(theta));
  });
  const result = simplifyGuidedSegment(input, opts);
  assert.ok(result.length >= 8 && result.length <= 24, `${result.length} output points`);
  assert.deepEqual(result[0], input[0]);
  assert.deepEqual(result.at(-1), input.at(-1));
  assertErrorBound(input, result);
});

test('large right-angle corners remain but one-pixel staircase corners do not', () => {
  const input = [];
  for (let x = 20; x <= 100; x++) input.push(uv(x, 20));
  for (let y = 21; y <= 100; y++) input.push(uv(100, y));
  for (let x = 101; x <= 200; x++) input.push(uv(x, 100));
  const result = simplifyGuidedSegment(input, opts);
  assert.deepEqual(result, [uv(20, 20), uv(100, 20), uv(100, 100), uv(200, 100)]);
  const stairs = [uv(20, 20)];
  for (let i = 21; i <= 200; i++) stairs.push(uv(i, i - 1), uv(i, i));
  assert.deepEqual(simplifyGuidedSegment(stairs, opts), [stairs[0], stairs.at(-1)]);
  assertErrorBound(stairs, simplifyGuidedSegment(stairs, opts));
});

test('pixel metric respects prepared dimensions and anisotropic images', () => {
  const input = [[0, 0], [.5, .08], [1, 0]];
  assert.equal(simplifyGuidedSegment(input, { width: 256, height: 16 }).length, 2);
  assert.equal(simplifyGuidedSegment(input, { width: 16, height: 256 }).length, 3);
  // Pixel centers span width-1 and height-1, matching the existing tracer.
  assert.equal(simplifyGuidedSegment([[0, 0], [.5, 1], [1, 0]], { width: 2, height: 2, tolerancePx: 1 }).length, 2);
});

test('point caps fail closed instead of dropping corners or raising tolerance', () => {
  const input = Array.from({ length: 300 }, (_, i) => [i / 299, i % 2 ? .9 : .1]);
  assert.throws(() => simplifyGuidedSegment(input, opts), /point cap/);
  assert.throws(() => simplifyGuidedSegment([[0, 0], [.5, 1], [1, 0]], { ...opts, maxPoints: 2 }), /point cap/);
  assert.equal(simplifyGuidedSegment([[0, 0], [.5, 1], [1, 0]], { ...opts, maxPoints: 3 }).length, 3);
  const boundary = Array.from({ length: 256 }, (_, i) => [i / 255, i % 2 ? .9 : .1]);
  assert.equal(simplifyGuidedSegment(boundary, { ...opts, tolerancePx: 0 }).length, 256);
});

test('degenerate, duplicate, reversing, and coincident-anchor chains stay bounded', () => {
  for (const input of [
    [[.1, .1], [.1, .1]],
    [[.1, .1], [.1, .1], [.1, .1]],
    [[.1, .1], [.9, .1], [.2, .1]],
    [[.1, .1], [.9, .1], [.9, .9], [.1, .1]],
  ]) {
    const result = simplifyGuidedSegment(input, opts);
    assert.deepEqual(result[0], input[0]);
    assert.deepEqual(result.at(-1), input.at(-1));
    assertErrorBound(input, result);
  }
  const reverse = [[.1, .1], [.9, .1], [.2, .1]];
  assert.deepEqual(simplifyGuidedSegment(reverse, opts), reverse, 'uses distance to a segment, not an infinite line');
});

test('validates malformed coordinates and bounded inputs before allocation', () => {
  for (const input of [null, {}, [], [[0, 0]], new Array(2001), [[0, 0], null], [[0, 0], [NaN, 0]],
    [[0, 0], [0, Infinity]], [[0, 0], [-.1, 0]], [[0, 0], [0, 1.1]], [[0, 0], [0]],
    [[0, 0], [0, 0, 0]], [[0, 0], ['0', 0]], [[0, 0], new Array(2)]]) {
    assert.throws(() => simplifyGuidedSegment(input, opts), RangeError);
  }
  const input = Array.from({ length: 2000 }, (_, i) => [i / 1999, .5]);
  assert.equal(simplifyGuidedSegment(input, opts).length, 2);
});

test('validates dimensions, tolerance, options, and hard output ceiling', () => {
  const input = [[0, 0], [1, 1]];
  for (const key of ['width', 'height']) for (const value of [undefined, null, 1, 321, 5.5, Infinity, NaN, '256']) {
    assert.throws(() => simplifyGuidedSegment(input, { ...opts, [key]: value }), RangeError);
  }
  assert.throws(() => simplifyGuidedSegment(input, { width: 320, height: 320 }), /pixels/);
  for (const tolerancePx of [null, -1, NaN, Infinity, '1.5', 1e20]) {
    assert.throws(() => simplifyGuidedSegment(input, { ...opts, tolerancePx }), RangeError);
  }
  for (const maxPoints of [null, 0, 1, 257, 2.5, NaN, Infinity, '256']) {
    assert.throws(() => simplifyGuidedSegment(input, { ...opts, maxPoints }), RangeError);
  }
  for (const options of [null, [], 'options']) assert.throws(() => simplifyGuidedSegment(input, options), TypeError);
  assert.throws(() => simplifyGuidedSegment(input), RangeError);
});

test('zero tolerance and smaller explicit tolerances are never relaxed', () => {
  const input = [[0, 0], [.5, .001], [1, 0]];
  assert.equal(simplifyGuidedSegment(input, opts).length, 2);
  assert.deepEqual(simplifyGuidedSegment(input, { ...opts, tolerancePx: 0 }), input);
  assert.deepEqual(simplifyGuidedSegment(input, { ...opts, tolerancePx: .1 }), input);
});
