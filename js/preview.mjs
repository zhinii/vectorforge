// Local, transactional AI proposals. The provider only receives serializeScene;
// raster underlays, user annotations, and reconstruction records stay local.
import { applyOps } from './model.mjs?v=20261024-14';
export { reconcileSketches } from './sketch.mjs?v=20261024-14';

export const MAX_PREVIEW_OPS = 24;
const previews = new WeakMap();
const copy = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
// Content, not selection or viewport, determines whether a proposal is stale.
// Keep the exact baseline private: a public fingerprint must not embed images.
function content(doc) {
  return JSON.stringify({ entities: doc.entities, timeline: doc.timeline,
    references: doc.references || [], annotations: doc.annotations || [], sketches: doc.sketches || {} });
}
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
export function designContentSignature(doc) { return fingerprint(content(doc)); }

export function createDesignPreview(doc, ops) {
  if (!Array.isArray(ops) || ops.length > MAX_PREVIEW_OPS) throw Error('preview_operation_limit');
  const baseline = content(doc);
  const candidate = { entities: copy(doc.entities), timeline: copy(doc.timeline), selectedId: doc.selectedId };
  // applyOps validates the entire bounded batch before committing to this clone.
  // It can reserve IDs, but never mutates the live document or its undo history.
  const result = applyOps(candidate, ops, 'ai');
  const sketches = copy(doc.sketches || {}), invalidatedSketchGroups = [];
  for (const group of Object.keys(sketches)) {
    const before = doc.entities.filter(e => e.group === group);
    const after = candidate.entities.filter(e => e.group === group);
    if (!before.length || JSON.stringify(before) !== JSON.stringify(after)) {
      delete sketches[group]; invalidatedSketchGroups.push(group);
    }
  }
  candidate.sketches = sketches;
  const preview = freeze({ entities: copy(candidate.entities), timeline: copy(candidate.timeline),
    created: result.created.slice(), touched: result.touched.slice(),
    baselineFingerprint: fingerprint(baseline), invalidatedSketchGroups: invalidatedSketchGroups.slice() });
  previews.set(preview, { doc, baseline, candidate, result, invalidatedSketchGroups, consumed: false });
  return preview;
}

// Validate immediately before recording undo; accept validates again itself.
export function validateDesignPreview(doc, preview) {
  const entry = preview && previews.get(preview);
  if (!entry || entry.consumed || entry.doc !== doc) throw Error('preview_unavailable');
  // Compare full private baseline, not the non-cryptographic display fingerprint.
  if (entry.baseline !== content(doc)) throw Error('preview_stale');
  return true;
}
export function acceptDesignPreview(doc, preview) {
  validateDesignPreview(doc, preview);
  const entry = previews.get(preview);
  // Finish all allocations before replacing the live state. Existing local image
  // and annotation arrays remain untouched, and selection-only edits are allowed.
  const entities = copy(entry.candidate.entities), timeline = copy(entry.candidate.timeline);
  const sketches = copy(entry.candidate.sketches);
  const selectedId = entities.some(e => e.id === doc.selectedId) ? doc.selectedId : null;
  Object.assign(doc, { entities, timeline, sketches, selectedId });
  entry.consumed = true;
  return { created: entry.result.created.slice(), touched: entry.result.touched.slice(),
    invalidatedSketchGroups: entry.invalidatedSketchGroups.slice() };
}
export const applyDesignPreview = acceptDesignPreview;
export function discardDesignPreview(preview) {
  const entry = preview && previews.get(preview);
  if (entry) entry.consumed = true;
}
