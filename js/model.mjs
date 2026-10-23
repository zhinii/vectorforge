// VectorForge model — parametric entities, driving dimensions, ops, timeline.
// Units are millimetres. World coordinates are y-up (like real CAD / DXF).

let seq = 0;
export const nextId = () => 'e' + (++seq);
export const EPS = 1e-6;

const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const pt = (p, fallback = [0, 0]) =>
  Array.isArray(p) && p.length >= 2 ? [num(p[0]), num(p[1])] : fallback.slice();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function makeEntity(type, p) {
  const id = nextId();
  switch (type) {
    case 'line':
      return { id, type, p1: pt(p.from), p2: pt(p.to, [10, 0]) };
    case 'circle':
      return { id, type, c: pt(p.center), r: Math.max(0.1, num(p.radius, 10)) };
    case 'arc':
      return { id, type, c: pt(p.center), r: Math.max(0.1, num(p.radius, 10)),
               a0: num(p.start, 0), a1: num(p.end, 180) };
    case 'rect':
      return { id, type, c: pt(p.center), w: Math.max(0.1, num(p.width, 20)),
               h: Math.max(0.1, num(p.height, 20)) };
    case 'polygon': {
      const n = clamp(Math.round(num(p.sides, 6)), 3, 64);
      return { id, type, c: pt(p.center), R: Math.max(0.1, num(p.radius, 20)),
               n, rot: num(p.rotation, 90) };
    }
    case 'star': {
      const n = clamp(Math.round(num(p.points, 5)), 3, 32);
      return { id, type, c: pt(p.center), R: Math.max(0.1, num(p.radius, 20)),
               n, rot: num(p.rotation, 90), ratio: clamp(num(p.innerRatio, 0.5), 0.05, 0.95) };
    }
    default:
      throw new Error('unknown entity type: ' + type);
  }
}

// ---- geometry helpers ----------------------------------------------------
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const deg = r => r * 180 / Math.PI;
const rad = d => d * Math.PI / 180;

export function entityPoints(e) {
  // Polygonal outline used for rendering, hit-testing and export.
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'circle': {
      const pts = [];
      for (let i = 0; i < 72; i++) {
        const a = i / 72 * 2 * Math.PI;
        pts.push([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'arc': {
      const pts = [];
      let a0 = e.a0, a1 = e.a1;
      while (a1 < a0) a1 += 360;
      const steps = Math.max(8, Math.ceil((a1 - a0) / 5));
      for (let i = 0; i <= steps; i++) {
        const a = rad(a0 + (a1 - a0) * i / steps);
        pts.push([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'rect': {
      const { c, w, h } = e;
      return [[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2],
              [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]];
    }
    case 'polygon': {
      const pts = [];
      for (let i = 0; i < e.n; i++) {
        const a = rad(e.rot + i * 360 / e.n);
        pts.push([e.c[0] + e.R * Math.cos(a), e.c[1] + e.R * Math.sin(a)]);
      }
      return pts;
    }
    case 'star': {
      const pts = [];
      for (let i = 0; i < 2 * e.n; i++) {
        const R = i % 2 === 0 ? e.R : e.R * e.ratio;
        const a = rad(e.rot + i * 180 / e.n);
        pts.push([e.c[0] + R * Math.cos(a), e.c[1] + R * Math.sin(a)]);
      }
      return pts;
    }
  }
}

export function isClosed(e) { return e.type !== 'line' && e.type !== 'arc'; }

// Distance from point to entity outline (for selection hit-testing).
export function distanceToEntity(p, e) {
  const pts = entityPoints(e);
  let best = Infinity;
  const closed = isClosed(e);
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 < EPS ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

export function moveEntity(e, d) {
  const add = (p) => [p[0] + d[0], p[1] + d[1]];
  if (e.type === 'line') { e.p1 = add(e.p1); e.p2 = add(e.p2); }
  else e.c = add(e.c);
}

// ---- grips ----------------------------------------------------------------
// A grip exposes get()/set() against entity parameters. Dragging a grip
// reshapes the entity; dimensions update because they are derived.
export function entityGrips(e) {
  switch (e.type) {
    case 'line': return [
      { kind: 'endpoint', get: () => e.p1, set: p => { e.p1 = p.slice(); } },
      { kind: 'endpoint', get: () => e.p2, set: p => { e.p2 = p.slice(); } },
    ];
    case 'circle': return [
      { kind: 'radius', get: () => [e.c[0] + e.r, e.c[1]], set: p => { e.r = Math.max(0.1, dist(e.c, p)); } },
    ];
    case 'arc': return [
      { kind: 'radius', get: () => [e.c[0] + e.r, e.c[1]], set: p => { e.r = Math.max(0.1, dist(e.c, p)); } },
      { kind: 'angle', get: () => [e.c[0] + e.r * Math.cos(rad(e.a0)), e.c[1] + e.r * Math.sin(rad(e.a0))],
        set: p => { e.a0 = deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0])); } },
      { kind: 'angle', get: () => [e.c[0] + e.r * Math.cos(rad(e.a1)), e.c[1] + e.r * Math.sin(rad(e.a1))],
        set: p => { e.a1 = deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0])); } },
    ];
    case 'rect': return [
      { kind: 'corner', get: () => [e.c[0] + e.w / 2, e.c[1] + e.h / 2],
        set: p => { e.w = Math.max(0.1, 2 * Math.abs(p[0] - e.c[0])); e.h = Math.max(0.1, 2 * Math.abs(p[1] - e.c[1])); } },
    ];
    case 'polygon': case 'star': return [
      { kind: 'vertex', get: () => [e.c[0] + e.R * Math.cos(rad(e.rot)), e.c[1] + e.R * Math.sin(rad(e.rot))],
        set: p => { e.R = Math.max(0.1, dist(e.c, p)); e.rot = deg(Math.atan2(p[1] - e.c[1], p[0] - e.c[0])); } },
      ...(e.type === 'star' ? [{ kind: 'inner',
        get: () => { const a = rad(e.rot + 180 / e.n); return [e.c[0] + e.R * e.ratio * Math.cos(a), e.c[1] + e.R * e.ratio * Math.sin(a)]; },
        set: p => { e.ratio = clamp(dist(e.c, p) / e.R, 0.05, 0.95); } }] : []),
    ];
  }
}

// ---- dimensions -------------------------------------------------------------
// Driving dimensions: reading shows the value; set(v) reshapes the entity.
// This is the bidirectional contract — dimensions are parameters, not labels.
export function entityDimensions(e) {
  const r1 = v => Math.round(v * 10) / 10;
  switch (e.type) {
    case 'line': {
      const d = dist(e.p1, e.p2);
      const mid = [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2];
      return [{ key: 'length', label: r1(d) + ' mm', value: d, anchor: mid,
        set: v => {
          if (v <= 0) return;
          const len = dist(e.p1, e.p2) || 1, k = v / len;
          e.p2 = [e.p1[0] + (e.p2[0] - e.p1[0]) * k, e.p1[1] + (e.p2[1] - e.p1[1]) * k];
        } }];
    }
    case 'circle': case 'arc':
      return [{ key: 'radius', label: 'R' + r1(e.r), value: e.r,
        anchor: [e.c[0] + e.r * 0.7071, e.c[1] + e.r * 0.7071],
        set: v => { if (v > 0) e.r = v; } }];
    case 'rect': return [
      { key: 'width', label: r1(e.w) + ' mm', value: e.w, anchor: [e.c[0], e.c[1] - e.h / 2],
        set: v => { if (v > 0) e.w = v; } },
      { key: 'height', label: r1(e.h) + ' mm', value: e.h, anchor: [e.c[0] + e.w / 2, e.c[1]],
        set: v => { if (v > 0) e.h = v; } },
    ];
    case 'polygon': case 'star':
      return [{ key: 'radius', label: 'R' + r1(e.R), value: e.R,
        anchor: [e.c[0] + e.R * Math.cos(rad(e.rot)), e.c[1] + e.R * Math.sin(rad(e.rot))],
        set: v => { if (v > 0) e.R = v; } }];
  }
}

// ---- document state ---------------------------------------------------------
export function createDoc() {
  return { entities: [], timeline: [], selectedId: null };
}

export function serializeScene(doc) {
  // Compact parametric state sent to the LLM. Feature-level, not pixels.
  return {
    units: 'mm',
    entities: doc.entities.map(e => ({
      id: e.id, type: e.type,
      ...(e.p1 ? { from: e.p1.map(v => Math.round(v * 10) / 10), to: e.p2.map(v => Math.round(v * 10) / 10) } : {}),
      ...(e.c ? { center: e.c.map(v => Math.round(v * 10) / 10) } : {}),
      ...(e.r !== undefined ? { radius: Math.round(e.r * 10) / 10 } : {}),
      ...(e.R !== undefined ? { radius: Math.round(e.R * 10) / 10 } : {}),
      ...(e.w !== undefined ? { width: Math.round(e.w * 10) / 10, height: Math.round(e.h * 10) / 10 } : {}),
      ...(e.n !== undefined ? { [e.type === 'star' ? 'points' : 'sides']: e.n } : {}),
      ...(e.a0 !== undefined ? { start: Math.round(e.a0), end: Math.round(e.a1) } : {}),
      selected: e.id === doc.selectedId,
    })),
  };
}

// ---- ops executor -------------------------------------------------------------
// Ops are the shared language between the LLM, the timeline and the tools.
export function applyOps(doc, ops, source = 'user') {
  const created = [], touched = [];
  for (const op of ops) {
    switch (op.op) {
      case 'line': case 'circle': case 'arc': case 'rect':
      case 'polygon': case 'star': {
        const e = makeEntity(op.op, op);
        doc.entities.push(e); created.push(e.id);
        doc.timeline.push({ text: describeOp(op), source, ids: [e.id] });
        break;
      }
      case 'move': {
        const e = doc.entities.find(x => x.id === op.id);
        if (!e || !Array.isArray(op.to)) break;
        const target = pt(op.to);
        const ref = e.type === 'line' ? [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2] : e.c;
        moveEntity(e, [target[0] - ref[0], target[1] - ref[1]]);
        touched.push(e.id);
        doc.timeline.push({ text: `move ${e.id} → (${target.map(v => Math.round(v * 10) / 10)})`, source, ids: [e.id] });
        break;
      }
      case 'set_dimension': {
        const e = doc.entities.find(x => x.id === op.id);
        if (!e) break;
        const dim = entityDimensions(e).find(d => d.key === op.dimension);
        const v = num(op.value);
        if (dim && v > 0) { dim.set(v); touched.push(e.id);
          doc.timeline.push({ text: `${e.id} ${op.dimension} = ${v} mm`, source, ids: [e.id] }); }
        break;
      }
      case 'delete': {
        const i = doc.entities.findIndex(x => x.id === op.id);
        if (i >= 0) { doc.entities.splice(i, 1);
          doc.timeline.push({ text: `delete ${op.id}`, source, ids: [] }); }
        break;
      }
      case 'clear':
        doc.entities.length = 0;
        doc.timeline.push({ text: 'clear canvas', source, ids: [] });
        break;
    }
  }
  return { created, touched };
}

function describeOp(op) {
  const r = v => Math.round(v * 10) / 10;
  switch (op.op) {
    case 'line': return `line (${pt(op.from).map(r)}) → (${pt(op.to, [10, 0]).map(r)})`;
    case 'circle': return `circle R${r(num(op.radius, 10))} at (${pt(op.center).map(r)})`;
    case 'arc': return `arc R${r(num(op.radius, 10))} ${num(op.start, 0)}°→${num(op.end, 180)}°`;
    case 'rect': return `rect ${r(num(op.width, 20))} × ${r(num(op.height, 20))}`;
    case 'polygon': return `polygon ${clamp(Math.round(num(op.sides, 6)), 3, 64)} sides R${r(num(op.radius, 20))}`;
    case 'star': return `star ${clamp(Math.round(op.points ?? 5), 3, 32)} points R${r(num(op.radius, 20))}`;
    default: return op.op;
  }
}
