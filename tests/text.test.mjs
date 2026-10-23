import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, entityPoints, entityGrips, entityDimensions, distanceToEntity,
  isClosed, moveEntity, createDoc, applyOps, serializeScene, textMetrics,
  MAX_VALUE, MAX_TEXT_SIZE, MAX_TEXT_LENGTH } from '../js/model.mjs';
import { toSVG, toDXF } from '../js/dxf.mjs';

const label = () => makeEntity('text', { at: [10, 20], text: 'Chris', size: 10 });

test('text has a baseline anchor, bounded size, and plain single-line Unicode content', () => {
  const at = [10, 20], e = makeEntity('text', { at, text: 'Chris 陈 😀', size: '12' });
  assert.deepEqual(e.c, at); assert.notStrictEqual(e.c, at);
  assert.equal(e.text, 'Chris 陈 😀'); assert.equal(e.size, 12);
  assert.equal(makeEntity('text').text, 'Text');
  assert.equal(makeEntity('text', { text: '😀'.repeat(MAX_TEXT_LENGTH) }).text.length, MAX_TEXT_LENGTH * 2);
  for (const text of ['', '   ', null, {}, 12, 'a'.repeat(MAX_TEXT_LENGTH + 1), 'x\ny', 'x\ry', 'x\ty', 'x\0y',
    'x\u0085y', 'x\u2028y', 'x\u2029y', 'x\u202Ey', '\uD800', '\uDC00', '\uFFFE', '\uFFFF']) {
    assert.throws(() => makeEntity('text', { text }), /text must/);
  }
  for (const size of [0, -1, NaN, Infinity, null, '', MAX_TEXT_SIZE + 1]) assert.throws(() => makeEntity('text', { size }));
  for (const at of [[NaN, 0], [Infinity, 0], [0, MAX_VALUE + 1], [0], null]) assert.throws(() => makeEntity('text', { at }));
  assert.equal(makeEntity('text', { size: MAX_TEXT_SIZE }).size, MAX_TEXT_SIZE);
});

test('text uses approximate non-path bounds and picks the label interior', () => {
  const e = label(), { width, ascent, descent } = textMetrics(e);
  const pts = entityPoints(e);
  assert.deepEqual(pts, [[10, 20 - descent], [10 + width, 20 - descent], [10 + width, 20 + ascent], [10, 20 + ascent]]);
  assert.equal(isClosed(e), false);
  assert.equal(distanceToEntity([10 + width / 2, 25], e), 0);
  assert.equal(distanceToEntity([7, 25], e), 3);
  assert.equal(distanceToEntity([10, 20 + ascent + 5], e), 5);
  assert.ok(textMetrics(makeEntity('text', { text: '陈' })).width > textMetrics(makeEntity('text', { text: 'i' })).width);
  assert.equal(textMetrics(makeEntity('text', { text: 'e\u0301' })).width, textMetrics(makeEntity('text', { text: 'e' })).width);
});

test('text supports independent position grip, move and font-size dimension', () => {
  const e = label(), grips = entityGrips(e);
  assert.equal(grips.length, 1); assert.equal(grips[0].kind, 'position');
  grips[0].set([20, 30]); assert.deepEqual(grips[0].get(), [20, 30]);
  moveEntity(e, [5, -2]); assert.deepEqual(e.c, [25, 28]);
  const dim = entityDimensions(e)[0];
  assert.equal(dim.key, 'size'); assert.equal(dim.value, 10); assert.equal(dim.label, 'Font size 10 mm');
  dim.set(24); assert.equal(e.size, 24);
  const before = JSON.stringify(e);
  for (const bad of [0, -1, NaN, Infinity, MAX_TEXT_SIZE + 1]) {
    assert.throws(() => dim.set(bad)); assert.equal(JSON.stringify(e), before);
  }
  assert.throws(() => grips[0].set([NaN, 0])); assert.equal(JSON.stringify(e), before);
  assert.throws(() => moveEntity(e, [MAX_VALUE, 0])); assert.equal(JSON.stringify(e), before);
});

test('text operations are transactional, preserve references, and restore IDs on error', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'text', at: [10, 20], text: 'Chris', size: 10 }]);
  const e = doc.entities[0]; doc.selectedId = e.id;
  applyOps(doc, [{ op: 'move', id: e.id, to: [30, 40] }, { op: 'set_dimension', id: e.id, dimension: 'size', value: 18 }]);
  assert.strictEqual(doc.entities[0], e); assert.deepEqual(e.c, [30, 40]); assert.equal(e.size, 18);
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [{ op: 'move', id: e.id, to: [0, 0] }, { op: 'text', text: 'valid' }, { op: 'text', text: 'bad\ntext' }]), /Operation 3:/);
  assert.equal(JSON.stringify(doc), before);
  assert.throws(() => applyOps(doc, [{ op: 'set_dimension', id: e.id, dimension: 'size', value: MAX_TEXT_SIZE + 1 }]));
  assert.equal(JSON.stringify(doc), before);
  applyOps(doc, [{ op: 'text', text: 'next' }]);
  assert.equal(Number(doc.entities[1].id.slice(1)), Number(e.id.slice(1)) + 1);
});

test('text serialization round-trips without sharing anchors; copied entities move independently', () => {
  const doc = createDoc(); applyOps(doc, [{ op: 'text', at: [10, 20], text: 'Chris', size: 10 }]);
  doc.selectedId = doc.entities[0].id;
  const s = serializeScene(doc).entities[0], restored = makeEntity(s.type, s);
  assert.equal(s.selected, true); assert.equal(s.center, undefined);
  assert.deepEqual(s.at, [10, 20]); assert.equal(s.text, 'Chris'); assert.equal(s.size, 10);
  assert.deepEqual({ ...restored, id: s.id }, doc.entities[0]);
  moveEntity(restored, [100, 200]); assert.deepEqual(doc.entities[0].c, [10, 20]);
  s.at[0] = 99; assert.equal(doc.entities[0].c[0], 10);
});

test('SVG emits upright editable text, XML-escapes content and never outlines glyphs', () => {
  const e = makeEntity('text', { at: [10, 20], text: '<script>&"\' Chris 陈 😀', size: 12 });
  const svg = toSVG({ entities: [e] });
  assert.match(svg, /<text x="10" y="-20" font-size="12" font-family="sans-serif"/);
  assert.match(svg, /xml:space="preserve">&lt;script&gt;&amp;&quot;&apos; Chris 陈 😀<\/text>/);
  assert.match(svg, /not outlined cutting paths/);
  assert.doesNotMatch(svg, /<script>|<path\b|<polygon\b/);
  assert.equal((svg.match(/<text\b/g) || []).length, 1);
});

test('DXF uses TEXT, safe Unicode escapes and literal formatting characters', () => {
  const e = makeEntity('text', { at: [10, 20], text: 'Chris 陈 😀 %%%d \\U+0041', size: 12 });
  const dxf = toDXF({ entities: [e] });
  assert.match(dxf, /0\nTEXT\n100\nAcDbEntity\n8\n0\n100\nAcDbText\n10\n10\n20\n20\n30\n0\n40\n12\n1\n/);
  assert.ok(dxf.includes('Chris \\U+9648 \\U+D83D\\U+DE00 \\U+0025\\U+0025\\U+0025d \\U+005CU+0041'));
  assert.match(dxf, /not outlined cutting paths/);
  assert.doesNotMatch(dxf, /\nLWPOLYLINE\n/);
  assert.ok([...dxf].every(char => char.codePointAt(0) <= 127));
  assert.equal(dxf.trim().split('\n').length % 2, 0);
});

test('export rejects injected line controls, illegal XML, malformed sizes and coordinates', () => {
  for (const mutation of [{ text: 'x\n0\nENDSEC' }, { text: '\uFFFF' }, { text: '\uD800' },
    { text: 'x'.repeat(121) }, { size: Infinity }, { size: 0 }, { size: MAX_TEXT_SIZE + 1 }, { c: [NaN, 0] }]) {
    const e = { ...label(), ...mutation };
    assert.throws(() => toDXF({ entities: [e] })); assert.throws(() => toSVG({ entities: [e] }));
  }
});
