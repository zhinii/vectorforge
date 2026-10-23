// VectorForge model. Units are millimetres; world coordinates are y-up.
let seq = 0;
export const nextId = () => 'e' + (++seq);
export const EPS = 1e-6;
// Keep arithmetic and rendering inside a practical, finite CAD working range.
export const MAX_VALUE = 1e12;
export const MAX_TEXT_SIZE = 1e6;
export const MAX_TEXT_LENGTH = 120;
// Plain, single-line Unicode labels. Exclude control/format characters,
// lone surrogates and XML-invalid noncharacters, including DXF line breaks.
export function validateText(value) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > MAX_TEXT_LENGTH ||
      /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\uFFFE\uFFFF]/u.test(value)) {
    throw Error(`text must be 1–${MAX_TEXT_LENGTH} plain Unicode characters on one line without controls`);
  }
  return value;
}
function textSize(value, fallback) {
  const size = positive(value, 'size', fallback);
  if (size > MAX_TEXT_SIZE) throw Error(`size must not exceed ${MAX_TEXT_SIZE}`);
  return size;
}
// Approximate sans-serif advance widths, ascent and descent in world units.
// These are picking/fit bounds, NOT glyph outlines or exact font metrics.
export function textMetrics(e) {
  let advance = 0;
  for (const char of e.text) {
    if (/\p{M}/u.test(char)) continue;
    advance += /[ilI.,'!:;| ]/.test(char) ? 0.35 : /[MW@#%]/.test(char) ? 1 : char.codePointAt(0) > 0x2ff ? 1.1 : 0.7;
  }
  return { width: Math.max(0.35, advance) * e.size, ascent: e.size, descent: e.size * 0.25 };
}
// Adaptive cubic flattening targets 0.05 mm chord error. Depth is capped at
// 12 (4096 segments) for predictable draw/pick/export cost; extreme geometry
// may exceed the target at that cap. SVG retains the exact cubic regardless.
export const BEZIER_TOLERANCE = 0.05;
export const BEZIER_MAX_DEPTH = 12;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
export const normalizeAngle = a => ((a % 360) + 360) % 360;
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function number(v, name, fallback) {
  if (v === undefined && fallback !== undefined) return fallback;
  if ((typeof v !== 'number' && typeof v !== 'string') ||
      (typeof v === 'string' && !v.trim())) throw Error(`${name} must be a finite number`);
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_VALUE) throw Error(`${name} must be finite and within ±${MAX_VALUE}`);
  return n;
}
function positive(v, name, fallback) {
  const n = number(v, name, fallback);
  if (n <= 0) throw Error(`${name} must be greater than zero`);
  return n;
}
function point(p, name, fallback) {
  if (p === undefined && fallback) return fallback.slice();
  if (!Array.isArray(p) || p.length !== 2) throw Error(`${name} must contain two coordinates`);
  return [number(p[0], `${name}.x`), number(p[1], `${name}.y`)];
}
function count(v, name, fallback, max) {
  const n = number(v, name, fallback);
  if (!Number.isInteger(n) || n < 3 || n > max) throw Error(`${name} must be an integer from 3 to ${max}`);
  return n;
}

export function makeEntity(type, p = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Entity parameters must be an object');
  let e;
  switch (type) {
    case 'text': e = { type, c: point(p.at, 'at', [0, 0]), text: validateText(p.text === undefined ? 'Text' : p.text), size: textSize(p.size, 10) }; break;
    case 'line': e = { type, p1: point(p.from, 'from', [0, 0]), p2: point(p.to, 'to', [10, 0]) }; break;
    case 'bezier': e = { type, p1: point(p.from, 'from', [0, 0]),
      c1: point(p.control1, 'control1', [10, 20]), c2: point(p.control2, 'control2', [30, 20]),
      p2: point(p.to, 'to', [40, 0]) }; break;
    case 'circle': case 'arc':
      e = { type, c: point(p.center, 'center', [0, 0]), r: positive(p.radius, 'radius', 10) };
      if (type === 'arc') Object.assign(e, { a0: number(p.start, 'start', 0), a1: number(p.end, 'end', 180) });
      break;
    case 'rect':
      e = { type, c: point(p.center, 'center', [0, 0]), w: positive(p.width, 'width', 20), h: positive(p.height, 'height', 20) }; break;
    case 'polygon': case 'star':
      e = { type, c: point(p.center, 'center', [0, 0]), R: positive(p.radius, 'radius', 20),
        n: count(type === 'star' ? p.points : p.sides, type === 'star' ? 'points' : 'sides', type === 'star' ? 5 : 6, type === 'star' ? 32 : 64),
        rot: normalizeAngle(number(p.rotation, 'rotation', 90)) };
      if (type === 'star') {
        e.ratio = positive(p.innerRatio, 'innerRatio', 0.5);
        if (e.ratio >= 1) throw Error('innerRatio must be less than one');
      }
      break;
    default: throw Error('Unknown entity type: ' + type);
  }
  return { id: nextId(), ...e };
}

// Counterclockwise sweep, including wraparound. Nonzero multiples of 360
// describe one full turn, never an unbounded number of sampled revolutions.
export function arcAngles(e) {
  const start = normalizeAngle(e.a0);
  const raw = e.a1 - e.a0;
  const wrapped = normalizeAngle(raw);
  const sweep = wrapped === 0 && raw !== 0 ? 360 : wrapped;
  return { start, sweep, end: start + sweep };
}
function polar(c, r, angle) {
  const a = rad(normalizeAngle(angle));
  return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
}
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  const t = length === 0 ? 0 : clamp(((p[0] - a[0]) * (dx / length) + (p[1] - a[1]) * (dy / length)) / length, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
export function bezierPoints(e) {
  const points = [e.p1];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  function flatten(p1, c1, c2, p2, depth) {
    // Distance to the finite chord, not its infinite line, also catches
    // collinear reversals, cusps, and loops with coincident endpoints.
    if (depth >= BEZIER_MAX_DEPTH || Math.max(distanceToSegment(c1, p1, p2), distanceToSegment(c2, p1, p2)) <= BEZIER_TOLERANCE) {
      points.push(p2); return;
    }
    const a = mid(p1, c1), b = mid(c1, c2), c = mid(c2, p2);
    const d = mid(a, b), f = mid(b, c), m = mid(d, f);
    flatten(p1, a, d, m, depth + 1);
    flatten(m, f, c, p2, depth + 1);
  }
  flatten(e.p1, e.c1, e.c2, e.p2, 0);
  return points;
}
export function entityPoints(e) {
  switch (e.type) {
    case 'text': {
      const { width, ascent, descent } = textMetrics(e);
      return [[e.c[0], e.c[1] - descent], [e.c[0] + width, e.c[1] - descent],
        [e.c[0] + width, e.c[1] + ascent], [e.c[0], e.c[1] + ascent]];
    }
    case 'line': return [e.p1, e.p2];
    case 'bezier': return bezierPoints(e);
    case 'circle': return Array.from({ length: 72 }, (_, i) => polar(e.c, e.r, i * 5));
    case 'arc': {
      const { start, sweep } = arcAngles(e);
      const steps = Math.max(1, Math.ceil(sweep / 5));
      return Array.from({ length: steps + 1 }, (_, i) => polar(e.c, e.r, start + sweep * i / steps));
    }
    case 'rect': {
      const { c, w, h } = e;
      return [[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2],
        [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]];
    }
    case 'polygon': return Array.from({ length: e.n }, (_, i) => polar(e.c, e.R, e.rot + i * 360 / e.n));
    case 'star': return Array.from({ length: e.n * 2 }, (_, i) => polar(e.c, i % 2 ? e.R * e.ratio : e.R, e.rot + i * 180 / e.n));
    default: throw Error('Unknown entity type: ' + e.type);
  }
}
export function isClosed(e) { return !['line', 'arc', 'bezier', 'text'].includes(e.type); }

// Exact outline distance for circular entities avoids zoom-dependent picking
// errors caused by a polygonal approximation of a circle or arc.
export function distanceToEntity(p, e) {
  if (e.type === 'text') {
    // Pick the interior of the approximate label box, not a fictitious path.
    const [lo, , hi] = entityPoints(e);
    return Math.hypot(Math.max(lo[0] - p[0], 0, p[0] - hi[0]), Math.max(lo[1] - p[1], 0, p[1] - hi[1]));
  }
  if (e.type === 'circle') return Math.abs(dist(p, e.c) - e.r);
  if (e.type === 'arc') {
    const { start, sweep } = arcAngles(e);
    const angle = normalizeAngle(deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0])) - start);
    if (sweep === 360 || angle <= sweep) return Math.abs(dist(p, e.c) - e.r);
    return Math.min(dist(p, polar(e.c, e.r, start)), dist(p, polar(e.c, e.r, start + sweep)));
  }
  // Bézier picking is approximate, using the same bounded adaptive sampling
  // as drawing and DXF. It is not an exact closest-point solver.
  const pts = entityPoints(e);
  let best = Infinity;
  const segments = isClosed(e) ? pts.length : pts.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    best = Math.min(best, distanceToSegment(p, a, b));
  }
  return best;
}

export function moveEntity(e, d) {
  d = point(d, 'offset');
  const add = p => point([p[0] + d[0], p[1] + d[1]], 'position');
  if (e.type === 'bezier') {
    // Validate every new point before mutating, including direct UI moves.
    const points = ['p1', 'c1', 'c2', 'p2'].map(key => add(e[key]));
    [e.p1, e.c1, e.c2, e.p2] = points;
  } else if (e.type === 'line') {
    const p1 = add(e.p1), p2 = add(e.p2);
    e.p1 = p1; e.p2 = p2;
  } else e.c = add(e.c);
}

export function entityGrips(e) {
  const radiusGrip = { kind: 'radius', get: () => [e.c?.[0] + e.r, e.c?.[1]],
    set: p => { p = point(p, 'grip'); e.r = positive(Math.max(EPS, dist(e.c, p)), 'radius'); } };
  switch (e.type) {
    case 'text': return [{ kind: 'position', get: () => e.c, set: p => { e.c = point(p, 'at'); } }];
    case 'bezier': return ['p1', 'c1', 'c2', 'p2'].map(key => ({
      kind: key.startsWith('c') ? 'control' : 'endpoint', get: () => e[key],
      set: p => { e[key] = point(p, key.startsWith('c') ? 'control point' : 'endpoint'); },
    }));
    case 'line': return [
      { kind: 'endpoint', get: () => e.p1, set: p => { e.p1 = point(p, 'endpoint'); } },
      { kind: 'endpoint', get: () => e.p2, set: p => { e.p2 = point(p, 'endpoint'); } },
    ];
    case 'circle': return [radiusGrip];
    case 'arc': return [radiusGrip, ...['a0', 'a1'].map(key => ({ kind: 'angle', get: () => polar(e.c, e.r, e[key]),
      set: p => { p = point(p, 'grip'); if (dist(p, e.c) > EPS) e[key] = normalizeAngle(deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0]))); } }))];
    case 'rect': return [{ kind: 'corner', get: () => [e.c[0] + e.w / 2, e.c[1] + e.h / 2],
      set: p => {
        p = point(p, 'grip');
        const w = positive(Math.max(EPS, 2 * Math.abs(p[0] - e.c[0])), 'width');
        const h = positive(Math.max(EPS, 2 * Math.abs(p[1] - e.c[1])), 'height');
        e.w = w; e.h = h;
      } }];
    case 'polygon': case 'star': return [{ kind: 'vertex', get: () => polar(e.c, e.R, e.rot),
      set: p => {
        p = point(p, 'grip');
        const R = positive(Math.max(EPS, dist(e.c, p)), 'radius');
        if (dist(e.c, p) > EPS) e.rot = normalizeAngle(deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0])));
        e.R = R;
      } }, ...(e.type === 'star' ? [{ kind: 'inner', get: () => polar(e.c, e.R * e.ratio, e.rot + 180 / e.n),
        set: p => { p = point(p, 'grip'); e.ratio = clamp(dist(e.c, p) / e.R, 0.001, 0.999); } }] : [])];
    default: throw Error('Unknown entity type: ' + e.type);
  }
}

export function entityDimensions(e) {
  const r1 = v => Math.round(v * 10) / 10;
  const dimension = (key, value, anchor, set) => ({ key, value, anchor,
    label: key === 'radius' ? 'R' + r1(value) : r1(value) + ' mm',
    set: v => set(positive(v, key)) });
  switch (e.type) {
    case 'text': {
      const dim = dimension('size', e.size, [e.c[0], e.c[1] + e.size], v => { e.size = textSize(v); });
      dim.label = 'Font size ' + r1(e.size) + ' mm';
      return [dim];
    }
    case 'bezier': {
      const dim = dimension('chord', dist(e.p1, e.p2), [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2], v => {
        const length = dist(e.p1, e.p2);
        const dx = length === 0 ? 1 : (e.p2[0] - e.p1[0]) / length;
        const dy = length === 0 ? 0 : (e.p2[1] - e.p1[1]) / length;
        const p2 = point([e.p1[0] + dx * v, e.p1[1] + dy * v], 'endpoint');
        // Preserve the end tangent by translating its control with the end.
        const c2 = point([e.c2[0] + p2[0] - e.p2[0], e.c2[1] + p2[1] - e.p2[1]], 'control2');
        e.p2 = p2; e.c2 = c2;
      });
      dim.label = 'Chord ' + r1(dim.value) + ' mm';
      return [dim];
    }
    case 'line': return [dimension('length', dist(e.p1, e.p2), [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2], v => {
      const length = dist(e.p1, e.p2);
      // A coincident-endpoint line has no direction. Recover it along +X.
      const dx = length === 0 ? 1 : (e.p2[0] - e.p1[0]) / length;
      const dy = length === 0 ? 0 : (e.p2[1] - e.p1[1]) / length;
      e.p2 = point([e.p1[0] + dx * v, e.p1[1] + dy * v], 'endpoint');
    })];
    case 'circle': case 'arc': return [dimension('radius', e.r, polar(e.c, e.r, 45), v => { e.r = v; })];
    case 'rect': return [
      dimension('width', e.w, [e.c[0], e.c[1] - e.h / 2], v => { e.w = v; }),
      dimension('height', e.h, [e.c[0] + e.w / 2, e.c[1]], v => { e.h = v; }),
    ];
    case 'polygon': case 'star': return [dimension('radius', e.R, polar(e.c, e.R, e.rot), v => { e.R = v; })];
    default: throw Error('Unknown entity type: ' + e.type);
  }
}

export function createDoc() { return { entities: [], timeline: [], selectedId: null }; }
export function serializeScene(doc) {
  return { units: 'mm', entities: doc.entities.map(e => ({
    id: e.id, type: e.type,
    ...(e.p1 ? { from: e.p1.slice(), to: e.p2.slice() } : {}),
    ...(e.type === 'bezier' ? { control1: e.c1.slice(), control2: e.c2.slice() } : {}),
    ...(e.c && e.type !== 'text' ? { center: e.c.slice() } : {}),
    ...(e.type === 'text' ? { at: e.c.slice(), text: e.text, size: e.size } : {}),
    ...(e.r !== undefined ? { radius: e.r } : {}),
    ...(e.R !== undefined ? { radius: e.R, rotation: e.rot } : {}),
    ...(e.w !== undefined ? { width: e.w, height: e.h } : {}),
    ...(e.n !== undefined ? { [e.type === 'star' ? 'points' : 'sides']: e.n } : {}),
    ...(e.ratio !== undefined ? { innerRatio: e.ratio } : {}),
    ...(e.a0 !== undefined ? { start: e.a0, end: e.a1 } : {}),
    selected: e.id === doc.selectedId,
  })) };
}

// A batch is transactional: any invalid operation leaves the document,
// timeline, selection, and ID allocation unchanged. Never silently skip ops.
export function applyOps(doc, ops, source = 'user') {
  if (!Array.isArray(ops)) throw Error('Operations must be an array');
  const staged = { entities: doc.entities.map(e => ({ ...e, ...(e.c ? { c: e.c.slice() } : {}), ...(e.p1 ? { p1: e.p1.slice(), p2: e.p2.slice() } : {}),
    ...(e.type === 'bezier' ? { c1: e.c1.slice(), c2: e.c2.slice() } : {}) })),
    timeline: doc.timeline.slice(), selectedId: doc.selectedId };
  const beforeSeq = seq;
  const created = [], touched = [];
  try {
    // Imported/restored entities must never collide with newly allocated IDs.
    for (const e of staged.entities) if (/^e\d+$/.test(e.id)) seq = Math.max(seq, Number(e.id.slice(1)));
    ops.forEach((op, index) => {
      try {
        if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('Operation must be an object');
        const target = () => {
          const e = staged.entities.find(x => x.id === op.id);
          if (!e) throw Error(`Entity ${String(op.id)} does not exist`);
          return e;
        };
        let text, ids = [];
        switch (op.op) {
          case 'text': case 'line': case 'bezier': case 'circle': case 'arc': case 'rect': case 'polygon': case 'star': {
            const e = makeEntity(op.op, op);
            staged.entities.push(e); created.push(e.id); ids = [e.id]; text = describeEntity(e); break;
          }
          case 'move': {
            const e = target(), to = point(op.to, 'to');
            const ref = e.p1 ? [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2] : e.c;
            moveEntity(e, [to[0] - ref[0], to[1] - ref[1]]);
            touched.push(e.id); ids = [e.id]; text = `move ${e.id} → (${to})`; break;
          }
          case 'set_dimension': {
            const e = target(), dim = entityDimensions(e).find(d => d.key === op.dimension);
            if (!dim) throw Error(`${e.type} has no ${String(op.dimension)} dimension`);
            dim.set(op.value); touched.push(e.id); ids = [e.id]; text = `${e.id} ${op.dimension} = ${Number(op.value)} mm`; break;
          }
          case 'delete': {
            const e = target(); staged.entities = staged.entities.filter(x => x.id !== e.id);
            if (staged.selectedId === e.id) staged.selectedId = null;
            text = `delete ${e.id}`; break;
          }
          case 'clear': staged.entities = []; staged.selectedId = null; text = 'clear canvas'; break;
          default: throw Error(`Unknown operation: ${String(op.op)}`);
        }
        staged.timeline.push({ text, source, ids });
      } catch (error) { throw Error(`Operation ${index + 1}: ${error.message}`); }
    });
  } catch (error) { seq = beforeSeq; throw error; }
  // Preserve object references held by current grips and dimension controls.
  const existing = new Map(doc.entities.map(e => [e.id, e]));
  doc.entities = staged.entities.map(e => existing.has(e.id) ? Object.assign(existing.get(e.id), e) : e);
  doc.timeline = staged.timeline;
  doc.selectedId = staged.entities.some(e => e.id === staged.selectedId) ? staged.selectedId : null;
  const live = new Set(doc.entities.map(e => e.id));
  return { created: created.filter(id => live.has(id)), touched: [...new Set(touched)].filter(id => live.has(id)) };
}
function describeEntity(e) {
  switch (e.type) {
    case 'text': return `text “${e.text}” size ${e.size} at (${e.c})`;
    case 'line': return `line (${e.p1}) → (${e.p2})`;
    case 'bezier': return `Bézier (${e.p1}) → (${e.p2})`;
    case 'circle': return `circle R${e.r} at (${e.c})`;
    case 'arc': return `arc R${e.r} ${e.a0}°→${e.a1}°`;
    case 'rect': return `rect ${e.w} × ${e.h}`;
    case 'polygon': return `polygon ${e.n} sides R${e.R}`;
    case 'star': return `star ${e.n} points R${e.R}`;
  }
}
