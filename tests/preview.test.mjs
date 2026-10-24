import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, applyOps, serializeScene } from '../js/model.mjs';
import { createDesignPreview, validateDesignPreview, acceptDesignPreview, discardDesignPreview, designContentSignature } from '../js/preview.mjs';
const fixture = () => {
  const doc = createDoc();
  applyOps(doc, [{ op: 'rect', center: [0, 0], width: 20, height: 10, group: 'panel' }]);
  doc.references = [{ id: 'image', dataURL: 'local private raster', width: 10 }];
  doc.annotations = [{ id: 'note', text: 'local private note' }];
  doc.sketches = { panel: { kind: 'local-reconstruction' } };
  return doc;
};
test('AI proposal leaves the live drawing and all local-only data unchanged until accepted', () => {
  const doc = fixture(), snapshot = structuredClone(doc), refs = doc.references, notes = doc.annotations;
  const preview = createDesignPreview(doc, [{ op: 'circle', center: [30, 5], radius: 3 }]);
  assert.deepEqual(doc, snapshot);
  assert.equal(preview.entities.length, 2);
  assert.equal(preview.created.length, 1);
  assert.doesNotMatch(JSON.stringify(preview), /local private|dataURL|local-reconstruction/);
  assert.doesNotMatch(JSON.stringify(serializeScene(doc)), /local private|dataURL|local-reconstruction/);
  const result = acceptDesignPreview(doc, preview);
  assert.deepEqual(result.created, preview.created);
  assert.deepEqual(doc.entities, preview.entities);
  assert.equal(doc.references, refs); assert.equal(doc.annotations, notes);
  assert.deepEqual(doc.sketches, snapshot.sketches);
  assert.equal(doc.timeline.at(-1).source, 'ai');
  assert.throws(() => acceptDesignPreview(doc, preview), /preview_unavailable/);
});
test('selection and view changes are allowed without discarding the current selection', () => {
  const doc = fixture(), preview = createDesignPreview(doc, [{ op: 'circle', radius: 3 }]);
  const signature = designContentSignature(doc);
  doc.selectedId = doc.entities[0].id; doc.view = { scale: 40 };
  assert.equal(designContentSignature(doc), signature);
  assert.equal(validateDesignPreview(doc, preview), true);
  acceptDesignPreview(doc, preview);
  assert.equal(doc.selectedId, doc.entities[0].id);
});
test('geometry, reference, annotation, registry and history edits invalidate a proposal without mutation', () => {
  const edits = [d => d.entities[0].w++, d => d.references[0].width++, d => d.annotations[0].text += '!',
    d => d.sketches.panel.kind = 'changed', d => d.timeline.push({ text: 'changed' })];
  for (const edit of edits) {
    const doc = fixture(), preview = createDesignPreview(doc, [{ op: 'circle', radius: 3 }]);
    edit(doc); const snapshot = structuredClone(doc);
    assert.throws(() => validateDesignPreview(doc, preview), /preview_stale/);
    assert.throws(() => acceptDesignPreview(doc, preview), /preview_stale/);
    assert.deepEqual(doc, snapshot);
  }
});
test('failed or excessive operations leave live state unchanged', () => {
  const doc = fixture(), snapshot = structuredClone(doc);
  assert.throws(() => createDesignPreview(doc, [{ op: 'clear' }, { op: 'circle', radius: -1 }]));
  assert.throws(() => createDesignPreview(doc, Array.from({ length: 25 }, () => ({ op: 'clear' }))), /preview_operation_limit/);
  assert.throws(() => createDesignPreview(doc, [{ op: 'surprise' }]));
  assert.deepEqual(doc, snapshot);
});
test('clear and deletion previews preserve local underlays but remove dead reconstruction constraints', () => {
  for (const op of ['clear', 'delete', 'move', 'set_dimension', 'set_metadata']) {
    const doc = fixture(), snapshot = structuredClone(doc);
    const preview = createDesignPreview(doc, [{ op, id: doc.entities[0].id, to: [30, 30], dimension: 'width', value: 40, group: 'changed' }]);
    assert.deepEqual(doc, snapshot);
    assert.deepEqual(preview.invalidatedSketchGroups, ['panel']);
    acceptDesignPreview(doc, preview);
    assert.deepEqual(doc.sketches, {});
    assert.deepEqual(doc.references, snapshot.references);
    assert.deepEqual(doc.annotations, snapshot.annotations);
  }
});
test('a proposal cannot be forged, transplanted, modified or accepted after cancellation', () => {
  const doc = fixture(), preview = createDesignPreview(doc, [{ op: 'circle', radius: 3 }]);
  assert.throws(() => acceptDesignPreview(doc, { ...preview }), /preview_unavailable/);
  assert.throws(() => acceptDesignPreview(structuredClone(doc), preview), /preview_unavailable/);
  assert.throws(() => { preview.entities[0].w = 999; });
  discardDesignPreview(preview);
  assert.throws(() => acceptDesignPreview(doc, preview), /preview_unavailable/);
});
test('new entities in a constrained group invalidate its registry; unrelated edits do not', () => {
  const doc = fixture(), preview = createDesignPreview(doc, [{ op: 'circle', radius: 3, group: 'panel' }]);
  acceptDesignPreview(doc, preview); assert.deepEqual(doc.sketches, {});
});
