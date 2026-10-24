// Advisory fabrication checks only. This is not a machine-safety certification.
import { entityPoints, isClosed, arcAngles, entityLayer, dist, MAX_SCENE_ENTITIES, MAX_SCENE_POINTS, assertSceneBudget } from './model.mjs?v=20261024-14';
import { checkEntity, extentPoints } from './dxf.mjs?v=20261024-14';

export const TINY_SEGMENT_MM = 0.01;
export const MAX_INTERSECTION_CHECKS = 200000;
const pointKey = p => `${Object.is(p[0], -0) ? 0 : p[0]},${Object.is(p[1], -0) ? 0 : p[1]}`;
// Least lexicographic cyclic rotation in linear time (Booth's algorithm).
function rotation(a) {
  const n = a.length;
  let i = 0, j = 1, k = 0;
  while (i < n && j < n && k < n) {
    const x = a[(i + k) % n], y = a[(j + k) % n];
    if (x === y) { k++; continue; }
    if (x > y) { i += k + 1; if (i === j) i++; }
    else { j += k + 1; if (i === j) j++; }
    k = 0;
  }
  const start = Math.min(i, j);
  return a.slice(start).concat(a.slice(0, start)).join(';');
}
function geometryKey(e, points) {
  if (e.type === 'circle' || (e.type === 'arc' && arcAngles(e).sweep === 360)) return `circle:${pointKey(e.c)}:${e.r}`;
  if (e.type === 'arc') { const a = arcAngles(e); return `arc:${pointKey(e.c)}:${e.r}:${a.start}:${a.sweep}`; }
  if (e.type === 'text') return `text:${pointKey(e.c)}:${e.size}:${e.text}`;
  if (e.type === 'bezier') {
    const a = [e.p1, e.c1, e.c2, e.p2].map(pointKey);
    return 'bezier:' + [a.join(';'), a.reverse().join(';')].sort()[0];
  }
  const closed = isClosed(e), a = points.map(pointKey);
  // Repeated closing coordinates and implicit closing flags describe one ring.
  if (closed && a.length > 1 && a[0] === a.at(-1)) a.pop();
  const forward = closed ? rotation(a) : a.join(';');
  const reverse = closed ? rotation(a.reverse()) : a.reverse().join(';');
  return `${closed ? 'closed' : 'open'}:${forward < reverse ? forward : reverse}`;
}
function orientation(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.sign(v);
}
const inBox = (p, a, b) => p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function intersects(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const x = orientation(a, b, c), y = orientation(a, b, d), z = orientation(c, d, a), w = orientation(c, d, b);
  return (x * y < 0 && z * w < 0) || (!x && inBox(c, a, b)) || (!y && inBox(d, a, b)) || (!z && inBox(a, c, d)) || (!w && inBox(b, c, d));
}
export function preflight(doc, { bedWidth, bedHeight } = {}) {
  const issues = [], counts = { total: 0, exported: 0, cut: 0, engrave: 0, reference: 0 }, seen = new Map();
  const add = (code, severity, e, detail) => issues.push({ code, severity, entityId: e?.id ?? null, detail });
  const limitations = ['Advisory checks do not validate material, kerf, tooling, machine settings, fixturing, or fire safety.',
    'Self-intersections are checked within individual paths, not between different entities. Bézier checks use bounded sampled curves; SVG curves remain exact.',
    'Bed fit compares drawing width and height without rotation or nesting; it does not validate machine origin or placement.'];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, comparisons = 0, incomplete = false;
  const entities = Array.isArray(doc?.entities) ? doc.entities : [];
  const units = doc?.units ?? 'mm';
  if (units !== 'mm') add('units_mismatch', 'error', null, `Expected millimetres; document declares ${String(units)}.`);
  if (!Array.isArray(doc?.entities)) add('invalid_scene', 'error', null, 'Scene entities must be an array.');
  try { assertSceneBudget(entities, { validateEntity: checkEntity }); }
  catch (error) {
    add(error.code === 'SCENE_LIMIT' ? 'scene_limit' : 'invalid_geometry', 'error', { id: error.entityId }, error.message);
    counts.total = entities.length;
    return { units, bounds: null, issues, counts, limitations };
  }
  for (const e of entities.slice(0, MAX_SCENE_ENTITIES)) {
    counts.total++;
    if (e?.layer === 'reference') {
      counts.reference++;
      add('reference_excluded', 'info', e, 'Reference geometry is excluded from default SVG/DXF fabrication exports.');
      continue;
    }
    try { checkEntity(e); } catch (error) { add('invalid_geometry', 'error', e, error.message); continue; }
    counts.exported++; counts[entityLayer(e)]++;
    for (const [x, y] of extentPoints(e)) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    let points = entityPoints(e);
    const closed = isClosed(e) || (e.type === 'arc' && arcAngles(e).sweep === 360);
    if (e.type === 'text') add('text_not_outlined', 'warning', e, 'Editable text is font-dependent, not an outlined cutting path. Convert to verified outlines before cutting.');
    else if (entityLayer(e) === 'cut' && !closed) add('open_cut_path', 'warning', e, 'Cut geometry is open. Confirm an intentional slit/score or close the contour.');
    const key = geometryKey(e, points);
    if (seen.has(key)) add('duplicate_geometry', 'warning', e, `Geometry duplicates ${seen.get(key)} and could be processed twice (including across layers).`);
    else seen.set(key, e.id);
    if (e.type === 'text') continue;
    if (closed && points.length > 1 && pointKey(points[0]) === pointKey(points.at(-1))) points = points.slice(0, -1);
    if (closed && !['arc', 'circle'].includes(e.type)) {
      const origin = points[0];
      let twiceArea = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        twiceArea += (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
      }
      if (Math.abs(twiceArea) / 2 < TINY_SEGMENT_MM ** 2)
        add('tiny_area', 'warning', e, `Closed contour has signed area below ${TINY_SEGMENT_MM ** 2} mm². Check collapsed geometry or cancelling self-intersections.`);
    }
    const segmentCount = closed ? points.length : points.length - 1;
    // A sampled full arc repeats its first coordinate; avoid its fictitious extra closing segment.
    const n = e.type === 'arc' && !closed ? points.length - 1 : segmentCount;
    let tiny = 0;
    for (let i = 0; i < n; i++) if (dist(points[i], points[(i + 1) % points.length]) < TINY_SEGMENT_MM) tiny++;
    if (tiny) add('tiny_segment', 'warning', e, `${tiny} segment(s) shorter than ${TINY_SEGMENT_MM} mm${['bezier', 'arc', 'circle'].includes(e.type) ? ' in sampled curve' : ''}; review geometry and machine resolution.`);
    if (['circle', 'arc'].includes(e.type)) continue;
    // Consecutive segments normally share just one endpoint. Collinear
    // backtracking shares an interval and is also a self-overlap.
    let crossing = false;
    for (let i = 0; i < (closed ? points.length : points.length - 2); i++) {
      const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
      if (orientation(a, b, c) === 0 && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0) { crossing = true; break; }
    }
    for (let i = 0; i < n && !crossing; i++) {
      for (let j = i + 2; j < n; j++) {
        if (closed && i === 0 && j === n - 1) continue;
        if (comparisons >= MAX_INTERSECTION_CHECKS) { incomplete = true; break; }
        comparisons++;
        if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) { crossing = true; break; }
      }
      if (incomplete) break;
    }
    if (crossing) add('self_intersection', 'warning', e, 'Non-adjacent segments cross, overlap, or touch. Review the intended fabrication contour.');
  }
  if (incomplete) add('intersection_check_incomplete', 'warning', null, `Self-intersection analysis reached its ${MAX_INTERSECTION_CHECKS}-comparison limit. Remaining geometry needs review.`);
  const bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } : null;
  if (!counts.exported) add('no_export_geometry', 'warning', null, 'No valid non-reference geometry is available for fabrication export.');
  for (const [key, value, span] of [['bedWidth', bedWidth, bounds?.width], ['bedHeight', bedHeight, bounds?.height]]) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) add('invalid_bed_size', 'error', null, `${key} must be a finite positive number in mm.`);
    else if (span > value) add('bed_exceeded', 'warning', null, `Drawing ${key === 'bedWidth' ? 'width' : 'height'} ${span} mm exceeds ${key} ${value} mm.`);
  }
  return { units, bounds, issues, counts, limitations };
}
